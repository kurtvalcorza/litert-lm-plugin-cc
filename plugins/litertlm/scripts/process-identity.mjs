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

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

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

/**
 * Run a query tool and preserve whether the query produced an answer at all.
 *
 * Shared by socket discovery and the process-table walk. `ok` is the load-bearing
 * part: an empty successful answer means "nothing matched" while a failed query means
 * "I could not tell", and callers must never spend the second as the first.
 *
 * `nonZeroIsAnswer` IS FOR `lsof` ALONE, and it has to be opt-in rather than the
 * default. `lsof` exits 1 for "nothing matched", so for that one tool a nonzero exit
 * really is a result. Extending the same generosity to PowerShell, `ss` and `ps` meant
 * a query that STARTED and then failed handed its empty stdout back as an
 * authoritative scan: in `--stop` an operational failure became "no owners", state was
 * cleared and success reported while the server carried on running. Every other tool
 * here exits 0 on an empty result, so nonzero from them is a broken question.
 */
function run(cmd, args, { nonZeroIsAnswer = false } = {}) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    // `error` is ENOENT, EACCES, or a failure to spawn at all — the query never ran.
    // That is NOT the same answer as "it ran and found nothing", and returning '' for
    // both is how a failed lookup comes back looking like an empty port.
    // A SIGNAL is a failure too, and a quieter one: `spawnSync` leaves `error` unset
    // when the process started fine and was then killed, so a terminated PowerShell
    // or lsof would hand back its partial (usually empty) stdout as an authoritative
    // answer — turning a query someone interrupted straight into an empty port.
    if (r.error || r.signal) return { ok: false, out: '', status: null };
    if (!nonZeroIsAnswer && r.status !== 0) return { ok: false, out: '', status: r.status };
    return { ok: true, out: r.stdout ?? '', status: r.status };
  } catch {
    return { ok: false, out: '', status: null };
  }
}

/**
 * `run`, off the event loop.
 *
 * Same contract, same three-state answer; the caller keeps its timers and sockets
 * while the query runs, and a query that exceeds its bound becomes `{ ok: false }`.
 * That is what makes a tight sampling cadence affordable on Windows, where a
 * process-table walk is a PowerShell start-up measured at ~930ms — long enough that a
 * blocking version had to be throttled to every 3s, which is itself long enough for a
 * launcher stage to spawn a descendant and exit unobserved.
 */
const PROCESS_QUERY_TIMEOUT_MS = 10_000;

