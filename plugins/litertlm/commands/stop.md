---
description: Stop the local model server and release accelerator memory now
---

Shut the server down and free the VRAM it is holding.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --stop
```

This kills both the server and its idle watchdog, then clears the runtime state files. It
confirms those processes actually exited rather than assuming the signal landed — by identity,
not by the port. A server can close its socket and still be alive in teardown, so "the port went
quiet" would say nothing about whether the memory is back.

A success message therefore means **this plugin's processes are gone**. It does not promise the
port is free: an unrelated listener may be sharing or holding it, and one is deliberately left
running rather than killed.

It stops **only what it can prove belongs to this plugin**: a process whose recorded identity
still matches, because the plugin launched it or was told to take it over. Anything else on that
port is reported and left running, including another OpenAI-compatible server that answers
`/v1/models`, and **including a `litert-lm serve` the user started themselves**. Connecting to a
server does not make it the plugin's to end.

If you see such a note, relay it. For another program the port is simply occupied, and the user has
to deal with it or pass `--port`. For a litert-lm server, the user can hand it over, but only ask
for this on their say-so, since it ends a process they started:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --stop --manage-existing
```

Report whether it was running, and how much accelerator memory was released if you can measure
it (`nvidia-smi --query-gpu=memory.used --format=csv`).

## When you need this

The server already shuts itself down after an idle period, so this is for the cases where
waiting is not what you want:

- You need the VRAM back **now** — for a game, a training run, or another tool.
- You are about to **switch models**. Stopping between models is strongly preferred over
  switching in place: repeated engine teardown and re-initialisation on the GPU backend has
  been observed to hang the display driver (bugcheck `0x116`, VIDEO_TDR_ERROR). Never
  interleave models in a loop.
- Something looks wedged and you want a clean slate. The next call starts a fresh server.

Stopping is safe for your own work: nothing is lost, there is no conversation state to discard,
and the next request starts the server again automatically, just more slowly.

It is also safe for everything else on the machine, which was not always true — `--stop` used to
treat any reply to `/v1/models` as proof the port was ours and terminate whatever held it, and
later still took any `litert-lm serve` on the port to be ours. If a model server of yours ever died
alongside a `/litertlm:stop`, that was why.
