# Contract: `litertlm_backend.py`

**Feature**: 001-local-gemma-plugin | **Consumers**: `/gemma:setup`, `/gemma:models`, users

The diagnosis-and-repair surface. This is the only component that writes to model files, so its
guarantees are the ones Principle IV rests on.

## Invocation

```
python litertlm_backend.py resolve [MODELS_DIR]
python litertlm_backend.py show    <model.litertlm>
python litertlm_backend.py check   <model.litertlm> [--backend gpu|cpu|npu]
python litertlm_backend.py patch   <model.litertlm> [--backend gpu|cpu|npu] [--yes]
```

`--backend` defaults to `gpu`. `MODELS_DIR` defaults to the runtime's models root.

## Subcommands

### `resolve` — read-only

Lists every model and the backend it will actually serve on. Models resolving to `cpu` are
visibly flagged. Satisfies FR-011; the primary diagnostic.

```
gemma4-e4b               cpu  <-- serves on CPU
gemma4-e4b-gpu           gpu
```

### `show` — read-only

Dumps one model's full section metadata: index, `model_type`, item count, and every key/value.
Long values truncated with the original length noted. Satisfies FR-012.

### `check` — read-only, never writes

Performs every validation `patch` would, reports what would change, writes nothing. Satisfies
FR-016. Documentation MUST present this before `patch`.

### `patch` — mutating

Applies the change in place after all validations pass.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including the idempotent no-op case |
| 1 | Aborted — validation failed, bounds exceeded, no main section, or confirmation declined |
| 2 | Usage error |

## Safety guarantees — all mandatory, all pre-write

1. **Round-trip validation** (FR-014) — unpack and repack the existing header with no change;
   the result MUST be content-identical to the original. If not, abort and write nothing. This
   catches a schema the tool does not fully understand *before* it damages anything.
2. **Bounds check** (FR-015) — the rewritten header MUST fit within `BLOCK_SIZE - 32` bytes. If
   not, abort. Overrunning would corrupt the first payload section.
3. **Idempotency** (FR-017) — a file already declaring the requested backend reports "nothing to
   do" and performs no write.
4. **Reversibility** (FR-018) — `--backend cpu` restores the fallback declaration. Reversal is a
   first-class operation, not a side effect, and MUST be documented alongside `patch`.
5. **Confirmation** (FR-019) — when invoked non-interactively by another command, `patch` MUST
   NOT proceed without `--yes`. `--yes` asserts the caller has already obtained consent in the
   same invocation.
6. **Atomic offset update** — the header bytes and the `header_end` value at offset 24 MUST both
   be written and flushed before the process exits. A partial write leaves an unreadable file.
7. **Payload untouched** — only bytes in `[32, BLOCK_SIZE)` are written. Everything from the
   first block boundary onward MUST be byte-identical afterwards.

## Portability guarantees

- Stdlib only, plus modules imported from the user's existing runtime install (Principle III).
- Locates the runtime by trying documented per-platform candidates, overridable via
  `LITERT_LM_SITE_PACKAGES` (FR-032). Failure to locate it produces an actionable message
  naming the install command, not an `ImportError` trace.
- Applies the upstream `VDataCreator` / `VdataCreator` casing workaround, guarded by `hasattr`
  so it becomes a no-op once upstream fixes it (research R8).

## Non-guarantees

- Does not create, download, convert, or delete models.
- Does not alter weights. It changes only where computation runs; output equivalence is
  verified by observation, not asserted by the tool.
- Cannot repair a model whose header has no spare room — it aborts instead.
