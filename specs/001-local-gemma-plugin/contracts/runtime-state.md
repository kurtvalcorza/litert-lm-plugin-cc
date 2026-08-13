# Contract: Runtime State & Idle Watchdog

**Feature**: 001-local-gemma-plugin | **Parties**: `gemma-client.mjs` (writer), `idle-watchdog.mjs` (reader/terminator)

The coordination protocol behind FR-023 through FR-025. Written as a contract because two
independent processes depend on it and the failure modes are races.

## State directory

One small file per fact, under a plugin-owned runtime directory keyed by port so two servers on
different ports never share state.

| File | Format | Writer | Reader |
|---|---|---|---|
| `server.pid` | `<pid> <start-token>` | client, after successful start | watchdog |
| `watchdog.pid` | `<pid> <start-token>` | **watchdog only** — see below | client, watchdog |
| `last-activity` | epoch ms | client, before and after each request | watchdog |
| `in-flight.d/<pid>-<ts>` | **directory of marker files** | client, one per request | watchdog |
| `stopping` | empty; presence is the signal | watchdog, before terminating | client |
| `stopped-idle` | epoch ms | watchdog, before exiting | client (consumes) |
| `stopped-at` | epoch ms | client, at the end of a SUCCESSFUL `--stop` | watchdog and client, before publishing |
| `survivors` | `<pid> <start-token>` per line | client and watchdog, when a stop fails | client, on the next stop |
| `starting` | `<spawned-at-ms> <client-pid>` | client, before spawning a server | a cancelling start, as its generation |
| `loaded-model` | model id | client, after a successful request | client |

**Why files, not one document**: single-fact files make every read and write atomic enough
without a lock.

**Why in-flight is a directory, not a counter** *(revised during code review)*: an integer
requires read-modify-write, and two concurrent clients can interleave — both read 0, both
write 1 — after which one decrement drops it to 0 while a request is still running, freeing
the watchdog to kill the server mid-generation. Creating and unlinking one uniquely-named file
per request is atomic at the filesystem level, so no update can be lost.

The marker name carries the **owning pid**, which also makes crash recovery exact rather than
heuristic: a marker whose process no longer exists is stale by definition. The watchdog removes
such markers as it counts, so a crashed client cannot pin accelerator memory — no timeout
guesswork required.

