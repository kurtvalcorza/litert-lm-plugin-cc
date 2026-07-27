<!--
SYNC IMPACT REPORT (latest first)

Version change: 1.0.0 → 2.0.0
Bump rationale: MAJOR — redefinition of a requirement inside a NON-NEGOTIABLE principle.
  Principle IV previously mandated "operate on a copy and retain the original". The
  /speckit-clarify session of 2026-07-27 chose in-place repair, which contradicts that
  MUST outright. Per Governance, a principle in conflict is amended, never ignored.
  The copy mandate is replaced by a REVERSIBILITY mandate: the tool must be able to
  restore the prior state, with re-acquisition documented as the external fallback.
  Classified MAJOR rather than MINOR because an existing MUST was removed and replaced
  rather than clarified or expanded.

Modified principles:
  - IV. Non-Destructive Model Modification — copy mandate → reversibility mandate
Downstream artifacts updated:
  ✅ specs/001-local-gemma-plugin/spec.md — FR-018 rewritten; US2 Independent Test
     changed from "apply to a copy" to "apply in place"; SC-011 added asserting
     reversibility and byte-identical payload; Clarifications carries a governance note.

---

Version change: (template) → 1.0.0
Bump rationale: MAJOR — initial ratification of a previously unfilled template.

Modified principles: none (initial definition)
Added sections:
  - I. Honest About the Model's Limits (NON-NEGOTIABLE)
  - II. Local-First, Zero Cost
  - III. Dependency-Free Portable Tooling
  - IV. Non-Destructive Model Modification (NON-NEGOTIABLE)
  - V. Unmistakably Unofficial
  - VI. Cross-Platform by Default
  - Additional Constraints (upstream coupling)
  - Development Workflow
  - Governance
Removed sections: none

Templates requiring updates:
  ✅ .specify/templates/plan-template.md      — Constitution Check gate reviewed, generic; no edit needed
  ✅ .specify/templates/spec-template.md      — no constitution-mandated sections added
  ✅ .specify/templates/tasks-template.md     — no new principle-driven task categories
  ✅ .claude/skills/speckit-*/SKILL.md        — no agent-specific name drift found
  ⚠ README.md                                 — pending; must carry the Principle V disclaimer

Deferred TODOs: none
-->

# Gemma Plugin for Claude Code Constitution

## Core Principles

### I. Honest About the Model's Limits (NON-NEGOTIABLE)

This project wraps a small on-device model. Every surface MUST make that plain and MUST
NOT let its output pass as authority.

- Commands that relay model output MUST instruct the caller to verify claims against the
  actual source before repeating them, and to state plainly which claims did not survive.
- No surface may describe the model as reviewing, analysing, or understanding a codebase.
  It reads only the text placed in its prompt. It has no file access, no shell, no repo
  awareness, and no iteration.
- Where a stronger tool exists for a task, the command MUST say so rather than implying
  parity with a frontier model.
- Confidence in model output is not evidence. Fluent prose from a small model is the
  expected failure mode, not a signal of correctness.

**Rationale**: The single largest risk here is a plausible wrong answer laundered through
a confident summary. A wrong answer the user distrusts costs a minute; a wrong answer the
user believes costs far more, and silently.

### II. Local-First, Zero Cost

All inference MUST happen on the user's machine.

- No feature may require a network call to a hosted inference provider.
- No API keys, accounts, or per-token billing may be required to use any command.
- Prompts, diffs, and file contents MUST NOT leave the machine.
- Network access is permitted ONLY for explicit, user-initiated model downloads, and the
  command that triggers it MUST say so.

**Rationale**: Offline operation and privacy are the reasons to run a local model at all.
A feature that quietly reaches the network forfeits both.

### III. Dependency-Free Portable Tooling

Scripts MUST run from a clean checkout with no install step.

- Node scripts MUST use only the standard library and built-in `fetch`. No `package.json`
  dependency tree, no lockfile, no `npm install`.
- Python tools MUST use only the standard library plus modules already vendored inside the
  installed `litert-lm` CLI.
- A script MUST fail with an actionable message naming the missing prerequisite, never with
  a bare stack trace.

**Rationale**: A plugin that needs its own install step will not survive contact with a
user who just wants to ask a question. Every added dependency is a new way for the plugin
to break on someone else's machine.

### IV. Non-Destructive Model Modification (NON-NEGOTIABLE)

Tools that write to model files MUST make damage structurally difficult.

- A write MUST be preceded by a no-op round-trip that reproduces the existing content
  exactly. If the round-trip is lossy, the tool MUST abort and write nothing.
