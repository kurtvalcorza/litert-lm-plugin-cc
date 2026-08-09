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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The boot-session test and pid liveness already have a home; ownership builds on
// them rather than restating them. marker-state imports nothing from here, so this
// direction is the only one and there is no cycle.
import { BOOT_TIME_MS, pidAlive } from './marker-state.mjs';

/**
 * pid -> {start, cmdline} | null, memoised.
 *
 * Worth the memo because on Windows every uncached lookup is a PowerShell start-up
 * (~930ms measured) and `reconcileState` alone asks about the same two pids four
 * times.
 *
 * SCOPE, AND WHY IT IS NARROW: this is only sound across a single short operation.
 * An earlier version of this comment justified the memo with "a pid that has died
 * stays dead", which is precisely the assumption the rest of this file exists to
 * disprove — the pid NUMBER outlives the process and the OS hands it to someone
 * else. A cached entry describing a process that has since exited will happily
 * identify its replacement as the original.
 *
 * So: anything that signals a pid AFTER having killed something must call
 * `forgetIdentities` first, and any long-lived caller must not assume a second
 * lookup of the same pid is free of meaning. Both escalation loops do exactly that.
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

/**
 * macOS and other POSIX: `ps` is the only portable answer, and a coarse one.
 *
 * `lstart` is `Www Mmm dd HH:MM:SS YYYY` — no subsecond field, so two processes
 * created in the same second are indistinguishable by time alone. That is the exact
 * pid-churn case the identity check exists to catch: a target exits, its pid is
 * reissued within the same second, and `{pid, start}` matches the replacement.
 *
 * The token therefore carries a digest of the command line as well. A collision now
 * needs the recycled pid to be running the same argv too, which narrows "unrelated
 * process" to "another instance of the same server" — still a collision in
 * principle, but no longer one that can reach an unrelated program.
 *
 * Not fully closed, and worth being plain about that: Linux (/proc field 22, clock
 * ticks) and Windows (creation time, 100ns) are precise enough not to need this.
 * A subsecond source on macOS would be better than a digest; there is no portable
 * one via `ps`.
 */
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
    const cmdline = flatten(m[3]);
    const digest = createHash('sha256').update(cmdline).digest('hex').slice(0, 16);
    cache.set(Number.parseInt(m[1], 10),
      { start: `${flatten(m[2])}#${digest}`, cmdline });
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

/**
 * Drop cached identities so the next lookup asks the OS again.
 *
 * Required before re-checking a pid we have already signalled: by then the process
 * may have exited and the number been reissued, and the cache would still be
 * describing the process we killed.
 */
export function forgetIdentities(pids) {
  for (const pid of pids) cache.delete(pid);
}

// ---------------------------------------------------------------------------
// Who is listening on a port
//
// Lives here, next to identity, because both the client and the watchdog need it
// and each used to carry its own copy — including its own platform quirks to fix
// twice. Discovery answers "who holds this socket"; it says nothing about whether
// that process is ours, which is what `isLitertLmServeCommand` is for.
// ---------------------------------------------------------------------------

/**
 * litert-lm is a multi-stage launcher: the pid we spawned is not the process that
 * ends up holding the socket, so the recorded pid alone can never stop the server.
 * Asking the OS who owns the port is the only reliable answer.
 *
 * On Linux `lsof` is tried first and `ss` second. Minimal container and CI images
 * routinely ship iproute2 without lsof, and with only lsof the discovery silently
 * returned nothing — which reads exactly like "the port is free" and makes `--stop`
 * quietly do nothing.
 */
