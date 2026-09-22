---
name: excel-spreadsheets
description: Create, read, and make targeted cell or sheet updates to XLSX/CSV files with SheetJS xlsx; activate for workbook generation, inspection, formula-aware patches, or safe CSV export with explicit fidelity and recalculation limits.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code]
---

# Excel spreadsheets

Use the standard `xlsx` package (ADF guide version 0.18.5) for `.xlsx`, `.xls`, and CSV work. Treat workbook updates as targeted transformations, not a promise of full Excel round-trip fidelity.

## Preflight

1. In `sys_code`, import `xlsx`; if the standard-library install is still running, stop and report that capability rather than enabling tools/packages from this skill.
2. Read binary spreadsheet input with `fs_read`, then decode `Buffer.from(file.content, "base64")`. For CSV/text, use the returned UTF-8 content or a buffer with an explicit `type`.
3. Parse XLSX with `cellDates: true`, `cellFormula: true`, and (when styles matter) `cellStyles: true`; inspect `cell.t`, `cell.v`, `cell.f`, and `cell.z` rather than guessing types from formatted text.
4. Never overwrite the source by default. Write a distinct output path as base64 with the appropriate MIME (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for XLSX, `text/csv` for CSV), reopen it, and verify the intended cells/formulas. Link it as `[XLSX](adf-file://path/to/output.xlsx)`.

## Workflows

Use `scripts/xlsx-tools.cjs` as a tested Node reference. In ADF `sys_code`, use the documented ESM import (`import * as XLSX from "xlsx";`) and the complete workflow in `references/adf-usage.md`.

- `createWorkbook` generates sheets from arrays and optional column widths. Values can be primitives, `Date`s, or `{value, formula, type, numberFormat}` cell descriptors. The helper rejects arbitrary `style` objects because SheetJS CE generally does not reliably write them.
- `readWorkbook` returns a compact sheet/cell summary and `readRows` returns raw row arrays. Do not use `sheet_to_json`'s formatted strings as a type-preserving interchange format.
- `updateCells` updates named cells or formulas in a copied workbook. A formula is stored in `cell.f` **without** a leading `=`. The package does not calculate formulas; supply a trusted cached value if one is known, otherwise Excel/LibreOffice must recalculate on open. The helper marks calculation for full recalculation where supported.
- `safeCsv` exports a sheet and prefixes a single quote to string fields beginning with `=`, `+`, `-`, `@`, tab, carriage return, or line feed. This reduces CSV formula injection risk; it does not make an untrusted workbook safe in every consumer.

## Fidelity, formulas, dates, and styles

- SheetJS parses and writes common workbook content, formulas, dates, and limited style metadata. SheetJS CE does not generally write arbitrary supplied style objects; verify critical formatting in Excel/LibreOffice and do not promise generated styling. It is **not** an Excel calculation engine. It does not guarantee preservation of every unsupported feature (for example, macros, comments, drawings, slicers, external links, pivot caches, conditional formatting, rich layout, or obscure metadata). A read/write can alter workbook internals even when target cells are unchanged.
- `cellDates: true` gives date cells `t: "d"` and JavaScript `Date` values where supported. Excel serial dates, timezone interpretation, and the 1904 date system need explicit checking; never silently treat a number as a date.
- Formula cells have both a formula (`f`) and often a cached result (`v`). Updating `f` without recalculating can leave a stale or absent display value until a spreadsheet application opens the file. Never claim computed results from this package alone.
- `cellStyles: true` exposes some style information on read, but SheetJS CE does not generally write arbitrary style objects. It is not a full-fidelity style round-trip guarantee. Preserve the original and verify critical formatting in Excel/LibreOffice when it matters.
- XLSX is not a safe arbitrary-file parser for encrypted or malicious files. Reject unsupported/encrypted input errors, cap input sizes appropriate to the task, and do not execute macros.

`tests/xlsx-tools.test.cjs` exercises create → update formula/date/number-format metadata → reopen plus missing-sheet/cell, canonical-address/bounds, and invalid-input failures. It uses Node with exact package versions; it is not a sandbox smoke test and does not prove Excel rendering.
