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

`/gemma:setup` finds affected models and offers to repair them. The repair rewrites **only the
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

Windows, WSL, Linux, and macOS.

## Install

```
/plugin marketplace add kurtvalcorza/litert-lm-plugin-cc
/plugin install gemma@litert-lm-local
```

This repository is its own marketplace — it is not listed in any vendor catalogue. Updates come
through the same mechanism.

> `/plugin` opens an interactive dialog, so run it from an interactive `claude` terminal.

Then:

```
/gemma:setup
```

## Commands

| Command | What it does |
|---|---|
| `/gemma:ask` | Ask the local model a question |
| `/gemma:setup` | Check the stack; offer to repair CPU-fallback models |
| `/gemma:models` | List models and the backend each will *actually* use |
| `/gemma:review` | Offline second-opinion pass over your diff |
| `/gemma:stop` | Stop the server, release accelerator memory now |

## Skills

Four skills ship with the plugin. Commands load them by reference, so the guidance lives in one
place and cannot drift.

| Skill | Load it when |
|---|---|
| [`gemma-usage`](plugins/gemma/skills/gemma-usage/SKILL.md) | Reporting anything the model produced — the honesty policy |
| [`gemma-prompting`](plugins/gemma/skills/gemma-prompting/SKILL.md) | Composing a prompt — a 4B model needs a different shape |
| [`litert-lm-troubleshooting`](plugins/gemma/skills/litert-lm-troubleshooting/SKILL.md) | Something is wrong — failure catalogue by symptom |
| [`litertlm-format`](plugins/gemma/skills/litertlm-format/SKILL.md) | Debugging or extending the repair tool — container internals |

## What this is honest about

The model is **an endpoint, not an agent**. It has no file access, no shell, no repository
awareness, and no iteration. It answers only from the text in its prompt — anything not pasted
or piped in does not exist to it.

The default is Gemma 4 E4B, roughly a 4B-class model. Treat its output as a cheap offline
second opinion, never as authority. Fluent, confident prose is the *expected* failure mode of a
small model, not evidence of correctness. That policy lives in one place —
[`gemma-usage`](plugins/gemma/skills/gemma-usage/SKILL.md) — and every command references it
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
- ⚠️ **Never interleave models in a loop on the GPU backend.** Repeated teardown and re-init
  has been observed to hang the display driver (bugcheck `0x116`, VIDEO_TDR_ERROR) and force a
  reboot. Use `/gemma:stop` between models. Causation is indicated, not proven — but the
  failure mode is severe enough to avoid entirely.
- A model whose weights approach total VRAM may pass `litert-lm benchmark` and still fail in
  real use; benchmark does not exercise every section. `serve` cannot cap the context, so such
  a model cannot be served at all.

## Development

Built specification-first. The constitution, spec, plan, contracts, and task breakdown are in
[`specs/001-local-gemma-plugin/`](specs/001-local-gemma-plugin/), and
[`quickstart.md`](specs/001-local-gemma-plugin/quickstart.md) contains runnable verification
scenarios for every claim above.

## Licence

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
