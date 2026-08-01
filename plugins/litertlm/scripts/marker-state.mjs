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

import { readdirSync, rmSync } from 'node:fs';
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

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    if (markerIsStale(name)) {
      try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
    } else {
      live += 1;
    }
  }
  return live;
}
