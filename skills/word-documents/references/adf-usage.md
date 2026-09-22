# ADF DOCX usage

Run the following as one `sys_code` call. ADF transforms ESM imports for the sandbox; keep these imports at the top of the `sys_code` call.

```js
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const validXml10 = (value) => [...String(value)].every((ch) => {
  const n = ch.codePointAt(0);
  return n === 0x9 || n === 0xA || n === 0xD || (n >= 0x20 && n <= 0xD7FF) || (n >= 0xE000 && n <= 0xFFFD) || (n >= 0x10000 && n <= 0x10FFFF);
});
const patchSingleRun = (xml, placeholder, replacement) => {
  if (!placeholder || !validXml10(placeholder) || !validXml10(replacement)) throw new Error("Invalid XML 1.0 text");
  let count = 0;
  const next = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t\s*>)/gi, (whole, open, inner, close) => {
    const hits = inner.split(placeholder).length - 1;
    count += hits;
    return hits ? `${open}${inner.split(placeholder).join(escapeXml(replacement))}${close}` : whole;
  });
  if (count !== 1) throw new Error(`Expected one placeholder in one w:t, found ${count}`);
  return next;
};

const sourceDoc = new Document({ sections: [{ children: [
  new Paragraph({ text: "Invoice", heading: HeadingLevel.TITLE }),
  new Paragraph({ children: [new TextRun("Customer: {{NAME}}") ] }),
  new Paragraph({ children: [new TextRun("Total: {{TOTAL}}") ] }),
]}] });
const original = Buffer.from(await Packer.toBuffer(sourceDoc));
const originalZip = await JSZip.loadAsync(original);
let documentXml = await originalZip.file("word/document.xml").async("string");
documentXml = patchSingleRun(documentXml, "{{NAME}}", "Ada & Co.");
documentXml = patchSingleRun(documentXml, "{{TOTAL}}", "$42.00");
originalZip.file("word/document.xml", documentXml);
const output = await originalZip.generateAsync({ type: "nodebuffer" });
await adf.fs_write({ mode: "write", path: "out/invoice-filled.docx", content: output.toString("base64"), encoding: "base64", mime_type: mime });
const check = await adf.fs_read({ path: "out/invoice-filled.docx" });
const checkZip = await JSZip.loadAsync(Buffer.from(check.content, "base64"));
const checkXml = await checkZip.file("word/document.xml").async("string");
if (checkXml.includes("{{NAME}}") || !checkXml.includes("Ada &amp; Co.")) throw new Error("DOCX verification failed");
({ path: "out/invoice-filled.docx", bytes: output.length, verified: true });
```

The example creates a new DOCX, patches only text inside one `w:t` node, writes a distinct VFS path, and reopens/verifies the output. For an existing template, replace `original` with `Buffer.from((await adf.fs_read({path: "imports/template.docx"})).content, "base64")`; keep the original path unchanged. The patch intentionally does not handle placeholders split across runs, layout, fields, relationships, tracked changes, macros, or arbitrary Word import.
