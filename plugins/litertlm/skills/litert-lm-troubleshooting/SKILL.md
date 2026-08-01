---
name: litert-lm-troubleshooting
description: Failure catalogue for local LiteRT-LM inference — crashes, hangs, silent slowness, download refusals, stale state. Load this when something is wrong rather than debugging from first principles.
---

# When local inference misbehaves

Observed against **litert-lm 0.14.0**, RTX 5070 Ti Laptop GPU (12 GB), Windows 11 and WSL2.
Symptoms first, since that is what you have when you arrive.

---

## ⚠️ The machine hard-crashed

**Symptom**: BSOD, hard reboot. Event log shows bugcheck **`0x116` VIDEO_TDR_ERROR**, often
with parameter 3 `0xC000009A` (`STATUS_INSUFFICIENT_RESOURCES`). The display driver hung and
could not be reset.

**Four occurrences on this host**, all bugcheck `0x116` with `nvlddmkm.sys` named:

| When | Condition at the time | Model |
|---|---|---|
| 2026-07-27 20:16 | in-place model switch | — |
| 2026-07-31 20:34 | in-place model switch | — |
| 2026-08-01 18:28 | **cold start, nothing resident** | `qwen3-4b-instruct` |
| 2026-08-01 20:49 | **cold start, nothing resident** | `qwen3-4b-instruct` |

**The shared condition is GPU engine initialisation, not the switch.** That is a correction: the
first two crashes both involved a switch, and a switch forces an init, so the switch looked
causal. The last two had no switch and no resident model and hung the driver anyway. Causation
remains indicated rather than proven throughout, but the condition common to all four is the
narrower one.

**Those last two were also the only two cold-start attempts made that day.** One cold-start
crash reads as bad luck; two out of two does not. On this host the mitigated path is not
"unproven" — it is failing, and the honest expectation for a GPU init here is that it takes the
desktop with it.

Establishing them as genuine cold starts matters, so here is the evidence rather than the
assertion. In both cases a `--check` moments earlier reported the server down. The runtime
directory left behind held `server.pid`, `watchdog.pid` and one in-flight marker — but **no
`loaded-model`**. That file is written only after a completion returns, so no request had ever
finished on that server: it was the first request against a freshly started engine.

The second crash is still worth reading carefully, because it looks like a counter-example and
is not. Reconstructed from file timestamps: the switch target's GPU caches were written seconds
before the bugcheck, so a **completed** initialisation preceded the hang — the engine did not
choke on a malformed load. Note the trap: that model's ML Drift weight cache is legitimately
**0 bytes**, so its presence after a crash proves nothing about whether the init finished.
Compare sizes against a known-good run before concluding anything from cache files.

**Rule**: still never interleave models in a loop, because a switch stacks a teardown on top of
an init and remains the worst case. Stop the server between models:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --stop
```

**But do not read that as safe.** Earlier revisions of this skill called the mitigation tested,
on the strength of re-running the identical initialisation as a cold start — same model, same
backend — twice, cleanly, with memory released afterwards. Those runs happened and that result
stands; what it does not do is generalise, as both 2026-08-01 crashes showed. Stop-then-load is
**lower risk, not safe**. Do not trigger a GPU init over unsaved work, and do not schedule one
where a reboot would cost you something.

If you need the model to work today rather than to diagnose the driver, **run it on CPU**. It is
several times slower and has never done this. `/litertlm:setup` will offer to repair a model to
GPU; on this host that offer is currently the wrong trade.

**When this is expected to stop being true**: the hang is in the display driver, so the thing to
watch is an NVIDIA driver release, not a `litert-lm` one. Re-test on a driver update before
assuming any of this still holds.

**After a crash**, state files survive the reboot and lie — dead pids, leaked in-flight
markers. The client reconciles this automatically on next run, and the test is **boot time as
well as pid liveness**: pids are reused, so after a reboot a dead client's pid can belong to
something live and unrelated, which would make a meaningless marker look like a running request
forever and suppress idle shutdown. A marker written before the current boot is stale whatever
its pid says. If you are inspecting by hand, do not trust what is in the runtime directory.

**That rule was only half-applied, and the 20:49 crash proved it.** Until 0.3.1 the boot-time
test guarded in-flight markers only; `server.pid` and `watchdog.pid` were trusted on pid
liveness alone. After the 18:28 crash reconciliation appeared to work perfectly — but only
because those pids happened not to be reused. After 20:49 they were:

| File | Written | Pid | What that pid was afterwards |
|---|---|---|---|
| `server.pid` | 20:47 | 30684 | a running **Discord** |
| `watchdog.pid` | 20:47 | 35640 | a running **VS Code** |

Both files predated the 20:48:58 boot, both pids were alive, so both were believed. The cost:
`startWatchdog` saw a supervisor that did not exist and started none, leaving the server free to
hold accelerator memory indefinitely — and `--stop` would have sent `SIGTERM` to Discord and VS
Code, because the recorded pids were signalled without the scepticism applied to the port owner.

Fixed in 0.3.1: `livePid` now requires both tests, and `stopProcesses` goes through it. **If you
are on 0.3.0 or earlier and have just rebooted from a crash, delete `server.pid` and
`watchdog.pid` by hand before running anything** — deleting them signals nobody, which is more
than can be said for `--stop`.

The general lesson is the one this file already stated and the code had not finished acting on:
after a reboot, a pid in a state file is a number, not an identity.

---

## Everything is several times slower than it should be

**Symptom**: responses take ~13 s where ~3 s is expected. Nothing reports a problem.

**Cause**: the model is serving on **CPU**. Its metadata omits `backend_constraint`, so the
resolver falls back to CPU — and `serve` has no `--backend` flag to override it.

**Diagnose**:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

Anything reporting `cpu` is affected. Fix via `/litertlm:setup` step 3, or directly — dry run
first, it writes nothing:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" check <model.litertlm>
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" patch <model.litertlm> --backend gpu --yes
```

