#!/usr/bin/env node
/**
 * gemma-client — call a local LiteRT-LM model from Claude Code.
 *
 * `litert-lm serve` exposes an OpenAI-compatible API. This wraps it so a local
 * model can be invoked as a one-shot command, starting the server on demand and
 * reusing it across calls.
 *
 * Contract:       specs/001-local-gemma-plugin/contracts/gemma-client-cli.md
 * State protocol: specs/001-local-gemma-plugin/contracts/runtime-state.md
 *
 * Dependency-free by constitution (Principle III): Node standard library only.
 *
 * stdout carries the payload and nothing else, so output can be piped.
 * stderr carries every notice, warning and diagnostic.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9379,
  model: 'gemma4-e4b-gpu',
  maxTokens: 800,
  idleTimeout: 900,          // seconds; 0 disables idle shutdown
  requestTimeoutMs: 15 * 60 * 1000,
  startupTimeoutMs: 90 * 1000,
};

/** Usage error — exit 2, so a caller can tell "called wrong" from "environment broken". */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Runtime state (contracts/runtime-state.md)
//
// One small file per fact, so concurrent readers and writers never need a lock.
// Keyed by port: two servers on different ports must not share state.
// ---------------------------------------------------------------------------

function stateDir(port) {
  const base = process.env.LITERT_LM_PLUGIN_RUNTIME
    ?? join(homedir() || tmpdir(), '.litert-lm', 'plugin-runtime');
  return join(base, String(port));
}

const statePath = (port, name) => join(stateDir(port), name);

function readState(port, name, fallback = null) {
  try {
    return readFileSync(statePath(port, name), 'utf8').trim();
  } catch {
    return fallback;   // absent means the default, never "long ago"
  }
}

function writeState(port, name, value) {
  try {
    mkdirSync(stateDir(port), { recursive: true });
    writeFileSync(statePath(port, name), String(value), 'utf8');
  } catch {
    // State is an optimisation for the watchdog, never a reason to fail a request.
  }
}

function clearState(port, name) {
  try { rmSync(statePath(port, name), { force: true }); } catch { /* ignore */ }
}

/**
 * In-flight tracking by marker file, not by counter.
 *
 * A single `in-flight` integer requires read-modify-write, which two concurrent
 * clients can interleave: both read 0, both write 1, and one decrement then drops
 * it to 0 while a request is still running — at which point the watchdog is free
 * to kill the server mid-generation. Creating and unlinking one uniquely-named
 * file per request is atomic at the filesystem level, so no update can be lost.
 *
 * The name carries the owning pid, which also makes crash recovery exact: a
 * marker whose process is gone is stale by definition, no timeout guesswork.
 */
const IN_FLIGHT_DIR = 'in-flight.d';