- A write MUST be bounds-checked against the file's own layout and MUST abort rather than
  overrun a boundary.
- Every mutating tool MUST offer a dry-run mode that performs all validation and writes
  nothing, and documentation MUST show the dry run first.
- Mutating operations MUST be idempotent: re-running on an already-correct file reports
  that fact and does not write.
- Mutating operations MUST be **reversible**: the same tool MUST be able to restore the
  prior state, and documentation MUST state both the reversal command and the external
  fallback (re-acquiring the file). Operating on a copy MUST remain possible but MUST NOT
  be imposed as the only safe path.

**Rationale**: These files are multi-gigabyte downloads. A corrupting write costs the user
a re-download at best; at worst it produces a file that loads but misbehaves. The four
preceding safeguards — validated round-trip, bounds check, dry run, idempotency — constrain
*whether a bad write can occur*; reversibility constrains *what it costs if one does*.
Mandating a duplicate copy addressed the same risk by spending a model-size of disk on every
repair, which is a poor trade once the write itself is provably bounded.

### V. Unmistakably Unofficial

This project MUST NOT imply endorsement by Google, Anthropic, or OpenAI.

- The README MUST carry a disclaimer of non-affiliation above the fold.
- Plugin and marketplace metadata MUST identify the individual author, never a vendor.
- Naming and wording MUST NOT suggest a vendor-published or vendor-supported plugin.
- Upstream projects MUST be credited by name and licence where used.

**Rationale**: The plugin wraps a Google runtime and mirrors an OpenAI plugin's structure.
Both invite a reasonable reader to assume official provenance, and that assumption must be
actively prevented rather than merely not encouraged.

### VI. Cross-Platform by Default

Features MUST work on Windows, WSL, Linux, and macOS.

- Paths MUST be constructed programmatically; no hardcoded absolute paths or separators.
- Locating installed dependencies MUST use documented per-platform candidates with an
  environment-variable override, never a single hardcoded location.
- Platform-specific behaviour MUST be isolated behind a check and MUST have a defined
  fallback or an explicit, actionable error.
- Any capability unavailable on a platform MUST be documented as such rather than failing
  obscurely.

**Rationale**: The primary development machine is Windows, which is exactly the environment
most likely to produce accidentally non-portable code.

## Additional Constraints

**Upstream coupling.** This project depends on `litert-lm` internals that carry no
compatibility guarantee — the metadata layout of `.litertlm` files, the behaviour of
`model_default_backend()`, and the absence of a `--backend` flag on `serve`. Therefore:

- Any workaround for an upstream gap MUST record, in a comment at the point of use, what
  upstream behaviour it compensates for and how to tell when the workaround is obsolete.
- The `litert-lm` version a behaviour was observed against MUST be stated.
- Where upstream is known to be fixing a gap, documentation MUST name the version that is
  expected to make the workaround unnecessary.

**Quantitative claims.** Any performance figure published in this repository MUST state
the model, the hardware, and the measurement conditions. A cold-start figure MUST NOT be
presented as steady-state.

## Development Workflow

- Specification precedes implementation: constitution → specify → clarify → plan → tasks →
  analyze → implement.
- Every mutating tool MUST be exercised against a real model file — dry run first, then a
  patched copy, with the result verified — before it is documented as working.
- A claim that a command works MUST be backed by having run it. Reporting untested work as
  functional is a defect.
- Prototype code may precede the spec to de-risk it, but MUST be reconciled with the spec
  before release and MUST NOT be shipped as though specified.

## Governance

This constitution supersedes other practices in this repository. Where a convenience and a
principle conflict, the principle wins or the principle is amended — it is never silently
ignored.

**Amendment procedure**: Amendments MUST be committed as an explicit change to this file,
stating the rationale and the version bump. Amending the constitution to authorise a design
already chosen is a signal that the feature is mis-scoped; prefer re-scoping the feature.

**Versioning policy**: Semantic versioning. MAJOR for removing or redefining a principle in
a backward-incompatible way; MINOR for adding a principle or materially expanding guidance;
PATCH for clarifications that do not change meaning.

**Compliance review**: Every plan MUST pass an explicit Constitution Check before tasks are
generated. Violations MUST be either remediated or recorded in Complexity Tracking with a
justification for why no simpler approach suffices. Principles I and IV are
NON-NEGOTIABLE: a violation of either blocks release outright.

**Version**: 2.0.0 | **Ratified**: 2026-07-27 | **Last Amended**: 2026-07-27
