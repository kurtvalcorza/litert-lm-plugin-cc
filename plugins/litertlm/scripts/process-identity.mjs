/**
 * process-identity — prove a process is the one we started before signalling it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two things had been standing in for ownership, and neither is one:
 *
 * 1. A 2xx from `/v1/models`. That is a protocol shape, not an identity. Any
 *    OpenAI-compatible server — llama.cpp, LM Studio, vLLM, another agent's
 *    sidecar — answers it, and `--stop` then terminated whatever held the port and
 *    reported "Server stopped; accelerator memory released." Reproduced: a stranger
 *    answering /v1/models on a spare port was killed, exit 0, success message.
 *
 * 2. A live pid in `server.pid`. A pid is a slot the OS reuses, not a handle. The
 *    boot-session test in litertlm-client.mjs catches reuse ACROSS a reboot, which
 *    is what the 0x116 bugcheck of 2026-08-01 produced. It cannot catch reuse
 *    WITHIN one boot: our server exits, the pid comes back around, and the recorded
 *    file now names a bystander. Reproduced with no listener on the port at all —
 *    the recorded pid alone was enough to SIGTERM an innocent process.
 *
 * WHAT IDENTITY MEANS HERE
 * ------------------------
 * A pid plus the process's OS-reported creation time. The pair is unique for as
 * long as the process lives: a reused pid belongs to a process that started later,
 * so its creation time differs and the comparison fails. We record the pair when we
 * spawn something and re-check it before we signal it.
 *
 * That works for processes WE spawned. It cannot work for the process holding the
 * socket, because we never spawned it — `litert-lm serve` is a three-stage
 * launcher (litert-lm.exe -> uv shim -> python), and the socket ends up with a
 * grandchild we have no record of. For those, identity comes from the command
 * line: a process already known to be listening on the target port, whose command
 * line names litert-lm and `serve`, is the server. Descent from our recorded pid
 * was the stronger alternative and was rejected: `ensureServer` deliberately adopts
 * a server it did not start, and an ancestry test would refuse to stop exactly
 * those, trading a correctness bug for a functional one.
 *
 * THREAT MODEL: accident, not adversary. This stops `--stop` from killing your
 * other model server or a bystander that inherited a pid. A local process that
 * deliberately forges a litert-lm command line and listens on the port will still
 * be signalled, and that is out of scope for a developer tool.
 *
 * Node standard library only (constitution, Principle III).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The boot-session test and pid liveness already have a home; ownership builds on
// them rather than restating them. marker-state imports nothing from here, so this
// direction is the only one and there is no cycle.
import { BOOT_TIME_MS, pidAlive } from './marker-state.mjs';

/**
 * pid -> {start, cmdline} | null, memoised for the life of this process.
 *
 * Identity is immutable while a process lives, and a pid that has died stays dead,
 * so a second lookup can only repeat the first. This matters for cost, not just
 * tidiness: on Windows every uncached lookup is a PowerShell start-up, and
 * `reconcileState` alone asks about the same two pids four times.
 */
const cache = new Map();

