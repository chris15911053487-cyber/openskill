'use strict';

/**
 * python-exec — execute LLM-written Python code against a skill bundle.
 *
 * Phase 2 of TODO-python-agent-mode.md. Used by the chat tool
 * `run_python_code` when an attached skill is in "agent mode" (no
 * `scripts/run.{js,py}` entry, just SKILL.md + assets / templates).
 *
 * The skill ZIP is extracted into a fresh temp directory whose root
 * becomes the script's CWD. The LLM-supplied `code` is written to
 * `_run.py` inside that root and executed. Output files written under
 * `OPENSKILL_OUTPUT_DIR` are collected with the same caps + multi-file
 * zipping behaviour as `runSkill`.
 *
 * Reuses internal helpers from skill-runner.js so the two paths share
 * extraction, output collection, stdio capping and the single-flight
 * lock semantics.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const {
  contentTypeFor,
  isBusy,
  RunnerError,
  DEFAULTS,
  _internal,
} = require('./skill-runner');

const { extractZipToDir, listOutputFiles, zipOutputFiles } = _internal;

// Python interpreter; overridable for tests / unusual hosts.
const PYTHON_BIN = process.env.OPENSKILL_PYTHON || 'python3';

// Same defaults as the host PYTHONPATH segments in skill-runner.js.
const DEFAULT_PYTHONPATH = [
  '/usr/local/lib/python3.12/dist-packages',
  '/usr/lib/python3/dist-packages',
  '/usr/local/lib/python3/dist-packages',
];

// Expose the same single-flight lock the Node + Python runners use.
// Skill-runner manages a module-level `_busy` boolean; we re-import the
// `_acquire`/`_release` semantics by going through a shared helper.
//
// The cleanest way to share the lock without exporting more internals is
// to require the module at runtime and rely on `isBusy()`. For atomic
// acquire we use a local mutex variable + double-check via isBusy.
let _localBusy = false;
function _acquire() {
  if (_localBusy || isBusy()) return false;
  _localBusy = true;
  return true;
}
function _release() {
  _localBusy = false;
}

/**
 * Capture-with-cap helper (duplicated locally to avoid exporting another
 * internal). 256 KB stdout/stderr each by default.
 */
function makeCapturer(cap) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (total >= cap) {
        truncated = true;
        return;
      }
      const remaining = cap - total;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
      }
    },
    value() {
      const buf = Buffer.concat(chunks, total);
      return truncated ? buf.toString('utf8') + '\n…[truncated]' : buf.toString('utf8');
    },
  };
}

/**
 * Run LLM-written Python code against a skill bundle.
 *
 * @param {Object} args
 * @param {Buffer} args.zipBuffer       — skill ZIP contents
 * @param {object|null} [args.manifest] — parsed manifest.json (used for
 *        per-skill timeout override)
 * @param {string} args.code            — Python 3 source to execute
 * @param {string} [args.stdin]         — optional text fed to the script
 * @param {string[]} [args.extraPythonPaths]
 * @param {Partial<typeof DEFAULTS>} [args.limits]
 *
 * @returns {Promise<{
 *   filename: string,
 *   contentType: string,
 *   data: Buffer,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number,
 *   runtime: 'python',
 * }>}
 *
 * Throws RunnerError on any failure. Cleans up the temp dir.
 */
