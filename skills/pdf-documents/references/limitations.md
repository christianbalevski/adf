# PDF capability and safety notes

- `pdf-lib` is reliable for creating a new PDF and for ordinary page/text/image edits. Reopen the result with MuPDF before reporting success.
- MuPDF extraction reads an existing text layer. A scanned/image-only page requires OCR; do not silently report an empty extraction as an empty document.
- A visual overlay, white rectangle, or annotation is **not redaction**. For redaction, use a redaction-capable workflow that removes underlying content and then reopen/extract/render to verify. Keep the original.
- Do not promise preservation of digital signatures, incremental-signature validity, complex forms, JavaScript, encryption, or every vendor-specific PDF feature after a rewrite. Encrypted/password-protected files need the correct password and a workflow that explicitly supports them.
- PDF/A, accessibility tags, embedded fonts, color management, and print fidelity need specialized validation beyond page-count/text checks.
- Rendered PNGs are previews for visual review. They are not evidence that OCR, redaction, signatures, or accessibility requirements are satisfied.

## Current ADF sandbox compatibility note

In the tested ADF runtime, `pdf-lib` imported and completed a real VFS write/read/reopen roundtrip. `mupdf` was listed as available, but its ESM/WASM loader failed before module evaluation with a Windows-path URL error (`Only URLs with a scheme in: file, data, node, and electron are supported ... Received protocol 'c:'`). A direct `file:///C:/...` dynamic import then failed with `A dynamic import callback was not specified`, consistent with the sandbox's `vm.runInContext` execution lacking a dynamic-import callback. This is a runtime/package-loader issue, not a PDF input failure.

Do not work around this by importing `fs`, reading `__stdlibPath` yourself, changing permissions, or claiming MuPDF extraction/rendering. Stop the MuPDF leg and report the exact error until the runtime supplies a supported loader fix. `pdf-lib` can still create/modify/reopen and count pages, but it is not a substitute for MuPDF text extraction or raster rendering.

The same sandbox smoke showed `StandardFonts.Helvetica` rejects characters outside WinAnsi (for example `✓`) with `WinAnsi cannot encode`; embed a suitable Unicode font when licensed/available rather than silently dropping characters.
