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
