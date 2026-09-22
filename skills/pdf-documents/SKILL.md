---
name: pdf-documents
description: Create, read, modify, and validate PDF documents in ADF using pdf-lib and MuPDF; use for PDF workflows with explicit binary I/O and safety caveats.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code]
---

# PDF documents in ADF

Use this skill when the task is to create a PDF, inspect or extract an existing PDF, apply an ordinary edit, or produce a visual preview for validation. Work in `sys_code` so binary files stay bytes; direct chat `fs_read` results for binary content may omit the base64 payload.

## Non-negotiable workflow

1. **Preflight.** Confirm `fs_read`, `fs_write`, and `sys_code` are enabled. In `sys_code`, import only the documented standard packages (`pdf-lib`, `mupdf`) and check package errors before touching the input. Do not enable tools or authorization from the skill.
2. **Preserve first.** Treat the source path as read-only for the workflow. Read it, keep the original unchanged, and choose a different explicit output path such as `output/updated-report.pdf`. Never overwrite the source unless the principal explicitly asks and the normal file-protection rules allow it.
3. **Read bytes deliberately.** `const file = await adf.fs_read({ path: 'input/report.pdf' })`; decode `file.content` with `Buffer.from(file.content, 'base64')` in code. Refuse a missing, non-binary, or empty payload rather than guessing.
4. **Choose the right tool.** Use `pdf-lib` for new PDFs and ordinary page/text/image edits. Use MuPDF for opening an existing PDF, page counts, text extraction, and raster previews. Do not claim either library is a general-purpose PDF/A, redaction, OCR, signature, or encryption solution.
5. **Write explicitly.** Use `adf.fs_write({ mode: 'write', path: outputPath, content: base64, encoding: 'base64', mime_type: 'application/pdf' })`. The helper in `scripts/pdf-workflow.mjs` returns the payload fields. Never write a base64 string without `encoding: 'base64'`.
6. **Reopen and validate.** Load the output again with MuPDF. Check that it opens, has the expected page count, and that expected text is present. Render at least one representative page to PNG with MuPDF for visual inspection when the output is meant to be seen. Inspect the actual image bytes or a native multimodal preview before saying visual validation passed; page-count metadata alone is not visual evidence.
7. **Report evidence and limits.** Give the output path, whether the original was preserved, checks performed, and any unavailable validation (OCR, viewer, signatures, encryption, accessibility, PDF/A). Do not call a successful byte write “visually validated.”

## Runnable `sys_code` examples

The repository helper `scripts/pdf-workflow.mjs` is a portable reference. In ADF, copy its functions into a `lib/` file or paste the relevant imports/functions into `sys_code`; sandbox import transforms support the package imports shown below.

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
await adf.fs_write({
  mode: 'write', path: outputPath,
  content: Buffer.from(bytes).toString('base64'),
  encoding: 'base64', mime_type: 'application/pdf',
})
```

### Read, modify, preserve, and reopen an existing PDF

```javascript
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as mupdf from 'mupdf'

const inputPath = 'input/source.pdf'
const outputPath = 'output/source-updated.pdf'
const source = await adf.fs_read({ path: inputPath })
if (source.mime_type !== 'application/pdf' || !source.content) throw new Error('Expected a readable PDF payload')
const inputBytes = Buffer.from(source.content, 'base64')
const pdf = await PDFDocument.load(inputBytes)
const pages = pdf.getPages()
if (!pages[0]) throw new Error('PDF has no page zero')
const font = await pdf.embedFont(StandardFonts.Helvetica)
pages[0].drawText('Reviewed', { x: 72, y: 72, size: 12, font, color: rgb(0.8, 0.1, 0.1) })
const outputBytes = await pdf.save()
await adf.fs_write({
  mode: 'write', path: outputPath,
  content: Buffer.from(outputBytes).toString('base64'),
  encoding: 'base64', mime_type: 'application/pdf',
})
const reopened = mupdf.Document.openDocument(Buffer.from(outputBytes), 'application/pdf')
if (reopened.countPages() !== pages.length) throw new Error('Page count changed unexpectedly')
const text = reopened.loadPage(0).toStructuredText().asText()
const saved = await adf.fs_read({ path: outputPath })
const savedBytes = Buffer.from(saved.content, 'base64')
const savedDoc = mupdf.Document.openDocument(savedBytes, 'application/pdf')
const savedText = savedDoc.loadPage(0).toStructuredText().asText()
if (!savedText.includes('Reviewed')) throw new Error('Saved VFS output does not contain Reviewed')
console.log({ inputPath, outputPath, pageCount: savedDoc.countPages(), savedTextIncludesReviewed: savedText.includes('Reviewed') })
```

### Extract and render for visual review

```javascript
import * as mupdf from 'mupdf'
const file = await adf.fs_read({ path: 'output/hello.pdf' })
const bytes = Buffer.from(file.content, 'base64')
const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
const page = doc.loadPage(0)
const extracted = page.toStructuredText().asText()
const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false)
const png = pixmap.asPNG()
await adf.fs_write({
  mode: 'write', path: 'output/hello-page-1-preview.png',
  content: Buffer.from(png).toString('base64'),
  encoding: 'base64', mime_type: 'image/png',
})
console.log({ pageCount: doc.countPages(), extracted, previewPath: 'output/hello-page-1-preview.png' })
// Deliver the VFS artifact as: [PDF preview](adf-file://output/hello-page-1-preview.png)
```

## Extraction, OCR, overlays, and redaction

- Text extraction is only extraction of the PDF's text layer. If `asText()` is empty or incomplete, the page may be scanned, outlined, encrypted, or otherwise unsupported. Say “no extractable text found”; do not infer that the page is blank.
- OCR is a separate capability. Do not invent OCR output or enable a provider/package automatically. Ask for an approved OCR tool or have the principal provide one.
- A highlight, annotation, white rectangle, crop, or drawn overlay **does not redact** underlying text or images. Do not use an overlay when the requirement is secure redaction. Use a dedicated redaction workflow, preserve the original, then reopen and check that removed content is not extractable/rendered.
- `pdf-lib` rewrites can affect incremental updates and unsupported features. Do not promise preservation of digital signatures, JavaScript, complex forms, encryption, PDF/A conformance, accessibility tags, or vendor-specific behavior. Password-protected input may require a password-aware workflow.

## Tests and evidence

From an isolated checkout with the packages installed, run:

```sh
cd skills/pdf-documents
node --test tests/pdf-workflow.test.mjs
```

The checked-in helper tests create a PDF, reopen and extract it with MuPDF, render a PNG, update it without mutating the original bytes, verify explicit VFS base64 conversion, and assert a missing-page failure. The repository is not asserting that `mupdf`/`pdf-lib` are available as host `node_modules`; they are ADF standard-library packages according to `docs/guides/code-execution.md`. A local test run must report the package setup and whether a real PDF viewer or OCR engine was available.

See `references/limitations.md` for the complete caveat list and `scripts/pdf-workflow.mjs` for reusable helpers.
