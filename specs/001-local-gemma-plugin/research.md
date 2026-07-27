# Phase 0 Research: Local Gemma Plugin

**Feature**: 001-local-gemma-plugin | **Date**: 2026-07-27

All findings below were established empirically against `litert-lm` **v0.14.0** on Windows 11
with a 12 GB RTX 5070 Ti Laptop GPU, unless stated otherwise. Per the constitution's
Additional Constraints, each finding records the version it was observed against.

---

## R1. How does the serving component choose a processing backend?

**Decision**: Repair the model file's own metadata; do not attempt to override at serve time.

**Rationale**: `litert-lm serve` exposes only `--host`, `--port`, `--cors-origin`, and
`--verbose`. It has no `--backend`. Internally it calls `model.parse_backend(None, model_obj=m)`
— passing `None` for the user override — so the backend comes entirely from the model file.

`model_default_backend()` scans the main section for a `backend_constraint` key. Observed
resolution across real models:

| Model | main section declares | resolves to |
|---|---|---|
| `gemma-4-12B-it.litertlm` | `backend_constraint = gpu` | gpu |
| `gemma-4-E4B-it.litertlm` | *(key absent)* | **cpu** |
| `Qwen3-0.6B` mixed-int4 | *(key absent)* | **cpu** |

The fallback when the key is absent is a hardcoded `"cpu"`. E4B is therefore not a CPU-only
model — it merely fails to declare a preference. Serving it patched vs unpatched, same prompt:
**2.6 s vs 12.9 s**, a 4.96x difference.

**Alternatives considered**:
- *Patch the CLI's resolver* — rejected: an edit to installed site-packages, silently reverted
  by `uv tool upgrade`, and invisible to anyone reading the repository.
- *Environment variable override* — rejected: no such variable exists; the only one read is
  `LITERT_LM_DIR`, which selects the base directory.
- *Wait for upstream* — rejected as the sole plan: the unreleased 0.15.0 config schema carries
  per-model `backend` and `max_num_tokens`, which would supersede this, but it is not shipped.
  Recorded so the tool can be retired when it lands.

---

## R2. Is rewriting a multi-gigabyte model file safe and affordable?

**Decision**: Rewrite only the header flatbuffer, in place, guarded by a round-trip check.

**Rationale**: The container layout makes this cheap. An 8-byte magic (`LITERTLM`), a version
triple, a `u64` at offset **24** holding `header_end`, the flatbuffer header at offset **32**,
then section payloads aligned to **BLOCK_SIZE = 16384**.

Measured headroom:

| Model | header bytes used | limit | slack |
|---|---|---|---|
| `gemma4-e4b` (3.4 GiB) | 1,840 | 16,352 | 14,512 |
| `gemma4-12b` (6.1 GiB) | 992 | 16,352 | 15,360 |

Adding `backend_constraint` grew the E4B header 1,840 → 1,896 bytes, well inside the first
block. Payloads never move, so every section offset stays valid. The write completed in well
under a second on a 3.4 GiB file, satisfying SC-004.

Safety rests on four checks, all verified: a no-op unpack/repack reproducing byte-identical
output (1840 → 1840, content-compared); a bounds check against the block boundary; a dry-run
mode; and idempotency (re-running reports "already gpu, nothing to do" and does not write).

**Alternatives considered**:
- *Rebuild the whole file with `LitertLmFileBuilder`* — rejected: it constructs a file from
  source parts and cannot patch an existing one; would mean rewriting gigabytes.
- *Binary search-and-replace on the raw bytes* — rejected: flatbuffers are offset-addressed;
  inserting a key shifts internal offsets, so a naive splice corrupts the header.

---

## R3. How to implement idle shutdown when the server has no such feature?

**Decision**: A detached watchdog process polling a client-maintained activity file.

**Rationale**: FR-023 requires idle shutdown; `litert-lm serve` offers none. The server is also
contacted directly by the client, so a proxy would be the only way to observe traffic
in-band — and a proxy adds a hop, a port, and a failure mode.

The chosen design keeps the data path untouched:

- The client writes `last-activity` (a timestamp) before each request and again after it
  completes, and maintains an `in-flight` counter file incremented before and decremented
  after.
- A watchdog, started once alongside the server, wakes on an interval and terminates the
  server only when `in-flight == 0` **and** `now - last-activity > idle_timeout`.
- Checking `in-flight` before the timeout satisfies FR-024: a long generation cannot be
  truncated by the timer.
- FR-025 needs no extra work — the client's existing "probe, else start" logic transparently
  restarts a server the watchdog reaped. The client must, however, report *why* a request was
  slow, distinguishing a watchdog restart from a first-ever start.

The race in the spec's edge cases — a request arriving between the timer firing and the process
exiting — is handled by having the watchdog write a `stopping` marker before it terminates
anything. A client that sees `stopping` waits for the process to exit and then starts a fresh
server, rather than connecting to a dying one.

**Alternatives considered**:
- *SessionEnd hook* — rejected: hooks do not fire reliably on crash or force-quit, orphaning a
  server that holds several GB of accelerator memory indefinitely.
- *Client-side "kill at T+idle" timer refreshed per call* — rejected: with no client running
  between sessions, the last scheduled kill is the only one that fires, and a second concurrent
  client would race it.
