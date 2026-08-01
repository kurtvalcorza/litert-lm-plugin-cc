---
description: List local models and which backend each will actually serve on
---

Report the imported models and, for each, the backend it will really use.

```bash
litert-lm list
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

The second command is the one that matters. `litert-lm list` shows size and date but **not**
the backend, and the backend is decided by metadata inside each model file — a model marked
`cpu` serves on CPU with no warning and no way to override it at run time.

Present them together: id, size, resolved backend. Flag anything on `cpu` that the user
probably wants on the accelerator.

To inspect one model's full metadata:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" show ~/.litert-lm/models/<id>/model.litertlm
```

The interesting section is `tf_lite_prefill_decode`. If it carries no `backend_constraint`
key, that absence *is* the bug — the resolver falls back to `cpu`. Audio and vision adapter
sections carry their own `backend_constraint = cpu`, which is genuine and must not be touched.

Anything resolving to `cpu` that you want on the accelerator → `/litertlm:setup` step 3 walks
through the repair, which is dry-runnable, reversible, and leaves the payload untouched.

## Things worth telling the user

**One model is resident at a time.** Naming a different model in a request tears the engine
down and re-initialises it — tens of seconds. **Never interleave models in a loop on the GPU
backend**: repeated re-initialisation has been observed to hang the display driver (bugcheck
`0x116`, VIDEO_TDR_ERROR, on an RTX 5070 Ti Laptop GPU). Run `/litertlm:stop` between models
instead of switching in place.

**Disk cost is roughly double the model size** once both backends have been exercised. Each
backend writes its own compiled-artifact cache next to the model — `mldrift_*` for GPU,
`xnnpack_*` for CPU. Check before assuming a model is small:

```bash
du -sh ~/.litert-lm/models/*
```

```powershell
Get-ChildItem "$env:USERPROFILE\.litert-lm\models" -Directory | ForEach-Object {
  "{0,-24} {1,8:N1} GB" -f $_.Name, ((Get-ChildItem $_.FullName -File | Measure-Object Length -Sum).Sum/1GB) }
```

`litert-lm delete <id>` removes the model and its caches together.
