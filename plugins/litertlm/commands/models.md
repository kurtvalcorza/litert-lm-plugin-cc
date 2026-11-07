---
description: List local models and which backend each will actually serve on
---

Report the imported models and, for each, the backend it will really use.

```bash
litert-lm list
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

The second command is the one that matters. `litert-lm list` shows size and date but **not** the
backend. Each row of `resolve` gives the **effective** backend first, then what the file declares
(`embedded`) and any `override` from `~/.litert-lm/config.json`. On LiteRT-LM 0.15.0 and later the
config wins; on 0.14 and earlier only the file counts, and a model marked `cpu` serves on CPU with
no warning.

Present them together: id, size, effective backend. Flag anything effectively on `cpu` that the
user probably wants on the accelerator. Do not flag `embedded=cpu` on its own: with a `gpu` override
that model is correctly on the GPU. Flag every `REFUSED` row: that model will fail to load, because
its override is outside the backends the file allows.

To inspect one model's full metadata:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" show ~/.litert-lm/models/<id>/model.litertlm
```

The interesting section is `tf_lite_prefill_decode`. If it carries no `backend_constraint`
key, the resolver falls back to `cpu` unless config says otherwise. Audio and vision adapter
sections carry their own `backend_constraint = cpu`, which is genuine and must not be touched.

Anything effectively on `cpu` that you want on the accelerator → `/litertlm:setup` step 4 offers
the fix for the installed runtime: a config override on 0.15.0 and later, the header repair before.

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