function runAsync(cmd, args,
  { nonZeroIsAnswer = false, timeoutMs = PROCESS_QUERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // A process-table query sits inside the startup deadline, but awaiting a child
      // with no bound prevents that deadline from advancing at all. Abort the query
      // and return the ordinary unjudgeable result; callers already know not to spend
      // `{ ok: false }` as an empty process table.
      child = spawn(cmd, args, {
        windowsHide: true,
        signal: AbortSignal.timeout(timeoutMs),
        killSignal: 'SIGKILL',
      });
    } catch {
      resolve({ ok: false, out: '', status: null });
      return;
    }
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    child.stdout?.on('error', () => {});
    child.stderr?.on('data', () => {});
    child.stderr?.on('error', () => {});
    child.on('error', () => done({ ok: false, out: '', status: null }));
    child.on('close', (status, signal) => {
      if (signal) { done({ ok: false, out: '', status: null }); return; }
      if (!nonZeroIsAnswer && status !== 0) { done({ ok: false, out: '', status }); return; }
      done({ ok: true, out, status });
    });
  });
}

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

    // Field 3 is run state. A zombie has exited — it holds no memory, answers no
    // socket, and is only still in the table because nobody has reaped it. It keeps
    // its pid and its start time, though, so without this check it matches its own
    // recorded token forever and `--stop` reports a process it successfully killed as
    // still running. Under a container PID 1 that does not reap, that is permanent.
    if (fields[0] === 'Z') return null;

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
    out = spawnSync('ps', ['-ww', '-p', pids.join(','), '-o', 'pid=,lstart=,args='],
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
 * Reduce a listen address to a comparable form.
 *
 * The three OS queries spell the same socket three ways — `[::1]`, `::1`, and
 * `::ffff:127.0.0.1` are all real output — so they are normalised before any of them
 * is compared. Scope ids (`fe80::1%lo0`) name an interface, not an address, and are
 * dropped for the same reason.
 */
function normaliseAddress(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const scope = a.indexOf('%');
  if (scope !== -1) a = a.slice(0, scope);
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a;
}

/**
 * Would a listener bound to `listenAddress` answer a request we send to `host`?
 *
 * A PORT IS NOT A SOCKET. Two servers may hold the same port on different local
 * addresses at once — ours on 127.0.0.1:9379 and another litert-lm on
 * 192.168.1.5:9379 — and every OS query below reports both. Matching on the number
 * alone therefore let `--stop` prove a second, unrelated litert-lm server "ours" by
 * its command line and signal it, which is the same class of accident as killing a
 * bystander by pid: the identity test passed, the location test was never asked.
 *
 * A WILDCARD SERVES ITS OWN FAMILY, AND ONLY ITS OWN. `::` is dual-stack on some
 * hosts and IPv6-only on others — it turns on `IPV6_V6ONLY`, which none of the three
 * platform queries below reports, so we cannot tell the two apart from here. An
 * earlier version read `::` as serving everything on the grounds that dual-stack is
 * the common default. That admits an IPv6-only `litert-lm serve` on `:::9379` as the
 * owner of a socket a client on 127.0.0.1 cannot reach, and `--stop` would then
 * terminate it: precisely the cross-interface kill this function exists to prevent,
 * reintroduced by the case meant to be generous. A cross-family wildcard is kept
 * unprovable rather than discarded: it cannot authorise a signal, but its pid enters
 * the unidentified bucket so an incomplete picture cannot authorise success either.
 *
 * `localhost` is the exception, and not a grudging one: it is a NAME that resolves to
 * either family depending on the resolver, so neither wildcard can be ruled out and
 * both are accepted.
 *
 * `host` of null means the caller wants every listener regardless of address.
 *
 * An address we could not READ is a match too, and that is deliberate. An unreadable
 * address is not evidence of a foreign bind — it is the absence of evidence — and
 * treating it as a mismatch would silently drop a genuine server on a host whose
 * `ss` output we failed to parse, leaving `--stop` doing nothing at all. The command
 * line still has to prove ownership before anything is signalled, so this filter
 * only ever narrows a set that is already gated; it is not the thing standing
 * between us and a stranger.
 */
export function addressVerdict(listenAddress, host) {
  if (host === null || host === undefined) return 'serves';
  const a = normaliseAddress(listenAddress);
  if (a === '' || a === '*') return 'serves';
  const h = normaliseAddress(host);
  if (a === h) return 'serves';

  const isWildcard = a === '0.0.0.0' || a === '::' || a === '0:0:0:0:0:0:0:0';
  if (!isWildcard) {
    // A literal address is compared literally: a listener on ::1 is unreachable from
    // a client configured with 127.0.0.1, so it is not ours however loopback it looks.
    return (h === 'localhost' && (a === '127.0.0.1' || a === '::1')) ? 'serves' : 'foreign';
  }
  if (h === 'localhost') return 'serves';              // either family may be the one
  if (h.includes(':') ? a !== '0.0.0.0' : a === '0.0.0.0') return 'serves';

  // A CROSS-FAMILY WILDCARD IS UNPROVABLE, NOT ABSENT — and the difference is the
  // whole verdict. `::` serves v4 callers when IPV6_V6ONLY is off and does not when
  // it is on, and no platform query here reports which. Excluding it outright was the
  // first correction and it overshot: a filtered pid appears in none of `ours`,
  // `strangers` or `unidentified`, so a genuinely dual-stack server that IS answering
  // us vanished from discovery entirely and `--stop` reported "not running", cleared
  // state, and left it holding accelerator memory. Unjudgeable keeps it out of the
  // kill set and out of the success verdict at the same time, which is the only
  // reading that is honest in both directions.
  return 'unprovable';
}

/** Convenience for callers that only care whether it definitely serves `host`. */
export const addressServes = (listenAddress, host) =>
  addressVerdict(listenAddress, host) === 'serves';

/**
 * Every listening socket on `port`, as `{ pid, address }`.
 *
 * `address` is the LOCAL address the socket is bound to, or null when the platform
 * query did not give us one. Separated from the filtering below so the parsing and
 * the policy are testable apart from each other.
 *
 * On Linux `lsof` is tried first and `ss` second. Minimal container and CI images
 * routinely ship iproute2 without lsof, and with only lsof the discovery silently
 * returned nothing — which reads exactly like "the port is free" and makes `--stop`
 * quietly do nothing.
 */
function listenersOnPort(port) {
  if (process.platform === 'win32') {
    // THE EXIT CODE IS MADE MEANINGFUL HERE RATHER THAN INTERPRETED.
    //
    // `Get-NetTCPConnection` reports "no matching connections" as a non-terminating
    // ERROR, so `powershell.exe -Command` exits 1 for an empty port — measured, and
    // identical to the exit it gives when the query genuinely fails. Read naively,
    // nonzero would mean `--stop` refuses on every idle port; ignored, as it was, a
    // broken query hands back empty stdout that becomes an authoritative "no owners",
    // and `--stop` clears state and reports success while the server runs.
    //
    // Neither reading is available from the outside, so the script settles it itself:
    // the one error id that means "nothing matched" is swallowed and exits 0, anything
    // else exits 3. `run` then applies its ordinary rule — nonzero is a failed query —
    // and both cases are finally distinguishable. Verified on this host: empty port 0
    // with no rows, live port 0 with a row, malformed query 3.
    const r = run('powershell.exe', ['-NoProfile', '-Command',
      'try { '
      + `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop `
      + '| ForEach-Object { ($_.LocalAddress, $_.OwningProcess) -join [char]9 } '
      + "} catch { if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*')"
      + ' { exit 3 } }; exit 0']);
    return { ok: r.ok, listeners: parseGetNetTcpConnection(r.out) };
  }

  // `-F pn` is lsof's machine-readable mode: `p<pid>` opens a process set and each
  // `n<addr>:<port>` under it is one of its sockets. The previous `-ti` form printed
  // pids alone, which is why there was no address to check.
  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pn'],
    { nonZeroIsAnswer: true });
  if (lsof.ok) {
    const found = parseLsofFields(lsof.out);
    if (found.length) return { ok: true, listeners: found };
  }
  // lsof's EXIT STATUS IS NOT A USABLE ERROR SIGNAL, and it is worth saying why
  // rather than leaving it to be rediscovered. It returns 1 both for "nothing
  // matched" and for an operational failure, and "nothing matched" is overwhelmingly
  // the common case — an idle port. Treating nonzero as failure was tried and made
  // `--stop` refuse on every empty port, because that is what an empty port looks
  // like. Its stderr cannot arbitrate either: real installations emit `WARNING:
  // can't stat()` for unreadable mounts on perfectly successful runs.
  //
  // So the ambiguity is accepted and mitigated rather than resolved: `ss` is
  // consulted below and, where it runs, supplies an independent answer. Where neither
  // tool runs at all, that IS detected — `ok` is false and the caller refuses.

  // Minimal container and CI images routinely ship iproute2 without lsof, so `ss` is
  // not a fallback for a failed lsof so much as the other half of the same question.
  const ss = run('ss', ['-ltnp', 'sport', `= :${port}`]);
  if (ss.ok) return { ok: true, listeners: parseSs(ss.out) };

  // Neither tool added anything. `lsof.ok` is the whole verdict here, and because lsof
  // is the one tool run with `nonZeroIsAnswer` it stays true for an exit-1-nothing-
  // matched run — an empty port on a host with lsof is a real observation, not a
  // failure. It goes false only when lsof could not run at all, which with `ss` also
  // unavailable leaves nobody to answer the question, and the caller refuses.
  return { ok: lsof.ok, listeners: [] };
}

