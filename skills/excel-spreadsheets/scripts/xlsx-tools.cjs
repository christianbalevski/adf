'use strict';

const XLSX = require('xlsx');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv';
const DEFAULT_READ_OPTIONS = {
  type: 'buffer', cellDates: true, cellFormula: true, cellStyles: true, cellNF: true,
};
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_SHEETS = 1000;
const MAX_CELLS = 2_000_000;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inspectZip(bytes) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  const min = Math.max(0, bytes.length - 0xFFFF - 22);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('OOXML ZIP is missing its end-of-central-directory record');
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) throw new Error('ZIP64 OOXML is unsupported by the active-content preflight');
  if (centralOffset + centralSize > bytes.length) throw new Error('OOXML central directory exceeds input');
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL) throw new Error('Malformed OOXML central directory');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    const segments = [];
    for (const segment of rawName.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') throw new Error(`OOXML archive path traversal is forbidden: ${rawName}`);
      segments.push(segment);
    }
    const name = segments.join('/');
    if (localOffset === 0xFFFFFFFF) throw new Error('ZIP64 OOXML entry is unsupported by the active-content preflight');
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, read(entry) {
    if (entry.compressedSize > bytes.length || entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== ZIP_LOCAL) return null;
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) return null;
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return zlib.inflateRawSync(compressed);
    return null;
  } };
}

const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function isXml10Text(value) {
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    const valid = code === 0x9 || code === 0xA || code === 0xD
      || (code >= 0x20 && code <= 0xD7FF)
      || (code >= 0xE000 && code <= 0xFFFD)
      || (code >= 0x10000 && code <= 0x10FFFF);
    if (!valid) return false;
  }
  return true;
}

function decodeXmlEntities(value) {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor);
    if (amp < 0) { output += value.slice(cursor); break; }
    output += value.slice(cursor, amp);
    const semi = value.indexOf(';', amp + 1);
    if (semi < 0) throw new Error('Malformed XML entity in [Content_Types].xml');
    const entity = value.slice(amp, semi + 1);
    let decoded;
    if (entity === '&amp;') decoded = '&';
    else if (entity === '&lt;') decoded = '<';
    else if (entity === '&gt;') decoded = '>';
    else if (entity === '&quot;') decoded = '"';
    else if (entity === '&apos;') decoded = "'";
    else if (/^&#[0-9]+;$/.test(entity)) decoded = String.fromCodePoint(Number(entity.slice(2, -1)));
    else if (/^&#x[0-9a-f]+;$/i.test(entity)) decoded = String.fromCodePoint(parseInt(entity.slice(3, -1), 16));
    else throw new Error(`Unsupported XML entity in [Content_Types].xml: ${entity}`);
    output += decoded;
    cursor = semi + 1;
  }
  if (!isXml10Text(output)) throw new Error('Invalid XML 1.0 text in [Content_Types].xml');
  return output;
}

function xmlLocalName(name) {
  return name.slice(name.lastIndexOf(':') + 1);
}

function parseXmlStartTag(raw) {
  let body = raw.trim();
  let selfClosing = false;
  if (/\/\s*$/.test(body)) { selfClosing = true; body = body.replace(/\/\s*$/, '').trim(); }
  let cursor = 0;
  const isSpace = (character) => character === '\t' || character === '\n' || character === '\r' || character === ' ';
  const isDelimiter = (character) => isSpace(character) || character === '=' || character === '/' || character === '>';
  const skipSpace = () => { while (cursor < body.length && isSpace(body[cursor])) cursor += 1; };
  skipSpace();
  const nameStart = cursor;
  while (cursor < body.length && !isDelimiter(body[cursor])) cursor += 1;
  const name = body.slice(nameStart, cursor);
  if (!XML_NAME_RE.test(name)) throw new Error('Malformed XML element name in [Content_Types].xml');
  const attrs = Object.create(null);
  const localAttrs = Object.create(null);
  while (true) {
    skipSpace();
    if (cursor >= body.length) break;
    const attrStart = cursor;
    while (cursor < body.length && !isDelimiter(body[cursor])) cursor += 1;
    const attrName = body.slice(attrStart, cursor);
    if (!XML_NAME_RE.test(attrName)) throw new Error('Malformed XML attribute name in [Content_Types].xml');
    skipSpace();
    if (body[cursor] !== '=') throw new Error('XML attribute is missing = in [Content_Types].xml');
    cursor += 1;
    skipSpace();
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") throw new Error('XML attribute must be quoted in [Content_Types].xml');
    cursor += 1;
    const valueStart = cursor;
    while (cursor < body.length && body[cursor] !== quote) cursor += 1;
    if (cursor >= body.length) throw new Error('Unclosed XML attribute in [Content_Types].xml');
    const value = decodeXmlEntities(body.slice(valueStart, cursor));
    cursor += 1;
    if (attrs[attrName] !== undefined || localAttrs[xmlLocalName(attrName)] !== undefined) throw new Error('Duplicate XML attribute in [Content_Types].xml');
    attrs[attrName] = value;
    localAttrs[xmlLocalName(attrName)] = value;
  }
  return { name, localName: xmlLocalName(name), attrs: localAttrs, selfClosing };
}

