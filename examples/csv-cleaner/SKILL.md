---
name: csv-cleaner
description: Cleans a CSV (trims whitespace, drops fully-empty rows, dedups by key columns) and exports the result as an .xlsx workbook.
---

# csv-cleaner

A runnable example skill that demonstrates the OpenSkill **Python**
runtime. Given a CSV string + a few options, it produces a cleaned
`.xlsx` workbook using `pandas` + `openpyxl`.

The OpenSkill server runs `scripts/run.py` with `pandas` and `openpyxl`
available on `PYTHONPATH`, so no vendoring is required.

## Input shape

```json
{
  "csv": "name, score\n alice ,10\nbob,20\n alice ,10\n",
  "filename": "cleaned.xlsx",
  "sheetName": "cleaned",
  "dedupColumns": ["name"],
  "trim": true,
  "dropEmptyRows": true
}
```

| Field            | Default                | Meaning                                                    |
|------------------|------------------------|------------------------------------------------------------|
| `csv`            | _required_             | Raw CSV body; first row is the header.                     |
| `filename`       | `cleaned.xlsx`         | Output filename written into `$OPENSKILL_OUTPUT_DIR`.      |
| `sheetName`      | `cleaned`              | Worksheet title.                                           |
| `dedupColumns`   | `[]`                   | Drop duplicate rows where these columns match (after trim).|
| `trim`           | `true`                 | Strip leading/trailing whitespace from string cells.       |
| `dropEmptyRows`  | `true`                 | Drop rows where every cell is empty after trim.            |

## Output

A single `.xlsx` with one worksheet of cleaned rows. Headers are bold;
column widths auto-fit to the content.

## How it runs

The OpenSkill server runs `scripts/run.py` with:

- `OPENSKILL_INPUT_FILE` → path to a JSON file containing the input
- `OPENSKILL_OUTPUT_DIR` → directory to write the produced file to
- `PYTHONPATH` → includes the host's pre-installed scientific libraries
  (`pandas`, `openpyxl`, `python-docx`, `pdfplumber`, `Pillow`, `lxml`)

The script writes one file to `OPENSKILL_OUTPUT_DIR` and exits 0.
