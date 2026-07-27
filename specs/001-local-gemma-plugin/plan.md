# Implementation Plan: Local Gemma Plugin for Claude Code

**Branch**: `001-local-gemma-plugin` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-local-gemma-plugin/spec.md`

## Summary

Ship an unofficial Claude Code plugin that lets a user call a locally served Gemma model with
no API cost and no network egress, and that repairs the silent CPU-fallback trap in LiteRT-LM
model metadata.

Technical approach: a dependency-free Node client that talks to `litert-lm serve`'s
OpenAI-compatible endpoint and starts it on demand; a dependency-free Python tool that
rewrites the 16 KB flatbuffer header inside a `.litertlm` file to declare its processing
backend; markdown command definitions carrying the honesty guardrails; and a self-hosted
marketplace manifest so the repository installs directly without a vendor catalogue listing.

A working prototype of the client and the metadata tool already exists in the repository and
has been exercised against real models. This plan reconciles that prototype with the spec and
identifies exactly where it falls short (idle shutdown, reversal, confirmation flow, model-
switch warning).

## Technical Context

**Language/Version**: Node.js ≥18 (built-in `fetch`, `AbortSignal.timeout`) for the client and
watchdog; Python ≥3.9 (stdlib only) for the metadata tool. Markdown for commands and skill.

**Primary Dependencies**: **None declared.** No `package.json`, no lockfile, no `pip install`.
The metadata tool imports `litert_lm_cli`, `litert_lm_builder`, and `flatbuffers` from the
user's existing `litert-lm` installation rather than vendoring them (Principle III).

**Storage**: Model files under `~/.litert-lm/models/<id>/model.litertlm`, owned by the runtime.
Plugin-owned state is a single small runtime directory holding the server's last-activity
timestamp and an in-flight marker. No database.

**Testing**: Scenario-based verification driven by `quickstart.md`, with `payload_checksum.py`
as the one purpose-built instrument — it makes the "payload is byte-identical after a repair"
assertion checkable rather than argued. No test framework is introduced; adding one would
violate Principle III for a project whose entire surface is four scripts and six markdown
files. Every mutating operation is verified against a real model file before being documented
as working (Development Workflow).

**Target Platform**: Windows 10/11 (PowerShell), WSL2, Linux, macOS.

**Project Type**: Claude Code plugin, distributed as a self-hosted marketplace repository.

**Performance Goals**: Warm short-prompt response ≤3 s. Repair completes ≤5 s regardless of
model size. Repaired model ≥3x faster than the fallback path on a warm server (SC-002).

**Constraints**: No network egress except user-initiated model download. No credentials. No
telemetry. No install step from a clean checkout. Single model resident at a time.

**Scale/Scope**: One user, one machine, one resident model. Five commands, one skill, three
executable tools (`litertlm_backend.py`, `payload_checksum.py`, `gemma-client.mjs`), one
watchdog.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against constitution **v2.0.0**.

| Principle | Gate | Pre-design | Post-design |
|---|---|---|---|
| I. Honest About Limits (NON-NEGOTIABLE) | Every output-relaying command carries verification guidance; no surface claims repo awareness | PASS | PASS |
| II. Local-First, Zero Cost | No hosted inference call; no credentials; no telemetry | PASS | PASS |
| III. Dependency-Free Portable Tooling | Stdlib only; no manifest; actionable failure messages | PASS | PASS |
| IV. Non-Destructive Modification (NON-NEGOTIABLE) | Round-trip validation, bounds check, dry run, idempotency, reversibility | PASS | PASS |
| V. Unmistakably Unofficial | Disclaimer above the fold; individual author in metadata | PASS | PASS |
| VI. Cross-Platform by Default | No hardcoded paths; documented candidates + env override | PASS | PASS |

**Notes on the two NON-NEGOTIABLE gates:**

- **Principle I** is enforced structurally, not by wording discipline. The usage policy lives in
  a single skill (FR-009); commands reference it rather than restating it, so the guidance
  cannot drift between commands. The prototype violated this — `ask.md` and `review.md` each
  carried their own hand-written caveats. Phase 1 extracts them.
- **Principle IV** requires reversibility as of v2.0.0. The prototype's `patch` accepts
  `--backend cpu`, which already reverses the change, but this is neither documented nor
  verified. Phase 1 makes reversal a first-class, tested operation (FR-018, SC-011).

**No violations require Complexity Tracking.** The one design element that could look like
unjustified complexity — a separate watchdog process for idle shutdown — is examined in
research.md R3 and reduced to a single dependency-free script; the alternative of "no idle
shutdown" is not available because FR-023 mandates it.

## Project Structure

### Documentation (this feature)

```text
specs/001-local-gemma-plugin/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── gemma-client-cli.md
│   ├── litertlm-backend-cli.md
│   └── runtime-state.md
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
.claude-plugin/
└── marketplace.json          # Repo acts as its own distribution source (FR-027)

plugins/gemma/
├── .claude-plugin/
│   └── plugin.json           # Individual author, unofficial description (FR-029)
├── commands/
│   ├── ask.md                # US1
│   ├── review.md             # US5
│   ├── setup.md              # US3 — mutating, requires confirmation (FR-019)
│   ├── models.md             # US4
│   └── stop.md               # Manual lifecycle control alongside idle timeout
├── skills/
│   └── gemma-usage/
│       └── SKILL.md          # Single source of honesty policy (FR-009)
├── scripts/
│   ├── gemma-client.mjs      # Invocation, server lifecycle, model-switch warning
│   └── idle-watchdog.mjs     # Idle shutdown (FR-023..FR-025)
└── tools/
    ├── litertlm_backend.py   # resolve | show | check | patch (FR-011..FR-018)
    └── payload_checksum.py   # payload hash excluding header — makes SC-005/SC-011 runnable

