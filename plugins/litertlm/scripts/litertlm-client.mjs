#!/usr/bin/env node
/**
 * litertlm-client — call a local LiteRT-LM model from Claude Code.
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

// The marker rule lives in one file so this and the watchdog cannot drift apart.
import { pidAlive, reapMarkers } from './marker-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9379,
  // Must match the id `/litertlm:setup` tells a new user to import as. A default
  // naming some other id makes the very first call fail with "model not found",
  // so the SHIPPED value is not a preference — it is a contract with setup.md.
  //
  // LITERT_LM_PLUGIN_MODEL overrides it per machine, which is where a personal
  // preference belongs: changing the shipped constant would break every fresh
  // install that followed the documented import.
  model: process.env.LITERT_LM_PLUGIN_MODEL || 'gemma4-e4b',
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

/** Drop every marker. Only correct once we have killed the server ourselves. */
function clearInFlight(port) {
  try {
    rmSync(join(stateDir(port), IN_FLIGHT_DIR), { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Drop stale markers. What counts as stale is defined once, in marker-state.mjs.
 *
 * Never prune by server reachability. A model switch tears the engine down and
 * rebuilds it, so the server is legitimately unreachable for tens of seconds
 * *while a request is in flight* — the watchdog tolerates exactly that (see
 * UNREACHABLE_TOLERANCE). If this pruned on unreachability instead, any second
 * invocation landing in that window — even a read-only `--check` — would delete a
 * live client's marker, the watchdog would then count zero in flight, and it would
 * be free to kill the server mid-generation. That is the failure the marker files
 * replaced the in-flight counter to prevent; pruning on reachability reintroduces it.
 */
function pruneInFlight(port) {
  reapMarkers(join(stateDir(port), IN_FLIGHT_DIR));   // live count is the watchdog's concern
}

const touchActivity = (port) => writeState(port, 'last-activity', Date.now());

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
 *
 * Every decision here keys off PROCESS LIVENESS, never off server reachability.
 * "The server did not answer just now" and "the server is gone" are different
 * claims: a model switch produces the first for tens of seconds at a stretch. The
 * watchdog already distinguishes them (UNREACHABLE_TOLERANCE); this must agree
 * with it, or the two supervisors race and the client wins by deleting state the
 * watchdog is still relying on.
 */
function reconcileState(port, serverUp) {
  if (livePid(port, 'watchdog.pid') === null) clearState(port, 'watchdog.pid');
  if (livePid(port, 'server.pid') === null) clearState(port, 'server.pid');

  // Owner-liveness only — see pruneInFlight for why reachability must not decide.
  pruneInFlight(port);

  // `stopping` is the watchdog's handshake, and it stays set through a drain loop
  // that mostly runs AFTER the socket closes. Clearing it because the server is
  // unreachable would therefore erase it during almost the whole shutdown, letting
  // the next client walk past awaitNotStopping and start a second server while the
  // first watchdog is still tearing state down. It is stale only if its author died.
  if (livePid(port, 'watchdog.pid') === null) clearState(port, 'stopping');

  if (!serverUp && livePid(port, 'server.pid') === null) {
    clearState(port, 'in-flight');          // legacy counter from older installs
    clearState(port, 'loaded-model');
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ...DEFAULTS, prompt: '', system: null, json: false, action: 'chat',
    modelExplicit: false,
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
      // modelExplicit records that the flag decided this, not the environment —
      // reporting the wrong source is worse than reporting none.
      case '--model': opts.model = needValue(a, argv[++i]); opts.modelExplicit = true; break;
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
  process.stderr.write('[litertlm] server is shutting down; waiting for it to exit...\n');
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
    process.stderr.write('[litertlm] warning: idle watchdog failed to start; the server will '
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
      '[litertlm] the server had been stopped to free accelerator memory after going idle'
      + `${agoS === null ? '' : ` (${agoS}s ago)`}; restarting it, so this request pays engine `
      + 'initialisation and is slower than usual. Later calls will be fast.\n');
  } else {
    process.stderr.write(`[litertlm] starting litert-lm server on ${baseUrl(opts)} ...\n`);
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
  // Prune, not wipe: another client may have acquired a marker against this same
  // new server between our spawn and this line.
  pruneInFlight(opts.port);
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

/**
 * Stop our server and watchdog.
 *
 * `ours` says whether a litert-lm-shaped server actually answered on this port. It
 * gates killing whoever owns the socket, because that step is otherwise a licence
 * to terminate an arbitrary process: the port is a guess, not an identity. Pids we
 * recorded ourselves are always fair game — we started them.
 */
async function stopProcesses(opts, ours) {
  const port = opts.port;

  const recorded = ['watchdog.pid', 'server.pid']
    .map((n) => Number.parseInt(readState(port, n, ''), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  for (const pid of [...recorded, ...(ours ? pidsOnPort(port) : [])]) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Confirm the port actually closed rather than assuming SIGTERM landed.
  if (ours) {
    for (let i = 0; i < 20; i++) {
      if (!(await probe(opts, 1000))) break;
      await sleep(400);
      for (const pid of pidsOnPort(port)) {
        try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
        catch { /* ignore */ }
      }
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

  let res;
  try {
    res = await fetch(`${baseUrl(opts)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens }),
      signal: AbortSignal.timeout(opts.requestTimeoutMs),
    });
  } catch (err) {
    // The server drops the connection rather than returning an HTTP error for some
    // failures, so `fetch failed` is all Node gives us. Say something useful.
    throw new Error(
      `lost the connection to the server mid-request (${err.message}).\n`
      + '  The server may have exited while loading the model — a model too large for '
      + 'available memory is the usual cause.\n'
      + `  Check what is available:  node <this script> --list\n`
      + '  Then retry naming one of those with --model <id>.');
  }

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
litertlm-client — call a local LiteRT-LM model (OpenAI-compatible, offline)

Usage:
  litertlm-client [options] "<prompt>"
  <stdin> | litertlm-client [options] ["<prompt>"]

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

Environment:
  LITERT_LM_PLUGIN_MODEL   Override the default model id for this machine
  LITERT_LM_PLUGIN_RUNTIME Override the runtime state directory

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
    // A successful /v1/models is what identifies the socket owner as ours. Without
    // it we still stop what we recorded, but we do not shoot at the port.
    const wasUp = await probe(opts);
    const strangers = wasUp ? [] : pidsOnPort(opts.port);
    const nowDown = await stopProcesses(opts, Boolean(wasUp));
    if (!wasUp) {
      process.stdout.write('Server was not running; state cleared.\n');
      if (strangers.length) {
        process.stderr.write(
          `[litertlm] note: pid ${strangers.join(', ')} is listening on port ${opts.port} but did `
          + 'not answer /v1/models, so it is not this plugin\'s server and was left alone.\n'
          + `  If you meant to free the port, stop that process yourself, or use --port <n>.\n`);
      }
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
    // Name the source of the default. An override that cannot be seen is one the
    // user cannot debug — "why is it loading that model?" has to be answerable here.
    const via = (process.env.LITERT_LM_PLUGIN_MODEL && !opts.modelExplicit)
      ? '  (via LITERT_LM_PLUGIN_MODEL)' : '';
    const lines = [`server   : ${up ? `up at ${baseUrl(opts)}` : 'not running (starts on demand)'}`];
    if (up) {
      const ids = (up.data ?? []).map((m) => m.id);
      lines.push(`models   : ${ids.length ? ids.join(', ') : '(none imported)'}`);
      lines.push(`default  : ${opts.model}${via}${ids.includes(opts.model) ? '' : '  <-- NOT IMPORTED'}`);
      if (!ids.includes(opts.model) && ids.length) {
        lines.push(`           pass --model <id> to use one of the above, `
          + `or import it as '${opts.model}'`);
      }
      const loaded = readState(opts.port, 'loaded-model');
      if (loaded) lines.push(`resident : ${loaded}`);
    } else {
      lines.push(`default  : ${opts.model}${via} (unverified — server is down)`);
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

  const { models } = await ensureServer(opts);

  // Fail fast on an unknown model. Sending it anyway makes the server close the
  // connection, which surfaces as a bare "fetch failed" that names nothing.
  const available = (models?.data ?? []).map((m) => m.id);
  if (available.length && !available.includes(opts.model)) {
    throw new Error(
      `no model named '${opts.model}' is available.\n`
      + `  Imported: ${available.join(', ')}\n`
      + '  Pass one of those with --model <id>, or import it:\n'
      + '    litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm '
      + `gemma-4-E4B-it.litertlm ${opts.model}`);
  }

  // Model-switch warning (FR-026): the engine holds one model; switching reloads it.
  const loaded = readState(opts.port, 'loaded-model');
  if (loaded && loaded !== opts.model) {
    process.stderr.write(
      `[litertlm] '${opts.model}' is not the resident model ('${loaded}'). The engine holds one `
      + 'model at a time, so this forces a full teardown and re-init — expect tens of seconds.\n'
      + '[litertlm] Do NOT interleave models in a loop on the GPU backend: repeated re-init has '
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
  process.stderr.write(`[litertlm] ${err.message}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
});
