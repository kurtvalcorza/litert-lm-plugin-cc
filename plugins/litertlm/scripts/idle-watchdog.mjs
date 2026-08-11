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
  formatPidRecord, identifyPortOwners, looksLikeLitertLmServe, parsePidRecord,
  resolveTargets, signallablePid, startToken,
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
  // `spawnedAt` defaults to now: started by hand, nothing can have stopped us before
  // we existed. The client passes its own value so the comparison covers the whole
  // window between the spawn and this process getting far enough to read state.
  const opts = { port: 9379, idleTimeout: 900, host: '127.0.0.1', spawnedAt: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--idle-timeout') opts.idleTimeout = Number(argv[++i]);
    else if (argv[i] === '--host') opts.host = argv[++i];
    else if (argv[i] === '--spawned-at') opts.spawnedAt = Number(argv[++i]);
  }
  if (!Number.isFinite(opts.spawnedAt)) opts.spawnedAt = Date.now();
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
/** Has a `--stop` landed since we were spawned? */
function invalidatedByStop() {
  const stoppedAt = Number.parseInt(readState('stopped-at', ''), 10);
  return Number.isFinite(stoppedAt) && stoppedAt > opts.spawnedAt;
}

function publish(record) {
  // Checked here, immediately before the write, and not only once at start-up.
  // Everything between those two points is slow — establishing our own identity costs
  // a process lookup, seconds on Windows — and a `--stop` landing inside it cannot
  // see us, because we are in no pid file yet. Publishing afterwards would install a
  // supervisor for a server that stop had already torn down.
  if (invalidatedByStop()) throw new Error('stopped while claiming');
  mkdirSync(stateDir(opts.port), { recursive: true });
  writeFileSync(statePath('watchdog.pid'), record, { encoding: 'utf8', flag: 'wx' });
}

