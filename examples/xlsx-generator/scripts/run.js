/**
 * xlsx-generator — runnable OpenSkill example.
 *
 * Reads a JSON description from $OPENSKILL_INPUT_FILE (or stdin), builds an
 * .xlsx workbook with `exceljs`, and writes it to $OPENSKILL_OUTPUT_DIR.
 *
 * Input shape (all fields optional):
 *   {
 *     "filename":  "report.xlsx",
 *     "sheetName": "Sheet1",
 *     "headers":   ["A", "B", "C"],
 *     "rows":      [[...], [...]]
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

function readInput() {
  const inputFile = process.env.OPENSKILL_INPUT_FILE;
  if (inputFile && fs.existsSync(inputFile)) {
    return JSON.parse(fs.readFileSync(inputFile, 'utf8') || '{}');
  }
  // Fallback: read all of stdin synchronously
  try {
    const data = fs.readFileSync(0, 'utf8');
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

async function main() {
  const input = readInput();
  const outDir = process.env.OPENSKILL_OUTPUT_DIR;
  if (!outDir) {
    throw new Error(
      'OPENSKILL_OUTPUT_DIR is not set; this skill is meant to be run by OpenSkill',
    );
  }

  const filename =
    typeof input.filename === 'string' && input.filename.endsWith('.xlsx')
      ? input.filename
      : 'output.xlsx';
  const sheetName = typeof input.sheetName === 'string' ? input.sheetName : 'Sheet1';
  const headers = Array.isArray(input.headers) ? input.headers : null;
  const rows = Array.isArray(input.rows) ? input.rows : [];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpenSkill xlsx-generator';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);

  if (headers) {
    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };
  }
  for (const row of rows) {
    if (Array.isArray(row)) ws.addRow(row);
  }

  // Auto-size columns based on the widest value seen.
  if (ws.columnCount > 0) {
    for (let i = 1; i <= ws.columnCount; i += 1) {
      const col = ws.getColumn(i);
      let max = 8;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value == null ? '' : String(cell.value);
        if (v.length > max) max = v.length;
      });
      col.width = Math.min(max + 2, 40);
    }
  }

  // Format numeric columns with thousand separators (best-effort heuristic:
  // if every non-header cell in a column parses as a number, treat it as
  // numeric).
  if (ws.rowCount > (headers ? 1 : 0)) {
    const startRow = headers ? 2 : 1;
    for (let c = 1; c <= ws.columnCount; c += 1) {
      let allNumeric = true;
      for (let r = startRow; r <= ws.rowCount; r += 1) {
        const v = ws.getCell(r, c).value;
        if (v == null || typeof v === 'number') continue;
        allNumeric = false;
        break;
      }
      if (allNumeric) ws.getColumn(c).numFmt = '#,##0';
    }
  }

  const outPath = path.join(outDir, filename);
  await wb.xlsx.writeFile(outPath);
  // Surface a tiny status message on stdout — OpenSkill captures it.
  console.log(`wrote ${filename} (${ws.rowCount} rows, ${ws.columnCount} cols)`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
