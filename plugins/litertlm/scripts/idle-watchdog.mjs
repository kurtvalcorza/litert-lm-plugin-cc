#!/usr/bin/env node
/**
 * idle-watchdog — stop an idle litert-lm server so it stops holding accelerator memory.
 *
 * `litert-lm serve` has no idle shutdown of its own, and the client talks to it
 * directly, so there is no in-band place to observe traffic. This supervises
 * out-of-band instead: the client records activity in small state files, and this
 * process polls them.
 *
 * Contract: specs/001-local-gemma-plugin/contracts/runtime-state.md
 *
 * Dependency-free by constitution (Principle III): Node standard library only.
 * Started detached by litertlm-client.mjs; never invoked by a user directly.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// The marker rule lives in one file so this and the client cannot drift apart.
import { reapMarkers } from './marker-state.mjs';

// So does the ownership rule. This file used to be the weaker of the two readers:
// it accepted a recorded `server.pid` on bare liveness, with none of the checks the
// client applied, so the supervisor could SIGTERM a bystander the client would have
// refused to touch. One home, one rule, no weaker copy.
import {
  forgetIdentities, formatPidRecord, identities, isRecordedProcess, looksLikeLitertLmServe,
  parsePidRecord, pidsOnPort, recordIsStale, signallablePid, startToken,
} from './process-identity.mjs';

const POLL_INTERVAL_MS = 5000;

/**
 * Backstop for a leaked in-flight counter (T056). A client that crashes between
 * incrementing and decrementing would otherwise pin accelerator memory until reboot.
 * No legitimate request outlives this, and the alternative failure is worse.
 */
const HARD_CEILING_MULTIPLIER = 4;
const HARD_CEILING_FLOOR_MS = 30 * 60 * 1000;

/**
 * Consecutive failed probes before concluding the server is really gone. A model
 * switch makes it unreachable for tens of seconds; at a 5s poll this tolerates
 * roughly two minutes of legitimate downtime.
 */
const UNREACHABLE_TOLERANCE = 24;

