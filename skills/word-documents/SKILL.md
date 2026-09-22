---
name: word-documents
description: Create, read, and perform targeted updates to DOCX files with the standard docx and jszip packages; activate for Word generation, placeholder/template patches, or narrowly scoped XML edits where fidelity limits are acceptable.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code]
---

# Word documents

Use this skill for **DOCX generation and narrowly targeted updates**, not as a general Word import/edit engine.

## Preflight

1. In `sys_code`, import `docx` and `jszip`; stop with the package error if standard-library installation is still in progress. Do not enable tools or packages from a skill.
2. Confirm the source path is readable and binary. `fs_read` returns binary content as base64; decode with `Buffer.from(file.content, "base64")`.
3. Keep the source bytes untouched. Write a distinct output path, with MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, using `encoding: "base64"`.
4. Before sending a result, reopen the output ZIP and verify the intended part/text. Link results as `[DOCX](adf-file://path/to/output.docx)`.

## Generate

Use `scripts/docx-tools.cjs` as a Node-test reference. In ADF `sys_code`, use the documented ESM imports (`import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx"; import JSZip from "jszip";`) and the complete workflow in `references/adf-usage.md`. `createDocx` creates a simple document from a title and paragraph strings. It is generation, not import.

See `references/adf-usage.md` for a complete, runnable `sys_code` example that creates a DOCX, reopens its `word/document.xml`, performs a safe single-`w:t` placeholder patch, writes a distinct VFS output, and reopens/verifies that output. Do not call a helper that is not defined in the current code block.

For reliable patches, put each placeholder in one Word text run (`<w:t>{{NAME}}</w:t>`). `patchDocxXml` performs exact replacements only when the placeholder is wholly inside one `<w:t>` text node; it fails on missing, ambiguous, split-run, markup/attribute, or invalid-XML-text placeholders. Replacement text is always XML-escaped; `{value, expected}` may set an explicit positive count, and there is no raw-XML bypass. Replacements are applied from the original text node and replacement values are not re-scanned as new tokens.

## Read and update

- `readDocxText(bytes)` extracts readable `w:t` text for verification; it is not a layout-preserving renderer.
- `patchDocxXml(bytes, replacements, options)` preserves all unmodified ZIP entries and returns new bytes. Default parts are `word/document.xml`; explicitly choose `word/header*.xml` or `word/footer*.xml` when needed.
- Use `zipEntryText` for a direct post-write assertion. The default part is `word/document.xml`; pass `{parts: ["word/document.xml", "word/header1.xml"]}` for headers/footers. Counts are global across selected parts. Reject invalid ZIPs, macro/VBA/ActiveX/executable entries/content types, missing parts, path traversal, missing placeholders, split-run/markup matches, invalid XML 1.0 controls, and unexpected replacement counts.
- For edits beyond exact text (tables, numbering, relationships, tracked changes, images), inspect the relevant ECMA-376 XML and make a deliberately scoped patch. Do not regex-rewrite an arbitrary document.

`tests/docx-tools.test.cjs` runs a realistic create → patch → reopen flow plus entity/token collision, expected-count, header, macro, invalid ZIP/control, and source-preservation negatives. It is a Node test using the exact package versions listed in the ADF code-execution guide, not proof that an ADF sandbox is currently installed or that Word will render every feature identically.

## Fidelity and safety limits

The `docx` package is a document generator. `jszip` can patch ZIP/XML parts but does not understand Word layout, fields, themes, tracked revisions, macros, embedded objects, or all relationship semantics. Do not claim arbitrary DOC/DOCX import, full-fidelity round trips, or rendering equivalence. A targeted patch can still invalidate a document if XML is malformed or a related part is omitted. Preserve originals, use a new output path, validate by reopening, and state the exact scope of the edit.