function findXmlTagEnd(xml, start) {
  let quote = null;
  for (let cursor = start; cursor < xml.length; cursor += 1) {
    const character = xml[cursor];
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '>') return cursor;
  }
  throw new Error('Unclosed XML tag in [Content_Types].xml');
}

function parseContentTypesXml(bytes) {
  let xml;
  try { xml = new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Invalid UTF-8 in [Content_Types].xml'); }
  if (!isXml10Text(xml)) throw new Error('Invalid XML 1.0 content in [Content_Types].xml');
  const records = [];
  const stack = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const next = xml.indexOf('<', cursor);
      const text = xml.slice(cursor, next < 0 ? xml.length : next);
      if (!stack.length && text.trim()) throw new Error('Text outside XML root in [Content_Types].xml');
      decodeXmlEntities(text);
      cursor = next < 0 ? xml.length : next;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--')) throw new Error('Malformed XML comment in [Content_Types].xml');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      if (!stack.length) throw new Error('CDATA outside XML root in [Content_Types].xml');
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || !isXml10Text(xml.slice(cursor + 9, end))) throw new Error('Malformed XML CDATA in [Content_Types].xml');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0) throw new Error('Malformed XML processing instruction in [Content_Types].xml');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', cursor)) throw new Error('Unsupported or malformed XML declaration in [Content_Types].xml');
    const end = findXmlTagEnd(xml, cursor + 1);
    const raw = xml.slice(cursor + 1, end);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!XML_NAME_RE.test(name) || !stack.length || stack[stack.length - 1] !== name) throw new Error('Mismatched XML closing tag in [Content_Types].xml');
      stack.pop();
      if (!stack.length) rootClosed = true;
    } else {
      const parsed = parseXmlStartTag(raw);
      if (!stack.length && (rootSeen || rootClosed)) throw new Error('Multiple XML roots in [Content_Types].xml');
      if (!stack.length) rootSeen = true;
      if (parsed.localName === 'Default' || parsed.localName === 'Override') records.push(parsed);
      if (!parsed.selfClosing) stack.push(parsed.name);
      else if (!stack.length) rootClosed = true;
    }
    cursor = end + 1;
  }
  if (!rootSeen || stack.length || !rootClosed) throw new Error('Incomplete XML document in [Content_Types].xml');
  return records;
}

