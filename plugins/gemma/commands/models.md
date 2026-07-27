---
description: List local LiteRT-LM models and which backend each will actually serve on
---

Report the imported models and, for each, the backend it resolves to.

```bash
litert-lm list
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

The second command is the one that matters. `litert-lm list` shows size and date but
not the backend, and the backend is decided by metadata inside each file — a model
marked `cpu` serves on CPU with no warning and no CLI override.

To inspect one model's full metadata:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" show ~/.litert-lm/models/<id>/model.litertlm
```

Anything reporting `cpu` that you want on GPU: see `/gemma:setup` step 3.

## Notes worth passing on

- The server holds **one model in VRAM at a time**. Naming a different model in a
  request tears the engine down and re-initialises it, so do not interleave models
  in a loop — it is effectively single-tenant.
- Disk cost runs well above the model size once both backends have been exercised:
  each backend writes its own compiled-artifact cache next to the model
  (`mldrift_*` for GPU, `xnnpack_*` for CPU). Budget roughly 2x, and check with
  `du -sh ~/.litert-lm/models/*` before assuming a model is small.
- `litert-lm delete <id>` removes the model and its caches together.