/** `<LocalAddress>\t<OwningProcess>`, one line per listening socket. */
function parseGetNetTcpConnection(out) {
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const [address, pidStr] = line.split('\t');
    const pid = Number.parseInt(pidStr, 10);
    if (Number.isInteger(pid) && pid > 0) found.push({ pid, address: address.trim() });
  }
  return found;
}

/** lsof `-F pn`: a `p<pid>` line, then one `n<addr>:<port>` line per socket. */
function parseLsofFields(out) {
  const found = [];
  let pid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null) {
      found.push({ pid, address: stripPort(line.slice(1)) });
    }
  }
  return found;
}

/**
 * `ss -ltnp` rows: `LISTEN 0 128 127.0.0.1:9379 0.0.0.0:* users:(("python",pid=68056,fd=7))`
 *
 * The header row carries no `pid=` and so is skipped by the same test that finds the
 * owners. One row can name several pids when a socket is shared across forked
 * workers; they all share the row's local address.
 */
function parseSs(out) {
  const found = [];
  for (const line of out.split('\n')) {
    const owners = [...line.matchAll(/pid=(\d+)/g)];
    if (!owners.length) continue;
    const address = stripPort(line.trim().split(/\s+/)[3] ?? '');
    for (const m of owners) {
      const pid = Number.parseInt(m[1], 10);
      if (Number.isInteger(pid) && pid > 0) found.push({ pid, address });
    }
  }
  return found;
}

/** `127.0.0.1:9379` -> `127.0.0.1`; `[::1]:9379` -> `[::1]`; `*:9379` -> `*`. */
function stripPort(endpoint) {
  const s = String(endpoint ?? '').trim();
  const colon = s.lastIndexOf(':');
  return colon === -1 ? s : s.slice(0, colon);
}

/**
 * litert-lm is a multi-stage launcher: the pid we spawned is not the process that
 * ends up holding the socket, so the recorded pid alone can never stop the server.
 * Asking the OS who owns the port is the only reliable answer.
 *
 * Scoped to the local address we are actually talking to, not to the port number —
 * see `addressServes`. Pass `host` of null only when the question really is "who
 * holds this port at all", which is what the test suite asks.
 */
function scanPort(port, host) {
  const { ok, listeners } = listenersOnPort(port);
  const pids = new Set();
  const unprovable = new Set();
  for (const { pid, address } of listeners) {
    const verdict = addressVerdict(address, host);
    if (verdict === 'serves') pids.add(pid);
    else if (verdict === 'unprovable') unprovable.add(pid);
  }
  return { ok, pids: [...pids], unprovable: [...unprovable] };
}

export function pidsOnPort(port, host = null) {
  return scanPort(port, host).pids;
}

// ---------------------------------------------------------------------------
// Descent
//
// WHY THIS IS HERE AT ALL, GIVEN THE FILE HEADER REJECTS ANCESTRY.
//
// That rejection is about OWNERSHIP: `--stop` must be able to stop a server this
// plugin adopted but did not start, so requiring descent from our recorded pid would
// refuse exactly the servers `ensureServer` is designed to take over. Nothing here
// changes that — `--stop` still identifies socket owners by their command line.
//
// Cancellation is a different question with a different answer. There, we DID spawn
// the launcher moments ago, and "descended from the process I just started" is a
// stronger claim than any command line: it cannot be forged by a bystander and needs
// no heuristic. It is also the only thing that can see a descendant which has not
// bound a socket yet, which is the gap a listener-based search cannot close.
// ---------------------------------------------------------------------------

/**
 * One snapshot of the process table: pid -> { ppid, start }.
 *
 * THE PARENT LINK AND THE START TOKEN COME FROM THE SAME OBSERVATION, and that is the
 * entire reason this exists rather than a `pid -> ppid` map with token lookups bolted
 * on afterwards. Reading the tree first and establishing identity second reopens the
 * exact window this module was written to close: a candidate exits between the two
 * steps, its number is reissued, and the token captured describes the replacement —
 * which then passes every later identity check, because it is a real token for a real
 * process that simply is not ours. Socket discovery had this bug and fixed it by
 * re-asking the port; here it is designed out instead, because one read can answer
 * both questions at once on every platform that matters.
 *
 * The `start` values are byte-identical to what `identity` produces, so a token from
 * here and a token from a pid file are directly comparable. That is load-bearing —
 * `resolveTargets` re-proves generation members against `identity`, not against this.
 */
const WIN_TABLE_QUERY =
  'try { Get-CimInstance Win32_Process -ErrorAction Stop '
  + '| ForEach-Object { ($_.ProcessId, $_.ParentProcessId, '
  + '$_.CreationDate.ToFileTimeUtc()) -join [char]9 } '
  + '} catch { exit 3 }; exit 0';

