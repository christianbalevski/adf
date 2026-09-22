'use strict';

const XLSX = require('xlsx');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv';
const DEFAULT_READ_OPTIONS = {
  type: 'buffer', cellDates: true, cellFormula: true, cellStyles: true, cellNF: true,
};

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new TypeError('Spreadsheet input must be a Buffer or Uint8Array');
}

function inferCell(value, descriptor = {}) {
  const formula = descriptor.formula == null ? null : String(descriptor.formula).replace(/^=/, '');
  const cell = {};
  if (descriptor.numberFormat != null) cell.z = String(descriptor.numberFormat);
  if (descriptor.style != null) throw new Error('SheetJS CE does not reliably write arbitrary style objects; omit style');
  if (formula != null) cell.f = formula;
  // A cached formula result is still a real cell value and needs a matching type.
  const hasCached = descriptor.cachedValue !== undefined;
  const actual = hasCached ? descriptor.cachedValue : value;
  if (actual instanceof Date) { cell.t = 'd'; cell.v = new Date(actual.getTime()); }
  else if (actual === null || actual === undefined) {
    if (formula == null) cell.t = 'z';
  } else if (typeof actual === 'boolean') { cell.t = 'b'; cell.v = actual; }
  else if (typeof actual === 'number') { if (!Number.isFinite(actual)) throw new TypeError('Spreadsheet numbers must be finite'); cell.t = 'n'; cell.v = actual; }
  else if (typeof actual === 'string') { cell.t = 's'; cell.v = actual; }
  else throw new TypeError(`Unsupported spreadsheet cell value: ${typeof actual}`);
  if (descriptor.type) cell.t = descriptor.type;
  return cell;
}

function normalizeInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) && ('value' in value || 'formula' in value || 'cachedValue' in value || 'type' in value || 'style' in value || 'numberFormat' in value)) {
    return inferCell(value.value, value);
  }
  return inferCell(value);
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('sheet rows must be an array');
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new TypeError('each sheet row must be an array');
    return row.map(normalizeInput);
  });
}

function createWorkbook({ sheets = [] } = {}) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new TypeError('sheets must be a non-empty array');
  const wb = XLSX.utils.book_new();
  for (const spec of sheets) {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new TypeError('each sheet needs a non-empty name');
    if (wb.SheetNames.includes(spec.name)) throw new Error(`Duplicate sheet name: ${spec.name}`);
    const ws = XLSX.utils.aoa_to_sheet(normalizeRows(spec.rows || []));
    if (spec.columns) {
      if (!Array.isArray(spec.columns)) throw new TypeError('columns must be an array');
      ws['!cols'] = spec.columns.map((column) => typeof column === 'number' ? { wch: column } : column);
    }
    XLSX.utils.book_append_sheet(wb, ws, spec.name);
  }
  return wb;
}

function parseWorkbook(bytes, options = {}) {
  try { return XLSX.read(asBuffer(bytes), { ...DEFAULT_READ_OPTIONS, ...options }); }
  catch (error) { throw new Error(`Unable to read spreadsheet: ${error.message}`); }
}

function writeWorkbook(workbook, options = {}) {
  if (!workbook || !Array.isArray(workbook.SheetNames)) throw new TypeError('workbook must be a SheetJS workbook');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', cellStyles: true, bookSST: false, ...options });
}

function requireSheet(workbook, sheetName) {
  if (!workbook.SheetNames.includes(sheetName) || !workbook.Sheets[sheetName]) throw new Error(`Worksheet not found: ${sheetName}`);
  return workbook.Sheets[sheetName];
}

function readRows(bytes, sheetName, options = {}) {
  const wb = parseWorkbook(bytes, options.readOptions);
  const ws = requireSheet(wb, sheetName);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

function cellSummary(cell) {
  if (!cell) return null;
  return { address: undefined, type: cell.t, value: cell.v, formula: cell.f, numberFormat: cell.z, style: cell.s };
}

function readWorkbook(bytes, options = {}) {
  const wb = parseWorkbook(bytes, options.readOptions);
  const sheets = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const cells = {};
    for (const address of Object.keys(ws)) {
      if (address.startsWith('!')) continue;
      cells[address] = { ...cellSummary(ws[address]), address };
    }
    sheets[name] = { range: ws['!ref'] || null, cells };
  }
  return { sheetNames: [...wb.SheetNames], sheets };
}

