'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  DOCX_MIME, createDocx, patchDocxXml, readDocxText, zipEntryText,
} = require('../scripts/docx-tools.cjs');

test('create, targeted patch, reopen and verify DOCX', async () => {
  const original = await createDocx({
    title: 'Invoice', paragraphs: ['Customer: {{NAME}}', 'Total: {{TOTAL}}'],
  });
  const before = crypto.createHash('sha256').update(original).digest('hex');
  const updated = await patchDocxXml(original, { '{{NAME}}': 'Ada & Co.', '{{TOTAL}}': '$42.00' });
  assert.notEqual(crypto.createHash('sha256').update(updated).digest('hex'), before);
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), before, 'source must stay unchanged');
  const text = await readDocxText(updated);
  assert.match(text, /Ada & Co\./);
  assert.match(text, /\$42\.00/);
  const xml = await zipEntryText(updated, 'word/document.xml');
  assert.doesNotMatch(xml, /\{\{NAME\}\}/);
  assert.match(xml, /Ada &amp; Co\./);
  assert.equal(DOCX_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('rejects missing or ambiguous placeholders and malformed input', async () => {
  const one = await createDocx({ paragraphs: ['{{ONLY_ONCE}}'] });
  await assert.rejects(() => patchDocxXml(one, { '{{MISSING}}': 'x' }), /Expected 1 occurrence/);
  const duplicate = await createDocx({ paragraphs: ['{{DUP}}', '{{DUP}}'] });
  await assert.rejects(() => patchDocxXml(duplicate, { '{{DUP}}': 'x' }), /Expected 1 occurrence/);
  await assert.rejects(() => patchDocxXml(Buffer.from('not a zip'), { x: 'y' }), /Invalid DOCX\/ZIP/);
  await assert.rejects(() => zipEntryText(one, '../word/document.xml'), /unsafe or unsupported/);
  await assert.rejects(() => patchDocxXml(one, { '{{ONLY_ONCE}}': 'bad\u0001text' }), /valid XML 1.0/);
  const zip = await require('jszip').loadAsync(one);
  zip.file('word/document.xml', '<w:document data="{{ATTR}}"><w:body><w:p><w:r><w:t>{{SPLIT</w:t></w:r><w:r><w:t>_RUN}}</w:t></w:r></w:p></w:body></w:document>');
  const unsafe = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => patchDocxXml(unsafe, { '{{ATTR}}': 'x' }), /Expected 1 occurrence/);
  await assert.rejects(() => patchDocxXml(unsafe, { '{{SPLIT_RUN}}': 'x' }), /Expected 1 occurrence/);
});
