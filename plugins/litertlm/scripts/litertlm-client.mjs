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
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// The marker rule lives in one file so this and the watchdog cannot drift apart.
import { pidAlive, reapMarkers } from './marker-state.mjs';

// Ownership — who we are allowed to signal — is defined once, for the same reason.
// `recordIsStale` and `signallablePid` answer deliberately different questions; the
// note above them explains which belongs where, and it is worth reading before
// choosing one.
import {
  forgetIdentities, formatPidRecord, identities, identity, isRecordedProcess,
  looksLikeLitertLmServe, parsePidRecord, pidsOnPort, recordIsStale, signallablePid,
  startToken,
} from './process-identity.mjs';

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

/** When a state file was last written, or null if it is not there. */
function stateWrittenAt(port, name) {
  try { return statSync(statePath(port, name)).mtimeMs; } catch { return null; }
}

/**
 * Record a process we just spawned, with the token that re-identifies it.
 *
 * Establishing identity is not instantaneous — on Windows it starts PowerShell,
 * measured at 0.9-3.4s — and a child that dies inside that window can have its pid
 * reissued before the lookup lands. The token captured would then describe the
 * replacement, and persisting it would produce a `server.pid` that passes every
 * later identity check while naming an unrelated process: the exact failure this
 * file exists to prevent, reintroduced by the act of recording.
 *
 * So the pid is only recorded if what the OS describes is still the program we
 * launched. Checking `child.exitCode` instead does NOT work, and looked like it did:
 * the identity lookup is `spawnSync`, which blocks the event loop, so the child's
 * exit event has not been delivered yet and `exitCode` is still null when we come
 * back. The command line is evidence about the process; the handle, at that moment,
 * is only evidence about our own event loop.
 *
 * Nothing recorded means `--stop` falls back to socket-owner discovery, which is
 * the right answer when we have nothing trustworthy to say.
 */
function recordSpawnedPid(port, name, child, exe) {
  clearState(port, name);
  if (!child.pid) return false;

  const seen = identity(child.pid);
  const launched = seen !== null
    && seen.cmdline.toLowerCase().includes(exe.toLowerCase());
  if (!launched) return false;

  writeState(port, name, formatPidRecord(child.pid));
  return true;
}

const pidRecord = (port, name) => parsePidRecord(readState(port, name, ''));

/**
 * Hygiene only: is this state file dead wood? Costs nothing, kills nothing.
 *
 * See the two-questions note in process-identity.mjs for why this is deliberately
 * weaker than `ownedPids` and must never be used to justify signalling anything.
 */
const staleRecord = (port, name) =>
  recordIsStale(pidRecord(port, name), stateWrittenAt(port, name));

/**
 * Authority: of `names`, the pids we can PROVE are the processes we started.
 *
 * The verdict is `signallablePid`, in process-identity.mjs — the watchdog applies
 * the identical rule, and it is defined once for the same reason the marker rule is.
 * What is added here is batching: identity costs a PowerShell start-up per CALL on
 * Windows rather than per pid, so the whole set is looked up before it is judged,
 * and the per-name calls below then read a warm cache.
 */
