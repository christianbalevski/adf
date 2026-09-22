---
name: pdf-documents
description: Create, read, modify, and validate PDF documents in ADF using pdf-lib with conditional MuPDF inspection/rendering; use for PDF workflows with explicit binary I/O, safety caps, and caveats.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code]
---

# PDF documents in ADF

Use this skill to create a PDF, inspect or extract an existing PDF, apply an ordinary edit, or produce a visual preview. Work in `sys_code` so binary files stay bytes; direct chat `fs_read` results for binary content may omit base64.

## Non-negotiable workflow

1. **Preflight.** Confirm `fs_read`, `fs_write`, and `sys_code` are enabled. Use `pdf-lib` for create/modify/reopen/page-count workflows. MuPDF inspection/rendering is conditional: if its ESM/WASM loader fails, stop extraction/rendering and report the loader error. Do not enable tools or authorization from the skill.
2. **Preserve first.** Treat the source path as read-only. Read it, keep the original unchanged, and choose a different explicit output path such as `output/updated-report.pdf`. Never overwrite the source unless explicitly requested and normal protection allows it.
3. **Read bytes deliberately.** In code, `const file = await adf.fs_read({ path: 'input/report.pdf' })`; decode `file.content` with `Buffer.from(file.content, 'base64')`. Refuse missing, empty, malformed-base64, or oversized payloads rather than guessing.
4. **Choose the right tool.** Use `pdf-lib` for new PDFs and ordinary page/text/image edits. Use MuPDF for text-layer extraction and raster previews only when the runtime loader works. Do not claim either library is a general PDF/A, redaction, OCR, signature, or encryption solution.
5. **Respect caps.** Helpers reject empty input, PDFs over 100 MB, documents over 1,000 pages, generated documents over 100 lines, extracted text over 1,000,000 characters, and rendered pages over 25,000,000 pixels (scale max 4). These are safety bounds, not format guarantees.
6. **Write explicitly.** Use `adf.fs_write({ mode: 'write', path: outputPath, content: base64, encoding: 'base64', mime_type: 'application/pdf' })`. Never write a base64 string without `encoding: 'base64'`.
7. **Reopen and validate.** Re-read the actual saved VFS output, load it with `pdf-lib`, and check page count/expected edit. If MuPDF is available, also extract text and render a representative page. Inspect actual PNG bytes or a native multimodal preview before saying visual validation passed; metadata alone is not visual evidence.
8. **Report honestly.** Give output path, original-preservation status, checks, caps, and unavailable validation (OCR, viewer, signatures, encryption, accessibility, PDF/A). Do not call a successful byte write “visually validated.” Deliver artifacts with `[PDF](adf-file://output/updated-report.pdf)`.

## Runnable `sys_code` examples

The repository helpers are `scripts/pdf-workflow.mjs` (pdf-lib core) and `scripts/pdf-inspect-render.mjs` (conditional MuPDF). In ADF, copy the relevant functions into `lib/` or paste them into `sys_code`; package import transforms support the documented imports.

### Create a PDF and write it to a new VFS path

```javascript
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
const outputPath = 'output/hello.pdf'
const pdf = await PDFDocument.create()
pdf.setTitle('ADF example')
const page = pdf.addPage([612, 792])
const font = await pdf.embedFont(StandardFonts.Helvetica)
page.drawText('Hello from ADF', { x: 72, y: 720, size: 18, font, color: rgb(0.1, 0.1, 0.1) })
const bytes = await pdf.save()
if (!bytes.length) throw new Error('PDF save returned empty bytes')
await adf.fs_write({ mode: 'write', path: outputPath, content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mime_type: 'application/pdf' })
const saved = await adf.fs_read({ path: outputPath })
const reopened = await PDFDocument.load(Buffer.from(saved.content, 'base64'))
if (reopened.getPageCount() !== 1) throw new Error('Saved PDF did not reopen with one page')
console.log({ outputPath, pages: reopened.getPageCount() })
// Deliver: [PDF](adf-file://output/hello.pdf)
```

### Read, modify, preserve, and reopen an existing PDF