function assertSafeOOXML(bytes) {
  const archive = inspectZip(bytes);
  if (!archive) return;
  const activeName = /(?:^|\/)(?:vbaProject[^/]*|activeX|embeddings)(?:\/|$)/i;
  for (const entry of archive.entries) {
    if (activeName.test(entry.name)) throw new Error(`Refusing active-content OOXML entry: ${entry.name}`);
  }
  const contentTypes = archive.entries.find((entry) => entry.name.toLowerCase() === '[content_types].xml');
  if (!contentTypes) throw new Error('OOXML is missing [Content_Types].xml');
  const contentXml = archive.read(contentTypes);
  if (!contentXml) throw new Error('Unable to read [Content_Types].xml for active-content preflight');
  const records = parseContentTypesXml(contentXml);
  if (records.some((record) => {
    if (record.localName === 'Default') return /ContentType/i.test(Object.keys(record.attrs).join()) && /(?:vbaProject|activeX|oleObject)/i.test(record.attrs.ContentType || '');
    return /(?:macroEnabled|vbaProject|activeX|oleObject|xlam|xltm|embeddings)/i.test(record.attrs.ContentType || '')
      || /(?:vbaProject|activeX|embeddings)/i.test(record.attrs.PartName || '');
  })) throw new Error('Refusing macro-enabled, VBA, ActiveX, or embedded-object OOXML content');
  for (const entry of archive.entries) {
    if (!/\.rels$/i.test(entry.name)) continue;
    const rels = archive.read(entry);
    if (!rels) throw new Error(`Unable to read OOXML relationship part: ${entry.name}`);
    if (/vbaProject|activeX|embeddings|oleObject|macroEnabled/i.test(rels.toString('utf8'))) {
      throw new Error(`Refusing active-content OOXML relationship: ${entry.name}`);
    }
  }
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) {
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RangeError(`Spreadsheet input exceeds ${MAX_INPUT_BYTES} byte limit`);
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RangeError(`Spreadsheet input exceeds ${MAX_INPUT_BYTES} byte limit`);
    return Buffer.from(bytes);
  }
  throw new TypeError('Spreadsheet input must be a Buffer or Uint8Array');
}

function inferCell(value, descriptor = {}) {
  const formula = descriptor.formula == null ? null : String(descriptor.formula).replace(/^=/, '');
  const cell = {};
  if (descriptor.numberFormat != null) cell.z = String(descriptor.numberFormat);
  if (descriptor.style != null) throw new Error('SheetJS CE does not reliably write arbitrary style objects; omit style');
  if (formula != null) cell.f = formula;
  const hasCached = descriptor.cachedValue !== undefined;
  const actual = hasCached ? descriptor.cachedValue : value;
  if (formula != null && descriptor.requireCachedFormula && (!hasCached || actual === null || actual === undefined)) {
    throw new Error(`Formula ${JSON.stringify(formula)} requires an explicit trusted cachedValue`);
  }
  if (actual instanceof Date) {
    if (Number.isNaN(actual.getTime())) throw new TypeError('Spreadsheet dates must be valid Date values');
    cell.t = 'd'; cell.v = new Date(actual.getTime());
  } else if (actual === null || actual === undefined) {
    if (formula == null) cell.t = 'z';
  } else if (typeof actual === 'boolean') { cell.t = 'b'; cell.v = actual; }
  else if (typeof actual === 'number') { if (!Number.isFinite(actual)) throw new TypeError('Spreadsheet numbers must be finite'); cell.t = 'n'; cell.v = actual; }
  else if (typeof actual === 'string') { cell.t = 's'; cell.v = actual; }
  else throw new TypeError(`Unsupported spreadsheet cell value: ${typeof actual}`);
  if (descriptor.type) {
    const type = String(descriptor.type);
    if (!['b', 'd', 'e', 'n', 's', 'z'].includes(type)) throw new TypeError(`Unsupported spreadsheet cell type: ${type}`);
    if (cell.v !== undefined && type !== cell.t && !(type === 'e' && cell.t === 's')) {
      throw new TypeError(`Spreadsheet cell type ${type} does not match value type ${cell.t}`);
    }
    cell.t = type;
  }
  return cell;
}

function normalizeInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) && ('value' in value || 'formula' in value || 'cachedValue' in value || 'type' in value || 'style' in value || 'numberFormat' in value)) {
    return inferCell(value.value, { ...value, requireCachedFormula: value.formula != null });
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

function assertWorkbookShape(workbook) {
  if (workbook.SheetNames.length > MAX_SHEETS) throw new RangeError(`Workbook contains too many worksheets (limit ${MAX_SHEETS})`);
  let cells = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    cells += Object.keys(sheet).filter((key) => !key.startsWith('!')).length;
    if (cells > MAX_CELLS) throw new RangeError(`Workbook contains too many populated cells (limit ${MAX_CELLS})`);
  }
  return workbook;
}

