# OpenSkill runnable-skill examples

This directory contains example skills that the OpenSkill platform can
**execute server-side** and stream the produced file(s) back to the user.

To enable execution for a skill, include a Node.js entry script in the ZIP
(by default at `scripts/run.js`), follow the contract below, and upload it
via the normal upload page. A **Run** tab will appear automatically on the
skill detail page.

> Same as the rest of OpenSkill, the platform does not currently sandbox
> skill execution beyond the Docker container the server itself runs in.
> Treat skill source as you would any third-party code.

## Building the example ZIPs

```bash
node scripts/build-examples.js
# Output: examples/dist/<skill>.zip
```

Then upload the produced ZIP through the OpenSkill UI (admin uploads are
auto-published; user uploads await review).

## Runnable-skill contract

A skill becomes runnable as soon as the archive contains an entry script
that the runner can find. The defaults below cover the common case; only
override them when you need to.

### Layout

```
my-skill/
├── SKILL.md             # required (Anthropic Agent Skill format)
├── manifest.json        # optional; carries the `run` configuration
└── scripts/
    └── run.js           # default entry point
```

### Execution environment

When the user clicks **Run**, the OpenSkill server:

1. Extracts the skill ZIP into a fresh temp directory.
2. Writes the JSON input from the request body to a temp file.
3. Spawns `node <entry>` with `cwd` = the skill directory and these env vars:

| Variable                  | Meaning                                                      |
|---------------------------|--------------------------------------------------------------|
| `OPENSKILL_INPUT_FILE`    | Path to the JSON input file (also piped to stdin).           |
| `OPENSKILL_OUTPUT_DIR`    | Directory the script must write its output file(s) into.     |
| `NODE_PATH`               | Includes the server's `node_modules` so `require()` works.   |
| `PATH`, `HOME`, `LANG`    | Minimal whitelist; nothing else from the parent env leaks.   |

The script is killed after a wall-clock timeout (default 60 s, configurable
via `manifest.run.timeout_ms`, capped at 300 s).

### Pre-installed packages

The server's `node_modules` is exposed via `NODE_PATH`, so any runnable
skill can `require()`:

- `docx`     — Word document (.docx) generation
- `exceljs`  — Excel spreadsheet (.xlsx) generation
- `adm-zip`  — ZIP packaging (also used internally for multi-file output)
- `js-yaml`  — YAML parsing
- All Node built-ins (`fs`, `path`, `crypto`, `zlib`, …)

If your skill needs additional libraries, vendor them by including a
`node_modules/` directory inside the ZIP.

### Output handling

The runner scans `OPENSKILL_OUTPUT_DIR` after the script exits cleanly:

| Files in OUTPUT_DIR | Response                                                    |
|---------------------|-------------------------------------------------------------|
| 0                   | `422 EMPTY_OUTPUT`                                          |
| 1                   | The file is streamed back with `Content-Type` from the ext. |
| ≥ 2                 | All files are bundled into a single `.zip` and streamed.    |

Output cap: 50 MB total. Anything larger fails with `413 OUTPUT_TOO_LARGE`.

### `manifest.json` `run` block

All fields are optional:

```json
{
  "name": "xlsx-generator",
  "version": "1.0.0",
  "run": {
    "entry": "scripts/run.js",
    "runtime": "node",
    "timeout_ms": 30000,
    "input_example": { "sheetName": "Demo", "rows": [["a", "b"]] }
  }
}
```

| Field           | Default            | Notes                                                |
|-----------------|--------------------|------------------------------------------------------|
| `entry`         | `scripts/run.js`   | Relative path; no `..` or absolute paths.            |
| `runtime`       | `node`             | Only `node` is supported today.                      |
| `timeout_ms`    | `60000`            | Clamped to `[1000, 300000]`.                         |
| `input_example` | _none_             | Pre-fills the textarea on the Run tab.               |

### Error model

Errors come back as JSON `{ error, code, detail? }`:

| Code             | HTTP | Cause                                                         |
|------------------|------|---------------------------------------------------------------|
| `NOT_RUNNABLE`   | 422  | Entry not found in the skill's file tree.                     |
| `INPUT_TOO_LARGE`| 413  | Request body exceeded 1 MB.                                   |
| `OUTPUT_TOO_LARGE` | 413| Total bytes written to OUTPUT_DIR exceeded 50 MB.             |
| `EMPTY_OUTPUT`   | 422  | Script exited 0 but didn't write any file.                    |
| `SCRIPT_FAILED`  | 422  | Script exited non-zero. `detail.stderr` and `detail.exitCode`. |
| `TIMEOUT`        | 504  | Script exceeded its timeout.                                   |
| `RUN_BUSY`       | 409  | Another run is already in progress (single-flight lock).      |

## Available examples

### `xlsx-generator`

Generates an Excel spreadsheet from a JSON description of headers and rows.
Demonstrates use of the pre-installed `exceljs` module, custom `manifest.run`
configuration with an `input_example`, and producing a single output file.

Try the example input directly from the Run tab — clicking **Run** will
download a ready-to-open `.xlsx`.
