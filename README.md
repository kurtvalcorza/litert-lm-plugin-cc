# litert-lm-plugin-cc

> ### ⚠️ Unofficial
>
> This is an independent project by an individual author. It is **not affiliated with,
> endorsed by, or supported by Google, Anthropic, or OpenAI**. "Gemma", "LiteRT-LM", "Claude",
> and "Claude Code" are used only to identify the software it interoperates with. Nothing here
> is vendor-published. See [NOTICE](NOTICE).

A [Claude Code](https://claude.com/claude-code) plugin for calling a **local, on-device model**
served by [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) — offline, with no API
tokens and nothing leaving your machine.

It also fixes a trap that costs most users 4–5× performance without telling them.

---

## The trap this exists to fix

Several published `.litertlm` models omit a `backend_constraint` key in their metadata. When
it is absent, LiteRT-LM's resolver falls back to **CPU** — and `litert-lm serve` has **no
`--backend` flag**, so there is no way to override it at run time. The model serves on CPU,
several times slower, and nothing reports a problem.

Measured here, same prompt, same model, warm server:

| Backend | Time | |
|---|---|---|
| CPU (as shipped) | 13.0 s | ← what you get by default |
| GPU (after repair) | 3.0 s | **4.33× faster** |

*gemma4-e4b, RTX 5070 Ti Laptop GPU (12 GB), Windows 11, litert-lm 0.14.0. Warm server,
steady state — a first call after idle is slower because it pays engine initialisation.*

`/litertlm:setup` finds affected models and offers to repair them. The repair rewrites **only the
16 KB metadata header**; the multi-gigabyte payload is never touched, which is verifiable, and
the change is reversible.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 18 and Python ≥ 3.9 — both standard-library only, no
  install step, no dependency tree
- LiteRT-LM — `uv tool install litert-lm`, or plain `pip install litert-lm` if you do not
  already have [uv](https://docs.astral.sh/uv/)
  *(there is no Windows or Linux binary in GitHub Releases — PyPI is the channel)*
- ~4 GB disk for the default model, plus roughly as much again for compiled caches
- A GPU is optional. Without one it still works, just slower.

### Hardware

**A GPU is optional.** Without one everything works, just several times slower — that is the
expected behaviour, not a fault, and `/litertlm:setup` will say so rather than offering a repair
that would make no sense.

Verified on: **Windows 11 + NVIDIA RTX 5070 Ti Laptop GPU (12 GB)** end to end, and **Linux
(WSL2)** for the tooling. Everything else is plausible but untested:

| Setup | Expectation |
|---|---|
| NVIDIA, any recent card | should work; VRAM must exceed the model size with headroom |
| **No GPU** | works on CPU; `/litertlm:setup` skips the repair step entirely |
| AMD / Intel GPU | LiteRT-LM's backend is cross-platform, but **untested here**. The plugin's checks use `nvidia-smi`, so it will report "no accelerator" and treat you as CPU-only — conservative, not wrong |
| macOS / Apple Silicon | LiteRT-LM ships macOS arm64 builds; the plugin's tooling has **never been run there** |

If you try it on hardware not listed as verified, the failure mode to expect is a check
reporting no accelerator rather than anything breaking.

## Install

```
/plugin marketplace add kurtvalcorza/litert-lm-plugin-cc
/plugin install litertlm@litert-lm-local
```

This repository is its own marketplace — it is not listed in any vendor catalogue. Updates come
through the same mechanism.

> `/plugin` opens an interactive dialog, so run it from an interactive `claude` terminal.

Then:

```
/litertlm:setup
```

## Commands

| Command | What it does |
|---|---|
| `/litertlm:ask` | Ask the local model a question |
| `/litertlm:setup` | Check the stack; offer to repair CPU-fallback models |
| `/litertlm:models` | List models and the backend each will *actually* use |
| `/litertlm:review` | Offline second-opinion pass over your diff |
| `/litertlm:stop` | Stop the server, release accelerator memory now |

## Skills

Four skills ship with the plugin. Commands load them by reference, so the guidance lives in one
place and cannot drift.

| Skill | Load it when |
|---|---|
| [`litertlm-usage`](plugins/litertlm/skills/litertlm-usage/SKILL.md) | Reporting anything the model produced — the honesty policy |
| [`litertlm-prompting`](plugins/litertlm/skills/litertlm-prompting/SKILL.md) | Composing a prompt — a 4B model needs a different shape |
| [`litert-lm-troubleshooting`](plugins/litertlm/skills/litert-lm-troubleshooting/SKILL.md) | Something is wrong — failure catalogue by symptom |
| [`litertlm-format`](plugins/litertlm/skills/litertlm-format/SKILL.md) | Debugging or extending the repair tool — container internals |

## What this is honest about

The model is **an endpoint, not an agent**. It has no file access, no shell, no repository
awareness, and no iteration. It answers only from the text in its prompt — anything not pasted
or piped in does not exist to it.

The shipped default is Gemma 4 E4B — roughly a 4B-class model — though any litert-lm model can
be served and `LITERT_LM_PLUGIN_MODEL` changes the default. Treat its output as a cheap offline
second opinion, never as authority. Fluent, confident prose is the *expected* failure mode of a
small model, not evidence of correctness. That policy lives in one place —
[`litertlm-usage`](plugins/litertlm/skills/litertlm-usage/SKILL.md) — and every command references it
rather than restating it, so the guidance cannot drift toward overclaiming.

**Good for**: offline work, zero API spend, privacy-sensitive text, explaining a snippet or
regex, drafting and rephrasing, smoke-testing local inference.

**Not for**: anything needing real codebase reasoning. Use Claude directly.

### Deliberately out of scope

No background job management, no session transfer, no agentic tool-execution loop. Those depend
on a persistent agent runtime that a stateless completions endpoint does not have — building
wrappers around a 1–3 second synchronous call would be ceremony, not capability.

The model *does* support multi-turn and OpenAI-shaped tool calling. The plugin surfaces tool
calls but never executes them.

## Operational notes

- The server starts on demand and **stops itself after 15 minutes idle**, releasing VRAM. The
  next question restarts it transparently. `--idle-timeout 0` disables this.
- **One model is resident at a time.** Naming another forces a full engine reload.
- The default model is `gemma4-e4b`, matching what `/litertlm:setup` imports. Set
  **`LITERT_LM_PLUGIN_MODEL`** to make a different id the standing default on your machine —
  editing the script instead would be overwritten by the next plugin update. `--check` shows
  when an override is active.
- ⚠️ **Never switch models in place on the GPU backend.** Two hard crashes on the development
  host (bugcheck `0x116`, VIDEO_TDR_ERROR, forced reboot) both happened while a model was
  resident and a request named a different one, forcing teardown and re-init. Causation is
  indicated, not proven — but the failure mode is severe enough to avoid entirely.
  Use `/litertlm:stop` between models. That mitigation has been **tested**: the same GPU
  initialisation that preceded a crash ran clean as a cold start with nothing resident.
- A model whose weights approach total VRAM may pass `litert-lm benchmark` and still fail in
  real use; benchmark does not exercise every section. `serve` cannot cap the context, so such
  a model cannot be served at all.

## Development

Built specification-first with [Spec Kit](https://github.com/github/spec-kit) (MIT, © GitHub,
Inc.), whose scaffolding is redistributed here under `.specify/` and `.claude/skills/speckit-*`
— see [NOTICE](NOTICE). None of it ships in the installed plugin.

The constitution, spec, plan, contracts, and task breakdown are this project's own and live in
[`specs/001-local-gemma-plugin/`](specs/001-local-gemma-plugin/). Those documents predate the
0.2.0 rename and still say `gemma` — the plugin was originally named for its default model.
They are left as written, because a specification is a record of what was decided at the time,
not a document to retrofit;
[`quickstart.md`](specs/001-local-gemma-plugin/quickstart.md) contains runnable verification
scenarios for every claim above.

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
