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

`/litertlm:review` is a thin wrapper over `litertlm-review.mjs`, which also runs on its own when
Claude Code is not available — see [When it earns its keep](#when-it-earns-its-keep).

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

### When it earns its keep

Its value is **independent weights, not quality**. Most of what it raises will not survive
verification; the few that do are things a different model family surfaced and yours did not.
Judge it on that, not on hit rate.

Two consequences:

- **Reach for it when a real review is out of reach** — rate-limited, out of quota, offline.
  A cheap independent signal beats nothing. It does not become a review because nothing else
  was available.
- **A same-family second opinion is not independent.** Run this alongside a frontier model of
  the same family and you have one perspective twice, reading as agreement it never earned.
  Different weights are the whole point — and that is a question of *which model answers*, not
  of how you invoke it. The slash command is fine here, provided the configured local model
  differs in family from your primary one.

**The first case is the one that needs something running without Claude Code**, because
`/litertlm:review` is agent-interpreted — Claude Code runs the pipeline and screens the output —
so it is unavailable in precisely the conditions that make a local pass attractive.

That is what `litertlm-review.mjs` is for. One command, no agent, no network. Run it from the
repository you want the pass over:

```powershell
$r = Get-ChildItem "$HOME\.claude\plugins\cache\litert-lm-local\litertlm\*\scripts\litertlm-review.mjs" -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if ($r) { node $r.FullName } else { Write-Error "litertlm-review.mjs not found — needs plugin 0.3.0 or later" }
```

```bash
d=$(command ls -1 ~/.claude/plugins/cache/litert-lm-local/litertlm 2>/dev/null | sort -V | tail -1)
r=~/.claude/plugins/cache/litert-lm-local/litertlm/$d/scripts/litertlm-review.mjs
[ -f "$r" ] && node "$r" || echo "litertlm-review.mjs not found — needs plugin 0.3.0 or later" >&2
```

**Neither line is written defensively for show.** A bare `node "$(...)"` whose glob matches
nothing expands to `node ""`, and Node then opens its REPL and waits on stdin — no output, no
error, no exit, and you sit there believing it is thinking. Since the script first ships in
**0.3.0**, that is what an un-updated install would do.

`command ls` is load-bearing too. Git Bash ships `alias ls='ls -F …'`, and `-F` appends `*` to
anything executable — which these scripts are — so a plain `ls` hands Node a path ending in an
asterisk and it fails with `Cannot find module`. `command` bypasses the alias. The `-f` test
then checks the result is a real file, which an emptiness check alone cannot do: a path that is
wrong is still non-empty.

**Sorting by version, rather than by date, is the third such detail.** Every version installed
stays in the cache, and the installer preserves file timestamps — so each copy of the launcher
carries an *identical* mtime and a most-recently-modified sort has nothing to sort on. It does
not pick badly; it picks arbitrarily. `sort -V` and the `[version]` cast order the directory
names as versions, which also gets 0.3.10 above 0.3.9 where a plain sort would not.

**Take the newest deliberately.** Each copy does drive its own sibling client, so an old one
runs — but it runs against that version's client, bugs included. Landing on a stale copy is how
you end up running a fix you already installed past. There is no stable path to hardcode,
because the versions live side by side; if you reach for this often, wrap it in a shell
function.

It is Node rather than shell, so the invocation itself is the same under PowerShell, cmd and a
POSIX shell — only the line that locates it differs.

It defaults to your uncommitted diff, and takes `--base main` (or `--base auto`) for a whole
branch, `--staged`, `--path` to narrow, and `--dry-run` to see what would be sent without
sending it. `--help` lists the rest.

Four things it owns that a hand-typed pipeline gets wrong:

- **Finding the client.** After a marketplace install it sits under the plugin cache at a
  versioned path, not in the repository you are reviewing. The launcher resolves it from its
  own location rather than from yours.
- **The range.** `git diff <base>...HEAD | client` puts the failure on the *left of a pipe*: git
  exits 128, the pipe still opens, the client receives an empty diff, and the model can still
  return a response. Bases are checked with `rev-parse` and `merge-base` before anything is sent,
  and a bad one is reported alongside the bases that would have worked.
- **Nothing to review.** An empty diff exits 3 without invoking the model, because an empty pass
  and a clean pass read identically.
- **Size.** Past 6 KB it refuses and names the files responsible. That figure was bisected
  against the server rather than estimated: serving `qwen3-4b-instruct` on LiteRT-LM 0.14.0
  (GPU backend, RTX 5070 Ti Laptop 12 GB), three real diffs were accepted up to 6,656, 7,168 and
  8,256 bytes respectively — the limit is on tokens, so it moves with how the text tokenises. 6 KB
  sits below the tightest of the three rather than at it, because three diffs do not bound the
  fourth. Expect a different number again on another model or runtime version.
  `--allow-oversize` sends it anyway and stamps the reply as partial coverage, but past that
  ceiling an oversized request usually does not come back partial at all: the server breaks the
  HTTP response and the run fails. The flag finds the ceiling; it does not get a large diff under
  it.

**What it cannot do is the screening.** Nothing sits between the model and you: verify every
claim against the actual code before repeating it, and say plainly how many did not survive.
The launcher prints that obligation after every reply. It cannot discharge it.

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
- ⚠️ **GPU engine initialisation has hard-crashed the development host four times.** Bugcheck
  `0x116` (VIDEO_TDR_ERROR, driver `nvlddmkm.sys`, forced reboot): 2026-07-27, 2026-07-31, and
  twice on 2026-08-01. The first two happened during an **in-place model switch** — a model
  resident, a request naming a different one. The last two did not: both were **cold starts with
  nothing resident**, the path earlier revisions of this file called the tested-safe mitigation.
  Of the **three** cold-start attempts made that day, two crashed and the third completed
  normally — so a cold start is neither safe nor reliably fatal, and a single clean run proves
  nothing either way. Causation is indicated, not proven, throughout.
  What survives: a switch forces the same initialisation and stacks a teardown on top of it, so
  still stop the server between models with `/litertlm:stop`. What does not: any claim that
  stopping first makes this safe. On this card a GPU engine init carries a real chance of taking
  the desktop with it — do not trigger one over unsaved work. **A GPU is optional here** — CPU is
  several times slower and has never done this. The full record, including what a crash leaves
  behind, is in the [`litert-lm-troubleshooting`](plugins/litertlm/skills/litert-lm-troubleshooting/SKILL.md)
  skill.
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
