# PDF capability and safety notes

- `pdf-lib` is reliable for creating a new PDF and for ordinary page/text/image edits. Reopen the result with MuPDF before reporting success.
- MuPDF extraction reads an existing text layer. A scanned/image-only page requires OCR; do not silently report an empty extraction as an empty document.
- A visual overlay, white rectangle, or annotation is **not redaction**. For redaction, use a redaction-capable workflow that removes underlying content and then reopen/extract/render to verify. Keep the original.
- Do not promise preservation of digital signatures, incremental-signature validity, complex forms, JavaScript, encryption, or every vendor-specific PDF feature after a rewrite. Encrypted/password-protected files need the correct password and a workflow that explicitly supports them.
- PDF/A, accessibility tags, embedded fonts, color management, and print fidelity need specialized validation beyond page-count/text checks.
- Rendered PNGs are previews for visual review. They are not evidence that OCR, redaction, signatures, or accessibility requirements are satisfied.