function acquireInFlight(port) {
  const dir = join(stateDir(port), IN_FLIGHT_DIR);
  const marker = join(dir, `${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, '', 'utf8');
    return marker;
  } catch {
    return null;   // tracking is best-effort; never fail a request over it
  }
}

function releaseInFlight(marker) {
  if (!marker) return;
  try { rmSync(marker, { force: true }); } catch { /* ignore */ }
}

/** Drop every marker — used when the server is gone, so nothing can be in flight. */
function clearInFlight(port) {
  try {
    rmSync(join(stateDir(port), IN_FLIGHT_DIR), { recursive: true, force: true });
  } catch { /* ignore */ }
}

const touchActivity = (port) => writeState(port, 'last-activity', Date.now());

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const livePid = (port, name) => {
  const pid = Number.parseInt(readState(port, name, ''), 10);
  return pidAlive(pid) ? pid : null;
};

/**
 * Discard state left by a process that no longer exists.
 *
 * State files outlive the processes that wrote them — a crash, a kill, or a host
 * reboot leaves every one of them behind, still naming dead pids. Trusting them
 * is worse than having none: a stale `watchdog.pid` would suppress every future
 * watchdog, so the server would never release accelerator memory again, and a
 * leaked `in-flight` would suppress idle shutdown on top of that.
 *
 * Observed for real after a host BSOD, which left in-flight=1 and two dead pids.
 */
function reconcileState(port, serverUp) {
  if (livePid(port, 'watchdog.pid') === null) clearState(port, 'watchdog.pid');
  if (livePid(port, 'server.pid') === null) clearState(port, 'server.pid');
  if (!serverUp) {
    // No server means nothing can legitimately be in flight against it.
    clearInFlight(port);
    clearState(port, 'in-flight');          // legacy counter from older installs
    clearState(port, 'stopping');
    clearState(port, 'loaded-model');
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ...DEFAULTS, prompt: '', system: null, json: false, action: 'chat',
  };
  const rest = [];

  const needValue = (flag, value) => {
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    return value;
  };
  const needInt = (flag, value, min) => {
    const n = Number(needValue(flag, value));
    if (!Number.isInteger(n) || n < min) {
      throw new UsageError(`${flag} requires an integer >= ${min} (got "${value}")`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--model': opts.model = needValue(a, argv[++i]); break;
      case '--system': opts.system = needValue(a, argv[++i]); break;
      case '--max-tokens': opts.maxTokens = needInt(a, argv[++i], 1); break;
      case '--port': opts.port = needInt(a, argv[++i], 1); break;
      case '--idle-timeout': opts.idleTimeout = needInt(a, argv[++i], 0); break;
      case '--json': opts.json = true; break;
      case '--stop': opts.action = 'stop'; break;
      case '--check': opts.action = 'check'; break;
      case '--list': opts.action = 'list'; break;
      case '-h': case '--help': opts.action = 'help'; break;
      default:
        if (a.startsWith('--')) throw new UsageError(`Unknown flag: ${a}`);
        rest.push(a);
    }
  }
  opts.prompt = rest.join(' ');
  return opts;
}

const baseUrl = (o) => `http://${o.host}:${o.port}`;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function probe(opts, timeoutMs = 2000) {
  try {
    const res = await fetch(`${baseUrl(opts)}/v1/models`,
      { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * If the watchdog is mid-shutdown, wait for it rather than connecting to a dying
 * server (FR-025; runtime-state.md "Signals before acting").
 */
async function awaitNotStopping(opts) {
  if (readState(opts.port, 'stopping') === null) return false;
  process.stderr.write('[gemma] server is shutting down; waiting for it to exit...\n');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (readState(opts.port, 'stopping') === null) return true;
  }
  // Stale marker from a watchdog that died mid-shutdown: clear it and continue.
  clearState(opts.port, 'stopping');
  clearState(opts.port, 'server.pid');
  return true;
}

/** Start the watchdog only when we started a server, and only if none supervises (T060). */
function startWatchdog(opts) {
  if (opts.idleTimeout === 0) return;
  // Liveness, not file existence: a stale pid must never suppress the watchdog.
  if (livePid(opts.port, 'watchdog.pid') !== null) return;
  try {
    const child = spawn(
      process.execPath,
      [join(HERE, 'idle-watchdog.mjs'), '--port', String(opts.port),
        '--idle-timeout', String(opts.idleTimeout)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch {
    process.stderr.write('[gemma] warning: idle watchdog failed to start; the server will '
      + 'stay resident until you run --stop.\n');
  }
}

/**
 * Resolve the `litert-lm` executable to a concrete path.
 *
 * Spawning with `shell: true` would find it, but Node 24 deprecates passing an
 * args array with a shell (DEP0190) and prints a warning to stderr — which would
 * pollute output the contract says carries only our own diagnostics. Resolving the
 * path first lets us spawn directly, with no shell and no warning.
 */
function resolveLitertLm() {
  const [cmd, args] = process.platform === 'win32'
    ? ['where.exe', ['litert-lm']]
    : ['/usr/bin/env', ['which', 'litert-lm']];
  try {
    const out = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* fall through */ }
  return null;
}

async function ensureServer(opts) {
  reconcileState(opts.port, await probe(opts, 1000));

  const wasStopping = await awaitNotStopping(opts);

  const existing = await probe(opts);
  if (existing) {
    startWatchdog(opts);              // adopt a server nothing is supervising
    return { models: existing, started: false };
  }

  // Distinguish a restart-after-idle from a first-ever start (FR-025). The watchdog
  // leaves `stopped-idle` behind precisely so this is answerable; consume it here.
  const stoppedIdleAt = Number.parseInt(readState(opts.port, 'stopped-idle', ''), 10);
  clearState(opts.port, 'stopped-idle');

  if (wasStopping || Number.isInteger(stoppedIdleAt)) {
    const agoS = Number.isInteger(stoppedIdleAt)
      ? Math.max(1, Math.round((Date.now() - stoppedIdleAt) / 1000))
      : null;
    process.stderr.write(
      '[gemma] the server had been stopped to free accelerator memory after going idle'
      + `${agoS === null ? '' : ` (${agoS}s ago)`}; restarting it, so this request pays engine `
      + 'initialisation and is slower than usual. Later calls will be fast.\n');
  } else {
    process.stderr.write(`[gemma] starting litert-lm server on ${baseUrl(opts)} ...\n`);
  }

  const exe = resolveLitertLm();
  if (!exe) {
    throw new Error(
      `'litert-lm' was not found on PATH.\n`
      + `  Install: uv tool install litert-lm\n`
      + `  Check:   litert-lm --version`);
  }

  let child;
  try {
    child = spawn(exe, ['serve', '--host', opts.host, '--port', String(opts.port)],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (err) {
    throw new Error(
      `could not launch '${exe}'.\n`
      + `  Check it runs: litert-lm --version\n`
      + `  (underlying error: ${err.message})`);
  }

  if (child.pid) writeState(opts.port, 'server.pid', child.pid);
  clearInFlight(opts.port);
  touchActivity(opts.port);

  const deadline = Date.now() + opts.startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(750);
    const up = await probe(opts);
    if (up) { startWatchdog(opts); return { models: up, started: true }; }
  }

  throw new Error(
    `the litert-lm server did not become reachable on ${baseUrl(opts)} within `
    + `${opts.startupTimeoutMs / 1000}s.\n`
    + `  Run it directly to see why: litert-lm serve --host ${opts.host} --port ${opts.port}\n`
    + `  Confirm a model exists:     litert-lm list`);
}

/**
 * Find whatever process is listening on the port.
 *
 * litert-lm is a two-stage launcher: the pid we spawned is often not the process
 * that ends up holding the socket, so killing the recorded pid alone leaves the
 * server running. Asking the OS who owns the port is the only reliable answer.
 */
function pidsOnPort(port) {
  const run = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    } catch {
      return '';
    }
  };

  const pids = new Set();
  if (process.platform === 'win32') {
    const out = run('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue `
      + '| Select-Object -ExpandProperty OwningProcess']);
    for (const line of out.split(/\r?\n/)) {
      const n = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } else {
    const out = run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    for (const line of out.split('\n')) {
      const n = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  }
  return [...pids];
}

async function stopProcesses(opts) {
  const port = opts.port;

  const recorded = ['watchdog.pid', 'server.pid']
    .map((n) => Number.parseInt(readState(port, n, ''), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  for (const pid of [...recorded, ...pidsOnPort(port)]) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Confirm the port actually closed rather than assuming SIGTERM landed.
  for (let i = 0; i < 20; i++) {
    if (!(await probe(opts, 1000))) break;
    await sleep(400);
    for (const pid of pidsOnPort(port)) {
      try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
      catch { /* ignore */ }
    }
  }

  clearInFlight(port);
  for (const f of ['server.pid', 'watchdog.pid', 'in-flight', 'last-activity',
    'stopping', 'loaded-model', 'stopped-idle']) clearState(port, f);

  return !(await probe(opts, 1000));
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function chat(opts) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const res = await fetch(`${baseUrl(opts)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens }),
    signal: AbortSignal.timeout(opts.requestTimeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (/mapped_region|embedding lookup/i.test(text)) {
      hint = '\n  This model does not fit at its default context on this GPU. `serve` cannot cap'
        + ' the KV cache, so it cannot be served here.\n  Use a smaller model, or run it outside'
        + ' the plugin: litert-lm run <model> --max-num-tokens 1024';
    } else if (/not found|unknown model/i.test(text)) {
      hint = '\n  Check the model id: litert-lm list';
    }
    throw new Error(`the server rejected the request (HTTP ${res.status}).`
      + `\n  ${text.slice(0, 500).trim()}${hint}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------

const HELP = `
gemma-client — call a local LiteRT-LM model (OpenAI-compatible, offline)

Usage:
  gemma-client [options] "<prompt>"
  <stdin> | gemma-client [options] ["<prompt>"]

Options:
  --model <id>        Imported model id (default: ${DEFAULTS.model})
  --system <text>     System instruction
  --max-tokens <n>    Response cap (default: ${DEFAULTS.maxTokens})
  --port <n>          Server port (default: ${DEFAULTS.port})
  --idle-timeout <s>  Idle seconds before shutdown; 0 disables (default: ${DEFAULTS.idleTimeout})
  --json              Print the raw API response
  --check             Report readiness without starting anything
  --list              List served model ids
  --stop              Stop server and watchdog, release memory
  -h, --help          This message

Notes:
  One model is resident at a time; naming another forces a full reload.
  First call after idle pays engine init. Warm calls are fast.
`.trim();

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.action === 'help') { process.stdout.write(HELP + '\n'); return; }

  if (opts.action === 'stop') {
    const wasUp = await probe(opts);
    const nowDown = await stopProcesses(opts);
    if (!wasUp) {
      process.stdout.write('Server was not running; state cleared.\n');
    } else if (nowDown) {
      process.stdout.write('Server stopped; accelerator memory released.\n');
    } else {
      throw new Error(`the server on ${baseUrl(opts)} is still responding after being asked to `
        + 'stop.\n  Something else may own the port. Inspect it, then retry.');
    }
    return;
  }

  if (opts.action === 'check') {
    const up = await probe(opts);          // must not start anything (T033)
    reconcileState(opts.port, Boolean(up));
    const lines = [`server   : ${up ? `up at ${baseUrl(opts)}` : 'not running (starts on demand)'}`];
    if (up) {
      const ids = (up.data ?? []).map((m) => m.id);
      lines.push(`models   : ${ids.length ? ids.join(', ') : '(none imported)'}`);
      lines.push(`default  : ${opts.model}${ids.includes(opts.model) ? '' : '  <-- NOT IMPORTED'}`);
      const loaded = readState(opts.port, 'loaded-model');
      if (loaded) lines.push(`resident : ${loaded}`);
    } else {
      lines.push(`default  : ${opts.model} (unverified — server is down)`);
    }
    lines.push(`idle     : ${opts.idleTimeout === 0 ? 'disabled' : `${opts.idleTimeout}s`}`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (opts.action === 'list') {
    const { models } = await ensureServer(opts);
    for (const m of models.data ?? []) process.stdout.write(`${m.id}\n`);
    return;
  }

  const piped = await readStdin();
  if (piped) opts.prompt = opts.prompt ? `${opts.prompt}\n\n${piped}` : piped;
  if (!opts.prompt) {
    throw new UsageError('no prompt supplied (pass an argument or pipe input). Try --help.');
  }

  await ensureServer(opts);

  // Model-switch warning (FR-026): the engine holds one model; switching reloads it.
  const loaded = readState(opts.port, 'loaded-model');
  if (loaded && loaded !== opts.model) {
    process.stderr.write(
      `[gemma] '${opts.model}' is not the resident model ('${loaded}'). The engine holds one `
      + 'model at a time, so this forces a full teardown and re-init — expect tens of seconds.\n'
      + '[gemma] Do NOT interleave models in a loop on the GPU backend: repeated re-init has '
      + 'been observed to hang the display driver (bugcheck 0x116, VIDEO_TDR_ERROR). Stop the '
      + 'server between models instead: --stop\n');
  }

  // Activity accounting (T057). in-flight MUST fall on every exit path, or a crashed
  // client pins the server alive forever.
  touchActivity(opts.port);
  const marker = acquireInFlight(opts.port);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseInFlight(marker);
    touchActivity(opts.port);
  };
  const onSignal = () => { release(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let resp;
  try {
    resp = await chat(opts);
    writeState(opts.port, 'loaded-model', opts.model);
  } finally {
    release();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (opts.json) { process.stdout.write(JSON.stringify(resp, null, 2) + '\n'); return; }

  const choice = resp.choices?.[0];
  if (choice?.message?.tool_calls) {
    // The plugin surfaces tool calls; it never executes them (FR-034).
    process.stdout.write(JSON.stringify(choice.message.tool_calls, null, 2) + '\n');
  } else {
    process.stdout.write((choice?.message?.content ?? '(empty response)') + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[gemma] ${err.message}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
});
