# ADF XLSX usage

Run the following as one `sys_code` call. ADF transforms the ESM import for the sandbox; keep this import at the top of the call.

```js
import * as XLSX from "xlsx";

const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// For an existing OOXML input, hash bytes before and after the update; reject active-content parts before parsing.
const sourceWb = XLSX.utils.book_new();
const sourceWs = XLSX.utils.aoa_to_sheet([
  ["Name", "Amount", "Total"],
  ["Ada", 2, { t: "n", v: 4, f: "B2*2", z: "0.00" }],
]);
XLSX.utils.book_append_sheet(sourceWb, sourceWs, "Data");
const original = Buffer.from(XLSX.write(sourceWb, { bookType: "xlsx", type: "buffer" }));
const wb = XLSX.read(original, { type: "buffer", cellDates: true, cellFormula: true, cellStyles: true, cellNF: true });
const ws = wb.Sheets.Data;
if (!ws) throw new Error("No Data worksheet");
// B2 already exists. A3 is outside the initial range; extend !ref explicitly.
ws.B2 = { t: "n", v: 3 };
ws.C2 = { t: "n", v: 6, f: "B2*2" }; // trusted cache v=6 is required; formula text has no leading '='.
ws.A3 = { t: "s", v: "Updated" };
const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
for (const address of ["B2", "C2", "A3"]) {
  const cell = XLSX.utils.decode_cell(address);
  range.s.r = Math.min(range.s.r, cell.r); range.s.c = Math.min(range.s.c, cell.c);
  range.e.r = Math.max(range.e.r, cell.r); range.e.c = Math.max(range.e.c, cell.c);
}
ws["!ref"] = XLSX.utils.encode_range(range);
wb.Workbook = wb.Workbook || {};
wb.Workbook.CalcPr = { calcMode: "auto", fullCalcOnLoad: true, forceFullCalc: true };
const output = Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer", cellStyles: true }));
await adf.fs_write({ mode: "write", path: "out/updated.xlsx", content: output.toString("base64"), encoding: "base64", mime_type: mime });
const check = await adf.fs_read({ path: "out/updated.xlsx" });
const reopened = XLSX.read(Buffer.from(check.content, "base64"), { type: "buffer", cellDates: true, cellFormula: true });
if (reopened.Sheets.Data.B2.v !== 3 || reopened.Sheets.Data.C2.f !== "B2*2" || reopened.Sheets.Data.A3.v !== "Updated") throw new Error("XLSX verification failed");
({ path: "out/updated.xlsx", bytes: output.length, verified: true, formulaNotCalculated: true });
```

Keep source and output paths distinct. The helper preflights active OOXML (`vbaProject*` anywhere in the archive, ActiveX, embeddings, macro-enabled content types/relationships, and traversal paths) and checks the source SHA-256 remains unchanged after update. SheetJS CE does not calculate formulas and does not generally write arbitrary style objects; formula-only cells without trusted cached values are rejected by the helper because CE 0.18.5 can drop them on write/reopen. For CSV, prefix untrusted strings whose leading whitespace/BOM is followed by `=`, `+`, `-`, or `@` before export; numeric values remain typed. Explain that this mitigates but cannot control every consumer.
