# ADF DOCX usage

Run the following as one `sys_code` call. ADF transforms ESM imports for the sandbox; keep these imports at the top of the `sys_code` call.

```js
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const assertSafeDocxPackage = async (zip) => {
  const names = Object.keys(zip.files).map((name) => name.replaceAll("\\", "/"));
  if (names.some((name) => /(?:^|\/)vbaProject[^/]*(?:\/|$)|(?:^|\/)activeX(?:\/|$)|^word\/embeddings(?:\/|$)/i.test(name))) throw new Error("Refusing macro/VBA/ActiveX/embedded DOCX content");
  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes) throw new Error("DOCX missing [Content_Types].xml");
  const content = await contentTypes.async("string");
  if (/(?:macroEnabled|vbaProject|activeX)/i.test(content)) throw new Error("Refusing macro-enabled/VBA/ActiveX DOCX content");
};
const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const validXml10 = (value) => [...String(value)].every((ch) => {
  const n = ch.codePointAt(0);
  return n === 0x9 || n === 0xA || n === 0xD || (n >= 0x20 && n <= 0xD7FF) || (n >= 0xE000 && n <= 0xFFFD) || (n >= 0x10000 && n <= 0x10FFFF);
});
const decodeXml = (value) => {
  let out = "";
  let at = 0;
  while (at < value.length) {
    const amp = value.indexOf("&", at);
    if (amp < 0) { out += value.slice(at); break; }
    out += value.slice(at, amp);
    const semi = value.indexOf(";", amp + 1);
    if (semi < 0) throw new Error("Malformed XML entity in w:t");
    const entity = value.slice(amp, semi + 1);
    let decoded;
    if (entity === "&amp;") decoded = "&";
    else if (entity === "&lt;") decoded = "<";
    else if (entity === "&gt;") decoded = ">";
    else if (entity === "&quot;") decoded = "\"";
    else if (entity === "&apos;") decoded = "'";
    else if (/^&#[0-9]+;$/.test(entity)) decoded = String.fromCodePoint(Number(entity.slice(2, -1)));
    else if (/^&#x[0-9a-f]+;$/i.test(entity)) decoded = String.fromCodePoint(parseInt(entity.slice(3, -1), 16));
    else throw new Error(`Unsupported XML entity in w:t: ${entity}`);
    out += decoded;
    at = semi + 1;
  }
  if (!validXml10(out)) throw new Error("Decoded w:t contains invalid XML 1.0 text");
  return out;
};
const patchTextNodes = (xml, replacements) => {
  const entries = Object.entries(replacements).map(([key, value]) => {
    if (!key || typeof value !== "string" || !validXml10(key) || !validXml10(value) || key.includes("<") || key.includes(">")) throw new Error("Invalid placeholder/replacement");
    return { key, value, count: 0 };
  });
  for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
    if (entries[i].key.includes(entries[j].key) || entries[j].key.includes(entries[i].key)) throw new Error("Overlapping placeholders");
  }
  const rewritten = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t\s*>)/gi, (whole, open, inner, close) => {
    if (inner.includes("<")) throw new Error("Placeholder must be plain w:t text");
    const decoded = decodeXml(inner);
    const spans = [];
    for (const entry of entries) {
      let at = 0;
      while ((at = decoded.indexOf(entry.key, at)) >= 0) {
        spans.push({ start: at, end: at + entry.key.length, entry });
        at += entry.key.length;
      }
    }
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i += 1) if (spans[i].start < spans[i - 1].end) throw new Error("Overlapping placeholder matches");
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += escapeXml(decoded.slice(cursor, span.start));
      out += escapeXml(span.entry.value);
      span.entry.count += 1;
      cursor = span.end;
    }
    return spans.length ? `${open}${out}${escapeXml(decoded.slice(cursor))}${close}` : whole;
  });
  for (const entry of entries) if (entry.count !== 1) throw new Error(`Expected one ${entry.key}, found ${entry.count}`);
  return rewritten;
};

const sourceDoc = new Document({ sections: [{ children: [
  new Paragraph({ text: "Invoice", heading: HeadingLevel.TITLE }),
  new Paragraph({ children: [new TextRun("Customer: {{A}} & {{B}} {{C}}") ] }),
  new Paragraph({ children: [new TextRun("Total: $42.00") ] }),
]}] });
const original = Buffer.from(await Packer.toBuffer(sourceDoc));
const originalZip = await JSZip.loadAsync(original);
await assertSafeDocxPackage(originalZip);
let documentXml = await originalZip.file("word/document.xml").async("string");
documentXml = patchTextNodes(documentXml, { "{{A}}": "{{C}}", "{{B}}": "&", "{{C}}": "done" });
originalZip.file("word/document.xml", documentXml);
const output = await originalZip.generateAsync({ type: "nodebuffer" });
await adf.fs_write({ mode: "write", path: "out/invoice-filled.docx", content: output.toString("base64"), encoding: "base64", mime_type: mime });
const check = await adf.fs_read({ path: "out/invoice-filled.docx" });
const checkZip = await JSZip.loadAsync(Buffer.from(check.content, "base64"));
await assertSafeDocxPackage(checkZip);
const checkXml = await checkZip.file("word/document.xml").async("string");
if (checkXml.includes("{{A}}") || checkXml.includes("{{B}}") || !checkXml.includes("{{C}} &amp; &amp; done")) throw new Error("DOCX verification failed");
({ path: "out/invoice-filled.docx", bytes: output.length, verified: true });
```

The example creates a new DOCX, decodes each original `w:t` node, plans all non-overlapping matches before replacing, escapes once, and does not re-scan replacement-created tokens. It exercises an existing `&amp;`, a replacement containing bare `&`, and a token-collision value. It writes a distinct VFS path and reopens/verifies the output. For an existing template, replace `original` with `Buffer.from((await adf.fs_read({path: "imports/template.docx"})).content, "base64")`; keep the original path unchanged. The patch intentionally does not handle placeholders split across runs, layout, fields, relationships, tracked changes, macros, or arbitrary Word import. The helper rejects macro-enabled/VBA/ActiveX/executable OOXML packages before writing.
