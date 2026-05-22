---
name: xlsx-generator
description: Generates an Excel (.xlsx) spreadsheet from a JSON description of sheets, columns and rows.
---

# xlsx-generator

A runnable example skill that demonstrates the OpenSkill server-side
**Run** capability. Given a JSON input describing a worksheet, this skill
produces an `.xlsx` file using `exceljs` and OpenSkill streams it back to
the user's browser as a download.

## Input shape

```json
{
  "filename": "report.xlsx",
  "sheetName": "Q3 Sales",
  "headers": ["Product", "Region", "Units", "Revenue"],
  "rows": [
    ["Widget A", "EMEA",  120, 14400],
    ["Widget A", "APAC",   80,  9600],
    ["Widget B", "EMEA",   55, 11000],
    ["Widget B", "APAC",   42,  8400]
  ]
}
```

All fields are optional. If `headers` is provided, it is rendered bold;
numeric columns are auto-formatted with thousand separators.

## Output

A single `.xlsx` file. Open it in Excel, Numbers, Google Sheets, or
LibreOffice Calc.

## How it runs

The OpenSkill server runs `scripts/run.js` with:

- `process.env.OPENSKILL_INPUT_FILE` → path to a JSON file holding the input
- `process.env.OPENSKILL_OUTPUT_DIR` → directory to write produced files to
- A 60-second wall-clock timeout (configurable via `manifest.run.timeout_ms`)

The script writes one file to `OPENSKILL_OUTPUT_DIR` and exits 0.