function ownedPids(port, names) {
  const records = names
    .map((name) => [name, pidRecord(port, name)])
    // A record the cheap tests already reject, or one carrying no token, is refused
    // by `signallablePid` regardless — looking it up would buy nothing and cost a
    // subprocess. Tokenless is the common case on the first run after upgrading.
    .filter(([name, rec]) =>
      rec !== null && rec.token !== null && !staleRecord(port, name));

  identities(records.map(([, rec]) => rec.pid));            // one lookup for all

  const owned = new Map();
  for (const [name, rec] of records) {
    const pid = signallablePid(rec, stateWrittenAt(port, name));
    if (pid !== null) owned.set(name, pid);
  }
  return owned;
}

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
  // Hygiene, not authority: this function only deletes files. Proving identity here
  // would put a process lookup on every invocation — `--check` included — to protect
  // an operation that cannot hurt anything. See process-identity.mjs.
  const watchdogGone = staleRecord(port, 'watchdog.pid');
  const serverGone = staleRecord(port, 'server.pid');

  if (watchdogGone) clearState(port, 'watchdog.pid');
  if (serverGone) clearState(port, 'server.pid');

  // Owner-liveness only — see pruneInFlight for why reachability must not decide.
  pruneInFlight(port);

  // `stopping` is the watchdog's handshake, and it stays set through a drain loop
  // that mostly runs AFTER the socket closes. Clearing it because the server is
  // unreachable would therefore erase it during almost the whole shutdown, letting
  // the next client walk past awaitNotStopping and start a second server while the
  // first watchdog is still tearing state down. It is stale only if its author died.
  if (watchdogGone) clearState(port, 'stopping');

  if (!serverUp && serverGone) {
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
  //
  // Hygiene-grade, and this one is a judgement rather than a free win. Erring
  // towards starting a watchdog is self-correcting — the new one proves identity,
  // sees an owner that is not itself, and exits. Erring the other way is not: a
  // `watchdog.pid` naming a pid that was reused within this boot suppresses the
  // spawn, and the server then holds accelerator memory with nobody supervising it.
  //
  // Accepted anyway, because this call sits on the warm `ask` path — it runs every
  // time an existing server is adopted — and proving identity here would put ~930ms
  // onto every request to close a window that needs the watchdog to die AND its
  // exact pid to be handed to something else. The consequence is also recoverable
  // and visible: `--stop` still identifies and stops the server correctly, since
  // that path IS authority-grade. Revisit if a phantom supervisor is ever observed.
  if (!staleRecord(opts.port, 'watchdog.pid')) return;
  try {
    const child = spawn(
      process.execPath,
      [join(HERE, 'idle-watchdog.mjs'), '--port', String(opts.port),
        '--idle-timeout', String(opts.idleTimeout)],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    // Deliberately does NOT record the watchdog. The watchdog publishes its own pid,
    // and it is the only writer of that file.
    //
    // Recording it here was an optimisation — the record appears immediately instead
    // of after the watchdog's own identity lookup, so a client arriving in between
    // does not spawn a redundant supervisor. It cost correctness. A parent can only
    // publish a claim its child has already abandoned: two clients adopt one warm
    // server, both spawn a watchdog, the loser's watchdog sees a proven owner and
    // exits, and the loser's CLIENT then writes that now-dead pid over the winner's
    // record. The survivor reads an owner that is not itself and exits too, leaving
    // the server unsupervised.
    //
    // A watchdog never writes after deciding to stand down, so making it the sole
    // writer removes the whole class rather than arbitrating it. The redundant spawn
    // this reintroduces is a node start-up that immediately exits.
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

  // Record the identity now, while the process is still the one we just spawned —
  // and only if the OS still says so. Asked for later, the answer could already be
  // about whoever inherited the pid.
  recordSpawnedPid(opts.port, 'server.pid', child, exe);
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
 * Split the port's listeners into ours and everyone else's.
 *
 * A reply to `/v1/models` used to stand in for this, and it is not an ownership
 * test — it is a protocol test that every OpenAI-compatible server passes. On this
 * host that made `--stop` terminate an unrelated server and report success.
 *
 * The command line answers the question the probe could not. It has to, because the
 * socket owner is a process we never spawned: `litert-lm serve` is a three-stage
 * launcher (litert-lm.exe -> uv shim -> python) and the listener is a grandchild
 * with no entry in our state. See process-identity.mjs for why descent from our
 * recorded pid was considered and rejected.
 */
function classifyPortOwners(port) {
  const listening = pidsOnPort(port);
  identities(listening);                              // one lookup for all of them
  // Keep each owner's start token, not just its number. Escalation happens after we
  // have already killed things, and by then a pid we proved is a pid that may have
  // been reissued — the number alone stops meaning anything the moment it dies.
  const ours = listening.filter(looksLikeLitertLmServe)
    .map((pid) => ({ pid, token: startToken(pid) }));
  const ourSet = new Set(ours.map((o) => o.pid));
  return { ours, strangers: listening.filter((p) => !ourSet.has(p)) };
}

/**
 * Of the owners we proved, those still on the port AND still the same process.
 *
 * The cache is dropped first on purpose: it was populated before we sent SIGTERM,
 * so without this it would keep describing processes that have since exited and
 * happily confirm their replacements. Intersecting pid numbers is not enough — that
 * is the whole premise of this change, and it applies to our own frozen set too.
 */
function stillOurs(port, ours) {
  const onPort = new Set(pidsOnPort(port));
  const candidates = ours.filter((o) => onPort.has(o.pid));
  forgetIdentities(candidates.map((o) => o.pid));
  identities(candidates.map((o) => o.pid));
  return candidates.filter((o) => isRecordedProcess(o.pid, o.token)).map((o) => o.pid);
}

/**
 * Stop our server and watchdog — and nothing else.
 *
 * Every target is proven before it is signalled: recorded pids by the start token
 * written when we spawned them, socket owners by their command line. A process that
 * cannot be proven is left running and reported, never signalled on suspicion.
 *
 * State is cleared either way. "We could not identify anything to stop" and "there
 * is stale state here" are different facts, and the second is safe to act on alone.
 */
async function stopProcesses(opts) {
  const port = opts.port;

  const recorded = [...ownedPids(port, ['watchdog.pid', 'server.pid']).values()];
  const { ours, strangers } = classifyPortOwners(port);
  const signalled = [...new Set([...recorded, ...ours.map((o) => o.pid)])];

  for (const pid of signalled) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Confirm the port actually closed rather than assuming SIGTERM landed.
  //
  // Escalation is restricted to the owners proven above AND re-proven now. Freezing
  // the pid numbers is necessary but not sufficient: under pid churn the listener we
  // signalled can exit and an unrelated process inherit both its number and the port
  // before the next pass, at which point a numeric intersection would hand it a
  // SIGKILL. `stillOurs` re-asks the OS instead of trusting the number.
  if (ours.length) {
    for (let i = 0; i < 20; i++) {
      if (!(await probe(opts, 1000))) break;
      await sleep(400);
      for (const pid of stillOurs(port, ours)) {
        try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
        catch { /* ignore */ }
      }
    }
  }

  clearInFlight(port);
  for (const f of ['server.pid', 'watchdog.pid', 'in-flight', 'last-activity',
    'stopping', 'loaded-model', 'stopped-idle']) clearState(port, f);

  return { signalled, strangers, down: !(await probe(opts, 1000)) };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Below this, a lost connection is not worth blaming on prompt length.
 *
 * The measured ceilings sit around 6.5-15 KB depending on model (litertlm-review.mjs
 * DEFAULTS), so 4 KB is comfortably under the smallest of them: a payload beneath it has
 * not plausibly exhausted any token budget, and telling that caller to check its prompt
 * first would be actively wrong. `setup.md`'s readiness probe sends ~26 bytes.
 */
const SIZE_SUSPICION_BYTES = 4 * 1024;

async function chat(opts) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const body = JSON.stringify({ model: opts.model, messages, max_tokens: opts.maxTokens });

  let res;
  try {
    res = await fetch(`${baseUrl(opts)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(opts.requestTimeoutMs),
    });
  } catch (err) {
    // The server drops the connection rather than returning an HTTP error for some
    // failures, so `fetch failed` is all Node gives us. Say something useful.
    //
    // Ordered by what THIS request makes likely, not by what is likeliest in general.
    // This catch is shared by every caller — the review launcher's diffs, `ask`'s piped
    // files, `setup`'s 26-byte readiness probe — and it also catches the 15-minute
    // AbortSignal timeout. A fixed "check the prompt size first" would be right for the
    // first and flatly wrong for the third, so the size hypothesis is promoted only when
    // this payload is big enough for it to be possible.
    const bytes = Buffer.byteLength(body, 'utf8');
    const sizeSuspect = bytes >= SIZE_SUSPICION_BYTES;
    const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

    throw new Error(
      `lost the connection to the server mid-request (${err.message}).\n`
      + (sizeSuspect
        ? `  CHECK THE PROMPT SIZE FIRST — this request was ${kb(bytes)}. litert-lm 0.14.0 runs\n`
          + '  at a fixed max_num_tokens and breaks the HTTP response rather than refusing\n'
          + '  cleanly once a prompt exceeds it, so this is what an over-long prompt looks\n'
          + '  like. The ceiling is model-dependent; see litertlm-review.mjs DEFAULTS for\n'
          + '  measured figures. Send less and see if it clears.\n'
        : `  This request was only ${kb(bytes)}, so prompt length is an unlikely cause — the\n`
          + '  measured ceilings are several KB (litertlm-review.mjs DEFAULTS). Suspect the\n'
          + '  server instead: it may have exited while loading the model, which a model too\n'
          + '  large for available memory would cause, or the request may have timed out.\n')
      + '  Check what is available:  node <this script> --list\n'
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
    // The probe reports; it does not authorise. Whether anything gets signalled is
    // decided inside stopProcesses, from process identity.
    const wasUp = await probe(opts);
    const { signalled, strangers, down } = await stopProcesses(opts);

    const noteStrangers = () => {
      if (!strangers.length) return;
      process.stderr.write(
        `[litertlm] note: pid ${strangers.join(', ')} is listening on port ${opts.port}`
        + `${wasUp ? ' and answers /v1/models' : ''}, but its command line is not a litert-lm\n`
        + '  server, so it is not this plugin\'s and was left running.\n'
        + '  If you meant to free the port, stop that process yourself, or use --port <n>.\n');
    };

    if (!signalled.length) {
      // Nothing provable was ours. Clearing state is still right and still done.
      process.stdout.write(strangers.length
        ? `No server of this plugin's was running on port ${opts.port}; state cleared.\n`
        : 'Server was not running; state cleared.\n');
      noteStrangers();
    } else if (down) {
      process.stdout.write('Server stopped; accelerator memory released.\n');
      noteStrangers();
    } else {
      noteStrangers();
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