- *In-process timer inside a wrapper that owns the server* — rejected: the wrapper would have to
  outlive the invoking command, which is exactly what a detached watchdog is.

---

## R4. How is a plugin distributed without a vendor catalogue listing?

**Decision**: The repository carries its own `marketplace.json` and is added as a source.

**Rationale**: Inspection of the local plugin registry shows every installed plugin is keyed
`<plugin>@<marketplace>`; there is no path that installs a bare plugin repository. The
`openai-codex` entry resolves to the GitHub repo `openai/codex-plugin-cc`, whose root contains
`.claude-plugin/marketplace.json` listing one plugin at `./plugins/codex`.

So a self-hosted marketplace is not the same thing as a vendor listing: the repository is its
own catalogue of one, added by URL. This satisfies FR-027 while keeping the project entirely
outside any vendor-operated index, which is the stated intent.

**Consequence for layout**: the manifest and the plugin must occupy different directories. The
prototype placed the plugin at the repository root, which cannot work — the manifest's `source`
field must point somewhere other than itself.

**Alternatives considered**:
- *Manual clone into the plugin cache* — rejected: bypasses update handling and version
  tracking, and the cache path is an internal detail.
- *Submitting to a vendor marketplace* — explicitly rejected by the project owner.

---

## R5. What can the model actually do, and where must the guardrails sit?

**Decision**: Guardrails live in one skill; commands reference it. Tool calling is documented
as available but unused.

**Rationale**: Two capabilities were verified against `gemma4-e4b-gpu` and both work:
multi-turn via client-resent history (tracked a value across turns and answered correctly), and
OpenAI-shaped tool calling (returned a well-formed `tool_calls` with `finish_reason:
tool_calls`). This is more than expected from a ~4B on-device model.

What remains absent is the harness, not the primitive: no file access, no command execution, no
repository awareness, no iteration. The model answers only from prompt text. Building an agent
loop on top is feasible but is explicitly out of scope (FR-034) and would put a small model
where a frontier one already serves.

Placing the policy in a single skill rather than in each command is what makes Principle I
structurally enforced: five commands with five hand-maintained caveats will drift, and the
drift will always be toward overclaiming.

**Alternatives considered**:
- *Per-command caveats* — rejected as above; the prototype already showed the divergence.
- *Enforce honesty via a Stop hook gate* — rejected: a small model gating turns produces false
  positives that block real work, and users learn to ignore the gate, which is worse than none.

---

## R6. Which model sources require licence acceptance?

**Decision**: Default to Gemma 4, document that gating is per repository, and check rather than
assume.

**Rationale**: Gating is not uniform across a vendor's families. Verified against the Hub API:

| Repository | gated |
|---|---|
| `litert-community/gemma-4-E2B-it-litert-lm` | false |
| `litert-community/gemma-4-E4B-it-litert-lm` | false |
| `litert-community/gemma-4-12B-it-litert-lm` | false |
| `litert-community/Gemma3-1B-IT` | **auto** |

An import from the Gemma 3 repository fails with HTTP 401 without an accepted licence and a
token; the Gemma 4 repositories download anonymously. Note these are the `litert-community`
conversions, not the vendor's own `google/gemma-4-*` repositories, which *are* gated — a
distinction that reliably causes confusion.

---

## R7. Which models are actually usable on constrained accelerator memory?

**Decision**: Default to E4B; document the benchmark trap rather than recommending larger models.

**Rationale**: A model can pass `litert-lm benchmark` and still be unusable. Gemma 4 12B
benchmarked successfully (peak 10,270 MiB of 12,227) but **failed under both `run` and `serve`**
with a memory-mapping error and *"Input embeddings required by signature but embedding lookup
model is not initialized"*. Benchmark does not exercise the embedding-lookup and vision-encoder
sections, so it passes where real conversation does not. Reducing context via
`--max-num-tokens 1024` fixed `run` — but `serve` has no such flag, so the model cannot be
served at all on this hardware.

Measured, warm, 256 prefill / 256 decode:

| Model | prefill tok/s | decode tok/s | init |
|---|---|---|---|
| Qwen3-0.6B int4 | 6783.52 | 162.79 | 4.5 s |
| **Gemma4-E4B (gpu)** | **688.96** | **47.54** | 28.4 s |
| Gemma4-E4B (cpu) | 32.79 | 11.14 | 0.8 s |

**Implication for FR-021**: the readiness check must warn on thin margins and must not treat a
benchmark pass as proof of usability. A first cold GPU run also reports a misleadingly low
prefill figure (124.71 vs 688.96 warm) because kernel compilation is counted — hence the
constitution's requirement that a cold-start figure never be presented as steady-state.

---

## R8. Known upstream defect affecting the metadata tool

**Decision**: Alias the symbol at import time and comment why.

**Rationale**: `litertlm_header_schema_py_generated.py` calls `VDataCreator` inside `_UnPack`
but the module defines only `VdataCreator`. This casing mismatch raises `NameError` on any
`InitFromObj`, making the entire flatbuffers object API — and therefore any header rewrite —
unusable out of the box. Setting `schema.VDataCreator = schema.VdataCreator` before first use
resolves it.

Observed in `litert-lm` 0.14.0. This is an upstream codegen bug, so the workaround must be
guarded by `hasattr` and will become a no-op when fixed, rather than needing removal.