function normalizeAddress(address) {
  if (typeof address !== 'string') throw new TypeError('cell address must be a string');
  const match = /^([A-Za-z]{1,3})([1-9][0-9]*)$/.exec(address);
  if (!match) throw new Error(`Invalid A1 cell address: ${address}`);
  const column = match[1].toUpperCase();
  const row = Number(match[2]);
  let columnNumber = 0;
  for (const character of column) columnNumber = columnNumber * 26 + character.charCodeAt(0) - 64;
  if (columnNumber > 16384 || row > 1048576) throw new Error(`Cell address out of Excel bounds: ${address}`);
  return `${column}${row}`;
}

function updateCells(bytes, updates, { readOptions = {} } = {}) {
  if (!Array.isArray(updates) || updates.length === 0) throw new TypeError('updates must be a non-empty array');
  const wb = parseWorkbook(bytes, readOptions);
  for (const update of updates) {
    if (!update || typeof update.sheet !== 'string' || typeof update.address !== 'string') throw new TypeError('each update needs sheet and address');
    const ws = requireSheet(wb, update.sheet);
    const address = normalizeAddress(update.address);
    const previous = ws[address] || {};
    const hasFormula = Object.prototype.hasOwnProperty.call(update, 'formula');
    const hasValue = Object.prototype.hasOwnProperty.call(update, 'value') || Object.prototype.hasOwnProperty.call(update, 'cachedValue');
    if (update.style !== undefined) throw new Error('SheetJS CE does not reliably write arbitrary style objects; omit style');
    if (!hasFormula && !hasValue && update.numberFormat === undefined) throw new Error(`Update for ${update.sheet}!${address} has no change`);
    let next;
    if (hasValue) {
      // Supplying a value replaces a formula unless a new formula is supplied too.
      next = inferCell(update.value !== undefined ? update.value : undefined, {
        formula: hasFormula ? update.formula : null,
        cachedValue: update.cachedValue,
        type: update.type,
        numberFormat: update.numberFormat !== undefined ? update.numberFormat : previous.z,
      });
    } else if (hasFormula) {
      // A new formula has no trustworthy cache unless the caller provides one.
      next = inferCell(undefined, {
        formula: update.formula,
        type: update.type,
        numberFormat: update.numberFormat !== undefined ? update.numberFormat : previous.z,
      });
      if (update.formula === null) {
        next = { ...previous };
        delete next.f;
        if (update.numberFormat !== undefined) next.z = update.numberFormat;
      }
    } else {
      // A number-format-only update preserves the cell's value and formula.
      next = { ...previous };
      if (update.numberFormat !== undefined) next.z = update.numberFormat;
    }
    ws[address] = next;
    const range = XLSX.utils.decode_range(ws['!ref'] || address);
    const target = XLSX.utils.decode_cell(address);
    range.s.r = Math.min(range.s.r, target.r); range.s.c = Math.min(range.s.c, target.c);
    range.e.r = Math.max(range.e.r, target.r); range.e.c = Math.max(range.e.c, target.c);
    ws['!ref'] = XLSX.utils.encode_range(range);
  }
  wb.Workbook = wb.Workbook || {};
  wb.Workbook.CalcPr = { ...(wb.Workbook.CalcPr || {}), calcMode: 'auto', fullCalcOnLoad: true, forceFullCalc: true };
  return writeWorkbook(wb);
}

function csvSafeString(value) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  return typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
}

function csvField(value) {
  const text = csvSafeString(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeCsv(bytes, sheetName, options = {}) {
  const wb = parseWorkbook(bytes, options.readOptions);
  const ws = requireSheet(wb, sheetName);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

module.exports = {
  XLSX_MIME, CSV_MIME, createWorkbook, parseWorkbook, writeWorkbook,
  readRows, readWorkbook, updateCells, safeCsv, inferCell, normalizeAddress,
};
