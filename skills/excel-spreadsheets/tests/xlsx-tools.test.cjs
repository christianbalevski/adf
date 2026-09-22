'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  XLSX_MIME, createWorkbook, writeWorkbook, parseWorkbook, readRows, readWorkbook, updateCells, safeCsv,
} = require('../scripts/xlsx-tools.cjs');

test('create, update formula/date/number-format metadata, reopen and inspect', () => {
  const created = createWorkbook({ sheets: [{
    name: 'Data', columns: [18, 12, 14], rows: [
      ['Name', 'Amount', 'Total'],
      ['Ada', 2, { formula: 'B2*2', cachedValue: 4, numberFormat: '0.00' }],
      ['When', new Date('2026-09-22T00:00:00Z'), 'ok'],
    ],
  }] });
  const original = writeWorkbook(created);
  const updated = updateCells(original, [
    { sheet: 'Data', address: 'B2', value: 3 },
    { sheet: 'Data', address: 'C2', formula: 'B2*2', cachedValue: 6 },
  ]);
  const rows = readRows(updated, 'Data');
  assert.deepEqual(rows[1].slice(0, 3), ['Ada', 3, 6]);
  assert.ok(rows[2][1] instanceof Date, 'cellDates should preserve a Date value');
  const detail = readWorkbook(updated);
  assert.equal(detail.sheets.Data.cells.C2.formula, 'B2*2');
  assert.equal(detail.sheets.Data.cells.C2.value, 6);
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('safe CSV prefixes dangerous strings', () => {
  const wb = createWorkbook({ sheets: [{ name: 'Export', rows: [['value'], ['=1+1'], ['-danger'], [-5], ['normal, text']] }] });
  const csv = safeCsv(writeWorkbook(wb), 'Export');
  assert.match(csv, /'=?1\+1/);
  assert.match(csv, /'-danger/);
  assert.match(csv, /\r\n-5\r\n/);
  assert.match(csv, /"normal, text"/);
});

test('rejects invalid input and targeted update failures', () => {
  assert.throws(() => parseWorkbook('not a Buffer'), /Spreadsheet input must be a Buffer/);
  const wb = createWorkbook({ sheets: [{ name: 'Data', rows: [['A']] }] });
  const bytes = writeWorkbook(wb);
  assert.throws(() => updateCells(bytes, [{ sheet: 'Missing', address: 'A1', value: 1 }]), /Worksheet not found/);
  assert.throws(() => updateCells(bytes, [{ sheet: 'Data', address: 'bad', value: 1 }]), /Invalid A1/);
  const lower = updateCells(bytes, [{ sheet: 'Data', address: 'b2', value: 7 }]);
  assert.equal(parseWorkbook(lower).Sheets.Data.B2.v, 7);
  assert.throws(() => updateCells(bytes, [{ sheet: 'Data', address: 'XFE1', value: 1 }]), /out of Excel bounds/);
  assert.throws(() => updateCells(bytes, [{ sheet: 'Data', address: 'A1048577', value: 1 }]), /out of Excel bounds/);
  assert.throws(() => updateCells(bytes, [{ sheet: 'Data', address: 'A1', style: { font: { bold: true } } }]), /does not reliably write arbitrary style/);
  assert.throws(() => safeCsv(bytes, 'Missing'), /Worksheet not found/);
});
