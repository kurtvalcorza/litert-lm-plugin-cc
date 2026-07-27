---
description: Check whether the local LiteRT-LM stack is ready, and fix the CPU-fallback trap
---

Verify the local stack end to end and report what, if anything, needs doing.

## 1. CLI present

```bash
litert-lm --version
```

If missing: `uv tool install litert-lm`. There is **no Windows or Linux binary in
GitHub Releases** — only macOS arm64 and Apple `.xcframework` — so PyPI/uv is the
distribution channel. Building from source needs Bazel and is unnecessary.

## 2. A model imported

```bash
litert-lm list
```

If empty, import an ungated one:

```bash
litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm gemma4-e4b
```

Gating is per repo and **Gemma 3 is not Gemma 4**: `litert-community/Gemma3-*` is
gated (401 without an accepted licence and `HF_TOKEN`), while the Gemma 4 repos are
not. Check before assuming:

```bash
curl -s https://huggingface.co/api/models/litert-community/gemma-4-E4B-it-litert-lm | grep -o '"gated":[^,]*'
```

## 3. The CPU-fallback trap — the important step

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

Any model reported as `cpu` **will serve on CPU**, roughly 4-5x slower, with no
warning and no way to override — `litert-lm serve` has no `--backend` flag. Fix by
patching the model's own metadata. Work on a copy so the original stays as a
reference:

```bash
cp -r ~/.litert-lm/models/gemma4-e4b ~/.litert-lm/models/gemma4-e4b-gpu
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" check ~/.litert-lm/models/gemma4-e4b-gpu/model.litertlm
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" patch ~/.litert-lm/models/gemma4-e4b-gpu/model.litertlm
```

`check` is a dry run. `patch` refuses to write unless a no-op round-trip reproduces
the header exactly and the result still fits the first block. Re-run `resolve` to
confirm.

## 4. Server reachable

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" --check
```

Then a live call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "Reply with exactly: READY"
```

## 5. VRAM headroom

Report total VRAM (`nvidia-smi --query-gpu=name,memory.total --format=csv`) against
model size. A model whose weights approach total VRAM may pass `litert-lm benchmark`
yet still fail under `run`/`serve` — benchmark does not exercise the embedding-lookup
and vision-encoder sections. A memory-mapping error or *"embedding lookup model is
not initialized"* means it does not fit; retry with `--max-num-tokens 1024`. Note
`serve` cannot cap the KV cache at all, so a model needing that flag cannot be served.

Summarise the state and name the single next action, if any.
