---
description: Stop the local model server and release accelerator memory now
---

Shut the server down and free the VRAM it is holding.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --stop
```

This kills both the server and its idle watchdog, then clears the runtime state files. It
confirms the port actually closed rather than assuming the signal landed, so a success message
means the memory is genuinely back.

It stops **only what it can prove belongs to this plugin** — a recorded process whose identity
still matches, or a listener on the port whose command line is a `litert-lm serve`. Anything
else on that port is reported and left running, including another OpenAI-compatible server that
answers `/v1/models`. If you see such a note, relay it: the port is occupied by something the
plugin will not touch, and the user has to deal with it themselves or pass `--port`.

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
treat any reply to `/v1/models` as proof the port was ours and terminate whatever held it. If a
model server of yours ever died alongside a `/litertlm:stop`, that was why.
