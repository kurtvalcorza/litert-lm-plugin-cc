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

**`stopped-at` is a tombstone, and the only state file that is never cleared.** A watchdog is
spawned detached and cannot publish its pid until it has established its own identity — a
process lookup, seconds on Windows. A `--stop` arriving inside that window cannot see it: it is
in no pid file yet, so it cannot be a target, and it would go on to install itself as supervisor
of a server that has just been torn down. The watchdog therefore compares this stamp against
when it was spawned (`--spawned-at`), before claiming and again after, and stands down if a stop
has intervened.

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

Cancellation also requires **quiescence rather than one empty sample**. The launcher exits
before the detached descendant it spawned has bound the socket, so a single pass can see no live
process and no listener while the grandchild is still on its way up. Consecutive empty
observations are required before a cancellation is called complete — a heuristic, not a proof,
and it is written down as one.

**A teardown that lost its supervisor is unfinished, not finished.** If the watchdog dies
mid-shutdown, `stopping` is released but `server.pid` is preserved, and the next start must
consult it. An old server that closed its listener without exiting is invisible to an endpoint
probe, so starting beside it would lose the only identity of a process that may still hold
accelerator memory. The start refuses and names the pid.

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
