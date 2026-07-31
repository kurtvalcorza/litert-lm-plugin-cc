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

**Trigger: NOT established.** Two occurrences on the same host, five days apart. The first
followed rapid back-and-forth **model switching**, which made teardown/re-init the obvious
suspect. The second involved **no switch at all** — a single model had been resident, and the
only activity was an ordinary request. One shared condition: a model was loaded on the GPU.

Do not treat "avoid switching" as sufficient protection. It was the honest reading after one
data point; the second contradicts it. What remains true is that this is a **display-driver**
failure, not a LiteRT-LM one, and that it costs a reboot.

**Rule (still worth keeping)**: never interleave models in a loop. Stop the server between
models:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" --stop
```

Benchmark and comparison workflows should stop between models rather than switching in place —
that pairing has run clean where rapid switching did not. Just do not mistake it for immunity.

**After a crash**, state files survive the reboot and lie — dead pids, leaked in-flight
markers. The client reconciles this automatically on next run, and the test is **boot time as
well as pid liveness**: pids are reused, so after a reboot a dead client's pid can belong to
something live and unrelated, which would make a meaningless marker look like a running request
forever and suppress idle shutdown. A marker written before the current boot is stale whatever
its pid says. If you are inspecting by hand, do not trust what is in the runtime directory.

---

## Everything is several times slower than it should be

**Symptom**: responses take ~13 s where ~3 s is expected. Nothing reports a problem.

**Cause**: the model is serving on **CPU**. Its metadata omits `backend_constraint`, so the
resolver falls back to CPU — and `serve` has no `--backend` flag to override it.

**Diagnose**:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

Anything reporting `cpu` is affected. Fix via `/gemma:setup` step 3, or directly — dry run
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" --stop
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
