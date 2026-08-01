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

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// The marker rule lives in one file so this and the client cannot drift apart.
import { pidAlive, reapMarkers } from './marker-state.mjs';

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
 * Find whatever process is listening on the port (mirrors litertlm-client.mjs).
 *
 * litert-lm is a two-stage launcher: the pid we recorded is often not the process
 * holding the socket, so the recorded pid alone is not enough to stop it.
 */
function pidsOnPort(port) {
  const run = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    } catch {
      return '';
    }
  };

  const out = process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue `
      + '| Select-Object -ExpandProperty OwningProcess'])
    : run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);

  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
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
 * Only this port's socket owners, plus the pid we recorded ourselves, are targets.
 */
function terminateServer() {
  const targets = new Set(pidsOnPort(opts.port));
  const recorded = Number.parseInt(readState('server.pid', ''), 10);
  if (pidAlive(recorded)) targets.add(recorded);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

function cleanupAndExit(code = 0) {
  // Release ownership BEFORE the handshake. A client that sees `stopping` disappear
  // concludes the shutdown is over and immediately asks whether a watchdog is live;
  // if `watchdog.pid` still named this (exiting) process it would decline to start
  // one, and the server it goes on to launch would never be supervised.
  const mine = Number.parseInt(readState('watchdog.pid', ''), 10);
  if (mine === process.pid) clearState('watchdog.pid');
  clearState('stopping');
  process.exit(code);
}

async function main() {
  if (!Number.isFinite(opts.idleTimeout) || opts.idleTimeout <= 0) {
    process.exit(0);                                  // disabled; nothing to supervise
  }

  // Single-supervisor rule (T055): never compete with a live watchdog on this port.
  const existing = Number.parseInt(readState('watchdog.pid', ''), 10);
  if (pidAlive(existing) && existing !== process.pid) process.exit(0);

  writeState('watchdog.pid', process.pid);

  const idleMs = opts.idleTimeout * 1000;
  const ceilingMs = Math.max(idleMs * HARD_CEILING_MULTIPLIER, HARD_CEILING_FLOOR_MS);
  let missedProbes = 0;

  for (;;) {
    await sleep(POLL_INTERVAL_MS);

    // Another watchdog took over — stand down rather than double-terminate.
    const owner = Number.parseInt(readState('watchdog.pid', ''), 10);
    if (owner !== process.pid) process.exit(0);

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

    // Signal before acting, so a client cannot connect to a dying server (FR-025).
    writeState('stopping', Date.now());
    terminateServer();

    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (!(await serverReachable())) break;
      // Still answering: escalate on whatever still holds the socket. SIGTERM can be
      // ignored, and a server left alive here holds accelerator memory indefinitely.
      for (const pid of pidsOnPort(opts.port)) {
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