export function pidsOnPort(port) {
  const run = (cmd, args) => {
    try {
      return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    } catch {
      return '';
    }
  };

  const pids = new Set();
  const collect = (text, re) => {
    for (const m of text.matchAll(re)) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  };

  if (process.platform === 'win32') {
    collect(run('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue `
      + '| Select-Object -ExpandProperty OwningProcess']), /^\s*(\d+)\s*$/gm);
    return [...pids];
  }

  collect(run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']), /^\s*(\d+)\s*$/gm);
  if (pids.size) return [...pids];

  // `ss -ltnp` prints owners as: users:(("python",pid=68056,fd=7))
  collect(run('ss', ['-ltnp', 'sport', `= :${port}`]), /pid=(\d+)/g);
  return [...pids];
}

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
 * Is this command line a `litert-lm serve`?
 *
 * Parsed as argv, not searched as text, and the litert-lm token must occupy a
 * LAUNCHER POSITION. Two weaker versions of this test shipped in review and both
 * were wrong in the same direction:
 *
 *   v1, two independent word searches — satisfied by unrelated parts of one line:
 *     python /work/litert_lm/tools/server.py serve   <- directory + unrelated arg
 *     vim /home/kurt/litert-lm/serve notes.txt       <- directory + a FILE named serve
 *
 *   v2, required them adjacent — which is still not a role:
 *     python unrelated_server.py litert_lm serve     <- adjacent, both arguments
 *     node server.js --label litert-lm serve         <- adjacent, both arguments
 *
 * Every one of those would have been signalled had it owned the configured port,
 * which is the accident this whole change exists to prevent. Adjacency was a
 * narrower guess, not a different kind of answer; position is the answer.
 *
 * Deliberately does NOT require `--port <n>`: a server started by hand as plain
 * `litert-lm serve` on the default port carries no such flag, and `ensureServer`
 * adopts exactly that server. The listening socket already supplies the port; the
 * command line only has to supply the identity.
 *
 * Fails safe in the other direction too. `litert-lm --verbose serve` and
 * `uv run litert-lm serve` put something between the program and either the
 * interpreter or the subcommand, and neither is recognised. The cost is a real
 * server being reported as a stranger and left running — visible, and fixable by
 * stopping it yourself — rather than a stranger being killed, which is neither.
 */
/** Split a command line into argv-ish tokens, keeping quoted paths whole. */
function argvTokens(cmdline) {
  return [...String(cmdline ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A path or bare name whose final component IS the litert-lm program. */
const LITERT_LM_PROGRAM = /(?:^|[/\\])litert[-_]lm(?:\.exe)?$/i;

export function isLitertLmServeCommand(cmdline) {
  const argv = argvTokens(cmdline);
  const serveIdx = argv.findIndex((t) => t.toLowerCase() === 'serve');
  if (serveIdx < 1) return false;
  if (!LITERT_LM_PROGRAM.test(argv[serveIdx - 1])) return false;
  // Launcher role: the entry point (argv[0], or argv[1] behind an interpreter) or a
  // `-m litert_lm` module invocation. Position is what separates the program from an
  // argument that merely happens to be spelled the same way.
  return serveIdx - 1 <= 1 || argv[serveIdx - 2] === '-m';
}

/**
 * Does the process behind this pid look like a `litert-lm serve`?
 *
 * Only ever asked of a pid already observed listening on the port we are about to
 * act on, so this does not have to identify litert-lm among all processes — only to
 * separate it from an unrelated server that happens to hold the same socket.
 */
export const looksLikeLitertLmServe = (pid) =>
  isLitertLmServeCommand(identity(pid)?.cmdline);

// ---------------------------------------------------------------------------
// The pid-file record
//
// `<pid> <start-token>`. The client and the watchdog both read and write these, so
// the format and the verdict live here rather than in either of them — the last
// three rounds of defects in this plugin were all one rule with two homes.
// ---------------------------------------------------------------------------

/**
 * Parse a pid file's contents. Older installs wrote a bare `<pid>` and no token.
 *
 * The token is EVERYTHING after the pid, not the next whitespace-delimited field.
 * On Windows it is one integer, but the POSIX `ps` path produces a five-field
 * `lstart` such as `Sun Aug 9 12:34:56 2026`; splitting on whitespace kept only
 * `Sun`, so every later comparison failed and no recorded process on macOS was ever
 * signallable. Found in review, before any macOS run existed to catch it.
 */
export function parsePidRecord(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)(?:\s+(.+))?$/s);
  if (m === null) return null;
  const pid = Number.parseInt(m[1], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, token: m[2]?.trim() || null };
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