function tableWindows() {
  const r = run('powershell.exe', ['-NoProfile', '-Command', WIN_TABLE_QUERY]);
  return { ok: r.ok, table: parseTableWindows(r.out) };
}

/** `<ProcessId>\t<ParentProcessId>\t<CreationDate as FILETIME>` per row. */
function parseTableWindows(out) {
  const table = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [pidStr, ppidStr, start] = line.split('\t');
    const pid = Number.parseInt(pidStr, 10);
    const ppid = Number.parseInt(ppidStr, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !start) continue;
    table.set(pid, { ppid, start: start.trim() });
  }
  return table;
}

/**
 * Linux: fields 4 and 22 of /proc/<pid>/stat, from ONE read of ONE file — which makes
 * the pairing atomic rather than merely quick. No subprocess either, so this is cheap
 * enough to run on every poll, and the whole point is to catch a short-lived
 * intermediate before it exits.
 *
 * `comm` (field 2) is parenthesised and may itself contain spaces and parentheses, so
 * fields are counted from the LAST ')', exactly as `inspectLinux` does. Zombies are
 * omitted for the same reason they are elsewhere: they hold nothing, serve nothing,
 * and `pidAlive` already calls them dead.
 */
function tableLinux() {
  const table = new Map();
  let entries;
  try { entries = readdirSync('/proc'); } catch { return { ok: false, table }; }
  for (const name of entries) {
    const pid = Number.parseInt(name, 10);
    if (!Number.isInteger(pid) || String(pid) !== name) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') continue;                      // exited, not yet reaped
      const ppid = Number.parseInt(fields[1], 10);          // field 4, 1-indexed
      const start = fields[19];                             // field 22, 1-indexed
      if (Number.isInteger(ppid) && start) table.set(pid, { ppid, start });
    } catch { /* it exited between the readdir and the read */ }
  }
  return { ok: true, table };
}

/**
 * macOS and other POSIX: one `ps` for the whole table, carrying `args` because the
 * token on this platform includes a command-line digest — `lstart` has no subsecond
 * field, so time alone cannot separate two processes created in the same second.
 * Built exactly as `inspectPosixPs` builds it, or the two would not compare equal.
 */
function tablePosixPs() {
  const r = run('ps', ['-ww', '-Ao', 'pid=,ppid=,lstart=,args=']);
  return { ok: r.ok, table: parseTablePosix(r.out) };
}

/** `<pid> <ppid> <Www Mmm dd HH:MM:SS YYYY> <args...>` per row. */
function parseTablePosix(out) {
  const table = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (m === null) continue;
    const cmdline = flatten(m[4]);
    const digest = createHash('sha256').update(cmdline).digest('hex').slice(0, 16);
    table.set(Number.parseInt(m[1], 10), {
      ppid: Number.parseInt(m[2], 10),
      start: `${flatten(m[3])}#${digest}`,
    });
  }
  return table;
}

/**
 * `{ ok, table }` — because a walk that FAILED is not a walk that saw nothing.
 *
 * Every builder returns an empty Map when its query cannot run, and an empty Map is
 * indistinguishable from a machine with no processes on it. A caller that treats that
 * as an observation concludes quiescence from a question it never managed to ask,
 * which is how a generation stayed "authoritative" across failed lookups and reported
 * a clean teardown while its descendant was still starting.
 */
export function processTable() {
  if (process.platform === 'win32') return tableWindows();
  if (process.platform === 'linux') return tableLinux();
  return tablePosixPs();
}

/**
 * `processTable`, without blocking the event loop.
 *
 * Same output, same `{ ok, table }` contract. Linux needs no async form — it reads
 * /proc and starts no subprocess — so it simply reuses the sync one.
 *
 * This exists so the sampling cadence can be set by what a walk COSTS rather than by
 * what it blocks. The blocking version forced a 3s throttle on Windows to keep the
 * readiness probe alive, and 3s is long enough for a launcher stage to spawn a
 * detached descendant and exit between two samples — after which the descendant is
 * reparented and nothing can link it back to us.
 */
export async function processTableAsync() {
  if (process.platform === 'win32') {
    const r = await runAsync('powershell.exe', ['-NoProfile', '-Command', WIN_TABLE_QUERY]);
    return { ok: r.ok, table: parseTableWindows(r.out) };
  }
  if (process.platform === 'linux') return tableLinux();
  const r = await runAsync('ps', ['-ww', '-Ao', 'pid=,ppid=,lstart=,args=']);
  return { ok: r.ok, table: parseTablePosix(r.out) };
}

/**
 * Every process descended from `roots`, transitively, in the CURRENT process table.
 *
 * TWO THINGS THIS DOES NOT DO, both deliberate:
 *
 * 1. It does not remember. A detached grandchild is reparented to init the moment
 *    its parent exits, and after that no snapshot can connect it to us. So a single
 *    late call finds nothing useful — the caller has to sample WHILE the intermediate
 *    is alive and accumulate what it sees. That is the whole reason sampling happens
 *    during the startup poll rather than only at cancellation.
 *
 * 2. It does not vouch for a dead root. A ppid is a number, and the number of an
 *    exited process gets reissued like any other; "child of pid 4123" means nothing
 *    once 4123 has died and been handed to someone else. The caller must pass only
 *    roots it has just confirmed alive, which is what makes the link trustworthy —
 *    a live pid cannot be simultaneously held by anything else.
 */
