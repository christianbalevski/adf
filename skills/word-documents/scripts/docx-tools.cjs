'use strict';

const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx');
const JSZip = require('jszip');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_PARTS = ['word/document.xml'];
const SAFE_PART = /^word\/(?:document|header\d+|footer\d+)\.xml$/;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_XML_PART_BYTES = 20 * 1024 * 1024;

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) {
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RangeError(`DOCX input exceeds ${MAX_INPUT_BYTES} byte limit`);
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RangeError(`DOCX input exceeds ${MAX_INPUT_BYTES} byte limit`);
    return Buffer.from(bytes);
  }
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
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const amp = value.indexOf('&', cursor);
    if (amp === -1) { output += value.slice(cursor); break; }
    output += value.slice(cursor, amp);
    const semi = value.indexOf(';', amp + 1);
    if (semi === -1) throw new Error('Malformed XML entity in w:t text');
    const entity = value.slice(amp, semi + 1);
    let decoded;
    if (entity === '&amp;') decoded = '&';
    else if (entity === '&lt;') decoded = '<';
    else if (entity === '&gt;') decoded = '>';
    else if (entity === '&quot;') decoded = '"';
    else if (entity === '&apos;') decoded = "'";
    else if (/^&#[0-9]+;$/.test(entity)) decoded = String.fromCodePoint(Number(entity.slice(2, -1)));
    else if (/^&#x[0-9a-f]+;$/i.test(entity)) decoded = String.fromCodePoint(parseInt(entity.slice(3, -1), 16));
    else throw new Error(`Unsupported XML entity in w:t text: ${entity}`);
    output += decoded;
    cursor = semi + 1;
  }
  if (!isXml10Text(output)) throw new Error('Decoded w:t text contains invalid XML 1.0 characters');
  return output;
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

async function assertSafeDocxPackage(zip) {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new RangeError(`DOCX contains too many ZIP entries (limit ${MAX_ENTRIES})`);
  let expanded = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const size = entry._data && Number(entry._data.uncompressedSize);
    if (Number.isFinite(size)) expanded += size;
    const name = entry.name.replaceAll('\\', '/');
    if (/(?:^|\/)vbaProject[^/]*(?:\/|$)/i.test(name)
      || /(?:^|\/)activeX(?:\/|$)/i.test(name)
      || /^word\/embeddings\//i.test(name)) {
      throw new Error(`Refusing macro/ActiveX/executable DOCX entry: ${name}`);
    }
  }
  if (expanded > MAX_EXPANDED_BYTES) throw new RangeError(`DOCX expanded ZIP content exceeds ${MAX_EXPANDED_BYTES} byte limit`);
  const contentTypes = zip.file('[Content_Types].xml');
  if (!contentTypes) throw new Error('DOCX is missing [Content_Types].xml');
  const xml = await contentTypes.async('string');
  if (/macroEnabled|vbaProject|activeX/i.test(xml)) throw new Error('Refusing macro-enabled, VBA, or ActiveX OOXML content');
}

async function loadZip(bytes) {
  try {
    const zip = await JSZip.loadAsync(asBuffer(bytes));
    await assertSafeDocxPackage(zip);
    return zip;
  }
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
  const objectForm = replacement && typeof replacement === 'object' && !Buffer.isBuffer(replacement);
  const value = objectForm ? replacement.value : replacement;
  const expected = objectForm && replacement.expected !== undefined ? replacement.expected : 1;
  if (typeof value !== 'string') throw new TypeError(`DOCX replacement for ${JSON.stringify(key)} must provide a string value`);
  if (!Number.isInteger(expected) || expected < 1) throw new TypeError(`DOCX expected count for ${JSON.stringify(key)} must be a positive integer`);
  if (objectForm && Object.keys(replacement).some((keyName) => !['value', 'expected'].includes(keyName))) {
    throw new TypeError('DOCX replacement objects support only value and expected; raw XML is not accepted');
  }
  return { key, value, expected };
}

function invalidXml10Control(value) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value);
}