async function runPythonCode({
  zipBuffer,
  manifest = null,
  code,
  stdin = '',
  extraPythonPaths = [],
  limits = {},
}) {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new RunnerError('BAD_ARGUMENTS', 'run_python_code requires a non-empty `code` string');
  }
  if (!_acquire()) {
    throw new RunnerError(
      'RUN_BUSY',
      'Another skill execution is in progress; please retry',
    );
  }

  const lim = { ...DEFAULTS, ...limits };
  // Honour manifest.run.timeout_ms if the LLM is calling on behalf of a
  // skill that declares one. Clamp to [1s, 300s] like the Node runner.
  if (manifest && manifest.run && Number.isFinite(manifest.run.timeout_ms)) {
    lim.timeoutMs = Math.max(1_000, Math.min(300_000, manifest.run.timeout_ms));
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openskill-pyagent-'));
  const extractDir = path.join(tmpRoot, 'skill');
  const outputDir = path.join(tmpRoot, 'output');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // 1. Extract ZIP, find skill root (so the LLM's `code` runs with the
    //    skill bundle's templates / assets at relative paths).
    const skillRoot = extractZipToDir(zipBuffer, extractDir);
    const skillRootAbs = path.resolve(skillRoot);

    // 2. Cap source size on the same 1 MB envelope as input JSON. LLMs
    //    never write 1 MB of code; if they do something is wrong.
    const codeBytes = Buffer.byteLength(code, 'utf8');
    if (codeBytes > lim.maxInputBytes) {
      throw new RunnerError(
        'INPUT_TOO_LARGE',
        `code exceeds ${lim.maxInputBytes}-byte cap`,
      );
    }

    // 3. Write the code to disk so we don't hit argv length limits and
    //    Python errors point at file:line numbers.
    //    Pick a name that's unlikely to collide with anything the skill
    //    ships (it would be unusual but not impossible).
    let scriptName = '_openskill_agent.py';
    while (fs.existsSync(path.join(skillRootAbs, scriptName))) {
      scriptName = `_openskill_agent_${Math.random().toString(36).slice(2, 8)}.py`;
    }
    const scriptAbs = path.join(skillRootAbs, scriptName);
    fs.writeFileSync(scriptAbs, code, 'utf8');

    // 4. Build env. Whitelist exactly the same keys as the Python skill
    //    runner branch, plus PYTHONPATH that points at the skill root + the
    //    host's pre-installed libraries.
    const pyPathParts = [
      skillRootAbs,
      ...extraPythonPaths.map((p) => path.resolve(p)),
      ...DEFAULT_PYTHONPATH,
    ].filter((p, i, arr) => p && arr.indexOf(p) === i);

    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: tmpRoot,
      LANG: process.env.LANG || 'C.UTF-8',
      OPENSKILL_OUTPUT_DIR: outputDir,
      PYTHONPATH: pyPathParts.join(path.delimiter),
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    };

    // 5. Spawn python3.
    const startedAt = Date.now();
    const stdoutCap = makeCapturer(lim.maxStdioBytes);
    const stderrCap = makeCapturer(lim.maxStdioBytes);

    const child = spawn(PYTHON_BIN, [scriptAbs], {
      cwd: skillRootAbs,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => stdoutCap.append(chunk));
    child.stderr.on('data', (chunk) => stderrCap.append(chunk));
    child.stdin.end(stdin || '');

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, lim.timeoutMs);

    let spawnErr = null;
    const { code: exitCode, signal } = await new Promise((resolve) => {
      child.on('error', (err) => {
        spawnErr = err;
        resolve({ code: null, signal: null });
      });
      child.on('close', (c, s) => resolve({ code: c, signal: s }));
    });
    clearTimeout(timer);

    const stdout = stdoutCap.value();
    const stderr = stderrCap.value();

    if (spawnErr) {
      const code =
        spawnErr.code === 'ENOENT' ? 'PYTHON_NOT_INSTALLED' : 'SPAWN_FAILED';
      throw new RunnerError(code, spawnErr.message, { stdout, stderr });
    }
    if (timedOut) {
      throw new RunnerError(
        'TIMEOUT',
        `Skill execution exceeded ${lim.timeoutMs}ms`,
        { stdout, stderr },
      );
    }
    if (exitCode !== 0) {
      throw new RunnerError(
        'SCRIPT_FAILED',
        `Python code exited with code ${exitCode}${signal ? ` (signal=${signal})` : ''}`,
        { stdout, stderr, exitCode, signal },
      );
    }

    // 6. Collect output (same shape as skill-runner.js#runSkill).
    const { files } = listOutputFiles(outputDir, lim.maxOutputBytes);
    if (files.length === 0) {
      throw new RunnerError(
        'EMPTY_OUTPUT',
        'Python code did not produce any output files',
        { stdout, stderr },
      );
    }

    let result;
    if (files.length === 1) {
      const f = files[0];
      result = {
        filename: path.basename(f.rel),
        contentType: contentTypeFor(f.rel),
        data: fs.readFileSync(f.abs),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        runtime: 'python',
      };
    } else {
      const zipBuf = zipOutputFiles(files);
      const stem =
        manifest?.name && typeof manifest.name === 'string'
          ? manifest.name
          : 'agent-output';
      result = {
        filename: `${stem}-${Date.now()}.zip`,
        contentType: 'application/zip',
        data: zipBuf,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        runtime: 'python',
      };
    }
    return result;
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    _release();
  }
}

module.exports = {
  runPythonCode,
};
