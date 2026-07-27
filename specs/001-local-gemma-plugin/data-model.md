# Phase 1 Data Model: Local Gemma Plugin

**Feature**: 001-local-gemma-plugin | **Date**: 2026-07-27

This project owns very little state. Most entities described here are *observed* — they belong
to the runtime and are read, not written. Only the runtime-state files are plugin-owned.

---

## Entity: Model

A locally stored model, owned by the runtime.

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | string | directory name under the models root | User-assigned at import; the handle used everywhere |
| `path` | path | `<models_root>/<id>/model.litertlm` | Fixed convention |
| `size_bytes` | integer | filesystem | Payload dominates; header is negligible |
| `resolved_backend` | `gpu` \| `cpu` \| `npu` \| null | derived (see below) | **Not** stored directly; computed from metadata |
| `sections` | Section[] | header flatbuffer | See below |

**Derivation of `resolved_backend`** — this is the crux of the feature:

1. Scan sections for one whose `model_type` is a main type
   (`tf_lite_prefill_decode` or `artisan_text_decoder`).
2. If the type is `artisan_text_decoder` → `gpu`.
3. Else if that section carries a `backend_constraint` item → its first comma-separated value.
4. Else → **`cpu`** (the silent fallback this feature exists to expose and repair).

**Validation rules**:
- A model directory without `model.litertlm` is not a model and is skipped, not an error.
- `resolved_backend` of `cpu` on accelerator-capable hardware is a *finding*, not a failure —
  reported and flagged, never auto-corrected without confirmation (FR-019).

---

## Entity: Section

An entry in a model's header metadata. Read-only except for the one item this feature writes.

| Field | Type | Notes |
|---|---|---|
| `index` | integer | Position in the section vector |
| `model_type` | string \| null | e.g. `tf_lite_prefill_decode`, `tf_lite_vision_encoder` |
| `begin_offset` | u64 | Absolute byte offset of the payload |
| `end_offset` | u64 | Absolute byte offset of payload end |
| `items` | KeyValue[] | Metadata pairs |

**Invariant (load-bearing)**: `begin_offset` and `end_offset` are absolute file offsets. Any
header rewrite MUST leave them unchanged, which holds only while the rewritten header stays
within the first block. This is the invariant the bounds check protects.

**Observed shape**: a multimodal model carries ~12 sections — embedder, per-layer embedder,
audio encoder/adapter, vision encoder/adapter, prefill-decode, drafter. Only the main section
is ever modified. Audio and vision adapters carry their own `backend_constraint = cpu`, which
is genuine and MUST NOT be touched — they are resolved independently for the audio and vision
backends.

---

## Entity: KeyValue

| Field | Type | Notes |
|---|---|---|
| `key` | string | e.g. `model_type`, `backend_constraint`, `prefer_activation_type` |
| `value` | scalar | Union-typed; this feature only ever writes a string |
| `value_type` | enum | `StringValue` for everything this feature writes |

**The only mutation this project performs**: adding or updating
`{key: "backend_constraint", value: "<backend>", value_type: StringValue}` on the main section.

---

## Entity: Container Layout

Not user-visible, but the numbers govern whether a repair is safe.

| Field | Value | Notes |
|---|---|---|
| magic | `LITERTLM` | 8 bytes at offset 0 |
| version | 3 × u32 | Offsets 8–19 |
| `header_end` | u64 | At offset **24** — must be updated on every rewrite |
| header start | — | Offset **32** |
| `BLOCK_SIZE` | 16384 | Payload alignment |
| usable header | 16352 | `BLOCK_SIZE - 32` — the bounds-check limit |

**State transition — repair**:

```
declared(absent) --patch(gpu)--> declared(gpu)     [writes header + header_end]
declared(gpu)    --patch(gpu)--> declared(gpu)     [no write; idempotent, FR-017]
declared(gpu)    --patch(cpu)--> declared(cpu)     [reversal, FR-018]
any              --validation fails--> unchanged   [abort, FR-014/FR-015]
```

---

## Entity: Serving Process

| Field | Type | Notes |
|---|---|---|
| `host`, `port` | string, integer | Default `127.0.0.1:9379` |
| `loaded_model` | model id \| null | **Exactly one** at a time |
| `state` | `down` \| `starting` \| `ready` \| `stopping` | `stopping` is plugin-observed, not reported by the server |

**State transitions**:

```
down --request--> starting --ready--> ready
ready --request naming another model--> ready(reloaded)   [warn first, FR-026]
ready --idle timeout, in-flight == 0--> stopping --> down [FR-023]
stopping --request--> (wait for exit) --> starting        [FR-025, no connection error]
```

**Invariant**: the engine holds one model. A request naming a different model tears down and
re-initialises, costing tens of seconds. This makes the server effectively single-tenant and is
why FR-026 requires a warning rather than silent compliance.

---

## Entity: Runtime State *(plugin-owned — the only thing this project writes outside model files)*

Stored in a single directory, one small file per fact. Files rather than a single document so
that concurrent readers and writers never need a lock.

| File | Contents | Written by | Read by |
|---|---|---|---|
| `last-activity` | epoch milliseconds | client, before and after each request | watchdog |
| `in-flight` | integer counter | client, incremented before / decremented after | watchdog |
| `stopping` | presence is the signal | watchdog, before terminating | client |
| `server.pid` | process id | client, on successful start | watchdog |

**Validation rules**:
- A missing file means the zero value (`in-flight` absent → 0; `last-activity` absent → treat
  as now, so a fresh server is never immediately reaped).
- A stale `server.pid` naming a dead process MUST be ignored and overwritten, not trusted.
- `in-flight` MUST be decremented in a `finally`-equivalent path, or a crashed client pins the
  server alive forever. A bounded ceiling on activity age is the backstop.

---

## Entity: Usage Policy

Not data — a single markdown skill. Modelled here because FR-009 makes single-sourcing a
requirement rather than a convention.

| Field | Notes |
|---|---|
| capability boundary | No file access, no shell, no repo awareness, no iteration |
| verification duty | Claims checked against source before repeating; failures named |
| escalation | Name the stronger tool where one applies |
| model class | Small on-device model; fluency is not evidence |

**Invariant**: exactly one copy exists. Commands reference it. A command restating the policy
inline is a defect, because divergent copies drift toward overclaiming.