/**
 * Patch exact placeholders only inside a single w:t text node. XML markup and
 * placeholders split across runs are intentionally not eligible. Matching is
 * performed on decoded original text and all parts are validated before writes.
 */
async function patchDocxXml(bytes, replacements, { parts = DEFAULT_PARTS } = {}) {
  const zip = await loadZip(bytes);
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
    throw new TypeError('replacements must be an object keyed by exact placeholder text');
  }
  const normalized = Object.entries(replacements).map(([key, replacement]) => {
    const item = normalizeReplacement(key, replacement);
    if (!key || key.includes('<') || key.includes('>') || !isXml10Text(key) || !isXml10Text(item.value)) {
      throw new Error('DOCX placeholder and replacement must be valid XML 1.0 text without markup');
    }
    return item;
  });
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (normalized[i].key.includes(normalized[j].key) || normalized[j].key.includes(normalized[i].key)) {
        throw new Error(`DOCX placeholders overlap: ${JSON.stringify(normalized[i].key)} and ${JSON.stringify(normalized[j].key)}`);
      }
    }
  }
  const selectedParts = [...new Set(parts)];
  selectedParts.forEach(validatePart);
  const partUpdates = [];
  const totalCounts = new Map(normalized.map((item) => [item.key, 0]));
  for (const part of selectedParts) {
    const entry = zip.file(part);
    if (!entry) throw new Error(`DOCX part not found: ${part}`);
    const xml = await entry.async('string');
    if (xml.length > MAX_XML_PART_BYTES) throw new RangeError(`DOCX XML part exceeds ${MAX_XML_PART_BYTES} byte limit: ${part}`);
    if (invalidXml10Control(xml)) throw new Error(`DOCX part contains invalid XML 1.0 control characters: ${part}`);
    const rewritten = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t\s*>)/gi, (whole, open, inner, close) => {
      if (inner.includes('<')) throw new Error(`DOCX placeholder is not in plain w:t text: ${part}`);
      const decoded = decodeXml(inner);
      const spans = [];
      for (const item of normalized) {
        let at = 0;
        while ((at = decoded.indexOf(item.key, at)) !== -1) {
          spans.push({ start: at, end: at + item.key.length, item });
          at += item.key.length;
        }
      }
      spans.sort((left, right) => left.start - right.start || left.end - right.end);
      for (let i = 1; i < spans.length; i += 1) {
        if (spans[i].start < spans[i - 1].end) throw new Error(`DOCX placeholder matches overlap in ${part}`);
      }
      if (spans.length === 0) return whole;
      let output = '';
      let cursor = 0;
      for (const span of spans) {
        output += escapeXml(decoded.slice(cursor, span.start));
        output += escapeXml(span.item.value);
        totalCounts.set(span.item.key, totalCounts.get(span.item.key) + 1);
        cursor = span.end;
      }
      output += escapeXml(decoded.slice(cursor));
      return `${open}${output}${close}`;
    });
    partUpdates.push({ part, xml: rewritten });
  }
  for (const item of normalized) {
    const count = totalCounts.get(item.key);
    if (count !== item.expected) throw new Error(`Expected ${item.expected} occurrence(s) of ${JSON.stringify(item.key)} across selected DOCX parts; found ${count}`);
  }
  if (normalized.length === 0) throw new Error('No DOCX replacements were supplied');
  if ([...totalCounts.values()].every((count) => count === 0)) throw new Error('No DOCX replacements were applied');
  for (const update of partUpdates) zip.file(update.part, update.xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Extract text runs for verification; no layout, style, field, or rendering fidelity is implied. */
async function readDocxText(bytes, { parts = DEFAULT_PARTS } = {}) {
  const selectedParts = [...new Set(parts)];
  selectedParts.forEach(validatePart);
  const chunks = [];
  for (const part of selectedParts) {
    const xml = await zipEntryText(bytes, part);
    if (xml.length > MAX_XML_PART_BYTES) throw new RangeError(`DOCX XML part exceeds ${MAX_XML_PART_BYTES} byte limit: ${part}`);
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
