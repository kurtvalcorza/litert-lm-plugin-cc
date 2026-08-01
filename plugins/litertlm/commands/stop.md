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

Stopping is always safe. Nothing is lost — there is no conversation state to discard, and the
next request starts the server again automatically, just more slowly.
