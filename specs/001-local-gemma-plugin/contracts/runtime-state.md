# Contract: Runtime State & Idle Watchdog

**Feature**: 001-local-gemma-plugin | **Parties**: `gemma-client.mjs` (writer), `idle-watchdog.mjs` (reader/terminator)

The coordination protocol behind FR-023 through FR-025. Written as a contract because two
independent processes depend on it and the failure modes are races.

## State directory

One small file per fact, under a plugin-owned runtime directory keyed by port so two servers on
different ports never share state.

| File | Format | Writer | Reader |
|---|---|---|---|
| `server.pid` | integer | client, after successful start | watchdog |
| `watchdog.pid` | integer | watchdog, on adoption | client |
| `last-activity` | epoch ms | client, before and after each request | watchdog |
| `in-flight.d/<pid>-<ts>` | **directory of marker files** | client, one per request | watchdog |
| `stopping` | empty; presence is the signal | watchdog, before terminating | client |
| `stopped-idle` | epoch ms | watchdog, before exiting | client (consumes) |
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

## Default values

A missing file means:

| File | Absent means |
|---|---|
| `in-flight` | 0 |
| `last-activity` | **now** — never "long ago" |
| `stopping` | not stopping |
| `server.pid` | unknown; discover or ignore |

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