function parseWorkbook(bytes, options = {}) {
  try {
    const input = asBuffer(bytes);
    assertSafeOOXML(input);
    return assertWorkbookShape(XLSX.read(input, { ...DEFAULT_READ_OPTIONS, ...options }));
  }
  catch (error) { throw new Error(`Unable to read spreadsheet: ${error.message}`); }
}

function writeWorkbook(workbook, options = {}) {
  if (!workbook || !Array.isArray(workbook.SheetNames)) throw new TypeError('workbook must be a SheetJS workbook');
  if (workbook.vbaraw || (workbook.Workbook && workbook.Workbook.vbaraw)) throw new Error('Refusing workbook VBA payload');
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name] || {};
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!') || !cell || cell.f == null) continue;
      if (!isTrustedCachedValue(cell)) {
        throw new Error(`Formula ${name}!${address} requires a non-null, type-consistent trusted cachedValue before write`);
      }
    }
  }
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

function normalizeFormula(formula) {
  return formula == null ? null : String(formula).replace(/^=/, '');
}

function isTrustedCachedValue(cell) {
  if (!cell || !Object.prototype.hasOwnProperty.call(cell, 'v') || cell.v === null || cell.v === undefined) return false;
  if (cell.t === 'n') return typeof cell.v === 'number' && Number.isFinite(cell.v);
  if (cell.t === 'd') return cell.v instanceof Date && !Number.isNaN(cell.v.getTime());
  if (cell.t === 'b') return typeof cell.v === 'boolean';
  if (cell.t === 's') return typeof cell.v === 'string';
  // SheetJS CE can drop error-formula caches on write/reopen; reject them rather than claim durability.
  if (cell.t === 'e') return false;
  return false;
}

function updateCells(bytes, updates, { readOptions = {} } = {}) {
  if (!Array.isArray(updates) || updates.length === 0) throw new TypeError('updates must be a non-empty array');
  const source = asBuffer(bytes);
  const sourceHash = sha256(source);
  const wb = parseWorkbook(source, readOptions);
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
      if (hasFormula && update.formula !== null && (update.cachedValue === undefined || update.cachedValue === null)) {
        throw new Error('Changed or new formulas require an explicit trusted cachedValue');
      }
      next = inferCell(update.value !== undefined ? update.value : undefined, {
        formula: hasFormula ? update.formula : null,
        cachedValue: update.cachedValue,
        type: update.type,
        numberFormat: update.numberFormat !== undefined ? update.numberFormat : previous.z,
        requireCachedFormula: hasFormula && update.formula !== null,
      });
    } else if (hasFormula) {
      // Preserve a cache only when the formula is unchanged. A changed formula
      // must not carry a stale result; Excel/LibreOffice can recalculate it.
      const formula = normalizeFormula(update.formula);
      const sameFormulaWithCache = formula !== null && formula === normalizeFormula(previous.f)
        && isTrustedCachedValue(previous);
      if (formula !== null && !sameFormulaWithCache && (update.cachedValue === undefined || update.cachedValue === null)) {
        throw new Error('Changed or uncached formulas require an explicit trusted cachedValue');
      }
      next = inferCell(undefined, {
        formula,
        cachedValue: update.cachedValue !== undefined ? update.cachedValue : (sameFormulaWithCache ? previous.v : undefined),
        type: update.cachedValue !== undefined ? update.type : (sameFormulaWithCache ? previous.t : update.type),
        requireCachedFormula: formula !== null,
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
  const output = writeWorkbook(wb);
  if (sha256(source) !== sourceHash) throw new Error('Input workbook was mutated during update');
  return output;
}

function csvSafeString(value) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  return typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
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
  XLSX_MIME, CSV_MIME, MAX_INPUT_BYTES, MAX_SHEETS, MAX_CELLS, sha256, assertSafeOOXML, createWorkbook, parseWorkbook, writeWorkbook,
  readRows, readWorkbook, updateCells, safeCsv, inferCell, normalizeAddress,
};
