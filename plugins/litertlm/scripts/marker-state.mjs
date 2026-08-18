/**
 * marker-state — the single definition of what an in-flight marker means.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The client and the watchdog both read `in-flight.d/`, and they must agree
 * exactly. When they did not, the consequences were real: an earlier round of
 * fixes traced three separate defects to the two processes holding different
 * definitions of "the server is unreachable". The fix for that then reintroduced
 * the same shape one level down — the client grew a `markerIsStale()` helper while
 * the watchdog re-implemented the same rule inline, with a comment pointing at the
 * other file and asking the reader to keep them in step by hand.
 *
 * A rule that two components must share is not a rule until it has one home.
 *
 * Both callers now use `reapMarkers()`, so "stale" cannot mean two things: the
 * client ignores the return value and the watchdog uses it, but the pruning and
 * the counting are the same traversal under the same predicate.
 *
 * Node standard library only (constitution, Principle III).
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

/**
 * When this host last booted, as an epoch millisecond stamp.
 *
 * Computed once per process: `uptime()` advances while we run, so recomputing
 * would make the boundary drift and two calls could disagree about one marker.
 *
 * KNOWN LIMIT: each process computes this at its own start, so a wall-clock step
 * (an NTP correction, a manual clock change) moves one process's boundary and not
 * another's. Newly written markers always sit above a forward-skewed boundary, so
 * the exposure is limited to old markers, which are almost always stale anyway.
 * Recorded rather than fixed — a shared constant here does not make separate
 * processes agree about when they started.
 */
export const BOOT_TIME_MS = Date.now() - uptime() * 1000;

/**
 * Does this pid exist? Not: may we signal it.
 *
 * `kill(pid, 0)` performs the permission check without delivering anything, and it
 * has two distinct failures that this used to flatten into one:
 *
 *   ESRCH — no such process. Dead.
 *   EPERM — the process EXISTS; we are not allowed to touch it.
 *
 * Treating EPERM as dead is how a process that is plainly running gets classified as
 * gone: everything downstream then concludes a target exited, clears its state and
 * reports success. Verified on this host — pid 4, the Windows System process,
 * answers EPERM and was reported dead.
 *
 * Existence and permission are different questions, and only the first one is being
 * asked here. Whether we may signal something is settled by identity, not by this.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  return !isZombie(pid);
}

/**
 * Has this pid exited but not yet been reaped? Linux only; false elsewhere.
 *
 * Folded into `pidAlive` rather than bolted onto individual callers, because a
 * zombie is dead by every meaning this codebase has for the word: it holds no
 * memory, owns no socket, and answers no request. Checking it in only some places
 * is how a terminated watchdog kept its `watchdog.pid` forever under a container
 * PID 1 that does not reap — the shutdown path knew it was gone, the hygiene path
 * did not, and no replacement supervisor was ever started.
 */
export function isZombie(pid) {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z';
  } catch {
    return false;
  }
}

/**
 * Is this marker dead wood?
 *
 * Markers are named `<pid>-<epochMs>`. Two independent tests, either sufficient:
 *
 * 1. Written before this boot. Pid liveness alone is exact only WITHIN one boot
 *    session — the OS reuses pids, so after a reboot a crashed client's pid can
 *    belong to something unrelated and very much alive. The marker would then look
 *    live forever, idle shutdown would never fire, and the accelerator memory would
 *    stay pinned until someone ran --stop by hand: the exact failure this whole
 *    mechanism exists to prevent. Observed after a real 0x116 bugcheck, where the
 *    marker predated boot by two minutes and survived only because the pid happened
 *    not to be reused.
 * 2. Owning process is gone.
 *
 * An unparseable timestamp (a marker from some older layout) falls back to the pid
 * test rather than guessing.
 */
export function markerIsStale(name) {
  const [pidPart, tsPart] = name.split('-');
  const ts = Number.parseInt(tsPart, 10);
  if (Number.isFinite(ts) && ts < BOOT_TIME_MS) return true;
  return !pidAlive(Number.parseInt(pidPart, 10));
}

/**
 * Remove every stale marker in `dir`; return how many live ones remain.
 *
 * One traversal serves both callers so the count and the pruning can never
 * disagree. A missing directory means nothing is in flight, which is not an error.
 */
export function reapMarkers(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }

  let live = 0;
  for (const name of entries) {
    // Only `<pid>-<epochMs>` files are ours. A stray file (an editor temp, a
    // committed .gitkeep) is neither a live marker to count nor debris to delete —
    // markerIsStale() would otherwise judge it stale (NaN pid) and rmSync it.
    if (!/^\d+-\d+$/.test(name)) continue;
    if (markerIsStale(name)) {
      try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
    } else {
      live += 1;
    }
  }
  return live;
}