function parseArgs(argv) {
  const opts = { port: 9379, idleTimeout: 900, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--idle-timeout') opts.idleTimeout = Number(argv[++i]);
    else if (argv[i] === '--host') opts.host = argv[++i];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function stateDir(port) {
  const base = process.env.LITERT_LM_PLUGIN_RUNTIME
    ?? join(homedir() || tmpdir(), '.litert-lm', 'plugin-runtime');
  return join(base, String(port));
}

const statePath = (name) => join(stateDir(opts.port), name);

function readState(name, fallback = null) {
  try { return readFileSync(statePath(name), 'utf8').trim(); } catch { return fallback; }
}

function writeState(name, value) {
  try {
    mkdirSync(stateDir(opts.port), { recursive: true });
    writeFileSync(statePath(name), String(value), 'utf8');
  } catch { /* ignore */ }
}

function clearState(name) {
  try { rmSync(statePath(name), { force: true }); } catch { /* ignore */ }
}

/** When a state file was last written, or null if it is not there. */
function stateWrittenAt(name) {
  try { return statSync(statePath(name)).mtimeMs; } catch { return null; }
}

/**
 * Take the supervisor slot for this port, or report that someone else holds it.
 *
 * `wx` makes the create atomic, so of two watchdogs racing exactly one wins and the
 * loser stands down rather than overwriting. A merely stale file — a dead pid, or
 * one written before this boot — is not a claim, and is removed so an abandoned
 * record cannot lock the port out of supervision forever.
 *
 * Reclaiming a stale record is a RENAME, not a re-read followed by an unlink. Those
 * are two path operations, and two watchdogs could both read the same stale bytes,
 * both conclude they may delete, and the second one delete the record the first had
 * just published. `rename` is atomic and consumes the name: exactly one reclaimer
 * moves the file aside, the other gets ENOENT and stands down. If the bytes we moved
 * turn out not to be the ones we judged — someone published in the gap — we put them
 * back with the same exclusive create and withdraw.
 *
 * Only a watchdog writes this file, and only before it begins supervising — never
 * after deciding to stand down. That is what keeps "whoever wrote last is alive"
 * true, and it is why the client no longer publishes this record on our behalf.
 */
function publish(record) {
  mkdirSync(stateDir(opts.port), { recursive: true });
  writeFileSync(statePath('watchdog.pid'), record, { encoding: 'utf8', flag: 'wx' });
}

function claimWatchdogSlot() {
  const record = formatPidRecord(process.pid);       // one lookup, not one per attempt
  try {
    publish(record);
    return true;
  } catch { /* someone holds the name; it may be stale */ }

  const raw = readState('watchdog.pid', '');
  if (!recordIsStale(parsePidRecord(raw), stateWrittenAt('watchdog.pid'))) return false;

  const aside = statePath(`watchdog.pid.reclaim.${process.pid}`);
  try {
    renameSync(statePath('watchdog.pid'), aside);    // atomic: only one of us wins
  } catch {
    return false;                                    // another reclaimer took it
  }

  try {
    // What we moved must be what we judged. If it changed, a live watchdog published
    // in the gap and we are holding its record — hand it back rather than replace it.
    if (readFileSync(aside, 'utf8').trim() !== raw) {
      try { publish(readFileSync(aside, 'utf8')); } catch { /* slot already retaken */ }
      return false;
    }
    publish(record);
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(aside, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * The pid recorded under `name`, but only if it is provably still that process.
 *
 * Authority-grade at both call sites, and affordable at both: this process is
 * detached and long-lived, so a lookup at start-up and another when it decides to
 * terminate something are not on anyone's interactive path.
 */
const ownedPid = (name) =>
  signallablePid(parsePidRecord(readState(name, '')), stateWrittenAt(name));

/**
 * Count live in-flight requests, reaping stale markers on the way.
 *
 * Both the predicate and the traversal come from marker-state.mjs, so this cannot
 * disagree with the client about which markers are real — the count and the pruning
 * are one pass under one rule. Reaping here is what stops a crashed client pinning
 * accelerator memory forever.
 */
function countInFlight() {
  return reapMarkers(join(stateDir(opts.port), 'in-flight.d'));
}

async function serverReachable() {
  try {
    const res = await fetch(`http://${opts.host}:${opts.port}/v1/models`,
      { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stop the server this watchdog supervises — and only that one.
 *
 * An earlier version ran `Get-Process litert-lm | Stop-Process -Force` (and `pkill -f
 * 'litert-lm serve'` on POSIX), which kills EVERY litert-lm process on the machine.
 * State here is deliberately keyed by port so two servers can coexist, and the
 * client exposes --port, so that global kill contradicted the design: it would take
 * out a server on another port, an interactive `litert-lm run`, or a benchmark. On
 * the GPU backend an abrupt teardown of an unrelated process is not free — repeated
 * re-init is what has been observed to hang the display driver (bugcheck 0x116).
 *
 * Narrowing to the port was necessary but not sufficient: the port is a location,
 * not an identity, and an unrelated OpenAI-compatible server sitting on it was still
 * a target. Every pid is now proven before it is signalled — socket owners by their
 * command line, the recorded pid by the start token written when it was spawned.
 * Anything unprovable is left running.
 */
function ourTargets() {
  const listening = pidsOnPort(opts.port);
  identities(listening);                              // one lookup for all of them
  const targets = listening.filter(looksLikeLitertLmServe)
    .map((pid) => ({ pid, token: startToken(pid) }));
  const recorded = ownedPid('server.pid');
  if (recorded !== null && !targets.some((t) => t.pid === recorded)) {
    targets.push({ pid: recorded, token: startToken(recorded) });
  }
  return targets;
}

/**
 * Signal exactly this set. It takes the snapshot rather than deriving its own, so
 * the initial SIGTERM and every escalation act on ONE ownership decision. Deriving
 * it here as well left a window between the two lookups in which a new
 * `litert-lm serve` could take the port and receive a signal meant for its
 * predecessor — and on Windows each lookup starts PowerShell, so that window was
 * not small.
 */
function terminateServer(targets) {
  for (const { pid } of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/**
 * Of `targets`, those the OS says are STILL the same process, asked afresh.
 *
 * The cache is dropped first: it was filled before we signalled, so it would still
 * be describing processes that have since exited and would confirm a replacement
 * that inherited the pid. See the scope note on the cache in process-identity.mjs.
 *
 * Deliberately not intersected with the port. Requiring a target to still be
 * LISTENING made "closed its socket" mean "exited" — and a server that closes the
 * listener on SIGTERM and then hangs in teardown, still holding accelerator memory,
 * is exactly the case where this watchdog has to keep pressing rather than write
 * `stopped-idle` and walk away.
 */
function stillOurs(targets) {
  const pids = targets.map((t) => t.pid);
  forgetIdentities(pids);
  identities(pids);
  return targets.filter((t) => isRecordedProcess(t.pid, t.token)).map((t) => t.pid);
}

function cleanupAndExit(code = 0) {
  // Release ownership BEFORE the handshake. A client that sees `stopping` disappear
  // concludes the shutdown is over and immediately asks whether a watchdog is live;
  // if `watchdog.pid` still named this (exiting) process it would decline to start
  // one, and the server it goes on to launch would never be supervised.
  const mine = parsePidRecord(readState('watchdog.pid', ''));
  if (mine?.pid === process.pid) clearState('watchdog.pid');
  clearState('stopping');
  process.exit(code);
}

async function main() {
  if (!Number.isFinite(opts.idleTimeout) || opts.idleTimeout <= 0) {
    process.exit(0);                                  // disabled; nothing to supervise
  }

  // Single-supervisor rule (T055): never compete with a live watchdog on this port.
  // Proven identity, not bare liveness — a reused pid here used to make a fresh
  // watchdog stand down in favour of a supervisor that does not exist, and the
  // server it was meant to supervise would then hold accelerator memory until
  // someone ran --stop by hand.
  const existing = ownedPid('watchdog.pid');
  if (existing !== null && existing !== process.pid) process.exit(0);
  if (!claimWatchdogSlot()) process.exit(0);         // someone beat us to it

  const idleMs = opts.idleTimeout * 1000;
  const ceilingMs = Math.max(idleMs * HARD_CEILING_MULTIPLIER, HARD_CEILING_FLOOR_MS);
  let missedProbes = 0;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);

    // Another watchdog took over — stand down rather than double-terminate.
    const owner = parsePidRecord(readState('watchdog.pid', ''));
    if (owner?.pid !== process.pid) process.exit(0);

    // A model switch tears the engine down and re-initialises it, so the server is
    // legitimately unreachable for tens of seconds *while a request is in flight*.
    // Treating the first failed probe as "gone" would abandon supervision at the
    // busiest moment and clear in-flight out from under a live request. Require a
    // sustained absence instead.
    if (!(await serverReachable())) {
      missedProbes += 1;
      if (missedProbes < UNREACHABLE_TOLERANCE) continue;
      clearState('server.pid');
      // The engine died with someone else's hand on it, so nothing is resident.
      // Leaving `loaded-model` behind makes the next client warn about a model
      // switch that is not happening.
      clearState('loaded-model');
      cleanupAndExit(0);        // deliberately does not touch in-flight
    }
    missedProbes = 0;

    const inFlight = countInFlight();
    const lastActivity = Number.parseInt(readState('last-activity', String(Date.now())), 10)
      || Date.now();
    const idleFor = Date.now() - lastActivity;

    if (idleFor < idleMs) continue;

    // FR-024: a request in flight is never interrupted, however long it runs —
    // unless activity has been silent past the hard ceiling, which means the
    // counter leaked rather than work being genuinely in progress (T056).
    if (inFlight > 0 && idleFor < ceilingMs) continue;

    // Nothing here is provably ours. That happens when the server on this port was
    // adopted and cannot be identified as a litert-lm — another OpenAI-compatible
    // process, say. Stand down without touching it, and WITHOUT the shutdown
    // bookkeeping: clearing state and writing `stopped-idle` would record that we
    // released accelerator memory we never held, and the next client would be told a
    // server had been idle-stopped when it is still running and still unsupervised.
    const targets = ourTargets();
    if (!targets.length) cleanupAndExit(0);

    // Signal before acting, so a client cannot connect to a dying server (FR-025).
    writeState('stopping', Date.now());
    terminateServer(targets);

    // Wait on OUR targets, not on the endpoint: something else may hold or take the
    // port, and its answering says nothing about whether our server is gone.
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const surviving = stillOurs(targets);
      if (!surviving.length) break;
      // Still running: escalate, but only on owners proven above AND re-proven now —
      // a process that inherited the pid we just killed must not inherit the SIGKILL
      // along with it, which a numeric check would wave straight through.
      for (const pid of surviving) {
        try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
        catch { /* ignore */ }
      }
    }

    clearState('server.pid');
    try {
      rmSync(join(stateDir(opts.port), 'in-flight.d'), { recursive: true, force: true });
    } catch { /* ignore */ }
    clearState('in-flight');   // legacy counter from older installs
    clearState('loaded-model');

    // Leave a durable breadcrumb. `stopping` is cleared on the way out, so by the
    // time the next client runs there would otherwise be nothing left to
    // distinguish "we shut this down to free memory" from "never started". The
    // client consumes and clears this to explain why its request is slow (FR-025).
    writeState('stopped-idle', Date.now());

    cleanupAndExit(0);
  }
}

main().catch(() => cleanupAndExit(1));