/** Collapse whitespace so a wrapped or padded command line still matches. */
const flatten = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function inspectWindows(pids) {
  const filter = pids.map((p) => `ProcessId=${p}`).join(' or ');
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction SilentlyContinue `
    + '| ForEach-Object { ($_.ProcessId, $_.CreationDate.ToFileTimeUtc(), '
    + "($_.CommandLine -replace '\\s+',' ')) -join [char]9 }";

  let out = '';
  try {
    out = spawnSync('powershell.exe', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  } catch { return; }

  for (const line of out.split(/\r?\n/)) {
    const [pidStr, start, ...rest] = line.split('\t');
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isInteger(pid) || !start) continue;
    cache.set(pid, { start: start.trim(), cmdline: flatten(rest.join('\t')) });
  }
}

/**
 * Linux: /proc, read directly — no subprocess, so this costs nothing.
 *
 * Field 22 of /proc/<pid>/stat is the process start time in clock ticks since
 * boot. `comm` (field 2) is parenthesised and may itself contain spaces and
 * parentheses, so the fields are counted from the LAST ')' rather than by
 * splitting the whole line.
 *
 * Ticks-since-boot repeat across reboots, so this token is unique only within one
 * boot session. That is why the caller keeps its separate pre-boot test rather than
 * letting this replace it.
 */
function inspectLinux(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19];                       // field 22, 1-indexed
    if (!start) return null;
    const cmdline = flatten(
      readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
    return { start, cmdline };
  } catch {
    return null;
  }
}

/** macOS and other POSIX: `ps` is the only portable answer. 1-second resolution. */
function inspectPosixPs(pids) {
  let out = '';
  try {
    out = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,args='],
      { encoding: 'utf8' }).stdout ?? '';
  } catch { return; }

  for (const line of out.split('\n')) {
    // pid, then a fixed 5-field `lstart` (Www Mmm DD HH:MM:SS YYYY), then argv.
    const m = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    cache.set(Number.parseInt(m[1], 10), { start: flatten(m[2]), cmdline: flatten(m[3]) });
  }
}

/**
 * Identity for several pids at once, filling the cache.
 *
 * Batched because the Windows path pays a PowerShell start-up per call and not per
 * pid: asking about two processes separately costs twice as much as asking once.
 */
export function identities(pids) {
  const wanted = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const missing = wanted.filter((p) => !cache.has(p));

  if (missing.length) {
    if (process.platform === 'win32') {
      inspectWindows(missing);
    } else if (process.platform === 'linux') {
      for (const p of missing) cache.set(p, inspectLinux(p));
    } else {
      inspectPosixPs(missing);
    }
    // Anything the platform did not report does not exist as far as we can tell.
    for (const p of missing) if (!cache.has(p)) cache.set(p, null);
  }

  return new Map(wanted.map((p) => [p, cache.get(p) ?? null]));
}

export const identity = (pid) => identities([pid]).get(pid) ?? null;

/** The token to store alongside a pid so it can be re-identified later. */
export function startToken(pid) {
  return identity(pid)?.start ?? null;
}

/**
 * Is `pid` still the exact process whose token we recorded?
 *
 * Fails closed. A missing token (state written by an older version), a process the
 * platform will not describe, or any mismatch all return false — the caller must
 * then leave the process alone. Refusing to stop our own server is a slow, visible,
 * recoverable failure; signalling someone else's is a silent, unrecoverable one.
 */
export function isRecordedProcess(pid, token) {
  if (!token) return false;
  const seen = identity(pid);
  return seen !== null && seen.start === token;
}

/**
 * Does this process look like a `litert-lm serve`?
 *
 * Only ever asked of a pid already observed listening on the port we are about to
 * act on, so this does not have to identify litert-lm among all processes — only
 * to separate it from an unrelated server that happens to hold the same socket.
 *
 * Deliberately does NOT require `--port <n>` in the command line: a server started
 * by hand as plain `litert-lm serve` on the default port carries no such flag, and
 * `ensureServer` adopts exactly that server. The listening socket already supplies
 * the port; the command line only has to supply the identity.
 */
export function looksLikeLitertLmServe(pid) {
  const cmdline = identity(pid)?.cmdline;
  if (!cmdline) return false;
  return /litert[-_]lm/i.test(cmdline) && /(^|[\s"'/\\])serve(\s|$)/i.test(cmdline);
}

// ---------------------------------------------------------------------------
// The pid-file record
//
// `<pid> <start-token>`. The client and the watchdog both read and write these, so
// the format and the verdict live here rather than in either of them — the last
// three rounds of defects in this plugin were all one rule with two homes.
// ---------------------------------------------------------------------------

/** Parse a pid file's contents. Older installs wrote a bare `<pid>` and no token. */
export function parsePidRecord(raw) {
  const [pidStr, token] = String(raw ?? '').trim().split(/\s+/);
  const pid = Number.parseInt(pidStr, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, token: token ?? null } : null;
}

/** Serialise a pid we just spawned. Call while it is certainly the right process. */
export function formatPidRecord(pid) {
  const token = startToken(pid);
  return token ? `${pid} ${token}` : String(pid);
}

/**
 * TWO QUESTIONS, DELIBERATELY DIFFERENT — read this before using either.
 *
 * "May I delete this state file?" and "May I send this pid a signal?" are not the
 * same question, and answering them with one predicate is what makes the strong
 * answer too expensive to use. Establishing identity costs a process lookup — about
 * 930ms on Windows, where it means starting PowerShell — and `reconcileState` runs
 * on every single invocation, including `--check`. Paying it there put roughly a
 * second onto every call to buy nothing: reconciliation only ever DELETES STALE
 * FILES, and the worst case of getting that wrong is a redundant watchdog, which
 * stands down by itself under the single-supervisor rule.
 *
 * So: `recordIsStale` for hygiene, `signallablePid` for authority. The second is
 * strictly stronger than the first and is defined in terms of it, so they cannot
 * drift into disagreeing — which is exactly the failure this plugin has now hit
 * three times. What must never happen is the WEAK one being used to justify a
 * signal. If you are about to call `process.kill`, the answer comes from
 * `signallablePid`, and there is no second opinion.
 */

/**
 * Hygiene: is this record dead wood we may discard? Cheap; never authorises a kill.
 *
 * 1. Nothing recorded, or the pid is not alive.
 * 2. The file was written before this boot. Pid liveness is exact only within one
 *    boot session. After the 0x116 bugcheck of 2026-08-01 20:49 this host came back
 *    with `server.pid` naming a running Discord and `watchdog.pid` naming a running
 *    VS Code, both files written two minutes before boot.
 */
export function recordIsStale(record, writtenAtMs) {
  if (record === null || !pidAlive(record.pid)) return true;
  return writtenAtMs !== null && writtenAtMs < BOOT_TIME_MS;
}

/**
 * Authority: may we signal the process this record names? Returns the pid, or null.
 *
 * Everything `recordIsStale` requires, plus the one test that costs something: the
 * process's creation time must still match the token recorded when we spawned it.
 * The boot-session test cannot catch reuse WITHIN one boot — our server exits, the
 * pid comes back around, and the file now names a bystander. Reproduced: with
 * nothing listening on the port at all, the recorded pid alone was enough for
 * `--stop` to SIGTERM an innocent process. It is also what covers Linux, where the
 * token is ticks since boot and so can repeat across reboots.
 *
 * Fails closed, including on a tokenless record from an older install: an
 * unprovable claim is refused, not given the benefit of the doubt.
 */
export function signallablePid(record, writtenAtMs) {
  if (recordIsStale(record, writtenAtMs)) return null;
  return isRecordedProcess(record.pid, record.token) ? record.pid : null;
}

/** Test seam: forget everything looked up so far. */
export function _resetIdentityCache() {
  cache.clear();
}