**Why a pid file holds a token as well as a pid** *(revised after issue #10)*: a pid is a slot
the OS reuses, not a handle on a process. A recorded pid whose owner has exited can name
something else entirely, and both parties here send signals to recorded pids. The token is the
process's OS-reported creation time, captured at spawn; pid and token together are unique for as
long as that process lives, so a reused pid fails the comparison. A file carrying a bare pid —
every file written by a version before this one — is readable but **never signallable**.

Two questions are asked of these files and they are not the same question:

| Question | Test | Cost | Used by |
|---|---|---|---|
| May I delete this stale file? | pid alive + file written after boot | free | `reconcileState`, `startWatchdog` |
| May I signal this pid? | the above **plus** the token matches | one process lookup | `--stop`, watchdog termination |

The strong test is defined in terms of the weak one, so they cannot drift apart. The weak one
must never be used to justify a signal. Splitting them is what keeps the cost off the
interactive path: establishing identity means starting PowerShell on Windows (~930ms measured),
and reconciliation runs on every invocation while only ever deleting files.

**The watchdog is the SOLE writer of `watchdog.pid`, and claims it exclusively.** The client
spawns a watchdog but never publishes its pid. Doing so was an optimisation — the record appears
at once rather than after the watchdog's own identity lookup, so a client arriving in between
does not spawn a redundant supervisor — and it cost correctness: a *parent* can only publish a
claim its child has already abandoned. Two clients adopt one warm server, both spawn a watchdog,
the loser's watchdog sees a proven owner and exits, and the loser's client then writes that
now-dead pid over the winner's record; the survivor reads an owner that is not itself and exits
too, leaving the server unsupervised. A watchdog never writes after deciding to stand down, so
single-writer removes the class rather than arbitrating it. The claim itself is an exclusive
create (`wx`), and a stale record is reclaimed only after re-reading the exact bytes judged
stale, so reclamation cannot delete a live winner.

**Shutdown is judged by the processes signalled, never by the port.** The socket is an endpoint;
targets are processes. A stranger that holds or takes the port keeps answering, and treating
that as failure reports an error for correctly leaving it alone.

**A port is not a socket: ownership is scoped to the local address too.** Two servers may hold
the same port on different local addresses at once — ours on `127.0.0.1:9379`, another
`litert-lm serve` on `192.168.1.5:9379` — and every OS query (`Get-NetTCPConnection`, `lsof`,
`ss`) reports both. Matching on the number alone therefore let the command-line test prove a
second, unrelated litert-lm "ours" and signal it: identity passed, location was never asked.
Discovery now reads the local address alongside the pid and keeps only listeners that would
answer the host this client talks to. A literal host is compared literally, since a
socket on `::1` is unreachable from a client configured with `127.0.0.1`. The watchdog is passed
`--host` for the same reason — supervising the socket we talk to means asking about that socket.

**A wildcard serves its own family, and only its own.** `0.0.0.0` answers v4 callers; `::`
answers v6 callers. Reading `::` as dual-stack — true on many hosts, and the obvious
generalisation — was wrong: dual-stack depends on `IPV6_V6ONLY`, which none of the three
platform queries reports. An IPv6-only `litert-lm serve` on `:::9379` would then be admitted as
the owner of a socket a `127.0.0.1` client cannot reach, and `--stop` would terminate it —
exactly the cross-interface kill the filter exists to prevent, reintroduced by the case meant to
be generous. A cross-family wildcard is therefore `unprovable`: its pid enters the unidentified
bucket rather than being classified as a stranger, and the incomplete picture defers the whole
shutdown — nothing is signalled or cleared. That is visible and recoverable, while treating the
listener as absent could strand an unsupervised server. `localhost` is the one exception, and not
a grudging one: it is a name that resolves to either family, so neither wildcard can be ruled out
and both are accepted.

An address the platform query did not yield is treated as a match. That is the absence of
evidence, not evidence of a foreign bind, and dropping such a listener would silently disarm
`--stop` on any host whose output failed to parse. The command line still has to prove ownership
before anything is signalled, so the address only ever narrows a set that is already gated.

**`stopped-at` is a tombstone, and the only state file that is never cleared.** A watchdog is
spawned detached and cannot publish its pid until it has established its own identity — a
process lookup, seconds on Windows. A `--stop` arriving inside that window cannot see it: it is
in no pid file yet, so it cannot be a target, and it would go on to install itself as supervisor
of a server that has just been torn down. The watchdog therefore compares this stamp against
when it was spawned (`--spawned-at`), before claiming and again after, and stands down if a stop
has intervened.

**The comparison is repeated on every poll, not only at start-up.** A stop can land *after* a
watchdog has published: the tombstone is written last, at the very end of `--stop`, so a
watchdog that published anywhere inside that command passed both of its start-up checks against
a `stopped-at` that did not yet exist. It then supervised a server that had already been torn
down and — worse — stayed the registered supervisor, so the next client saw a live
`watchdog.pid`, declined to spawn one, and had its server adopted by a process running under the
previous invocation's idle-timeout. `--stop` closes the same hole from its own side by re-reading
the `watchdog.pid` slot before the success verdict rather than trusting the snapshot it took at
the start; neither check makes the other redundant. The client's keeps the *verdict* honest — a
stop must not report both processes gone while a supervisor it never saw is running — and the
watchdog's bounds how long a superseded supervisor lives.

It is deliberately a timestamp rather than a reachability check. "The server does not answer"
and "the server is gone" are different claims — a model switch produces the first for tens of
seconds, which is what `UNREACHABLE_TOLERANCE` exists for — and a watchdog that stood down for
an unanswered probe would abandon the server it was spawned to supervise. Nothing needs to clear
this file: an older stop is simply earlier than the next watchdog's spawn.

**A failed shutdown records every survivor, not just the ones that fit.** `server.pid` and
`watchdog.pid` are one slot each, and a stop can leave more survivors than that — a launcher and
a listener, for instance. The extra identity used to exist only in the error text, so a retry
could not find it once it had closed its socket and left port discovery blind. `survivors` has
no such ceiling and is cleared the moment a stop actually succeeds.

**A discovery that could not run is not an empty port.** Every socket query returned an empty
string for both "the tool is not here" and "it ran and found nothing", so a host with neither
`lsof` nor `ss` reported a free port — and a recorded launcher that had exited while its
unrecorded listener carried on then looked exactly like a server already gone. Failure to *spawn*
is now distinguished from a non-zero *exit* (`lsof` exits 1 when it matches nothing, which is a
real answer) and surfaces as `discoveryFailed`.

It blocks a success verdict when the endpoint answers **or recorded state says a process may still
need accounting**: a recorded server target, watchdog, or carried survivor. The latter matters
during startup and model switches, when a genuine server can be unreachable and its recorded
launcher can already have exited while an unrecorded descendant owns the socket. Discovery failure
with neither an answer nor any recorded state remains non-blocking; otherwise a minimal image with
no server would make `--stop` refuse forever. The watchdog likewise treats a failed discovery as
unjudgeable before its stand-down branch, rather than spending an empty result as proof that no
server remains.

**An incomplete picture cancels the whole operation.** If any listener on the port cannot be
identified, `--stop` signals nothing and clears nothing. Signalling only what is provable would
take out the watchdog — a recorded target — and then fail on the server, leaving it running with
nobody supervising it. A refusal can be retried; an unsupervised server can only be noticed.

**A cancelled start undoes itself, within its own generation.** A `--stop` that lands while a
server is coming up cancels that start, and the starting client tears down what it spawned
rather than merely declining to record it. Staying quiet while the server came up anyway
produced the worse of the two outcomes: running, unrecorded, and harder to find than if nothing
had been suppressed.

`starting` is what makes "its own" meaningful. `stopped-at` cannot serve as the boundary,
because a newer start does not write it: after (start A, stop S, start B, A notices S), every
cancellation pass in A still saw the same stamp and would adopt B's listener, letting a
cancelled start kill a valid newer one. Each start claims `starting`; a cancelling start that
finds the claim is no longer its own stops reaching for listeners and cleans up only the child
it spawned.

**Only the claim's owner may release it, and a cancelled generation clears only its own
records.** Both are the same mistake in different clothes: an older invocation tidying up state
that now belongs to a newer one. An older start that reaches its own exit — success, timeout,
or cancellation — used to clear `starting` unconditionally, which erased the newer start's
claim and left that start looking foreign to its own cancellation, so it took the child-only
path and could declare success before its descendant bound. Likewise a cancelling start that
had lost the generation still deleted the shared `server.pid`, discarding the identity the
newer start had just published. Not signalling a process whose only identity you then discard
is not restraint. Every release compares the claim first, and `server.pid` is cleared only
while it still names one of the cancelling invocation's own targets.

**The generation is `<spawned-at-ms> <client-pid>`, and ownership compares both.** The timestamp
alone is not an identity: it is `Date.now()`, so two clients that both find no claim and then
stamp the same millisecond write different records that compare equal, and each reads the
other's claim as its own. The older one could then clear or overwrite the newer one's
`server.pid`, release a claim it did not hold, or adopt its listener while cancelling — every
failure the claim exists to prevent, reached through a tie the comparison could not see. The pid
breaks the tie, because only the process that wrote a claim can match it.

**Recording a spawned pid is gated on the claim at both ends, and the opening gate matters as
much as the closing one.** `server.pid` is a single shared slot. Recording used to clear it on
the way in — before any identity work — so an older generation erased a record it did not own,
leaving a live server unrecorded by the act of recording something else. Publishing was
ungated too: everything between the spawn and the write costs real time (a process lookup is
seconds on Windows), which is exactly the window in which the claim changes hands, so an older
start could overwrite a newer one's identity on the way out. Ownership is now checked before
the clear, re-checked immediately before the write, and checked once more afterwards — and if
the claim moved in that last gap, the record is withdrawn only while the bytes on disk are
still the ones this invocation wrote.

**Cancellation tracks descendants, and does not wait to be shown a socket.** The launcher exits
before the detached descendant it spawned has bound anything, and that descendant then spends
tens of seconds initialising an engine — so for the whole of that window, every "who holds the
port" question truthfully answers "nobody" while a process that will shortly serve is very much
alive. Consecutive empty observations were the only defence, and they bought about 800ms: three
samples, two 400ms waits. The descendant bound anyway, unrecorded, which is precisely what
cancelling exists to prevent.

The start therefore walks the process table from the pid it spawned and accumulates everything
descended from it, sampling from the moment of the spawn and throughout the startup poll. This
is **not** the ancestry test that ownership rejected, and the distinction is the whole reason it
is admissible here: `--stop` must be able to stop a server this plugin *adopted*, so requiring
descent there would refuse exactly the servers `ensureServer` is designed to take over.
Cancellation is the opposite situation — we spawned the launcher moments ago, and "descended
from the process I just started" is a stronger claim than any command line, one no bystander can
forge and no heuristic has to guess at.

Two properties make it sound, and the second was got wrong once in exactly the way this document
keeps warning about.

**It must sample early and keep sampling**, because a detached grandchild is reparented to init
the moment its parent exits and no later walk can recover the relationship — verified directly:
a three-level tree yields two descendants while the middle stage lives and *zero* once it exits.

**A root must be PROVEN, not merely alive.** The first version admitted descendants of any member
that answered `pidAlive`, ignoring the token already stored beside it — the weak test authorising
what only the strong one may. When a launcher exited and its number was reissued, the unrelated
replacement became a live root, its children were admitted carrying their own genuine tokens, and
every later identity check confirmed them: real processes, real tokens, not ours. Cancellation
would have signalled a stranger's children with proof in hand. Liveness says a number is in use;
identity says by whom, and only the second may authorise anything.

**The parent link and the token come from one snapshot.** Reading the tree first and establishing
identity second reopens the same window one step along: a candidate exits in between, its number
is reissued, and the token captured describes the replacement — which then passes every check
downstream. Socket discovery had this shape and fixed it by re-asking the port; here it is
designed out, because one read answers both questions on every platform. Linux takes fields 4 and
22 from a single read of a single `/proc/<pid>/stat`; `ps` and `Win32_Process` each carry ppid and
creation time on the same row. The tokens are byte-identical to what `identity` produces, so a
token from the table and a token from a pid file are directly comparable.

Descent gets a process into the set; it never authorises a signal. Every member is re-proved
before each signal, so a reissued pid drops out like any other. The quiescence counter stays as a
backstop for the one case descent cannot cover — a grandchild spawned after the last sample *and*
after its parent had exited — rather than as the primary evidence.

**"I observed nothing" is only evidence if you were able to look.** The generation seeds itself
from the process table, and seeding used to happen once, in the constructor. A first read that
missed the launcher — the query could not run, or the stage was gone before it was enumerated —
left the set permanently empty, and every later sample derived its roots from that emptiness, so
no recovered table could bootstrap it. Cancellation then read the empty set as quiescence and
reported a clean teardown while the detached descendant went on to bind: the pre-bind false
success, re-entered through initialisation. Seeding is now retried on every sample, and the
generation reports separately whether it ever established a trusted member. Emptiness is spent as
proof only by a caller that gets `true` from that — the same three-state discipline as everywhere
else, where unjudgeable is never a verdict.

Admission takes an injectable process table, because real pid reuse cannot be forced in a test:
the OS decides when a number comes back around. The rules above are therefore driven against a
fabricated table, which is what makes the reuse case deterministic coverage rather than a
hopeful comment.

Sampling is throttled by what a walk costs. Linux reads `/proc` and starts nothing. Windows starts
PowerShell (~930ms), but the walk is asynchronous so it no longer blocks the readiness probe. For
the first 15 seconds, while launcher handoffs occur, Windows samples on every roughly 750ms startup
iteration; after that dense window it falls back to a 3-second cadence while the long-running engine
initialisation is unlikely to spawn new stages. Each asynchronous tool query is capped at 10 seconds;
exceeding that bound is a failed, unjudgeable walk rather than an empty process table. This narrows
rather than eliminates the handoff window, so cancellation's quiescence check remains the backstop.

**A teardown that lost its supervisor is unfinished, not finished.** If the watchdog dies
mid-shutdown, `stopping` is released but `server.pid` is preserved, and the next start must
consult it. An old server that closed its listener without exiting is invisible to an endpoint
probe, so starting beside it would lose the only identity of a process that may still hold
accelerator memory. The start refuses and names the pid.

That check is **not** conditional on having observed `stopping`. Gating it on the handshake
looked equivalent and was not: reconciliation clears `stopping` as soon as the watchdog's
record is stale, so an invocation arriving after the supervisor had already died saw no
handshake, skipped the check, and started beside the leftover anyway. Whether one of this
plugin's processes is still holding memory does not depend on which invocation happened to
witness the handshake. The check is free when nothing is recorded — an empty target list
performs no identity lookup.

**A start in progress is not a shutdown that failed, and `starting` is what tells them
apart.** A start is not atomic: `server.pid` names a live, provable process for seconds before
the socket answers. That is byte-for-byte the state the check above exists to catch, so a second
client arriving mid-start read a perfectly valid generation as wreckage and told the user to run
`--stop` — the one action that would have broken it. A live claim is therefore consulted *before*
the state is read as debris: the arriving client waits for that start instead, up to the same
startup timeout the start itself gets, and adopts the server when it comes up.

The claim is judged by liveness, not identity — it decides whether to *wait*, never whether to
signal, and the worst case of getting it wrong is a bounded wait ending in the same refusal it
would have reached at once. A claim whose author has exited, or whose file predates this boot, is
an abandoned file and the leftover refusal stands. If the wait times out with the claim still
live, that is reported as a start that has not come up rather than as leftover debris, because
advising `--stop` would again be advice to break a valid start.

**A stop succeeds only when the watchdog is confirmed gone too.** The watchdog is signalled
last and only once the server is proven down, but its own outcome then has to reach the
verdict. Discarding its `unknown` bucket and sending one un-followed-up `SIGTERM` meant the
command cleared `watchdog.pid`, wrote the success tombstone, and reported both processes exited
on the strength of the server's result alone — leaving a supervisor that ignored the signal
running with its identity deleted. It is chased and re-checked on the same terms as the server,
and a survivor keeps its record and lands in `survivors` like any other.

**"I could not identify this" is a verdict about a moment, and is never cached.** Identity
lookups fail transiently — PowerShell can fail to start, `ps` can be killed — and the pids whose
first lookup failed used to be remembered and folded unconditionally back into the final
`unknown` set. A lookup that failed once and then succeeded, with the process identified,
signalled and confirmed gone, was still reported as unjudgeable: a completed stop came out as a
failure, kept state it should have cleared, and named a pid that no longer existed. Every pass
re-asks the OS and returns a fresh verdict, so the last answer is the only one that counts. The
watchdog is not skipped for having failed an earlier lookup either — it gets the same fresh
check, which is what makes the failure recoverable rather than permanent.

**A failed idle stop keeps supervising rather than standing down.** The watchdog persisted
survivor identities and then exited, on the reasoning that the next client would reconcile and
start a fresh supervisor. That reasoning does not hold on the idle path: nothing guarantees a next
client. A server that refused the signal, or that hit a transient identity failure, would sit
resident with its accelerator memory held and no watchdog at all — the outcome this process exists
to prevent. It now releases the handshake, so clients are not blocked by a shutdown that did not
complete, and retries on the next poll; one poll plus a full escalation is roughly twenty seconds
between attempts. Relinquishing the slot is only safe when someone is known to be coming.

**Stop ordering compares `>=`, not `>`.** Both `stopped-at` and a start's `spawnedAt` are
`Date.now()`, so a stop landing in the same millisecond as a spawn is genuinely ambiguous — and
strict ordering resolved that by ignoring the stop, which is the one direction that cannot be
recovered from. An explicit `--stop` could be overtaken by a start it should have cancelled, and a
watchdog could go on supervising a server that command had torn down. Reading the tie as an
overtaking stop costs a start that has to be retried and says so, or a watchdog the next client
replaces.

**Existence is `kill(pid, 0)`, and `EPERM` means alive.** That call has two distinct failures.
`ESRCH` is "no such process"; `EPERM` is "it exists and you may not touch it". Flattening them
reports a running process as dead, which lets every downstream decision conclude a target
exited. Whether we may signal something is a separate question, settled by identity.

## Default values

A missing file means:

| File | Absent means |
|---|---|
| `in-flight` | 0 |
| `last-activity` | **now** — never "long ago" |
| `stopping` | not stopping |
| `server.pid` | unknown; discover or ignore |
| a pid file with no token | present but unprovable — reclaimable, never signallable |

The `last-activity` default is deliberate: treating absence as "epoch zero" would let a
watchdog reap a server that had just started.

## Watchdog algorithm

```
every POLL_INTERVAL:
  if idle_timeout == 0:            exit            # disabled
  if server not reachable:         cleanup; exit   # nothing to supervise
  if in-flight > 0:                continue        # FR-024: never interrupt work
  if now - last-activity < idle_timeout: continue
  write stopping
  terminate server.pid
  wait for exit
  remove stopping, server.pid
  exit
```

**Guarantees**:

1. **Never truncates work** (FR-024) — `in-flight > 0` is checked before the timeout, so a long
   generation cannot be cut off however long it runs.
2. **Exits when redundant** — an unreachable server means the watchdog has nothing to supervise;
   it cleans up and exits rather than lingering.
3. **Single supervisor** — a watchdog that finds a live `server.pid` it did not start exits
   rather than competing.
4. **Signals before acting** — `stopping` is written *before* termination, closing the race in
   which a client connects to a server that is already going down.

## Client obligations

1. Increment `in-flight` **before** the request; decrement on **every** exit path, including
   error and interrupt. A leaked increment pins the server alive.
2. Write `last-activity` both before and after — a long request must not appear idle throughout.
3. Before connecting, check `stopping`. If present, wait for exit, clear state, start fresh
   (FR-025). Never connect to a dying server.
4. Start the watchdog only when starting a server, and only if one is not already supervising.

## Backstop

Stale markers are handled precisely — a marker whose pid is dead is removed as the watchdog
counts — so a crashed client no longer pins accelerator memory, and the correctness of idle
shutdown does not depend on a timeout.

The time-based ceiling is retained as a second line of defence for the residual case where a
pid is *reused* by an unrelated process, making a stale marker look live. If
`now - last-activity` exceeds a hard ceiling well beyond the idle timeout, the watchdog
proceeds regardless. No legitimate request outlives the ceiling, and the alternative failure —
memory pinned until reboot — is worse than an early shutdown.

## Non-guarantees

- Not a supervisor: a crashed server is not restarted. The next request starts a fresh one.
- Not a scheduler: it does not queue, serialise, or arbitrate between concurrent callers.
- Not cross-machine. State is local and machine-specific.
