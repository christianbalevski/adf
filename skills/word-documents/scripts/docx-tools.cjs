'use strict';

const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx');
const JSZip = require('jszip');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_PARTS = ['word/document.xml'];
const SAFE_PART = /^word\/(?:document|header\d+|footer\d+)\.xml$/;

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new TypeError('DOCX input must be a Buffer or Uint8Array');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function literalCount(text, needle) {
  if (!needle) return 0;
  let count = 0; let at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) { count += 1; at += needle.length; }
  return count;
}

function validatePart(part) {
  if (typeof part !== 'string' || part.includes('..') || part.startsWith('/') || !SAFE_PART.test(part)) {
    throw new Error(`Refusing unsafe or unsupported DOCX XML part: ${part}`);
  }
}

/** Create a basic DOCX. This intentionally does not import an existing document. */
async function createDocx({ title = '', paragraphs = [] } = {}) {
  if (!Array.isArray(paragraphs)) throw new TypeError('paragraphs must be an array');
  const children = [];
  if (title) children.push(new Paragraph({ text: String(title), heading: HeadingLevel.TITLE }));
  for (const paragraph of paragraphs) {
    if (typeof paragraph === 'string') children.push(new Paragraph({ children: [new TextRun(paragraph)] }));
    else if (paragraph && typeof paragraph === 'object') {
      const runs = Array.isArray(paragraph.runs)
        ? paragraph.runs.map((run) => new TextRun({ text: String(run.text ?? ''), bold: run.bold === true, italics: run.italics === true }))
        : [new TextRun(String(paragraph.text ?? ''))];
      children.push(new Paragraph({ children: runs }));
    } else throw new TypeError('each paragraph must be a string or object');
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function loadZip(bytes) {
  try { return await JSZip.loadAsync(asBuffer(bytes)); }
  catch (error) { throw new Error(`Invalid DOCX/ZIP input: ${error.message}`); }
}

async function zipEntryText(bytesOrZip, part) {
  validatePart(part);
  const zip = bytesOrZip && typeof bytesOrZip.file === 'function' ? bytesOrZip : await loadZip(bytesOrZip);
  const entry = zip.file(part);
  if (!entry) throw new Error(`DOCX part not found: ${part}`);
  return entry.async('string');
}

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

function normalizeReplacement(key, replacement) {
  if (typeof replacement !== 'string') throw new TypeError(`DOCX replacement for ${JSON.stringify(key)} must be a string`);
  return { value: replacement, expected: 1 };
}

/**
 * Patch exact placeholders only inside a single w:t text node. XML markup and
 * placeholders split across runs are intentionally not eligible.
 */
async function patchDocxXml(bytes, replacements, { parts = DEFAULT_PARTS } = {}) {
  const zip = await loadZip(bytes);
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
    throw new TypeError('replacements must be an object keyed by exact placeholder text');
  }
  const selectedParts = [...new Set(parts)];
  selectedParts.forEach(validatePart);
  let changed = 0;
  for (const part of selectedParts) {
    const entry = zip.file(part);
    if (!entry) throw new Error(`DOCX part not found: ${part}`);
    let xml = await entry.async('string');
    for (const [needle, raw] of Object.entries(replacements)) {
      const { value, expected } = normalizeReplacement(needle, raw);
      if (!needle || !isXml10Text(needle) || !isXml10Text(value)) throw new Error('DOCX placeholder and replacement must contain valid XML 1.0 text');
      let count = 0;
      // Only the inner text captured by this expression is ever modified.
      xml = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t\s*>)/gi, (whole, open, inner, close) => {
        const occurrences = literalCount(inner, needle);
        count += occurrences;
        return occurrences ? `${open}${inner.split(needle).join(escapeXml(value))}${close}` : whole;
      });
      if (count !== expected) throw new Error(`Expected ${expected} occurrence(s) of ${JSON.stringify(needle)} in ${part}; found ${count}`);
      changed += count;
    }
    zip.file(part, xml);
  }
  if (changed === 0) throw new Error('No DOCX replacements were applied');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Extract text runs for verification; no layout, style, field, or rendering fidelity is implied. */
async function readDocxText(bytes, { parts = DEFAULT_PARTS } = {}) {
  const selectedParts = [...new Set(parts)];
  selectedParts.forEach(validatePart);
  const chunks = [];
  for (const part of selectedParts) {
    const xml = await zipEntryText(bytes, part);
    const paragraphs = xml.split(/<\/w:p\s*>/i);
    for (const paragraph of paragraphs) {
      const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t\s*>/gi)]
        .map((match) => decodeXml(match[1])).join('');
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n');
}


module.exports = {
  DOCX_MIME, DEFAULT_PARTS, escapeXml, createDocx, loadZip, zipEntryText,
  patchDocxXml, readDocxText,
};