```javascript
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
const inputPath = 'input/source.pdf'
const outputPath = 'output/source-updated.pdf'
const source = await adf.fs_read({ path: inputPath })
if (!source.content) throw new Error('Expected a non-empty PDF payload')
const inputBytes = Buffer.from(source.content, 'base64')
const pdf = await PDFDocument.load(inputBytes)
const pages = pdf.getPages()
if (!pages[0] || pages.length > 1000) throw new Error('PDF page safety check failed')
const font = await pdf.embedFont(StandardFonts.Helvetica)
pages[0].drawText('Reviewed', { x: 72, y: 72, size: 12, font, color: rgb(0.8, 0.1, 0.1) })
const outputBytes = await pdf.save()
if (!outputBytes.length || outputBytes.length > 100 * 1024 * 1024) throw new Error('Output size safety check failed')
await adf.fs_write({ mode: 'write', path: outputPath, content: Buffer.from(outputBytes).toString('base64'), encoding: 'base64', mime_type: 'application/pdf' })
const saved = await adf.fs_read({ path: outputPath })
const savedDoc = await PDFDocument.load(Buffer.from(saved.content, 'base64'))
if (savedDoc.getPageCount() !== pages.length) throw new Error('Saved page count changed unexpectedly')
console.log({ inputPath, outputPath, pageCount: savedDoc.getPageCount(), savedBytes: saved.size })
```

### Conditional MuPDF extraction/rendering

```javascript
let mupdf
try {
  mupdf = await __require('mupdf')
} catch (error) {
  throw new Error(`MuPDF extraction/rendering unavailable in this runtime: ${error.message}`)
}
const file = await adf.fs_read({ path: 'output/hello.pdf' })
const bytes = Buffer.from(file.content, 'base64')
const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
if (doc.countPages() > 1000) throw new Error('PDF page safety cap exceeded')
const page = doc.loadPage(0)
const extracted = page.toStructuredText().asText()
const bounds = page.getBounds()
const scale = 1.5
if ((bounds[2] - bounds[0]) * scale * (bounds[3] - bounds[1]) * scale > 25_000_000) throw new Error('Render pixel cap exceeded')
const png = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false).asPNG()
await adf.fs_write({ mode: 'write', path: 'output/hello-page-1-preview.png', content: Buffer.from(png).toString('base64'), encoding: 'base64', mime_type: 'image/png' })
console.log({ pageCount: doc.countPages(), extracted, previewPath: 'output/hello-page-1-preview.png' })
// Deliver: [PDF preview](adf-file://output/hello-page-1-preview.png)
```

## Extraction, OCR, overlays, and redaction

- Text extraction is only extraction of the PDF's text layer. If extraction is empty/incomplete, the page may be scanned, outlined, encrypted, or unsupported; do not infer that it is blank.
- MuPDF extraction/rendering is conditional on the runtime loader. In the tested Windows sandbox, its ESM/WASM import hit a path-URL/dynamic-import-callback failure; do not claim these checks passed there. See `references/limitations.md`.
- Standard PDF fonts such as Helvetica use WinAnsi in `pdf-lib`; characters such as `✓` can fail with `WinAnsi cannot encode`. Embed a suitable Unicode font when available and permitted.
- OCR is separate. Do not invent OCR or enable a provider/package automatically.
- A highlight, annotation, white rectangle, crop, or drawn overlay **does not redact** underlying text/images. Use a dedicated redaction workflow, preserve the original, then reopen and check removed content is not extractable/rendered.
- `pdf-lib` rewrites can affect incremental updates and unsupported features. Do not promise preservation of signatures, JavaScript, complex forms, encryption, PDF/A, accessibility tags, or vendor behavior.

## Tests and evidence

With packages installed in an isolated checkout:

```sh
cd skills/pdf-documents
node --test tests/*.mjs
```

Tests cover pdf-lib create/update/reopen, MuPDF extraction/render, VFS base64, empty/unsupported input, caps, missing pages, and WinAnsi/Unicode failure. Isolated Node evidence is not a sandbox MuPDF claim. In the current ADF runtime the actual sandbox `pdf-lib` VFS roundtrip succeeded; MuPDF loader failed as documented, so extraction/rendering remain explicitly unsupported there.

See `references/limitations.md`, `scripts/pdf-workflow.mjs`, and `scripts/pdf-inspect-render.mjs`.
