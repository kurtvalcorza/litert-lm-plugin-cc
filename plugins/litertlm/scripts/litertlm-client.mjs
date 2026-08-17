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
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// The marker rule lives in one file so this and the watchdog cannot drift apart.
import { BOOT_TIME_MS, pidAlive, reapMarkers } from './marker-state.mjs';

// Ownership — who we are allowed to signal — is defined once, for the same reason.
// `recordIsStale` and `signallablePid` answer deliberately different questions; the
// note above them explains which belongs where, and it is worth reading before
// choosing one.
import {
  commandLaunches, forgetIdentities, formatPidRecord, identifyPortOwners, identities, identity,
  looksLikeLitertLmServe, parsePidRecord, portOwnerDiscoveryHelp, recordIsStale, resolveTargets,
  signallablePid, startGeneration, startToken,
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
 * Write a state file atomically, so a concurrent reader never sees a torn document.
 *
 * `writeState` truncates in place, which leaves a window where a reader opens an empty
 * or partial file. That is harmless for the single-token records — a half-written pid
 * fails `parsePidRecord` and is treated as absent — but not for `watchdog-request`,
 * whose reader (`handoffReplacement`) takes a JSON parse failure as "no request" and
 * exits, stranding a replacement server unsupervised. Writing to a temp file and
 * renaming it into place makes every read see either the old bytes or the new ones,
 * never a mix. The watchdog already leans on `renameSync` being atomic for its own
 * slot claim; this is the same guarantee applied to the request it publishes.
 */
function writeStateAtomic(port, name, value) {
  try {
    mkdirSync(stateDir(port), { recursive: true });
    const tmp = statePath(port, `${name}.tmp.${process.pid}.${randomUUID()}`);
    writeFileSync(tmp, String(value), 'utf8');
    try {
      renameSync(tmp, statePath(port, name));
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* leave no orphan temp behind */ }
      throw err;
    }
  } catch {
    // Best-effort, like writeState: state is an optimisation, never a reason to fail.
  }
}

/**
 * Claim a single-slot state file atomically, reclaiming only a provably-abandoned one.
 *
 * `wx` gives outright ownership when the slot is empty. When it is taken, reclamation of
 * a stale claim goes through a RENAME, not a delete-by-name — the same shape the watchdog
 * uses for its own slot in `claimWatchdogSlot`. `renameSync` is atomic and consumes the
 * name, so of two reclaimers exactly one moves the stale file aside and the other gets
 * ENOENT and stands down. A `clearState`-by-name would let both delete it, and a claim
 * one of them published in the window between the liveness check and the delete would be
 * clobbered — reintroducing the very double-claim this slot exists to prevent. If the
 * bytes moved aside are not the ones we judged stale, a live claim was published in the
 * gap; it is put back and this reclaim withdraws rather than overwrite it.
 *
 * `isLive()` reports whether the current occupant is a live claim we must not disturb.
 * Returns `'won'` (we own the slot now), `'occupied'` (a live claim holds it — wait or
 * adopt), or `'retry'` (another reclaimer is mid-flight; re-observe). Propagates a
 * non-EEXIST create failure so the caller can choose how to degrade.
 */
