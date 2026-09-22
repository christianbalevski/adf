'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const crypto = require('node:crypto');
const {
  XLSX_MIME, MAX_INPUT_BYTES, createWorkbook, writeWorkbook, parseWorkbook, readRows, readWorkbook, updateCells, safeCsv,
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
  assert.equal(detail.sheets.Data.cells.C2.numberFormat, '0.00');
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('formula-only updates preserve matching cache and clear stale cache on changed formula', async () => {
  const source = writeWorkbook(createWorkbook({ sheets: [{ name: 'Calc', rows: [[1, 2, { formula: 'A1+B1', cachedValue: 3 }]] }] }));
  const same = updateCells(source, [{ sheet: 'Calc', address: 'C1', formula: '=A1+B1' }]);
  assert.equal(parseWorkbook(same).Sheets.Calc.C1.v, 3);
  const changed = updateCells(source, [{ sheet: 'Calc', address: 'C1', formula: 'A1-B1', cachedValue: 1 }]);
  const changedWb = parseWorkbook(changed);
  assert.equal(changedWb.Sheets.Calc.C1.f, 'A1-B1');
  const zip = await JSZip.loadAsync(changed);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheetXml, /<c r="C1"><f>A1-B1<\/f><v>1<\/v><\/c>/);
  assert.match(sheetXml, /<c r="C1"><f>A1-B1<\/f><v>1<\/v><\/c>/);
});

test('rejects no-cache formulas and explicit type/value mismatches', () => {
  assert.throws(() => createWorkbook({ sheets: [{ name: 'Calc', rows: [[{ formula: '1+1' }]] }] }), /requires an explicit trusted cachedValue/);
  const source = writeWorkbook(createWorkbook({ sheets: [{ name: 'Calc', rows: [[1, 2, { formula: 'A1+B1', cachedValue: 3 }]] }] }));
  assert.throws(() => updateCells(source, [{ sheet: 'Calc', address: 'C1', formula: 'A1-B1' }]), /require an explicit trusted cachedValue/);
  assert.throws(() => createWorkbook({ sheets: [{ name: 'Types', rows: [[{ value: '5', type: 'n' }]] }] }), /does not match value type/);
  assert.throws(() => createWorkbook({ sheets: [{ name: 'Types', rows: [[{ value: 5, type: 's' }]] }] }), /does not match value type/);
  assert.throws(() => createWorkbook({ sheets: [{ name: 'Types', rows: [[{ value: true, type: 'n' }]] }] }), /does not match value type/);
  assert.throws(() => writeWorkbook({ SheetNames: ['Calc'], Sheets: { Calc: { '!ref': 'A1', A1: { f: '1+1' } } } }), /trusted cachedValue/);
  for (const cell of [{ t: 'n', f: 'A1*2', v: undefined }, { t: 'n', f: 'A1*2', v: null }, { t: 's', f: 'A1*2', v: 3 }, { t: 'e', f: 'A1*2', v: '#DIV/0!' }]) {
    assert.throws(() => writeWorkbook({ SheetNames: ['Calc'], Sheets: { Calc: { '!ref': 'A1', A1: cell } } }), /non-null, type-consistent/);
  }
});

test('rejects oversized input before parser allocation', () => {
  assert.throws(() => parseWorkbook(Buffer.alloc(MAX_INPUT_BYTES + 1)), /exceeds/);
});

