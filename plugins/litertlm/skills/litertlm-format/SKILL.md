---
name: litertlm-format
description: Reference for the .litertlm container layout and how LiteRT-LM resolves a model's backend. Load this when debugging or extending the metadata repair tool, rather than just running it.
---

# The `.litertlm` container

Enough of the format to reason about it safely. All observed against **litert-lm 0.14.0** —
re-verify before trusting these offsets against a newer release.

## Layout

| Offset | Size | Contents |
|---|---|---|
| 0 | 8 | magic — `LITERTLM` |
| 8 | 12 | version triple: major, minor, patch (`<III`) |
| **24** | 8 | **`header_end`** — u64 (`<Q`), absolute offset where the header flatbuffer ends |
| **32** | var | **header flatbuffer** (`LiteRTLMMetaData`) |
| 16384+ | rest | section payloads, aligned to `BLOCK_SIZE` |

`BLOCK_SIZE` is **16384**. Read it from `litert_lm_builder.litertlm_core.BLOCK_SIZE` rather
than hardcoding — a wrong value silently addresses the wrong bytes, and that failure looks like
a pass.

**The invariant everything rests on**: payload sections are block-aligned, and headers are far
smaller than one block. Observed usage:

| Model | header bytes | limit (`BLOCK_SIZE - 32`) | slack |
|---|---|---|---|
| gemma4-e4b (3.4 GiB) | 1,840 | 16,352 | 14,512 |
| gemma4-12b (6.1 GiB) | 992 | 16,352 | 15,360 |
| qwen3-0.6b-int4 | 336 | 16,352 | 16,016 |

So the header can be rewritten in place — grow it, update `header_end` at offset 24 — and no
payload byte moves. `SectionObject.BeginOffset/EndOffset` are **absolute** file offsets, which
is precisely why the rewrite must stay under the block boundary. Cross it and every section
offset becomes a lie.

## Metadata structure

```
LiteRTLMMetaData
├── SystemMetadata.entries[]        author, uuid, creation_timestamp
└── SectionMetadata.objects[]       one per payload section
    ├── begin_offset, end_offset    absolute; must never change
    ├── data_type
    └── items[]                     KeyValuePair
        ├── model_type              e.g. tf_lite_prefill_decode
        ├── backend_constraint      the key that matters — often absent
        └── prefer_activation_type  fp16, fp32_fp16, ...
```

Section types seen on a multimodal model (~12 sections): `tf_lite_embedder`,
`tf_lite_per_layer_embedder`, `tf_lite_audio_encoder_hw`, `tf_lite_audio_adapter`,
`tf_lite_end_of_audio`, `tf_lite_vision_encoder`, `tf_lite_vision_adapter`,
`tf_lite_end_of_vision`, `tf_lite_prefill_decode`, `tf_lite_mtp_drafter`.

## How the backend is resolved

`litert_lm_cli.model.model_default_backend()` walks the sections looking for a **main** type.
Both names carry the `tf_lite_` prefix — take them verbatim from
`litert_lm_builder.TfLiteModelType`, because an abbreviated string silently matches nothing:

| Constant | Value |
|---|---|
| `PREFILL_DECODE` | `tf_lite_prefill_decode` |
| `ARTISAN_TEXT_DECODER` | `tf_lite_artisan_text_decoder` |

1. `tf_lite_artisan_text_decoder` → **`gpu`**, unconditionally — it returns *before* reading
   `backend_constraint`.
2. Otherwise, if that section carries `backend_constraint` → its first comma-separated value.
3. Otherwise → **`cpu`**.

Step 3 is the whole problem. Absence is not neutral; it means CPU. And `litert-lm serve` has no
`--backend` flag, so nothing downstream can override it.

**Never patch an artisan model.** Step 1 short-circuits, so `backend_constraint` is never
consulted for them — a write would be a no-op that merely looked like a fix, and they cannot
fall into the CPU trap in the first place. Such a file may still *carry* a value (observed:
`backend_constraint = gpu_artisan`, a real member of the backend enum). It is inert metadata
for resolution purposes, not a setting to correct. `check` reports these as "nothing to repair"
and `patch` writes nothing.

**Only touch the main section.** Audio and vision adapters carry their own
`backend_constraint = cpu`, which is genuine — those encoders really do run on CPU, and they
are resolved independently for `--audio-backend` / `--vision-backend`. Rewriting them would
break working models.

## Rewriting safely

Use the flatbuffers **object API** (`InitFromObj` → mutate → `Pack`), not byte splicing.
Flatbuffers are offset-addressed; inserting a key shifts internal offsets, so a naive
search-and-replace corrupts the header.

```python
metaT = schema.LiteRTLMMetaDataT.InitFromObj(
    schema.LiteRTLMMetaData.GetRootAs(buf, 0))
# ... mutate metaT ...
builder = flatbuffers.Builder(0)
builder.Finish(metaT.Pack(builder))
```

**Upstream defect that blocks this entirely**: the generated
`litertlm_header_schema_py_generated.py` calls `VDataCreator` inside `_UnPack` but only defines
`VdataCreator`. Any `InitFromObj` raises `NameError` until you alias it:

```python
if not hasattr(schema, "VDataCreator"):
    schema.VDataCreator = schema.VdataCreator
```

Guard with `hasattr` so it becomes a no-op when upstream fixes the casing.

## Non-negotiable checks before writing

1. **Round-trip** — unpack and repack with no change; the result must compare identical across
   **both** the section table *and* SystemMetadata. Comparing only sections leaves a blind spot
   that makes the guard weaker than it looks.
2. **Bounds** — new header length ≤ `BLOCK_SIZE - 32`, or abort.
3. **Both writes flushed** — the header bytes *and* the `header_end` u64 at offset 24. A
   partial write leaves an unreadable file.
4. **Scrub on shrink** — if the new header is shorter, zero the gap up to the old `header_end`.

Verify afterwards by hashing the payload with the first `BLOCK_SIZE` bytes skipped. Identical
before and after is the proof that the rewrite was contained.

## Expected obsolescence

The unreleased 0.15.0 config (`~/.litert-lm/config.json`) already carries per-model `backend`
and `max_num_tokens` in its schema. When it ships, editing model files becomes unnecessary —
and `max_num_tokens` would also fix the models that currently cannot be served at all.