function claimStateSlot(port, name, record, isLive) {
  try {
    mkdirSync(stateDir(port), { recursive: true });
    writeFileSync(statePath(port, name), record, { encoding: 'utf8', flag: 'wx' });
    return 'won';
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  const raw = String(readState(port, name, '')).trim();
  if (isLive()) return 'occupied';                     // a live claim owns the slot

  const aside = statePath(port, `${name}.reclaim.${process.pid}`);
  try {
    renameSync(statePath(port, name), aside);          // atomic: one reclaimer wins
  } catch {
    return 'retry';                                    // another reclaimer moved it first
  }
  try {
    if (readFileSync(aside, 'utf8').trim() !== raw) {
      // The bytes changed between the liveness read and the rename: a claim was published
      // in the gap and is not the stale record we judged. Put it back and withdraw.
      try {
        writeFileSync(statePath(port, name), readFileSync(aside, 'utf8'),
          { encoding: 'utf8', flag: 'wx' });
      } catch { /* the name was retaken by a newer claim; leave it in place */ }
      return 'occupied';
    }
    // The name is free and we hold only the stale bytes; take the slot.
    writeFileSync(statePath(port, name), record, { encoding: 'utf8', flag: 'wx' });
    return 'won';
  } catch {
    return 'retry';                                    // the name was retaken before we wrote
  } finally {
    try { rmSync(aside, { force: true }); } catch { /* ignore */ }
  }
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

async function acquireInFlight(port, opts = null) {
  const dir = join(stateDir(port), IN_FLIGHT_DIR);

  const publish = () => {
    const marker = join(dir, `${process.pid}-${Date.now()}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, '', 'utf8');
      return marker;
    } catch {
      return null;   // tracking is best-effort; never fail a request over it
    }
  };

  // PUBLISH, THEN RE-CHECK THE HANDSHAKE. Checking `stopping` before creating the
  // marker — which is what `awaitNotStopping` does, earlier and further away — is a
  // read whose answer expires immediately: a supervisor can claim the handshake, count
  // zero markers, and still be inside its identity lookup when this marker appears,
  // after which it signals a server with a live request against it. Writing the
  // handshake first on the watchdog side does not fix that on its own, because
  // nothing here looked again.
  //
  // Two one-way tests in opposite orders is the whole protocol: the watchdog claims
  // then counts, this claims then re-reads. A marker that appears before the
  // handshake is counted; one that appears after is withdrawn by its own author. Both
  // cannot miss each other.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const marker = publish();
    if (marker === null) return null;
    if (readState(port, 'stopping') === null) return marker;

    // A shutdown owns the server right now. Stand aside rather than pin it open, wait
    // for the handshake to clear, and try again.
    releaseInFlight(marker);
    if (opts === null) return null;
    await awaitNotStopping(opts);
  }

  // NEVER FALL THROUGH UNTRACKED. Returning null here and letting the request proceed
  // would be worse than not having this protocol at all: the watchdog counts markers
  // to decide whether anything is in flight, so a request running without one is
  // exactly the request it is free to kill mid-generation. Giving up loudly is
  // recoverable — the user retries — and running unprotected is not.
  throw new Error(
    'the server is shutting down and the shutdown has not finished.\n'
    + '  This request was not started, rather than started without protection from\n'
    + '  the idle watchdog. Retry in a moment.');
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
 * The `starting` claim on this port: which generation owns it, and who published it.
 *
 * Written by `ensureServer` as `<spawnedAt> <pid>`. The pid is what makes the claim
 * falsifiable — a start that crashes cannot release its own claim, and without a way
 * to tell an abandoned claim from a live one the file would lock the port out of
 * every future start.
 */
function readStartClaim(port) {
  const m = String(readState(port, 'starting', '')).trim().match(/^(\d+)(?:\s+(\d+))?$/);
  if (m === null) return null;
  return {
    spawnedAt: Number.parseInt(m[1], 10),
    pid: m[2] === undefined ? null : Number.parseInt(m[2], 10),
  };
}

/**
 * The claim, but only if someone is still behind it.
 *
 * Hygiene-grade on purpose, and that is the right grade here: this decides whether to
 * WAIT, never whether to signal. The two questions are separated for a reason (see
 * the note in process-identity.mjs), and paying for identity on the warm start path
 * would buy nothing — the worst case of getting this wrong is a bounded wait that
 * ends in the same refusal it would have reached immediately.
 *
 * A claim with no pid is treated as abandoned. Only this version writes the file and
 * it always writes the pid, so a claim without one came from somewhere we cannot
 * reason about, and the safe reading is the one that does not block.
 */
function liveStartClaim(port) {
  const claim = readStartClaim(port);
  if (claim === null || claim.pid === null) return null;
  const writtenAt = stateWrittenAt(port, 'starting');
  if (writtenAt !== null && writtenAt < BOOT_TIME_MS) return null;   // predates this boot
  return pidAlive(claim.pid) ? claim : null;
}

/**
 * Does this invocation's generation still own the claim?
 *
 * BOTH FIELDS, because a millisecond is not an identity. This compared `spawnedAt`
 * alone, and `spawnedAt` is `Date.now()`: two clients that both find no claim and
 * then stamp the same millisecond write different records that compare equal, so each
 * reads the OTHER's claim as its own. The older one may then clear or overwrite the
 * newer one's `server.pid`, release a claim it does not hold, or adopt its listener
 * while cancelling — every failure the claim was introduced to prevent, reachable
 * through a tie the comparison could not see.
 *
 * The pid is what breaks the tie. Only the process that wrote the claim can match it,
 * and a claim is always written with `process.pid`, so a collision on the timestamp
 * alone no longer collides on the generation.
 */
const ownsStartClaim = (port, spawnedAt) => {
  const claim = readStartClaim(port);
  return claim !== null && claim.spawnedAt === spawnedAt && claim.pid === process.pid;
};

/**
 * Take the `starting` slot for THIS generation, atomically. Returns true if we now own
 * it, false if a live foreign start already holds the port.
 *
 * EXCLUSIVE CREATE, not last-writer-wins. `awaitConcurrentStart` is what stops a second
 * server being spawned beside a start already in progress, but it reads the claim well
 * before this point — through the leftover checks and a PowerShell-slow `resolveLitertLm`
 * — so two cold invocations can both see no claim and, with a plain overwrite here, both
 * go on to spawn their own detached `litert-lm serve`. Both engines then initialise, both
 * clients accept whichever wins the port, and the losing child is left unrecorded because
 * `recordSpawnedPid` rejects its generation. `wx` closes that: the loser gets EEXIST and
 * is sent back to adopt the winner instead of launching.
 *
 * A merely stale claim — its pid dead, so `liveStartClaim` returns null — is reclaimed
 * through `claimStateSlot`'s rename-then-verify path, so an abandoned start can never lock
 * the port out AND two stale-reclaimers can never both delete the name and clobber a live
 * claim one of them just published. The generation boundary the rest of the start relies
 * on is unchanged: exactly one live claim exists at a time, and `ownsStartClaim` still
 * identifies its owner by `spawnedAt` and pid.
 */
function acquireStartClaim(port, spawnedAt) {
  const record = `${spawnedAt} ${process.pid}`;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let outcome;
    try {
      outcome = claimStateSlot(port, 'starting', record, () => liveStartClaim(port) !== null);
    } catch {
      // The exclusive create failed for a reason unrelated to contention (a full or
      // read-only filesystem). Fall back to the previous best-effort write rather than
      // refuse to start; state is an optimisation, and a lone start still needs to run.
      writeState(port, 'starting', record);
      return true;
    }
    if (outcome === 'won') return true;
    if (outcome === 'occupied') return false;            // a live start owns the port
    // 'retry': another reclaimer is mid-flight; loop and re-observe.
  }
  return false;   // could not win the slot after repeated stale reclaims; adopt instead
}

/** A direct `--stop` admission claim. Starts wait on it; they never signal its pid. */
function readStopClaim(port) {
  try {
    const claim = JSON.parse(readState(port, 'stop-claim', 'null'));
    if (typeof claim?.id !== 'string' || !claim.id
        || !Number.isFinite(claim.startedAt) || !Number.isInteger(claim.pid)) return null;
    return claim;
  } catch {
    return null;
  }
}

function liveStopClaim(port) {
  const claim = readStopClaim(port);
  if (claim === null) return null;
  const writtenAt = stateWrittenAt(port, 'stop-claim');
  if (writtenAt !== null && writtenAt < BOOT_TIME_MS) return null;
  // A direct stop is bounded well below five minutes. This also prevents a reused pid
  // from turning a crashed claim into a permanent admission lock.
  if (Date.now() - claim.startedAt > 5 * 60 * 1000) return null;
  return pidAlive(claim.pid) ? claim : null;
}

const ownsStopClaim = (port, claim) => readStopClaim(port)?.id === claim.id;

async function acquireStopClaim(port) {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error('another --stop invocation is still running after 5 minutes; retry later.');
    }
    // EXCLUSIVE CREATE, not write-then-read. Two stops that both saw no live owner and
    // then wrote could both pass `ownsStopClaim`: A writes and verifies before B
    // overwrites, then B writes and verifies too, and both run `stopProcesses`
    // concurrently — the first losing its claim during finalization and reporting a
    // spurious failure after it had already signalled. `claimStateSlot` gives the slot
    // to exactly one racer and reclaims a stale claim by rename, never by a delete that
    // two reclaimers could both perform.
    const claim = { id: randomUUID(), startedAt: Date.now(), pid: process.pid };
    let outcome;
    try {
      outcome = claimStateSlot(port, 'stop-claim', JSON.stringify(claim),
        () => liveStopClaim(port) !== null);
    } catch (err) {
      throw new Error(`could not establish stop admission claim.\n  (underlying error: ${err.message})`);
    }
    if (outcome === 'won') return claim;
    // 'occupied' — another live `--stop` holds admission, so wait and look again;
    // 'retry' — a reclaimer is mid-flight, re-observe promptly.
    if (outcome === 'occupied') await sleep(250);
  }
}

function releaseStopClaim(port, claim) {
  if (ownsStopClaim(port, claim)) clearState(port, 'stop-claim');
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
 *
 * BOTH ENDS ARE GATED ON THE `starting` CLAIM, and the opening one matters as much as
 * the closing one. `server.pid` is a single shared slot: a newer start publishes into
 * it, so an older generation that cleared the slot on the way in erased an identity
 * that was never its own — a live server left unrecorded by the act of recording
 * something else. And publishing is not instantaneous either. Everything between the
 * two gates costs real time (a process lookup is seconds on Windows), which is
 * precisely the window in which the claim changes hands, so ownership is re-asked
 * immediately before the write rather than assumed to have survived it.
 */
async function recordSpawnedPid(port, name, child, exe, spawnedAt) {
  if (!ownsStartClaim(port, spawnedAt)) return false;
  if (!child.pid) return false;

  // argv[0] must BE the executable we launched. A substring search over the whole
  // command line is not that test: `node worker.js --inspect …\litert-lm.exe`
  // mentions the path without having launched it, and a recycled pid shaped like
  // that would be recorded as our server.
  const seen = identity(child.pid);
  if (seen === null || !commandLaunches(seen.cmdline, exe)) return false;

  // Still not enough on its own. If our child died during the lookup and the number
  // was reissued to ANOTHER invocation of the same executable, argv[0] matches and we
  // would persist a stranger's token as ours. Only the child handle can distinguish
  // "our process" from "a process like ours" — so ask it, after yielding.
  //
  // The yield is the point. The lookup is `spawnSync` and blocks the event loop, so
  // an exit that happened during it has not been delivered yet and `exitCode` still
  // reads null. Checking it without turning the loop first is how an earlier version
  // of this guard looked correct while doing nothing.
  await sleep(50);
  if (child.exitCode !== null || child.signalCode !== null) return false;

  // A `--stop` that landed while we were starting has already returned, reporting
  // that nothing of ours is running. Publishing now would contradict it and leave a
  // record of a server the user was told had been stopped. Same tombstone the
  // watchdog uses, same reason: whoever stopped could not see us yet.
  //
  // `>=`, not `>`. Both stamps are `Date.now()`, so a stop landing in the same
  // millisecond as this spawn is genuinely ambiguous — and strict ordering resolved
  // that ambiguity by ignoring the stop, which is the one direction that cannot be
  // recovered from. Treating it as an overtaking stop costs a start that has to be
  // retried and says so; the other reading leaves a server running that the user was
  // told had been stopped.
  const stoppedAt = Number.parseInt(readState(port, 'stopped-at', ''), 10);
  if (Number.isFinite(stoppedAt) && stoppedAt >= spawnedAt) return false;

  // Warm — `identity(child.pid)` above already paid for it — so the gap between this
  // check and the write is a couple of syscalls rather than a PowerShell start-up.
  const record = formatPidRecord(child.pid);
  if (!ownsStartClaim(port, spawnedAt)) return false;
  writeState(port, name, record);

  // And once more afterwards, because "check then write" is two operations and a
  // newer generation can land between them. If it did, ours is the stale record and
  // has to go — but only while the bytes on disk are still the ones we wrote. If the
  // newer start has already published its own, removing it would repeat the mistake
  // this whole function is gated to prevent, one step further along.
  if (!ownsStartClaim(port, spawnedAt)) {
    if (readState(port, name, '') === record) clearState(port, name);
    return false;
  }
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

  // Returns the record, not a bare number. A pid on its own stops meaning anything
  // the moment its process exits, so anything that will act on this later has to
  // carry the token and re-check — see `stillAlive`.
  //
  // A record whose lookup FAILED is kept too, and marked. Dropping it here was the
  // same three-state mistake one level up from where it was fixed: `signallablePid`
  // returns null both for "the token contradicts this process" and for "I could not
  // read the process", and the omitted record never reached `resolveTargets` to be
  // called unknown. Its only identity was then cleared and the stop reported success
  // while an off-port process might still be holding accelerator memory.
  const owned = new Map();
  for (const [name, rec] of records) {
    if (signallablePid(rec, stateWrittenAt(port, name)) !== null) owned.set(name, rec);
    else if (identity(rec.pid) === null) owned.set(name, { ...rec, unresolved: true });
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
  if (readState(opts.port, 'stopping') === null && liveStopClaim(opts.port) === null) return false;
  process.stderr.write('[litertlm] server is shutting down; waiting for it to exit...\n');

  // Wait on the shutdown owner, not on a stopwatch. That owner is either the
  // watchdog (`stopping`) or a direct command (`stop-claim`).
  //
  // This used to give up after a flat 20s, which is shorter than a shutdown can
  // legitimately take: the watchdog escalates for 30 rounds and re-establishes
  // identity each time, and on Windows a single lookup can cost a second. Past the
  // deadline the client cleared the handshake and started a second server while the
  // first was still being torn down — the exact race `stopping` exists to prevent,
  // reintroduced by the timeout meant to protect against a dead watchdog.
  //
  // The real question is whether anyone is still working on it, and that is a
  // liveness question with a free answer. The long cap is only a backstop against a
  // handshake nobody owns at all.
  for (let i = 0; i < 600; i++) {                                   // 5 minutes
    await sleep(500);
    const manualStop = liveStopClaim(opts.port);
    const watchdogStop = readState(opts.port, 'stopping') !== null;
    if (manualStop === null && !watchdogStop) return true;
    if (manualStop !== null) continue;                               // direct stop still owns it
    if (staleRecord(opts.port, 'watchdog.pid')) break;               // watchdog author is gone
  }

  // The handshake is released, because nobody is left to release it. `server.pid` is
  // NOT — a dead supervisor is not evidence that the shutdown it was performing
  // finished. If the watchdog died after the server closed its listener but before it
  // exited, clearing the record here would delete the only identity of a process
  // still holding accelerator memory, and the next start would launch a second server
  // beside it. What we know is that supervision ended, not that teardown completed.
  clearState(opts.port, 'stopping');
  return true;
}

/** Start the watchdog only when we started a server, and only if none supervises (T060). */
function requestedServerIdentity(opts) {
  const recorded = readState(opts.port, 'server.pid', '') || null;

  // Normally the recorded identity is both cheaper and stronger than another
  // process-table walk. A failed idle shutdown is the exception: `server.pid` may
  // still name the old off-port survivor while a manually launched replacement now
  // owns the endpoint. The `survivors` record tells us that exceptional state is
  // active, so pay for discovery only there and publish the proven listener's full
  // identity for the incumbent's handoff.
  if (readState(opts.port, 'survivors') === null) {
    return { server: recorded, discoveryPending: false };
  }

  const survivors = new Set(String(readState(opts.port, 'survivors', ''))
    .split('\n').map((raw) => parsePidRecord(raw))
    .filter((rec) => rec?.token)
    .map((rec) => `${rec.pid} ${rec.token}`));
  const { ours, unidentified, discoveryFailed } =
    identifyPortOwners(opts.port, looksLikeLitertLmServe, opts.host);
  if (discoveryFailed || unidentified.length) {
    // The old recorded identity belongs to the survivor being retired, not to the
    // replacement that answered this client. Publishing it as the desired server
    // makes the incumbent reject the request once that survivor exits, permanently
    // losing the replacement's only watchdog-start opportunity. Preserve the missing
    // observation explicitly so the incumbent keeps its slot and retries discovery.
    return { server: null, discoveryPending: true };
  }

  const replacement = ours.find((rec) => rec.token
    && !survivors.has(`${rec.pid} ${rec.token}`));
  return {
    server: replacement ? `${replacement.pid} ${replacement.token}` : null,
    discoveryPending: false,
  };
}

const WATCHDOG_CLAIM_TIMEOUT_MS = 15_000;
const WATCHDOG_CLAIM_POLL_MS = 250;
const WATCHDOG_START_ATTEMPTS = 2;

async function liveWatchdogClaim(port, child) {
  const deadline = Date.now() + WATCHDOG_CLAIM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = parsePidRecord(readState(port, 'watchdog.pid', ''));
    if (record?.token) {
      // A first lookup can race identity publication and cache a miss. This is the
      // confirmation boundary, so each observed claim gets a fresh authority-grade
      // lookup rather than inheriting that stale answer.
      forgetIdentities([record.pid]);
      if (signallablePid(record, stateWrittenAt(port, 'watchdog.pid')) !== null) {
        return true;                 // this child or a concurrent winner both supervise
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await sleep(WATCHDOG_CLAIM_POLL_MS);
  }
  return false;
}

async function startWatchdog(opts) {
  // Publish the desired policy even when an older watchdog still owns the slot.
  // That incumbent may be finishing a failed shutdown while this invocation starts
  // replacement server B. B's only watchdog-start attempt used to stop here, then
  // the incumbent noticed B and exited on its next poll, leaving B unsupervised.
  // The durable request lets the incumbent hand the slot to a successor under B's
  // policy. A disabled request is meaningful too: it tells the old watchdog to
  // relinquish without replacing itself.
  const requested = requestedServerIdentity(opts);
  const request = {
    server: requested.server,
    discoveryPending: requested.discoveryPending,
    host: opts.host,
    idleTimeout: opts.idleTimeout,
    requestedAt: Date.now(),
  };
  // Atomic: an incumbent watchdog finishing survivor cleanup reads this file, and a
  // truncating write can hand it an empty or partial document. `handoffReplacement`
  // treats that parse failure as "no request" and exits, while this client — seeing the
  // incumbent still hold `watchdog.pid` — has already declined to spawn its own. The
  // replacement server would then run unsupervised. A temp-file-plus-rename write makes
  // the reader see the old request or the new one, never a torn one.
  writeStateAtomic(opts.port, 'watchdog-request', JSON.stringify(request));
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
  for (let attempt = 0; attempt < WATCHDOG_START_ATTEMPTS; attempt += 1) {
    try {
      const child = spawn(
        process.execPath,
        [join(HERE, 'idle-watchdog.mjs'), '--port', String(opts.port),
          '--idle-timeout', String(opts.idleTimeout),
          // The watchdog decides socket ownership by local address as well as port, so
          // it has to be told the same address this client talks to. Left to its own
          // default it would judge a different socket from the one being supervised.
          '--host', opts.host,
          // So a `--stop` landing before this child has published its pid can still
          // invalidate it. Without this the child is invisible to that stop and would
          // publish a supervisor record over the state it had just cleared.
          '--spawned-at', String(request.requestedAt)],
        { detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, LITERT_LM_PLUGIN_INSTANCE: randomUUID() } },
      );
      child.unref();
      if (await liveWatchdogClaim(opts.port, child)) return;
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
    } catch { /* retry below */ }
  }

  throw new Error('the idle watchdog started but did not claim supervision.\n'
    + '  The server is still running; retry this command or run --stop.');
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

/**
 * Release the `starting` claim, and ONLY if this invocation still holds it.
 *
 * Every exit from a start has to go through here rather than clearing the file
 * directly. A newer start overwrites the claim while an older one is still polling,
 * and the older one then reaches its own exit — success, timeout, or cancellation —
 * and erased a generation that was not its own. The damage is not the missing file:
 * `cancelStartedServer` reads the claim to decide whether it still owns the port, so
 * a wrongly-cleared claim makes the newer start look foreign to its own cancellation,
 * which then takes the child-only path and can call success before the descendant it
 * was supposed to wait for has even bound.
 */
function releaseStartClaim(port, spawnedAt) {
  if (ownsStartClaim(port, spawnedAt)) clearState(port, 'starting');
}

/**
 * Undo a start that a concurrent `--stop` cancelled.
 *
 * Only touches what this invocation is responsible for: the launcher we spawned,
 * everything `generation` has observed descending from it, and any listener on the
 * port we can prove is a litert-lm serve. Everything else is left exactly as found —
 * a cancelled start is not a licence to tidy up the machine.
 *
 * DESCENT IS WHAT MAKES THE VERDICT MEAN ANYTHING. Listener discovery can only see a
 * process that has already bound, and the whole difficulty here is the descendant
 * that has NOT: the launcher exits, its grandchild is still initialising an engine,
 * and every search that asks "who holds the port" truthfully answers "nobody". The
 * quiescence counter below used to be the only thing standing between that and a
 * report of "nothing is left running" — three samples, two 400ms waits, about 800ms
 * of silence treated as proof. A litert-lm descendant binds after engine init, which
 * is tens of seconds, so that window could be missed by two orders of magnitude.
 *
 * `generation` closes the ordinary case from the other side: a descendant observed
 * while its parent is alive is already a target when cancellation starts. It cannot
 * close the residual gap where a parent hands off and exits wholly between walks.
 * Once an admitted identity disappears, the generation therefore makes that
 * uncertainty sticky; the counter may damp transient identity answers, but no amount
 * of later silence may spend a missed handoff as proof.
 */
async function cancelStartedServer(opts, generation, child, spawnedAt) {
  const port = opts.port;

  let conclusive = false;
  let quiet = 0;
  for (let i = 0; i < 25; i++) {
    // Only listeners belonging to OUR start generation.
    //
    // The previous guard compared `stopped-at`, and that was not a generation at
    // all: a newer `ensureServer` does not write it, so after (A spawns, S stops,
    // B starts, A notices) every cancellation pass still saw the same stamp and
    // happily adopted B's listener — letting a cancelled start kill a valid newer
    // one. `starting` is written by each start and names the generation that owns
    // the port right now; when it is no longer ours, we stop reaching for listeners
    // and clean up only the child we spawned.
    const generationIsOurs = ownsStartClaim(port, spawnedAt);

    // Descent is sampled unconditionally: it asks about OUR processes and cannot
    // reach a newer start's, so the generation boundary has nothing to protect here.
    // Listener adoption is gated, because the port is shared and a newer start's
    // socket would otherwise be adopted by a cancellation that has already lost it.
    await generation.sample(true);
    if (generationIsOurs) {
      // Both the sample above and the owner lookup below are slow — on Windows each
      // launches PowerShell — so the claim read at the top of this pass is already
      // history by the time its result is used. If B took the claim inside that gap
      // and bound the port, adopting here pulls B's listener into A's generation with
      // a valid identity, and the loop below signals it: a cancelled start killing the
      // valid newer one, which is the exact failure the generation boundary exists to
      // prevent, re-entered through the staleness of its own check.
      const owners = classifyPortOwners(opts).ours;
      if (ownsStartClaim(port, spawnedAt)) {
        for (const owner of owners) generation.adopt(owner);
      }
    }

    const { alive, unknown } = resolveTargets(generation.members());
    // `unknown` is not "gone". Ending the loop on a transient lookup failure would
    // let this report "nothing is left running" while the overtaken server carried
    // on coming up, unrecorded — the exact outcome cancellation exists to prevent.
    if (!alive.length && !unknown.length) {
      // One empty sample is not quiescence. Consecutive emptiness only dampens a
      // transient identity answer; it cannot repair ancestry. `authoritative()` turns
      // permanently false when an admitted identity vanished between table walks, so
      // a launcher -> detached-child handoff missed in that gap remains inconclusive.
      quiet += 1;

      // And an empty picture is only evidence at all if we were ever able to look.
      //
      // The generation seeds itself from the process table; if that read never
      // yielded the launcher — the query could not run, or the stage was gone before
      // it was enumerated — then there are no members, and "no members" arrives here
      // looking exactly like "everything has exited". Spending that as proof reported
      // a clean teardown while the detached descendant was still on its way up, which
      // is the pre-bind false success this tracker exists to remove, re-entered
      // through its own initialisation. Unjudgeable is not a verdict.
      const provable = generation.authoritative();
      if (!generationIsOurs) { conclusive = provable; break; }
      // While this invocation still owns the start, a finite quiet interval cannot
      // prove that its launcher did not hand off wholly between process-table walks.
      // Three empty confirmations end the bounded cleanup, but as INCONCLUSIVE.
      if (quiet >= 3) break;
      await sleep(400);
      continue;
    }
    quiet = 0;

    for (const pid of alive) {
      try { process.kill(pid, i === 0 || process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
      catch { /* already gone */ }
    }
    await sleep(400);
  }

  clearState(port, 'loaded-model');
  releaseStartClaim(port, spawnedAt);
  if (conclusive) {
    // Clear `server.pid` only while it still names something of OURS.
    //
    // The generation boundary stopped this from SIGNALLING a newer start's listener
    // and then deleted its record anyway: once B has taken the claim, A reaches
    // `!generationIsOurs`, calls itself conclusive as soon as its own launcher is
    // gone, and wiped the identity B had just published — losing a live server to
    // the cleanup rather than to the kill. Not signalling a process whose only
    // identity you then discard is not restraint.
    // THE WHOLE IDENTITY, not the number. Once B has taken the claim, a dead member
    // of our generation can have its pid reissued to B — and a numeric test then finds
    // that pid in our set and clears the record B had just published, losing a live
    // server to the cleanup rather than to the kill. That is the mistake this branch
    // already carries a paragraph about, made again one comparison lower down.
    const rec = parsePidRecord(readState(port, 'server.pid', ''));
    const mineToo = rec !== null && generation.member(rec.pid)?.token === rec.token;
    if (rec === null || mineToo) clearState(port, 'server.pid');
    return true;
  }

  // Could not finish. Leave the identity behind so `--stop` can pick it up, rather
  // than reporting a clean cancellation we did not achieve.
  const left = generation.members().filter((t) => t.token);
  if (left.length) {
    writeState(port, 'survivors', left.map((t) => `${t.pid} ${t.token}`).join('\n'));
  }
  return false;
}

/** Cancel this start immediately when a concurrent `--stop` has overtaken it. */
async function cancelIfStopped(opts, generation, child, spawnedAt) {
  const stoppedAt = Number.parseInt(readState(opts.port, 'stopped-at', ''), 10);
  const stopClaim = liveStopClaim(opts.port);
  const overtakenByActiveStop = stopClaim !== null && stopClaim.startedAt >= spawnedAt;
  if ((!Number.isFinite(stoppedAt) || stoppedAt < spawnedAt) && !overtakenByActiveStop) return;

  const clean = await cancelStartedServer(opts, generation, child, spawnedAt);
  throw new Error(clean
    ? 'the server start was cancelled by a --stop that ran at the same time.\n'
      + '  Nothing is left running. Retry if you did want it started.'
    : 'the server start was cancelled by a --stop that ran at the same time,\n'
      + '  but it could not be confirmed torn down. Its identity has been recorded;\n'
      + '  run --stop again to finish the job.');
}

/**
 * Wait out another invocation's start rather than mistaking it for debris.
 *
 * A start is not atomic: `server.pid` is published seconds before the socket answers,
 * so between those two moments the state on disk looks exactly like the wreckage of a
 * shutdown that did not finish — a live, recorded, provably-ours pid with nothing
 * listening. The leftover check below read it that way and told the user to run
 * `--stop`, which is the one thing that would actually break the valid start in
 * progress.
 *
 * `starting` already distinguishes the two, and it is the file that exists to say
 * which generation owns the port right now. A live claim means the pid is a server on
 * its way up, not a corpse.
 *
 * Bounded by the same `startupTimeoutMs` the start itself gets, and re-reads the claim
 * each pass: a claim that disappears means that start finished or gave up, and the
 * caller should go back to judging the state on its merits. A NEWER claim replacing
 * the one we first saw is still an active start, so any live claim keeps us waiting.
 */
async function awaitConcurrentStart(opts) {
  if (liveStartClaim(opts.port) === null) return null;
  process.stderr.write('[litertlm] another invocation is already starting the server; '
    + 'waiting for it rather than starting a second one...\n');

  const deadline = Date.now() + opts.startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const up = await probe(opts);
    if (up) return up;
    if (liveStartClaim(opts.port) === null) return null;
  }
  return null;
}

async function ensureServer(opts) {
  reconcileState(opts.port, await probe(opts, 1000));

  const wasStopping = await awaitNotStopping(opts);

  const existing = await probe(opts);
  if (existing) {
    await startWatchdog(opts);        // adopt a server nothing is supervising
    return { models: existing, started: false };
  }

  // Before reading the state as debris, ask whether it belongs to a start that is
  // still happening. Ordered ahead of the leftover check deliberately: the two
  // situations produce identical state files and only `starting` tells them apart.
  const adopted = await awaitConcurrentStart(opts);
  if (adopted) {
    await startWatchdog(opts);
    return { models: adopted, started: false };
  }

  // A teardown that lost its supervisor is unfinished, not finished.
  //
  // `awaitNotStopping` preserves `server.pid` when the watchdog dies mid-shutdown,
  // and that record was documentary only: nothing consulted it here, so an old
  // server that had closed its listener but not exited was invisible to the probe
  // above, and this went on to spawn a second one beside it and overwrite the record
  // — losing the only identity of a process that may still hold accelerator memory.
  //
  // Deliberately NOT gated on `wasStopping`. That gate looked equivalent and was not:
  // `reconcileState` above clears `stopping` the moment the watchdog's record is
  // stale, so an invocation arriving after the supervisor had already died saw no
  // handshake at all, `awaitNotStopping` returned false, and the leftover it was
  // meant to catch walked straight past it. The question "is one of our processes
  // still holding memory" does not depend on which invocation happened to observe
  // the handshake — and when nothing is recorded the check costs nothing, because
  // an empty target list performs no identity lookup.
  //
  // Refusing is the conservative half of the fix. Taking over the teardown from here
  // would be the ambitious one, and the last four rounds of this change are a
  // reasonable argument against inventing more lifecycle machinery in the same
  // breath. The message says exactly what to run.
  const held = ['server.pid', 'survivors'].flatMap((name) => {
    const raw = readState(opts.port, name, '');
    return String(raw).split('\n').map(parsePidRecord)
      .filter((rec) => rec !== null && rec.token !== null
        && !recordIsStale(rec, stateWrittenAt(opts.port, name)));
  });
  const leftover = resolveTargets(held);
  if (leftover.alive.length || leftover.unknown.length) {
    // A claim that is STILL live here means the wait above ran out of patience, not
    // that anything died badly. Saying "run --stop" would be advice to break a valid
    // start, so the two verdicts are reported as the different things they are.
    const claim = liveStartClaim(opts.port);
    if (claim !== null) {
      throw new Error(
        `another invocation (pid ${claim.pid}) is still starting a server on `
        + `${baseUrl(opts)}, and it has not become reachable within `
        + `${opts.startupTimeoutMs / 1000}s.\n`
        + '  Nothing here is stale, so nothing has been changed. Retry in a moment.\n'
        + '  If that start is wedged rather than slow, stop it with --stop first.');
    }
    throw new Error(
      `pid ${[...leftover.alive, ...leftover.unknown].join(', ')} is left over from a `
      + 'shutdown that did not finish.\n'
      + '  It is this plugin\'s process and may still hold accelerator memory even\n'
      + '  though it has stopped listening. Starting a second server beside it would\n'
      + '  lose track of it. Run --stop first, then retry.');
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
  const spawnedAt = Date.now();
  // Claim the port for THIS start. `cancelStartedServer` uses it as the generation
  // boundary: an earlier start that is cancelling reads the claim to know it no longer
  // owns the listeners it once spawned. Acquired with an exclusive create so two cold
  // invocations that both passed `awaitConcurrentStart` cannot both spawn a server —
  // the loser adopts the winner rather than launching a second engine beside it. An
  // abandoned claim does not lock the port out: `acquireStartClaim` reclaims a stale one.
  if (!acquireStartClaim(opts.port, spawnedAt)) {
    // Another invocation won the port in the gap between the wait above and here. Take
    // its server instead of starting a second one; if it has not come up yet, wait it
    // out the same way `awaitConcurrentStart` does.
    const raced = (await probe(opts)) || (await awaitConcurrentStart(opts));
    if (raced) {
      await startWatchdog(opts);
      return { models: raced, started: false };
    }
    throw new Error(
      `another invocation won the start on ${baseUrl(opts)} but it did not become\n`
      + `  reachable within ${opts.startupTimeoutMs / 1000}s. Nothing was started here;\n`
      + '  retry in a moment.');
  }
  try {
    child = spawn(exe, ['serve', '--host', opts.host, '--port', String(opts.port)],
      { detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, LITERT_LM_PLUGIN_INSTANCE: randomUUID() } });
    child.unref();
  } catch (err) {
    throw new Error(
      `could not launch '${exe}'.\n`
      + `  Check it runs: litert-lm --version\n`
      + `  (underlying error: ${err.message})`);
  }

  // Start tracking descendants NOW, not when cancellation begins.
  //
  // The link between our launcher and the process that will actually serve exists
  // only while the launcher is alive — a detached grandchild is reparented to init
  // the moment its parent exits, and no later walk can recover the relationship. The
  // first sample is taken immediately for exactly that reason: on Linux a stage that
  // hands off and exits can be gone within milliseconds of `recordSpawnedPid`.
  // The third argument is what keeps a retried seed honest: if the first table read
  // missed this launcher, seeding may be re-attempted only while the child handle
  // still says the number is ours. `exitCode`/`signalCode` are the only evidence that
  // distinguishes our process from whoever inherits its pid.
  const generation = startGeneration(child.pid, undefined,
    () => child.exitCode === null && child.signalCode === null);
  // Seeding happens here rather than in the constructor: it has to yield to the event
  // loop before the handle above means anything, and a constructor cannot await.
  await generation.sample(true);

  // Record the identity now, while the process is still the one we just spawned —
  // and only if the OS still says so. Asked for later, the answer could already be
  // about whoever inherited the pid.
  await recordSpawnedPid(opts.port, 'server.pid', child, exe, spawnedAt);
  await generation.sample(true);   // again, now the identity lookup has cost us time
  // Prune, not wipe: another client may have acquired a marker against this same
  // new server between our spawn and this line.
  pruneInFlight(opts.port);
  touchActivity(opts.port);

  const deadline = Date.now() + opts.startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(750);

    // Keep watching the tree while the server comes up. The walk no longer blocks the
    // event loop, so this awaits a subprocess rather than freezing on one — an
    // in-flight probe keeps making progress across it. What the cadence rations now is
    // CPU: dense while the launcher chain is assembling and a handoff could be missed,
    // throttled once the start is a single process loading a model. See
    // DESCENDANT_SAMPLE_MS.
    await generation.sample();

    // A concurrent `--stop` cancels this start, and cancelling has to mean stopping.
    //
    // Declining to RECORD the pid was not enough, and left the worse outcome of the
    // two: `--stop` reported success, this loop carried on, and the server came up
    // anyway — running, unrecorded, and therefore harder to find than if we had
    // never suppressed the record at all. A start that has been overtaken has to
    // undo itself, not just stay quiet about it.
    await cancelIfStopped(opts, generation, child, spawnedAt);

    const up = await probe(opts);

    // Re-read the tombstone AFTER the probe, not only before it. The check at the top
    // of this iteration is already stale by the time the probe resolves, and a `--stop`
    // landing inside that await is exactly the one that cannot see us: our server
    // binds just after its ownership scan, the probe then succeeds, and accepting
    // readiness here would return a running server that stop had already reported as
    // gone — without ever entering cancellation.
    await cancelIfStopped(opts, generation, child, spawnedAt);

    if (up) {
      releaseStartClaim(opts.port, spawnedAt);   // ours only — a newer start may own it
      await startWatchdog(opts);
      return { models: up, started: true };
    }
  }
  releaseStartClaim(opts.port, spawnedAt);

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
/**
 * Split the port's listeners three ways: ours, someone else's, and undetermined.
 *
 * The third bucket is not pedantry. Deciding ownership from a command line requires
 * READING the command line, and that read can fail — PowerShell may not start, `ps`
 * may be killed. A failed read used to come back as `false`, which is
 * indistinguishable from "definitely not litert-lm", so a genuine server on our port
 * was filed as a stranger and left out of the shutdown model altogether: not
 * signalled, not chased, and not counted against success.
 *
 * Unidentified owners are never signalled — we cannot prove they are ours — but they
 * do block the success verdict, because "I could not tell" is not "it is not mine".
 *
 * Scoped to `opts.host` as well as the port. A second litert-lm server bound to
 * another local address on the same port passes the command-line test and is not
 * ours by any reading; the port number alone could not say so.
 */
const classifyPortOwners = (opts) =>
  identifyPortOwners(opts.port, looksLikeLitertLmServe, opts.host);

/**
 * Of `targets`, those still running as themselves — and those we could not judge.
 *
 * The rule is `resolveTargets`, in process-identity.mjs, so the watchdog applies the
 * identical one. Deliberately does not intersect with the port: an earlier version
 * did, and it made "stopped listening" mean "exited" — a server that closes its
 * socket on SIGTERM and then hangs in teardown, still holding accelerator memory,
 * would drop out of the set and be reported as successfully stopped.
 */
const stillAlive = (targets) => resolveTargets(targets);

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
async function stopProcesses(opts, endpointAnswered = false, stopClaim = null) {
  const port = opts.port;

  const PID_FILES = ['watchdog.pid', 'server.pid'];
  // A live record from pre-token releases is evidence, but never authority. The old
  // filter dropped it before the shutdown model was built, so an off-port launcher
  // or watchdog could remain alive while its only record was cleared and success was
  // reported. Keep it visible and fail closed; a socket owner independently proven
  // by command line does not need the legacy record's authority.
  const legacyRecords = PID_FILES
    .map((name) => ({ name, record: pidRecord(port, name) }))
    .filter(({ name, record }) => record !== null && record.token === null
      && !recordIsStale(record, stateWrittenAt(port, name)));
  const recordedByName = ownedPids(port, PID_FILES);
  const recorded = [...recordedByName.values()];
  const { ours, strangers, unidentified, observed, discoveryFailed } = classifyPortOwners(opts);
  const legacy = legacyRecords.map(({ record }) => record.pid)
    .filter((pid) => !ours.some((owner) => owner.pid === pid));

  // Survivors of a PREVIOUS failed stop, which the two pid slots could not hold.
  //
  // `server.pid` and `watchdog.pid` are one slot each and a failed shutdown can
  // leave more survivors than that — a launcher and a listener, say. The extra one
  // used to exist only in the error message, so a retry could not find it once it
  // had closed its socket. This file has no such limit: one record per line, read
  // back as targets, and removed the moment a stop actually succeeds.
  const carried = String(readState(port, 'survivors', '')).split('\n')
    .map((line) => parsePidRecord(line))
    .filter((rec) => rec !== null && rec.token !== null
      && !recordIsStale(rec, stateWrittenAt(port, 'survivors')));

  // The SERVER targets. The watchdog is deliberately not among them — see below.
  let watchdogRecord = recordedByName.get('watchdog.pid') ?? null;
  const targets = [];
  for (const t of [...recorded, ...ours, ...carried]) {
    if (t.pid === watchdogRecord?.pid) continue;
    if (!targets.some((seen) => seen.pid === t.pid)) targets.push(t);
  }

  // A recorded target we could not look up at all is unknown, not absent — but that
  // is a verdict about a MOMENT, and it is deliberately not cached here.
  //
  // It used to be. The pids whose first lookup failed were collected once, before any
  // signal, and unconditionally folded back into `unknown` at the end. A lookup that
  // failed transiently and then succeeded — the process identified, signalled, and
  // confirmed gone by the escalation loop — was still reported as unjudgeable, so a
  // completed stop came out as a failure, kept state it should have cleared, and told
  // the user to inspect a pid that no longer exists. `resolveTargets` re-asks the OS
  // on every pass and already returns a fresh `unknown`; a second, staler opinion
  // could only ever contradict it. The one target that never reaches those passes is
  // the watchdog, and it gets its own fresh check below rather than a remembered one.

  // Refuse to tear down a system we cannot see all of.
  //
  // With a listener we could not identify, signalling what we CAN prove takes out
  // the watchdog — a recorded target — and then fails on the server, leaving it
  // running with nobody supervising it. That is strictly worse than doing nothing:
  // a refusal is recoverable by retrying, an unsupervised server is not recoverable
  // by anything except noticing. So when the picture is incomplete, nothing is
  // signalled and nothing is cleared.
  //
  // A discovery that could not RUN counts here too, but only when another observation
  // says there is something to account for: either walk saw a listener, the endpoint
  // answered, or live state remains. On a host with neither lsof nor ss the query
  // always fails, and treating failure alone as a blocker would make `--stop` refuse
  // forever even when no server or state exists.
  //
  // `endpointAnswered` alone was not enough, and leaned on the one inference this
  // codebase spends most of its comments warning against. A genuine server is
  // legitimately unreachable during startup and for tens of seconds across a model
  // switch — that is what UNREACHABLE_TOLERANCE exists for in the watchdog — so a
  // failed probe is not evidence the server is gone. With discovery also unavailable
  // and the recorded launcher already exited, `targets` comes back empty, and the
  // command cleared state, wrote the success tombstone, and reported completion while
  // the unrecorded grandchild carried on holding the socket.
  //
  // So the question is not "did the endpoint answer" but "is there anything here we
  // cannot account for". Recorded identities count even when they turn out to be
  // gone: the process that owns the socket was never one of them, so proving our
  // records exited says nothing about it. Only a port with nothing answering AND
  // nothing recorded is genuinely a case of "there was never anything to stop".
  const somethingUnaccountedFor = endpointAnswered
    || observed || targets.length > 0 || watchdogRecord !== null
    || carried.length > 0 || legacy.length > 0;
  const blindPort = discoveryFailed && somethingUnaccountedFor;
  if (unidentified.length || blindPort || legacy.length) {
    return {
      signalled: [], strangers, surviving: [], unknown: unidentified,
      legacy, heldPort: false, down: false, blindPort,
    };
  }

  // Re-prove every target immediately before the FIRST signal, not only before
  // escalation. `ownedPids` proved the recorded pids, but `classifyPortOwners` then
  // spends two process lookups — seconds, on Windows — and a recorded process can
  // exit and have its number reissued inside that gap. Proving early and signalling
  // late is not proof; it is a stale claim with a delay in front of it.
  let { alive: remaining, unknown } = stillAlive(targets);
  const signalled = [...remaining];

  for (const pid of signalled) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Then confirm they actually went away rather than assuming SIGTERM landed. Both
  // the wait and the escalation key off the same identity check, so a process that
  // ignores SIGTERM, or closes its socket and hangs mid-teardown while still holding
  // accelerator memory, keeps being chased instead of being declared finished.
  if (signalled.length) {
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      ({ alive: remaining, unknown } = stillAlive(targets));
      if (!remaining.length && !unknown.length) break;
      for (const pid of remaining) {
        try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
        catch { /* ignore */ }
      }
    }
    // One more check, after the last signal rather than before it. The loop refreshes
    // at the TOP, so a target that dies in response to the final iteration's signal
    // would still be listed when the loop ends — reported as having refused to stop,
    // and its state kept, when it had in fact just exited.
    await sleep(200);
    ({ alive: remaining, unknown } = stillAlive(targets));
  } else {
    // Nothing was signallable — but `unknown` is NOT cleared here. It was, and that
    // turned "could not determine" straight back into "confirmed gone": with no
    // signal to send, the whole unjudgeable set was discarded, the verdict came out
    // clean, and the state was cleared. The one thing the three-state split exists to
    // prevent, undone by the branch that runs when there is nothing to do.
    //
    // What `unknown` holds here is the verdict `stillAlive(targets)` reached moments
    // ago, which is the freshest one available: nothing has been signalled, so nothing
    // about those processes can have changed because of us.
    remaining = [];
    unknown = [...new Set(unknown)];
  }

  // The watchdog goes LAST, and only once the server is confirmed gone.
  //
  // It used to be signalled in the same first volley as the server. If the server
  // then survived escalation, the command reported failure correctly — but the
  // supervisor was already dead, so nothing remained to retry the idle shutdown and
  // the memory stayed held until a human noticed. Killing the thing whose job is to
  // clean up, before knowing whether the cleanup succeeded, is backwards.
  //
  // And its fate counts. Signalling it and moving on took the same shortcut this
  // whole change exists to remove: the lookup's `unknown` bucket was destructured
  // away, no liveness check followed the SIGTERM, and the command then cleared
  // `watchdog.pid`, wrote the success tombstone, and reported both processes
  // confirmed exited on the strength of the server's result alone. A supervisor that
  // ignored the signal was left running with its identity deleted.
  //
  // A record whose earlier lookup failed is NOT skipped here. It used to be, and the
  // skip was what made that failure permanent: the record could never be re-judged, so
  // it went to the verdict as unjudgeable however long the process had been gone.
  // `stillAlive` drops the identity cache and asks the OS again, which answers all
  // three cases properly — gone, ours and signallable, or still unreadable.
  const serverGone = remaining.length === 0 && unknown.length === 0;

  // The slot is RE-READ here rather than taken from the snapshot at the top.
  //
  // A watchdog spawned before this stop can publish DURING it. It is in no pid file
  // when `ownedPids` runs, so the snapshot says there is no supervisor; its own two
  // invalidation checks pass because the tombstone they look for is written last, at
  // the end of this function. The stop then signalled nothing, cleared `watchdog.pid`
  // — destroying the identity of a process it had never seen — and reported both
  // processes confirmed gone while a live supervisor went on running.
  //
  // Everything below already knows how to chase and re-check a watchdog record, so
  // the fix is to give it the current one. The watchdog now re-checks the tombstone on
  // every poll as well; that closes the same hole from the other side, and neither
  // makes the other redundant — this one keeps the VERDICT honest, that one bounds how
  // long a superseded supervisor lives.
  // Unconditional, not only when the snapshot was empty. Gating it on a null snapshot
  // covered the watchdog that published during this stop and missed the one that
  // REPLACED a record we already held: the old supervisor dies, a new one publishes,
  // and the stale identity we are still carrying is the only thing consulted before
  // the new one's record is cleared.
  {
    const now = pidRecord(port, 'watchdog.pid');
    const live = now !== null && now.token !== null
      && !recordIsStale(now, stateWrittenAt(port, 'watchdog.pid'));
    watchdogRecord = live ? now : watchdogRecord;
  }

  if (serverGone && watchdogRecord !== null) {
    let watchdogState = stillAlive([watchdogRecord]);
    for (const pid of watchdogState.alive) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (watchdogState.alive.length || watchdogState.unknown.length) {
      // Same discipline as the server above: chase it, then re-ask after the last
      // signal rather than before it.
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        watchdogState = stillAlive([watchdogRecord]);
        if (!watchdogState.alive.length && !watchdogState.unknown.length) break;
        for (const pid of watchdogState.alive) {
          try { process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL'); }
          catch { /* ignore */ }
        }
      }
      await sleep(200);
      watchdogState = stillAlive([watchdogRecord]);
    }
    remaining = [...new Set([...remaining, ...watchdogState.alive])];
    unknown = [...new Set([...unknown, ...watchdogState.unknown])];
  }

  // FINAL ADMISSION BARRIER. The opening socket snapshot cannot authorise the final
  // verdict: a start that was still pre-bind then can become ready while this stop is
  // spending seconds on identity and escalation. `stop-claim` prevents starts begun
  // after us from entering, and an older in-progress start sees it in
  // `cancelIfStopped`. Wait for that generation to withdraw, then re-discover the
  // endpoint before clearing shared state or publishing the success tombstone.
  if (stopClaim !== null) {
    const startDrainDeadline = Date.now() + opts.startupTimeoutMs + 10_000;
    while (Date.now() < startDrainDeadline) {
      const starting = liveStartClaim(port);
      if (starting === null) break;
      await sleep(400);
    }

    const starting = liveStartClaim(port);
    // Probe before walking the process table. If a server binds between the two,
    // the later owner walk sees it; the opposite order leaves a final bind gap.
    const finalEndpointAnswered = Boolean(await probe(opts, 1000));
    const fresh = classifyPortOwners(opts);
    const lateRecord = pidRecord(port, 'server.pid');
    const openingRecord = recordedByName.get('server.pid');
    // Do not weaken the strong post-signal verdict for an opening target. On macOS
    // kill(pid, 0) can still see the unreaped zombie after the identity walk has
    // proven that target gone. Only a new or replaced record is late evidence.
    const changedRecord = lateRecord !== null
      && (openingRecord === undefined || lateRecord.pid !== openingRecord.pid
        || lateRecord.token !== openingRecord.token);
    const liveLateRecord = changedRecord
      && !recordIsStale(lateRecord, stateWrittenAt(port, 'server.pid'));
    const lateBlindPort = fresh.discoveryFailed
      && (finalEndpointAnswered || starting !== null || liveLateRecord);
    const lostClaim = !ownsStopClaim(port, stopClaim);
    const lateUnknown = [...fresh.unidentified];
    if (starting !== null) lateUnknown.push(starting.pid);
    const lateSurvivors = fresh.ours.map((owner) => owner.pid);
    if (liveLateRecord && !lateSurvivors.includes(lateRecord.pid)) {
      lateSurvivors.push(lateRecord.pid);
    }

    if (lostClaim) {
      return {
        signalled,
        strangers: [...new Set([...strangers, ...fresh.strangers])],
        surviving: remaining,
        unknown,
        legacy: [], heldPort: fresh.ours.length > 0,
        down: false, blindPort: false,
      };
    }

    if (lateSurvivors.length || lateUnknown.length || lateBlindPort) {
      const finalSurvivors = new Set([...remaining, ...unknown,
        ...lateSurvivors, ...lateUnknown]);
      const finalTargets = [...targets, ...fresh.ours,
        ...(liveLateRecord ? [lateRecord] : [])]
        .filter((target, index, all) => target?.token
          && all.findIndex((seen) => seen?.pid === target.pid) === index);
      const stillHere = finalTargets.filter((target) => finalSurvivors.has(target.pid));
      if (stillHere.length) {
        writeState(port, 'survivors', stillHere
          .map((target) => `${target.pid} ${target.token}`).join('\n'));
      }
      return {
        signalled,
        strangers: [...new Set([...strangers, ...fresh.strangers])],
        surviving: [...new Set([...remaining, ...lateSurvivors])],
        unknown: [...new Set([...unknown, ...lateUnknown])],
        legacy: [], heldPort: fresh.ours.length > 0,
        down: false, blindPort: lateBlindPort,
      };
    }
  }

  clearInFlight(port);
  for (const f of ['in-flight', 'last-activity', 'stopping', 'loaded-model',
    'stopped-idle']) clearState(port, f);

  // Keep the identity of anything that survived. Clearing it unconditionally
  // destroyed the only evidence a retry could use: a target that has closed its
  // socket but is still alive is invisible to port discovery, so "inspect it, then
  // retry" left the user with nothing to inspect and nothing for the retry to find.
  // An unjudgeable target counts as a survivor for state purposes: if we cannot say
  // it exited, we must not throw away the identity needed to ask again.
  const survivors = new Set([...remaining, ...unknown]);
  const kept = new Set();
  for (const name of PID_FILES) {
    // The watchdog's record comes from `watchdogRecord`, not the opening snapshot: a
    // supervisor that published mid-stop is absent from the snapshot, and reading the
    // slot from there would clear the identity of a process that is still running.
    // Re-read once more here, immediately before the decision to clear. Everything
    // between the check above and this point is escalation waits — seconds — and a
    // watchdog can publish inside them; clearing on a stale reading deletes the live
    // supervisor's identity and then reports success.
    const rec = name === 'watchdog.pid'
      ? (pidRecord(port, 'watchdog.pid') ?? watchdogRecord ?? undefined)
      : recordedByName.get(name);
    // The watchdog we chose not to signal keeps its record too. Clearing it would
    // orphan a live supervisor: still running, but invisible to the next client,
    // which would start a second one and leave this one de-supervising nothing.
    const spared = name === 'watchdog.pid' && !serverGone && rec !== undefined;
    if (rec !== undefined && (survivors.has(rec.pid) || spared)) kept.add(rec.pid);
    else clearState(port, name);
  }

  // Preserving only PRE-EXISTING records is not enough. The survivor is usually the
  // listener grandchild found from the port, which no pid file ever named — so every
  // record would be cleared while `remaining` still pointed at it, and a retry could
  // find it neither by port (it may have closed the socket) nor by state. Write the
  // identity we proved, so the next run can act on the advice this one gives.
  // Only into a slot nothing is already using. If the recorded launcher survived too,
  // its record is in `server.pid` and overwriting it would trade one survivor's
  // identity for another's — losing the very thing being preserved. There are two
  // slots and no third, so when both are taken the extra survivor is reported rather
  // than recorded; the error below names every one of them.
  const serverSlotFree = !kept.has(recordedByName.get('server.pid')?.pid);
  const orphan = targets.find((t) => survivors.has(t.pid) && !kept.has(t.pid));
  if (orphan !== undefined && serverSlotFree) {
    writeState(port, 'server.pid', `${orphan.pid} ${orphan.token}`);
  }

  // And every survivor, without the two-slot ceiling, so a retry can find all of
  // them rather than only whichever one happened to fit. A watchdog that outlived
  // its SIGTERM belongs in that list too: it is not among `targets` — deliberately,
  // so the server volley never reaches it — but it is one of this plugin's processes
  // and a retry has to be able to find it.
  const stillHere = [...targets, ...(watchdogRecord ? [watchdogRecord] : [])]
    .filter((t) => survivors.has(t.pid) && t.token);
  if (stillHere.length) {
    writeState(port, 'survivors', stillHere.map((t) => `${t.pid} ${t.token}`).join('\n'));
  } else {
    clearState(port, 'survivors');
  }

  // A tombstone, written last and ONLY on success. A watchdog spawned before this
  // stop may still be completing its own identity lookup and about to publish itself
  // as supervisor of a server that no longer exists; it compares this against when it
  // was spawned and stands down. Durable on purpose — an old stop is simply earlier
  // than the next watchdog, so nothing has to remember to clear it.
  //
  // Writing it after a FAILED stop was worse than not writing it: the server is still
  // running, and the pending watchdog we just invalidated was the thing that would
  // have gone on supervising it. A stop that did not stop anything must not disband
  // the supervision it could not replace.
  if (remaining.length === 0 && unknown.length === 0
      && (stopClaim === null || ownsStopClaim(port, stopClaim))) {
    writeState(port, 'stopped-at', Date.now());
  }

  // The verdict is about the processes we signalled, never about the endpoint.
  //
  // Judging by the port reported failure for doing exactly the right thing — leaving
  // a stranger alone while stopping our own watchdog — which is what it did on Linux
  // the first time the suite ran there. Windows had passed that case by accident:
  // identity costs a PowerShell start-up there, so the watchdog had not yet published
  // the pid that made the path reachable. Scoping to `ours` also covers the case
  // where a stranger takes the socket mid-teardown, where the port would still be
  // answering for a reason that has nothing to do with us.
  return {
    signalled,
    strangers,
    surviving: remaining,
    unknown,
    heldPort: ours.length > 0,
    down: remaining.length === 0 && unknown.length === 0,
    blindPort: false, legacy: [],
  };
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
    const stopClaim = await acquireStopClaim(opts.port);
    let wasUp;
    let result;
    try {
      wasUp = await probe(opts);
      result = await stopProcesses(opts, Boolean(wasUp), stopClaim);
    } finally {
      releaseStopClaim(opts.port, stopClaim);
    }
    const { signalled, strangers, surviving, unknown, legacy, heldPort, down, blindPort } = result;

    const noteStrangers = () => {
      if (!strangers.length) return;
      process.stderr.write(
        `[litertlm] note: pid ${strangers.join(', ')} is listening on port ${opts.port}`
        + `${wasUp ? ' and answers /v1/models' : ''}, but its command line is not a litert-lm\n`
        + '  server, so it is not this plugin\'s and was left running.\n'
        + '  If you meant to free the port, stop that process yourself, or use --port <n>.\n');
    };

    // Failure is tested FIRST, ahead of every success message.
    //
    // It has been wrong twice in the other order. Below the no-port branch, off-port
    // survivors printed "Stopped this plugin's processes" and exited 0. Below the
    // nothing-signalled branch, a set that was entirely unjudgeable — nothing to
    // signal, nothing proven gone — reported "Server was not running" and cleared the
    // state. Both said the work was done because no branch above them had asked
    // whether it was.
    if (!down) {
      noteStrangers();
      // Name them. A survivor may have closed its socket and so be invisible to any
      // port-based look-up the reader would otherwise try, which is exactly why the
      // state records were kept rather than cleared.
      const parts = [];
      if (blindPort) {
        parts.push(`process ownership on port ${opts.port} could not be determined — the\n`
          + '  platform owner-discovery query could not be run, so\n'
          + '  the question was never asked rather than answered "nobody". Nothing was\n'
          + '  signalled and no\n'
          + `  state was cleared. ${portOwnerDiscoveryHelp()}`);
      }
      if (legacy.length) {
        parts.push(`pid ${legacy.join(', ')} has a live legacy PID record without an identity\n`
          + '  token. It cannot be safely signalled or counted as gone. Nothing was\n'
          + '  signalled and its record was kept; stop it manually, then retry.');
      }
      if (surviving.length) {
        parts.push(`pid ${surviving.join(', ')} did not stop. It is this plugin's process\n`
          + '  and it is still running, so it may still hold accelerator memory even if it\n'
          + '  has closed its socket.');
      }
      if (unknown.length) {
        parts.push(`pid ${unknown.join(', ')} could not be identified — the process lookup\n`
          + '  failed, so whether it exited is unknown. Treated as still running rather\n'
          + '  than assumed gone.');
      }
      throw new Error(`${parts.join('\n  ')}\n  Inspect it, then retry.`);
    } else if (!signalled.length) {
      // Nothing provable was ours, and nothing was left unjudged. Clearing state is
      // still right and still done.
      process.stdout.write(strangers.length
        ? `No server of this plugin's was running on port ${opts.port}; state cleared.\n`
        : 'Server was not running; state cleared.\n');
      noteStrangers();
    } else if (!heldPort) {
      // We stopped our own processes — a watchdog, a launcher stage — but the socket
      // was never ours. Saying "accelerator memory released" here would be a lie:
      // whatever is on that port still holds whatever it holds.
      process.stdout.write(
        `Stopped this plugin's processes on port ${opts.port}; state cleared.\n`);
      noteStrangers();
    } else {
      process.stdout.write('Server stopped; accelerator memory released.\n');
      noteStrangers();
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
  const marker = await acquireInFlight(opts.port, opts);

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