export function descendantsOf(roots, table = processTable().table) {
  const known = new Set(roots);
  const found = new Set();

  // Fixed point rather than one pass: the table is in no particular order, so a
  // grandchild can be visited before the child that links it to us.
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { ppid }] of table) {
      if (known.has(pid) || found.has(pid)) continue;
      if (known.has(ppid) || found.has(ppid)) { found.add(pid); grew = true; }
    }
  }
  return [...found];
}

/**
 * How often to walk the process table, set by what a walk costs here.
 *
 * Linux reads /proc and starts nothing, so it can sample at the poll rate. Windows
 * means a PowerShell start-up measured at ~930ms; that used to also block the event
 * loop, which forced a 3s throttle to keep the readiness probe alive. `processTableAsync`
 * removes the blocking half, so what is left to ration is CPU rather than latency.
 *
 * THE STEADY RATE IS STILL NOT FAST ENOUGH TO OBSERVE A HANDOFF, so it is not asked
 * to. A stage that spawns a detached descendant and exits between two samples takes
 * the only link to that descendant with it — reparenting to init is immediate and no
 * later walk recovers it. Handoffs happen while the launcher chain is assembling, in
 * the first seconds of a start, so that window is sampled at the poll rate and the
 * long tail — a single process initialising an engine, spawning nothing — is not.
 *
 * This narrows the gap; it does not close it. A stage that hands off for the first
 * time after the dense window still escapes, and the quiescence counter in
 * `cancelStartedServer` remains the backstop for exactly that. Sampling every 750ms
 * for the whole start would cost a PowerShell process per poll for the full startup
 * timeout, on a machine simultaneously loading a model onto the GPU.
 */
const DESCENDANT_SAMPLE_MS = process.platform === 'win32' ? 3000 : 250;

/** How long a start is treated as still assembling, and sampled at the poll rate. */
const DESCENDANT_DENSE_MS = 15000;

/**
 * The pids between `pid` and the first root in `roots`, per `table`, or null if the
 * walk never reaches one.
 *
 * Separate from `descendantsOf` because admission needs the PATH and not merely the
 * fact of descent: every link on it is a claim the second walk gets to contradict.
 */
function chainToRoot(pid, table, roots) {
  const rootSet = new Set(roots);
  const chain = [];
  const seen = new Set([pid]);
  let cur = table.get(pid)?.ppid;
  while (Number.isInteger(cur) && !seen.has(cur)) {
    if (rootSet.has(cur)) return chain;
    const row = table.get(cur);
    if (!row) return null;
    chain.push(cur);
    seen.add(cur);
    cur = row.ppid;
  }
  return null;
}

/**
 * The set of processes one start is responsible for.
 *
 * Seeded with the launcher we spawned and grown by sampling the process table while
 * that launcher — or something already admitted from it — is still provably itself.
 *
 * ACCUMULATION IS THE POINT. A detached grandchild is reparented to init the instant
 * its parent exits, so a single walk at cancellation time finds nothing: by then the
 * only evidence of the relationship is gone. Sampling during the startup poll catches
 * the link while it still exists, and what is captured stays captured.
 *
 * A ROOT MUST BE PROVEN, NOT MERELY ALIVE — and getting this wrong is how the first
 * version of this recreated the accident the whole module exists to prevent. It
 * admitted descendants of anything in the set that answered `pidAlive`, ignoring the
 * token already stored beside each member. So when a launcher exited and its number
 * was reissued, the unrelated replacement became a "live" root, its children were
 * admitted with their own genuine tokens, and every later identity check faithfully
 * confirmed them — because they were real processes with real tokens that simply were
 * not ours. Cancellation would then have signalled a stranger's children, with proof.
 *
 * Liveness says a number is in use. Identity says by whom. Only the second can
 * authorise anything here, which is the rule the rest of this file already follows.
 *
 * Descent gets a process INTO the set; it never authorises a signal on its own. Every
 * member carries the token captured when it was first seen, and `resolveTargets`
 * re-proves each one before anything is signalled.
 *
 * `readTable` is a seam. Real pid reuse cannot be forced reliably in a test, so the
 * admission rules are exercised against a fabricated table instead — which is the
 * only way the case above gets deterministic coverage rather than a hopeful comment.
 */