README.md                     # Disclaimer above the fold (FR-028)
LICENSE                       # Apache-2.0
NOTICE                        # Upstream attribution (FR-030)
```

**Structure Decision**: The repository root is the marketplace; the plugin lives one level down
at `plugins/gemma/`. This mirrors the layout proven by `openai/codex-plugin-cc`, which is the
only structure verified to install from a plain GitHub repository without a vendor listing. A
flat layout with the plugin at the root was tried first in the prototype and is not installable
this way — the marketplace manifest must point at a plugin directory distinct from itself.

Tools are split by language for a concrete reason, not preference: the client needs `fetch` and
process spawning, which Node gives with zero dependencies; the metadata tool must import the
runtime's own vendored flatbuffers schema, which only exists in Python. Reimplementing either
side in the other language would mean vendoring a schema or an HTTP stack, violating Principle
III.

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.

---

## Post-Implementation Constitution Check (T069)

Re-run against the **built artifacts**, 2026-07-27. Each row cites the evidence that was
actually executed, not the intent.

| Principle | Verdict | Evidence |
|---|---|---|
| **I. Honest About Limits** (NON-NEG) | **PASS** | Policy exists once, in `skills/gemma-usage/SKILL.md`. Audit of all five commands: the two that relay model output (`ask`, `review`) reference it; the three that relay only tool output (`setup`, `models`, `stop`) correctly do not. No command restates the policy inline. `review.md` treats an uncritical relay as a task failure and stops on an empty diff rather than inviting invented findings — verified against a real 103-line diff, which returned "No concrete defects found" without padding. |
| **II. Local-First, Zero Cost** | **PASS** | T071: during a full request cycle the only socket held by any of `node`/`litert-lm`/`python` was `127.0.0.1:9379 Listen`. Zero non-loopback connections. No credential requested; `HF_TOKEN` unset throughout. |
| **III. Dependency-Free Portable Tooling** | **PASS** | No `package.json`, lockfile, `requirements.txt`, `pyproject.toml`, or `Pipfile` — confirmed absent on Linux. Both tools run from a clean checkout with no install step. Every failure path names the missing prerequisite: runtime-absent produces an actionable message with **0 tracebacks**. |
| **IV. Non-Destructive Modification** (NON-NEG) | **PASS** | Round-trip validation (1840→1840, content-compared) precedes every write; bounds-checked against `BLOCK_SIZE-32`; `check` writes nothing; re-patching reports "already gpu, nothing to do" and does not write; `--backend cpu` reverses. **Payload sha256 `edcc3078…` identical across four consecutive writes.** Consent gate refuses non-interactive writes without `--yes`, cleanly, including when `isatty()` lies. |
| **V. Unmistakably Unofficial** | **PASS** | README disclaimer at **line 3**; first runnable instruction at **line 53**. `NOTICE` states non-affiliation and credits LiteRT-LM, FlatBuffers, litert-community, and codex-plugin-cc by name and licence. Both manifests name an individual author. |
| **VI. Cross-Platform by Default** | **PASS** | T065: no hardcoded absolute paths or platform separators in shipped code. T066: full tool suite executed on Windows 11 **and** Linux (WSL2, kernel 6.18.33.2) with matching exit codes. `LITERT_LM_SITE_PACKAGES` honoured; a bogus override now surfaces the mistake rather than silently falling back. |

**Two principles were strengthened by implementation rather than merely satisfied.** Principle
IV gained the consent gate (FR-019) and reversal-as-first-class (FR-018) from the clarification
that amended the constitution to v2.0.0. Principle III gained a real teeth-check when the
Node `DEP0190` deprecation warning was found polluting stderr — resolving the executable path
and spawning without a shell removed it.

**Honest limits on this check**: SC-006 (first-run journey) is verified for the *guidance path*
in a prerequisite-free environment, not for a full bare-metal cold start — see research R10.
SC-009 covers Windows and one Unix-family environment; macOS is untested.

## Version Record (T070)

Every behaviour documented in this feature was observed against:

| Component | Version |
|---|---|
| `litert-lm` | **0.14.0** (`litert-lm-api` 0.14.0, `litert-lm-builder` 0.14.0) |
| Node.js | 24.12.0 (Windows), 24.18.0 (Linux) |
| Python | 3.12 |
| NVIDIA driver | 610.62 |
| GPU | RTX 5070 Ti Laptop GPU, 12,227 MiB |
| OS | Windows 11 Pro 26200; WSL2 kernel 6.18.33.2 |

**Workarounds a future release is expected to retire:**

| Workaround | Retired when | Detection |
|---|---|---|
| `schema.VDataCreator = schema.VdataCreator` alias | upstream fixes the codegen casing bug | the `hasattr` guard makes it a silent no-op automatically — no code change needed |
| The whole `litertlm_backend.py patch` path | `serve` gains a `--backend` flag, **or** the 0.15.0 per-model config (`~/.litert-lm/config.json`, which already carries `backend` and `max_num_tokens` in its schema) ships | `litert-lm serve --help` lists `--backend`, or `litert-lm --help` accepts `--config` |
| Client-side `loaded-model` tracking | the server reports its resident model over the API | `/v1/models` or a status endpoint exposes it |
| The idle watchdog | `serve` gains its own idle shutdown | `litert-lm serve --help` lists an idle option |

The 0.15.0 config schema would additionally fix the **12B-cannot-be-served** limitation, since
per-model `max_num_tokens` is exactly the cap `serve` currently cannot apply.
