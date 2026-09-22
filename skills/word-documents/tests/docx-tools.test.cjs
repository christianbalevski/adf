'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
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
  assert.match(await readDocxText(updated), /Ada & Co\./);
  assert.equal(DOCX_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('rejects missing or ambiguous placeholders and malformed input', async () => {
  const one = await createDocx({ paragraphs: ['{{ONLY_ONCE}}'] });
  await assert.rejects(() => patchDocxXml(one, { '{{MISSING}}': 'x' }), /Expected 1 occurrence/);
  const duplicate = await createDocx({ paragraphs: ['{{DUP}}', '{{DUP}}'] });
  await assert.rejects(() => patchDocxXml(duplicate, { '{{DUP}}': 'x' }), /Expected 1 occurrence/);
  const expected = await patchDocxXml(duplicate, { '{{DUP}}': { value: 'x & < > \" \'', expected: 2 } });
  assert.match(await readDocxText(expected), /x & < > \" \'/);
  const token = await patchDocxXml(await createDocx({ paragraphs: ['{{A}}/{{B}}'] }), { '{{A}}': '{{B}}', '{{B}}': 'done' });
  assert.equal(await readDocxText(token), '{{B}}/done');
  await assert.rejects(() => patchDocxXml(one, { '{{ONLY_ONCE}}': { value: 'x', expected: 0 } }), /positive integer/);
  await assert.rejects(() => patchDocxXml(one, { '{{ONLY_ONCE}}': { value: 'x', rawXml: true, expected: 1 } }), /raw XML is not accepted/);
  await assert.rejects(() => patchDocxXml(one, { '{{ONLY_ONCE}}': 'bad\u0001text' }), /valid XML 1.0/);
  await assert.rejects(() => patchDocxXml(Buffer.from('not a zip'), { x: 'y' }), /Invalid DOCX\/ZIP/);
  await assert.rejects(() => patchDocxXml(Buffer.alloc(50 * 1024 * 1024 + 1), { x: 'y' }), /exceeds/);
  await assert.rejects(() => zipEntryText(one, '../word/document.xml'), /unsafe or unsupported/);
  const zip = await JSZip.loadAsync(one);
  zip.file('word/document.xml', '<w:document data="{{ATTR}}"><w:body><w:p><w:r><w:t>{{SPLIT</w:t></w:r><w:r><w:t>_RUN}}</w:t></w:r></w:p></w:body></w:document>');
  const unsafe = await zip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => patchDocxXml(unsafe, { '{{ATTR}}': 'x' }), /Expected 1 occurrence/);
  await assert.rejects(() => patchDocxXml(unsafe, { '{{SPLIT_RUN}}': 'x' }), /Expected 1 occurrence/);
  const headerZip = await JSZip.loadAsync(one);
  headerZip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>{{HEAD}}</w:t></w:r></w:p></w:hdr>');
  const headerDoc = await patchDocxXml(await headerZip.generateAsync({ type: 'nodebuffer' }), { '{{HEAD}}': 'header' }, { parts: ['word/document.xml', 'word/header1.xml'] });
  assert.match(await readDocxText(headerDoc, { parts: ['word/header1.xml'] }), /header/);
  const entityZip = await JSZip.loadAsync(one);
  const entityXml = await entityZip.file('word/document.xml').async('string');
  entityZip.file('word/document.xml', entityXml.replace('{{ONLY_ONCE}}', '{{A}} &amp; {{B}}'));
  const entityDoc = await patchDocxXml(await entityZip.generateAsync({ type: 'nodebuffer' }), { '{{A}}': '&', '{{B}}': 'done' });
  const entityText = await readDocxText(entityDoc);
  assert.match(entityText, /& \& done/);
  for (const name of ['word/vbaProjectSignature.bin', 'word/vbaProject.bin/data']) {
    const macroZip = await JSZip.loadAsync(one);
    macroZip.file(name, Buffer.from('synthetic'));
    const macroDoc = await macroZip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => patchDocxXml(macroDoc, { '{{ONLY_ONCE}}': 'x' }), /macro|ActiveX|executable/i);
  }
  const embeddedZip = await JSZip.loadAsync(one);
  embeddedZip.file('word/embeddings/oleObject.lnk', Buffer.from('synthetic'));
  const embeddedDoc = await embeddedZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => patchDocxXml(embeddedDoc, { '{{ONLY_ONCE}}': 'x' }), /macro|ActiveX|executable/i);
  const contentMacroZip = await JSZip.loadAsync(one);
  const contentTypes = await contentMacroZip.file('[Content_Types].xml').async('string');
  contentMacroZip.file('[Content_Types].xml', contentTypes.replace('wordprocessingml.document.main+xml', 'vnd.ms-word.document.macroEnabled.main+xml'));
  const contentMacroDoc = await contentMacroZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => patchDocxXml(contentMacroDoc, { '{{ONLY_ONCE}}': 'x' }), /macro|VBA|ActiveX/i);
  const controlZip = await JSZip.loadAsync(one);
  const originalXml = await controlZip.file('word/document.xml').async('string');
  controlZip.file('word/document.xml', originalXml.replace('{{ONLY_ONCE}}', '{{ONLY_ONCE}}\u0001'));
  const controlDoc = await controlZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => patchDocxXml(controlDoc, { '{{ONLY_ONCE}}': 'x' }), /invalid XML 1.0 control/);
});
