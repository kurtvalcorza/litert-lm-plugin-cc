---
description: Check the local model stack is ready, and offer to fix the silent CPU-fallback trap
---

Verify the stack end to end, report the **first** unmet condition with its fix, and stop there
— do not dump every failure at once.

## 1. Runtime installed

```bash
litert-lm --version
```

Missing → install it. There is **no Windows or Linux binary in GitHub Releases** (only macOS
arm64 and Apple `.xcframework`), so PyPI is the channel. Building from source needs Bazel and
is unnecessary.

`uv` is the recommended installer, but **do not assume it is present** — on a clean machine it
usually is not, and telling the user to run `uv` when they have no `uv` is a dead end. Check:

```bash
uv --version
```

If `uv` is missing, either install it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh          # Linux / macOS / WSL
```

```powershell
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"   # Windows
```

…or skip it entirely — plain pip works and needs nothing extra:

```bash
pip install litert-lm
```

Then install the runtime:

```bash
uv tool install litert-lm
```

Re-run `litert-lm --version` to confirm before moving on. If the command is still not found
after a successful install, the install directory is not on `PATH` — on Linux/macOS that is
usually `~/.local/bin`.

## 2. A model imported

```bash
litert-lm list
```

Empty → import an ungated one:

```bash
litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm gemma4-e4b
```

Gating is **per repository, and Gemma 3 is not Gemma 4**. `litert-community/Gemma3-*` is gated
and fails with HTTP 401 without an accepted licence and `HF_TOKEN`; the Gemma 4 repositories
download anonymously. These `litert-community` conversions are also distinct from the vendor's
own `google/gemma-4-*` repositories, which *are* gated — a reliable source of confusion. Check
rather than assume:

```bash
curl -s https://huggingface.co/api/models/litert-community/gemma-4-E4B-it-litert-lm
```

## 3. The CPU-fallback trap — the step that matters

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" resolve
```

Any model reported `cpu` **will serve on CPU**, roughly 4–5× slower, silently. `litert-lm serve`
has no `--backend` flag, so there is no way to override it at run time — the model's own
metadata decides. Measured on an RTX 5070 Ti Laptop GPU: the same prompt took **13.0 s on CPU
versus 3.0 s on GPU**, a 4.33× difference, with nothing reporting a problem.

**If a model you intend to use resolves to `cpu`, offer to repair it.** Show what was found,
then ask once. Dry run first — it writes nothing:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" check <path-to-model.litertlm>
```

Only on **explicit consent in this same conversation**, apply it:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/litertlm_backend.py" patch <path-to-model.litertlm> --backend gpu --yes
```

**Never pass `--yes` without having asked.** The flag asserts the user agreed to this specific
change. If they decline, write nothing and say the system still works, just on the slow path —
declining must not leave things half-configured.

Reassure accurately: only the first 16 KB of the file is rewritten, the multi-gigabyte payload
is untouched and verifiable with `payload_checksum.py`, and the change reverses with
`--backend cpu --yes`.

## 4. Server reachable

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" --check
```

Then prove it end to end:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "Reply with exactly: READY"
```

## 5. Accelerator memory headroom

```bash
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv
```

Compare against the model's size and **warn when the margin is thin**. A model whose weights
approach total VRAM may pass `litert-lm benchmark` and still fail in real use — benchmark does
not exercise the embedding-lookup and vision-encoder sections. A memory-mapping error, or
*"embedding lookup model is not initialized"*, means it does not fit.

The mitigation is `--max-num-tokens 1024`, which `serve` **cannot** set — so a model needing it
cannot be served at all through this plugin. Say that rather than letting the user discover it.
Reference case: Gemma 4 12B benchmarks fine on a 12 GB card and cannot be served on it.

## Reporting

Summarise the state and name **one** next action. If everything passes, say so and mention that
the server stops itself when idle, so nothing needs cleaning up.