Reverses with `--backend cpu --yes`. See the `litertlm-format` skill for why this is safe.

---

## A model stopped loading after a repair was interrupted

**Symptom**: any command touching the model reports *"could not read the header"*, usually
naming a `struct.error` about a buffer being too small. It worked before a `patch` that was
cut short — a crash, a reboot, a killed terminal.

**Cause**: the header bytes sit at offset 32 and the length describing them sits at offset 24.
A patch writes both. Interrupted between the two, they disagree, and the flatbuffer then reads
truncated. **`patch --backend cpu` cannot undo this** — it reverses a *completed* patch, and
this one never completed.

**Fix**: `patch` copies the 16 KB header block aside before writing and removes it only on
success, so a leftover copy is itself the evidence the run died.

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" restore <model.litertlm>
```

Every command that hits an unreadable header already says whether a backup exists. If none
does, the model must be re-imported — the payload is intact but nothing describes it.

---

## A model benchmarks fine but fails when actually used

**Symptom**: `litert-lm benchmark` passes. `run` or `serve` fails with a memory-mapping error,
or *"Input embeddings required by signature but embedding lookup model is not initialized"*.

**Cause**: it does not fit. Benchmark does not exercise the embedding-lookup and vision-encoder
sections, so it passes where real conversation does not. **A benchmark pass is not evidence a
model is usable.**

**Fix**: reduce context — `litert-lm run <model> --max-num-tokens 1024`. But `serve` cannot set
this, so **such a model cannot be served through the plugin at all**.

Reference case: Gemma 4 12B benchmarks at peak 10,270 MiB of 12,227 and cannot be served on
that card. Use E4B (~3.4 GiB) instead.

---

## Download refused with HTTP 401

**Symptom**: `litert-lm import` fails with `Unauthorized`.

**Cause**: that repository is gated. Gating is **per repository**, and Gemma 3 is not Gemma 4:

| Repository | Gated |
|---|---|
| `litert-community/gemma-4-{E2B,E4B,12B}-it-litert-lm` | no |
| `litert-community/Gemma3-1B-IT` | **yes** |
| `google/gemma-4-*` (vendor originals) | **yes** |

Note the `litert-community` conversions are distinct from the vendor's own repositories — a
reliable source of confusion. Check rather than assume:

```bash
curl -s https://huggingface.co/api/models/<owner>/<repo>
```

Either accept the licence on the model page and set `HF_TOKEN`, or use an ungated repository.

---

## `litert-lm` is not found after installing it

Two distinct causes:

- **`uv` itself is absent.** A clean machine usually has neither. Install uv
  (`curl -LsSf https://astral.sh/uv/install.sh | sh`, or the PowerShell equivalent), or skip it
  — `pip install litert-lm` works and needs nothing extra.
- **Installed but not on `PATH`.** Usually `~/.local/bin` on Linux and macOS.

There is **no Windows or Linux binary in GitHub Releases** — only macOS arm64 and Apple
`.xcframework`. PyPI is the channel; do not go looking for an `.exe`.

---

## The server holds VRAM after you finish

Expected: it stops itself after the idle period (default 900 s) and the next call restarts it
transparently. To reclaim immediately:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --stop
```

If memory is still held afterwards, something else owns the port — `--stop` verifies the port
actually closed and will say so rather than reporting false success.

`--idle-timeout 0` disables automatic shutdown entirely.

---

## Disk fills faster than model sizes suggest

Each backend writes its own compiled-artifact cache **next to the model** — `mldrift_*` for
GPU, `xnnpack_*` for CPU. Budget roughly **2× the model size** once both have been exercised. A
475 MB model produced 433 MB + 324 MB of cache.

`litert-lm delete <id>` removes the model and its caches together.

---

## A traceback reached you

That is a defect in this plugin, not user error. Every failure path is supposed to name the
missing prerequisite or the diagnostic command. Report it.

The one exception outside our control: `litert_lm_builder`'s generated schema raises
`NameError: VDataCreator` on any `InitFromObj` — an upstream codegen casing bug, worked around
in our tools. If you hit it in your own code, see the `litertlm-format` skill.