export function startGeneration(launcherPid, readTable = processTableAsync,
  launcherIsStillOurs = () => true) {
  const mine = new Map();
  const startedAt = Date.now();
  let lastSample = 0;
  let seeded = false;
  let lastWalkSaw = false;
  let handoffUncertain = false;

  // The seam hands back a bare Map; production hands back a promise of
  // `{ ok, table }`. Normalised here so a test can stay as simple as `() => table`
  // while the real caller keeps the distinction between a walk that saw nothing and
  // one that never ran. `await` on a plain value is a no-op, so both shapes work.
  const walk = async () => {
    const r = await readTable();
    return r instanceof Map ? { ok: true, table: r } : r;
  };

  const admitFrom = async (table) => {
    // SEEDING IS RETRIED, NOT DONE ONCE. It used to happen only in the constructor,
    // so a first read that missed the launcher — the table query failed to run at
    // all, or the stage exited before it was enumerated — left the set permanently
    // empty. Every later sample then derived its roots from that empty set and found
    // nothing to work from, so no recovered table could ever bootstrap it.
    //
    // BUT A RETRY IS ONLY SAFE WHILE THE HANDLE STILL VOUCHES FOR THE NUMBER. The
    // first version of this retry took whatever row carried `launcherPid`, which is
    // the pid-reuse hole again one level up: if the launcher exited before it was
    // ever enumerated and its number was reissued, the stranger's row would be taken
    // as authoritative, its token stored as ours, and its descendants admitted with
    // valid tokens that cancellation would then re-prove and signal. `launcherPid` is
    // a number; the ChildProcess handle is the only thing that knows whether that
    // number is still the process we spawned.
    //
    // So a failed first read is recoverable only for as long as our child is alive.
    // Once it has exited unseen, the generation stays unauthoritative — which is the
    // honest answer, and one cancellation already knows how to handle.
    if (!seeded && launcherPid && launcherIsStillOurs()) {
      const row = table.get(launcherPid);
      if (row) {
        mine.set(launcherPid, { pid: launcherPid, token: row.start });
        seeded = true;
      }
    }

    // Members whose recorded token still matches this snapshot. Anything else is a
    // number we used to know, and a number vouches for nothing.
    const roots = [];
    for (const { pid, token } of mine.values()) {
      if (table.get(pid)?.start === token) roots.push(pid);
    }
    if (!roots.length) return;

    // Numeric membership is not identity. A later genuine descendant can receive a
    // pid held by an exited member; suppressing it here preserves the stale token and
    // prevents the two-walk proof below from replacing it with the current process.
    // Matching identities need no work, while a different token is a fresh candidate
    // that still has to pass every confirmation and ancestry check below.
    const candidates = descendantsOf(roots, table)
      .filter((pid) => mine.get(pid)?.token !== table.get(pid)?.start);
    if (!candidates.length) return;

    // A SECOND WALK BEFORE ADMITTING ANYTHING, because one walk is not a snapshot. On
    // Linux the table is built by reading each /proc/<pid>/stat in turn, so a root can
    // be read, exit, and have its number reissued before a replacement's child is read
    // later in the same enumeration — at which point the stale root row still matches
    // its token and the unrelated child is admitted carrying a genuine one. The rows
    // agree; they just describe two different moments.
    //
    // Paid only when there is something to admit, which is rare: most samples find
    // nothing new and return above. That matters on Windows, where a walk is a
    // PowerShell start-up.
    const confirmed = await walk();
    if (!confirmed.ok) { lastWalkSaw = false; return; }
    const confirm = confirmed.table;

    // Roots that survived the whole enumeration, judged against the second walk.
    const proven = roots.filter((pid) => confirm.get(pid)?.start === mine.get(pid).token);
    if (!proven.length) {
      // Both queries ran, but validation lost the only identities that could vouch
      // for the candidates. That is not an authoritative empty observation: the
      // child may simply have reparented after the first walk. Cancellation must keep
      // this sample unjudgeable instead of converting rejected admission to proof of
      // quiescence.
      handoffUncertain = true;
      return;
    }

    for (const pid of candidates) {
      // Present in BOTH walks with the SAME identity...
      const first = table.get(pid);
      const second = confirm.get(pid);
      if (!second || first.start !== second.start) {
        // The candidate identity may have handed off after the first walk and exited
        // or had its pid reused before confirmation. A surviving root proves neither
        // that handoff nor quiescence, so failed identity confirmation must remain
        // unjudgeable for this generation.
        handoffUncertain = true;
        continue;
      }

      // ...and descended, in the first walk, from a root that survived BOTH. Checking
      // only that SOME proven root exists was too weak: with two roots in the set, a
      // candidate descended from the one that turned out to be a reused number was
      // admitted on the strength of the other one's survival.
      const chain = chainToRoot(pid, table, proven);
      if (chain === null) {
        // Some root survived, but not the one that vouched for this candidate. Once
        // that ancestry disappears no later empty walk can recover it, so remember
        // the uncertainty rather than letting a different root manufacture global
        // authority for the generation.
        handoffUncertain = true;
        continue;
      }

      // EVERY LINK ON THE PATH IS A CLAIM, not just its two ends. One walk is not a
      // snapshot: an intermediate can be read, exit, and have its number reissued
      // before a later row in the SAME enumeration records an unrelated child under
      // that number. Both ends then survive both walks honestly — the root is ours,
      // the child is a real process with a real token — while the row that joined them
      // described two different processes. Cancellation would re-prove that bystander
      // and signal it, which is the accident this module exists to prevent.
      //
      // CONTRADICTED, NOT MERELY ABSENT, and the distinction is the whole reason this
      // can be checked at all. An intermediate MISSING from the second walk is the
      // ordinary case — a short-lived stage that handed off and exited, reparenting
      // its child to init — and rejecting that would discard exactly the descendant
      // this mechanism exists to catch. An intermediate PRESENT under a different
      // identity is the tear: the number is in use by someone who is not who the first
      // walk said it was.
      const torn = chain.some((mid) => {
        const then = table.get(mid);
        const now = confirm.get(mid);
        return now !== undefined && then !== undefined && now.start !== then.start;
      });
      if (torn) continue;

      mine.set(pid, { pid, token: second.start });
    }
  };

  return {
    members: () => [...mine.values()],
    has: (pid) => mine.has(pid),
    /** The recorded member, so a caller can compare the TOKEN and not just the pid. */
    member: (pid) => mine.get(pid) ?? null,

    /**
     * Did we ever establish a trusted member — or have we simply never managed to look?
     *
     * "I OBSERVED NOTHING" AND "THERE IS NOTHING" ARE THE SAME SENTENCE ONLY WHEN YOU
     * WERE ABLE TO LOOK, and cancellation is where the difference bites. It reads an
     * empty member set as quiescence, so a generation that never seeded reported
     * "nothing is left running" without ever having been able to see anything —
     * clearing the child's record while the detached descendant went on to bind. That
     * is the pre-bind false success this tracker exists to remove, re-entered through
     * its own initialisation.
     *
     * So emptiness is only evidence for a caller that this returns true to. It is the
     * same three-state discipline the rest of the module uses: gone, ours, or
     * unjudgeable — and unjudgeable must never be spent as proof.
     */
    // ALL THREE PARTS. Seeding proves we once identified the launcher; the last walk
    // succeeding proves the emptiness a caller is about to read is an observation
    // rather than a failed question; and no candidate may have lost the roots that
    // vouched for it during confirmation. A later empty walk cannot recover that
    // vanished ancestry. Without these distinctions cancellation concludes quiescence
    // from either a question never asked or a handoff it failed to follow.
    // Handoff uncertainty is sticky. A later empty walk cannot prove what happened
    // to a candidate after the last root that vouched for it disappeared.
    authoritative: () => seeded && lastWalkSaw && !handoffUncertain,

    adopt(owner) {
      // A MATCHING NUMBER IS NOT A MATCHING MEMBER. If an exited launcher's pid was
      // reissued to this start's eventual listener, the set already holds that number
      // under the OLD token — so discarding the adoption keeps a member that
      // `resolveTargets` will reject, cancellation counts as gone, and a clean
      // teardown is reported while the listener runs. A freshly proven identity for
      // the same number replaces the stale one rather than losing to it.
      const held = mine.get(owner.pid);
      if (held !== undefined && held.token === owner.token) return;
      // An adopted listener was proven ours by command line and carries a token, so
      // it is as good a root as the launcher and equally good evidence that we were
      // able to look at all. It does not erase an earlier uncertain handoff: another
      // candidate may still be starting without a socket.
      mine.set(owner.pid, owner);
      seeded = true;
      // An adoption is itself a successful observation: it comes from socket discovery
      // having answered, so the generation is not blind even if the last table walk was.
      lastWalkSaw = true;
    },

    /**
     * Async because the seed retry needs an EVENT-LOOP YIELD before it may trust the
     * child handle, and for exactly the reason `recordSpawnedPid` documents: the table
     * read is `spawnSync` and blocks the loop, so a child that exited during it has
     * not had its exit event delivered yet and `exitCode` still reads null. Checking
     * the handle straight after a blocking read is how a guard looks correct while
     * doing nothing — and here it would let a reused pid seed the generation.
     */
    async sample(force = false) {
      // Dense while the launcher chain is still assembling, throttled afterwards.
      // See DESCENDANT_SAMPLE_MS: a handoff is only observable if a sample lands
      // between the descendant's creation and its parent's exit, and that window is
      // at the start of a start.
      const interval = Date.now() - startedAt < DESCENDANT_DENSE_MS ? 0 : DESCENDANT_SAMPLE_MS;
      if (!force && Date.now() - lastSample < interval) return;
      lastSample = Date.now();
      const seen = await walk();
      await new Promise((r) => { setImmediate(r); });
      lastWalkSaw = seen.ok;
      if (seen.ok) await admitFrom(seen.table);
    },
  };
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
 *   v3, required a launcher POSITION but never checked what occupied the others:
 *     ./backup.sh litert-lm serve         <- argv[0] is not an interpreter
 *     node litert-lm serve                <- argv[0] is not an interpreter
 *     python unrelated.py -m litert_lm serve   <- `-m` accepted at any index
 *
 * Every one of those would have been signalled had it owned the configured port,
 * which is the accident this whole change exists to prevent. Each version was a
 * narrower guess rather than a different kind of answer; the shape of the whole
 * invocation is the answer.
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

/** A path or bare name whose final component is a Python interpreter. */
const PYTHON_INTERPRETER = /(?:^|[/\\])python[\d.]*(?:\.exe)?$/i;

export function isLitertLmServeCommand(cmdline) {
  const argv = argvTokens(cmdline);
  const serveIdx = argv.findIndex((t) => t.toLowerCase() === 'serve');
  if (serveIdx < 1 || !LITERT_LM_PROGRAM.test(argv[serveIdx - 1])) return false;

  // Exactly three shapes are a litert-lm serve, and each is checked whole rather
  // than by the position of one token:
  switch (serveIdx) {
    case 1: return true;                                   // litert-lm serve
    case 2: return PYTHON_INTERPRETER.test(argv[0]);       // python litert-lm serve
    case 3: return PYTHON_INTERPRETER.test(argv[0])        // python -m litert_lm serve
      && argv[1] === '-m';
    default: return false;
  }
}

/**
 * Did this command line LAUNCH `exe`?
 *
 * Two shapes count, and the second is not a concession — it is what actually
 * happens on POSIX. `uv tool install litert-lm` writes a Python console script with
 * a shebang, and the kernel rewrites a shebang exec to put the INTERPRETER at
 * argv[0] and the script at argv[1]. Requiring argv[0] to be `exe` therefore never
 * matches a real litert-lm on Linux or macOS: `server.pid` would never be recorded
 * there, quietly removing the recorded-process fallback that `--stop` depends on
 * when socket discovery is unavailable. On Windows `exe` is a real launcher binary
 * and sits at argv[0], which is why this went unnoticed.
 *
 * What is still rejected is the case this exists for: a path mentioned somewhere in
 * the arguments, as in `node worker.js --inspect C:\...\litert-lm.exe`.
 */
export function commandLaunches(cmdline, exe) {
  if (!exe) return false;
  const argv = argvTokens(cmdline);
  const same = (a, b) => (a === undefined || b === undefined ? false
    : (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b));

  if (same(argv[0], String(exe))) return true;
  return PYTHON_INTERPRETER.test(argv[0] ?? '') && same(argv[1], String(exe));
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

/**
 * Sort `targets` into those still running as themselves and those we cannot judge.
 *
 * THREE STATES, NOT TWO. Every identity source collapses failure into the same
 * `null` it uses for "no such process": PowerShell can fail to start, `ps` can be
 * killed, a /proc read can hit EACCES. Treating that as proof of exit is a
 * false-success generator — after we have signalled something, one transient
 * subprocess failure would let both callers clear state, report the memory released,
 * and destroy the identity needed to try again.
 *
 * So existence is settled by `kill(pid, 0)`, which needs no subprocess and no
 * cooperation, and identity is used only to decide WHOSE process it is:
 *
 *   pid not alive, or a zombie   -> gone. Confirmed, and cheap to confirm.
 *   identity matches the token   -> still ours. Signal it, keep chasing it.
 *   identity contradicts it      -> gone; the number belongs to someone else now.
 *   identity unavailable         -> UNKNOWN. Never signalled, never counted as done.
 *
 * `unknown` is deliberately not fatal on its own — it blocks the success verdict,
 * not the attempt.
 *
 * One home for the rule because the client and the watchdog both need it, and this
 * plugin's recurring defect is the second copy of a rule being the stale one.
 */
/**
 * Who owns this port, identified, and still owning it once identified.
 *
 * The order matters and used to be wrong. `pidsOnPort` yields numbers; establishing
 * what those numbers ARE takes a process lookup, seconds on Windows. In that gap the
 * listener can exit and its number be reissued — and if the new holder is another
 * `litert-lm serve` on a DIFFERENT port, it passes the command-line test, its token
 * is captured, and every later revalidation faithfully confirms the wrong process.
 * `--stop` would then terminate a server on a port it was never asked about.
 *
 * So the port is re-asked after the identification, and only pids present in both
 * snapshots are admitted. A listener that left in between is not ours to signal, and
 * one that arrived in between has not been identified yet.
 *
 * `host` scopes both snapshots to the local address this client actually talks to. A
 * litert-lm server bound to another interface on the same port passes the command
 * line test and is emphatically not ours; without the address it was signalled.
 */
export function identifyPortOwners(port, isOurs, host = null) {
  const first = scanPort(port, host);
  identities(first.pids);
  const second = scanPort(port, host);
  const after = new Set(second.pids);

  const ours = [];
  const strangers = [];
  const unidentified = [];
  for (const pid of first.pids) {
    if (!after.has(pid)) continue;                  // no longer holds this port
    if (identity(pid) === null) unidentified.push(pid);
    else if (isOurs(pid)) ours.push({ pid, token: startToken(pid) });
    else strangers.push(pid);
  }

  // "I could not ask who holds this port" is a THIRD answer, and it used to be
  // indistinguishable from "nobody does": every query failure returned an empty
  // string, which became an empty pid list, which became an empty owner set. A host
  // where neither lsof nor ss will run then reads as a free port, so a recorded
  // launcher that has exited while its unrecorded listener carries on looks exactly
  // like a server that is already gone. Reported rather than folded into
  // `unidentified`, because the two need different handling: an unidentified listener
  // is a process we know is there, while this is the absence of the question.
  // A listener we cannot prove either way about is unidentified — never signalled,
  // never counted as gone. See `addressVerdict`: a cross-family wildcard may or may
  // not be the socket answering us, and dropping it was how a live server became
  // invisible.
  //
  // ONE PROCESS CAN HOLD BOTH KINDS OF SOCKET, and that is not an unproven process.
  // A server bound to 127.0.0.1:P and :::P appears in `pids` for the first socket and
  // in `unprovable` for the second, so the loop above rightly calls it ours while this
  // one used to append the same pid to `unidentified` as well. Both `--stop` and the
  // watchdog treat any unidentified listener as an incomplete picture and refuse the
  // whole operation, so a server that had been conclusively identified deferred its
  // own shutdown for ever. A pid already judged — either way — is judged; the
  // unprovable socket adds nothing the proven one has not already settled.
  const judged = new Set([...ours.map((o) => o.pid), ...strangers, ...unidentified]);
  for (const pid of first.unprovable) {
    if (judged.has(pid)) continue;
    if (!second.unprovable.includes(pid)) continue;
    unidentified.push(pid);
    judged.add(pid);
  }

  return { ours, strangers, unidentified, discoveryFailed: !first.ok || !second.ok };
}

export function resolveTargets(targets) {
  const pids = targets.map((t) => t.pid);
  forgetIdentities(pids);            // a cache filled before we signalled is a liar
  identities(pids);

  const alive = [];
  const unknown = [];
  for (const t of targets) {
    if (!pidAlive(t.pid)) continue;             // covers zombies; see marker-state
    const seen = identity(t.pid);
    if (seen === null) unknown.push(t.pid);
    else if (seen.start === t.token) alive.push(t.pid);
  }
  return { alive, unknown };
}

/**
 * Test seam: the three platform output parsers.
 *
 * Exposed because each one can only be exercised on the host whose tool produces it,
 * and CI covers three platforms with one tool each. Captured real output run through
 * these is the only way the `ss` shape gets checked from a machine with lsof, and the
 * Windows shape from anywhere but Windows.
 */
export const _parsers = {
  getNetTcpConnection: parseGetNetTcpConnection,
  lsof: parseLsofFields,
  ss: parseSs,
  tableWindows: parseTableWindows,
  tablePosix: parseTablePosix,
};

/** Test seam: query completion and timeout behavior without a platform-specific tool. */
export const _queries = { runAsync };

/** Test seam: forget everything looked up so far. */
export function _resetIdentityCache() {
  cache.clear();
}