test('safe CSV prefixes dangerous strings', () => {
  const wb = createWorkbook({ sheets: [{ name: 'Export', rows: [['value'], ['=1+1'], ['-danger'], [-5], ['normal, text'], ['  =spaced'], ['\uFEFF=@bom'], ['\v=vertical']] }] });
  const csv = safeCsv(writeWorkbook(wb), 'Export');
  assert.match(csv, /'=?1\+1/);
  assert.match(csv, /'-danger/);
  assert.match(csv, /\r\n-5\r\n/);
  assert.match(csv, /"normal, text"/);
  assert.match(csv, /'  =spaced/);
  assert.match(csv, /'\uFEFF=@bom/);
  assert.match(csv, /'\v=vertical/);
});

test('rejects invalid input and targeted update failures', async () => {
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
  assert.throws(() => createWorkbook({ sheets: [{ name: 'Dates', rows: [[new Date('invalid')]] }] }), /dates must be valid/);
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');
  updateCells(bytes, [{ sheet: 'Data', address: 'A1', value: 2 }]);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sourceHash, 'update must not mutate input bytes');
  for (const name of ['xl/vbaProjectSignature.bin', 'custom/vbaProject.bin', 'xl/../vbaProject.bin']) {
    const activeZip = await JSZip.loadAsync(bytes);
    activeZip.file(name, Buffer.from('synthetic'));
    const activeBytes = await activeZip.generateAsync({ type: 'nodebuffer' });
    assert.throws(() => parseWorkbook(activeBytes), /active-content|VBA|macro|traversal/i);
  }
  const defaultTypeZip = await JSZip.loadAsync(bytes);
  const defaultTypes = await defaultTypeZip.file('[Content_Types].xml').async('string');
  defaultTypeZip.file('[Content_Types].xml', defaultTypes.replace('</Types>', '<Default Extension=\"bin\" ContentType=\"application/vnd.ms-office.vbaProject\"/></Types>'));
  const defaultTypeBytes = await defaultTypeZip.generateAsync({ type: 'nodebuffer' });
  assert.throws(() => parseWorkbook(defaultTypeBytes), /active-content|VBA|macro/i);
  const prefixedZip = await JSZip.loadAsync(bytes);
  const prefixedTypes = await prefixedZip.file('[Content_Types].xml').async('string');
  const prefixedXml = prefixedTypes.replace('<Types ', '<ct:Types ').replace('</Types>', '</ct:Types>').replace(/<Default /g, '<ct:Default ').replace(/<Override /g, '<ct:Override ').replace('xmlns="http://schemas.openxmlformats.org/package/2006/content-types"', 'xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"').replace('application/vnd.ms-excel.sheet.binary.macroEnabled.main', 'application/vnd.ms-office.vbaProject');
  prefixedZip.file('[Content_Types].xml', prefixedXml);
  const prefixedBytes = await prefixedZip.generateAsync({ type: 'nodebuffer' });
  assert.throws(() => parseWorkbook(prefixedBytes), /active-content|VBA|macro/i);
  const malformedZip = await JSZip.loadAsync(bytes);
  malformedZip.file('[Content_Types].xml', prefixedTypes.replace('<Types ', '<Types xmlns="x" '));
  const malformedBytes = await malformedZip.generateAsync({ type: 'nodebuffer' });
  assert.throws(() => parseWorkbook(malformedBytes), /Unable to read spreadsheet|Malformed|mismatched|attribute/i);
  const relZip = await JSZip.loadAsync(bytes);
  relZip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Target="../vbaProject.bin" Type="urn:vbaProject"/></Relationships>');
  const relBytes = await relZip.generateAsync({ type: 'nodebuffer' });
  assert.throws(() => parseWorkbook(relBytes), /active-content|relationship|VBA/i);
  assert.throws(() => safeCsv(bytes, 'Missing'), /Worksheet not found/);
});

 test('rejects genuinely invalid UTF-8 in content types', async () => {
  const bytes = writeWorkbook(createWorkbook({ sheets: [{ name: 'Data', rows: [['ok']] }] }));
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('[Content_Types].xml').async('string');
  const corrupt = Buffer.from(xml.replace('</Types>', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProXject"/></Types>'));
  corrupt[corrupt.indexOf(Buffer.from('vbaProXject')) + 6] = 0xff;
  zip.file('[Content_Types].xml', corrupt);
  zip.file('custom/payload.bin', Buffer.from('synthetic'));
  const malformed = await zip.generateAsync({type:'nodebuffer'});
  assert.throws(() => parseWorkbook(malformed), /UTF-8/);
});