function claimWatchdogSlot() {
  const record = formatPidRecord(process.pid);       // one lookup, not one per attempt

  // A record with no token is one nobody can ever act on. `formatPidRecord` falls
  // back to a bare pid when the identity lookup fails, and `signallablePid` refuses
  // exactly that — so publishing it would install a supervisor that a later `--stop`
  // is structurally unable to signal, and the slot would stay occupied by something
  // unkillable until the pid died on its own. Better to claim nothing: the next
  // client sees no supervisor and spawns one whose lookup may well succeed.
  if (parsePidRecord(record)?.token == null) return false;
  try {
    publish(record);
    return true;
  } catch { /* someone holds the name; it may be stale */ }

  // Reclaim when the incumbent cannot be PROVEN, not merely when it looks dead.
  //
  // `recordIsStale` is the cheap hygiene test, and it says "not stale" for a live pid
  // written after boot — including one that was reused, whose token no longer
  // matches. `main()` has already paid for the authority-grade answer by this point
  // and knows the slot is unowned; falling back to the weaker test here threw that
  // away and stood the new supervisor down in favour of a process that is not a
  // watchdog at all. Off the interactive path, so the lookup costs nothing extra.
  const raw = readState('watchdog.pid', '');
  if (signallablePid(parsePidRecord(raw), stateWrittenAt('watchdog.pid')) !== null) return false;

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
  // Same helper the client uses, so the port is re-asked AFTER identification and a
  // pid reissued mid-lookup to a litert-lm on another port cannot be adopted as
  // ours. A listener we could not describe lands in `unidentified` rather than being
  // filed as a stranger, because "the lookup failed" is not "definitely not mine".
  //
  // Scoped to `opts.host` too — the same address this watchdog probes for liveness.
  // A litert-lm bound to another interface on this port is a different server, and
  // supervising the socket we talk to means asking about that socket, not the number.
  const { ours: targets, unidentified } =
    identifyPortOwners(opts.port, looksLikeLitertLmServe, opts.host);
  const recorded = ownedPid('server.pid');
  if (recorded !== null && !targets.some((t) => t.pid === recorded)) {
    targets.push({ pid: recorded, token: startToken(recorded) });
  }
  return { targets, unidentified };
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
  // Re-prove immediately before signalling, not from the snapshot. `ourTargets`
  // identifies the socket owner and may then spend a second lookup resolving
  // `server.pid` — seconds, on Windows — and a target that exits in that gap has its
  // number reissued. The client path was given this treatment; this one was not, so
  // the rule had two homes and only one of them was right. Again.
  for (const pid of stillOurs(targets).alive) {
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
  const { alive, unknown } = resolveTargets(targets);
  // `unknown` never gets signalled — we cannot prove it is ours — but it also cannot
  // count as gone, so it is folded in wherever the answer decides "are we finished".
  return { alive, unknown, outstanding: [...alive, ...unknown] };
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

  // A stop that happened after we were spawned invalidates us before we start.
  //
  // We are spawned detached, and publishing our pid costs an identity lookup —
  // seconds on Windows. A `--stop` landing inside that window cannot see us: we are
  // in no pid file yet, so it cannot include us in its target set, and we would then
  // publish a supervisor record over the state it had just cleared.
  //
  // The test is a timestamp, NOT a reachability probe. Asking whether the server
  // answers would reintroduce the confusion this whole file is built to avoid — a
  // model switch makes it legitimately unreachable for tens of seconds, which is why
  // UNREACHABLE_TOLERANCE exists, and a watchdog that stood down for that would leave
  // the server it was spawned for unsupervised. `stopped-at` is durable and needs no
  // clearing: an older stop is simply earlier than the next watchdog's spawn.
  if (invalidatedByStop()) process.exit(0);
  if (!claimWatchdogSlot()) process.exit(0);         // someone beat us to it

  // And once more after publishing, because the claim itself is not instantaneous.
  // A stop that landed while we were writing has already cleared the state it meant
  // to clear, so withdraw rather than stand as supervisor over nothing.
  if (invalidatedByStop()) cleanupAndExit(0);

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
    const { targets, unidentified } = ourTargets();
    // Nothing provable AND nothing unprovable: genuinely not ours, stand down clean.
    if (!targets.length && !unidentified.length) cleanupAndExit(0);

    // ANY unidentified listener defers the whole attempt, not just the case where
    // nothing else was found. Proceeding with a partial picture meant signalling the
    // proven targets, folding the unidentified one into the failure verdict, and then
    // exiting — which clears `watchdog.pid` and leaves that listener alive with no
    // supervisor at all. The previous guard only covered an empty target set, so the
    // mixed case walked straight past it. Waiting one poll costs a cycle; leaving
    // costs the thing this process exists for.
    if (unidentified.length) continue;

    // Signal before acting, so a client cannot connect to a dying server (FR-025).
    writeState('stopping', Date.now());
    terminateServer(targets);

    // Wait on OUR targets, not on the endpoint: something else may hold or take the
    // port, and its answering says nothing about whether our server is gone.
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const surviving = stillOurs(targets);
      if (!surviving.outstanding.length) break;
      // Still running: escalate, but only on owners proven above AND re-proven now —
      // a process that inherited the pid we just killed must not inherit the SIGKILL
      // along with it, which a numeric check would wave straight through.
      for (const pid of surviving.alive) {
        try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
        catch { /* ignore */ }
      }
    }

    // The verdict, taken after the last signal rather than before it. The loop
    // refreshes at the top, so a target that dies in response to the final iteration
    // would still be listed when it ends.
    await sleep(200);
    const left = stillOurs(targets);
    left.outstanding = [...new Set([...left.outstanding, ...unidentified])];
    if (left.outstanding.length) {
      // Escalation did not finish the job — a process wedged in uninterruptible I/O,
      // one the OS refused to signal, or one we could not identify at all. Publish
      // NOTHING: `stopped-idle` tells the next client that accelerator memory was
      // released, and clearing `server.pid` destroys the identity a later attempt
      // would need to find a target that is still alive but no longer listening.
      //
      // Persist that identity if nothing already records it. The survivor is often
      // the listener grandchild discovered from the port, which no pid file names —
      // the client learned to write it, and a watchdog that only exits leaves the
      // next attempt with nothing to find. The rule has to be symmetric or the
      // recovery path depends on which component happened to fail.
      // Only into a slot nothing is already using. If the recorded launcher is itself
      // among the survivors, `server.pid` is already carrying an identity worth
      // keeping, and replacing it with the listener's would trade one survivor for
      // another rather than preserve both. The client makes the same choice; there is
      // one slot, so the second survivor is left to the next attempt's discovery.
      const recorded = parsePidRecord(readState('server.pid', ''))?.pid ?? null;
      const recordedSurvived = recorded !== null && left.outstanding.includes(recorded);
      const orphan = targets.find((t) => left.outstanding.includes(t.pid)
        && t.pid !== recorded && t.token);
      if (orphan !== undefined && !recordedSurvived) {
        writeState('server.pid', `${orphan.pid} ${orphan.token}`);
      }

      // And every survivor into the same list the client keeps, not just the one the
      // single `server.pid` slot could hold. Writing only that slot meant a second
      // survivor — a launcher and a listener both refusing to die — was recorded
      // nowhere at all, and the next `--stop` could rediscover only one of them.
      const outstanding = targets.filter((t) => left.outstanding.includes(t.pid) && t.token);
      if (outstanding.length) {
        writeState('survivors', outstanding.map((t) => `${t.pid} ${t.token}`).join('\n'));
      }

      // Standing down without a report leaves the next client free to reconcile and
      // start a fresh supervisor, which will try again once the server goes idle.
      cleanupAndExit(1);
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
