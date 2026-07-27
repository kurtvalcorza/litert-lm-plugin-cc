# Tasks: Local Gemma Plugin for Claude Code

**Feature**: 001-local-gemma-plugin | **Date**: 2026-07-27
**Input**: [spec.md](./spec.md) · [plan.md](./plan.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Tests**: No test framework is introduced (Principle III — a framework would be the project's
only dependency, for four scripts). Verification is scenario-based via `quickstart.md`, and
every mutating operation must be exercised against a real model file before being documented as
working (constitution, Development Workflow). Verification tasks are therefore explicit tasks,
not an afterthought.

**Prototype note**: working prototype code exists at `plugins/gemma/scripts/gemma-client.mjs`
and `plugins/gemma/tools/litertlm_backend.py`. Tasks below say **reconcile** where prototype
code exists and **create** where it does not. Prototype code MUST NOT be assumed correct — the
plan identifies four gaps it does not cover.

---

## Phase 1: Setup

- [ ] T001 Create the marketplace manifest at `.claude-plugin/marketplace.json` naming marketplace `gemma-local`, one plugin `gemma`, `source: ./plugins/gemma`, individual author (FR-027, FR-029)
- [ ] T002 [P] Create the plugin manifest at `plugins/gemma/.claude-plugin/plugin.json` with name `gemma`, version, Apache-2.0, and an "Unofficial" description (FR-029)
- [ ] T003 [P] Add `LICENSE` (Apache-2.0) at repository root
- [ ] T004 [P] Add `NOTICE` at repository root crediting `google-ai-edge/LiteRT-LM` and the `litert-community` model conversions by name and licence (FR-030)
- [ ] T005 [P] Add `.gitignore` covering `__pycache__/`, `*.pyc`, `.DS_Store`, and any local runtime-state directory
- [ ] T006 Verify the repository layout matches plan.md — manifest at root, plugin under `plugins/gemma/`, and confirm the manifest `source` path resolves (research R4: a root-level plugin is not installable)

**Checkpoint**: repository is structurally a self-hosted marketplace.

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ MUST complete before any user story phase.**

- [ ] T007 Create the shared usage-policy skill at `plugins/gemma/skills/gemma-usage/SKILL.md` stating the capability boundary (no file access, no shell, no repo awareness, no iteration), the verification duty, the escalation rule, and that fluency is not evidence (FR-007, FR-008, FR-009, FR-010)
- [ ] T008 Establish the runtime-state directory convention in `plugins/gemma/scripts/gemma-client.mjs` — port-keyed path, one file per fact, absent-means-default rules per `contracts/runtime-state.md`
- [ ] T009 Reconcile cross-platform dependency discovery in `plugins/gemma/tools/litertlm_backend.py` — per-platform candidate paths, `LITERT_LM_SITE_PACKAGES` override, and an actionable message naming the install command instead of an `ImportError` trace (FR-032, Principle III)
- [ ] T010 Reconcile the `VDataCreator`/`VdataCreator` workaround in `plugins/gemma/tools/litertlm_backend.py`, guarded by `hasattr` with a comment naming the upstream defect and the version observed (research R8, constitution Additional Constraints)

**Checkpoint**: shared policy exists in exactly one place; both tools locate their dependencies portably.

---

## Phase 3: User Story 1 — Ask the local model a question (P1) 🎯 MVP

**Goal**: A user asks a question and gets an answer, offline, with the server managed for them.

**Independent test**: With the runtime installed and a model imported, invoke the ask command and confirm an answer returns, no hosted-provider call occurs, and the framing is non-authoritative.

- [ ] T011 [US1] Reconcile argument parsing in `plugins/gemma/scripts/gemma-client.mjs` against `contracts/gemma-client-cli.md` — per-invocation `--model`, `--max-tokens`, `--system` overrides plus `--idle-timeout`, and exit code 2 for usage errors vs 1 for runtime failures (FR-004)
- [ ] T012 [US1] Reconcile stdin handling in `plugins/gemma/scripts/gemma-client.mjs` so positional prompt precedes piped content separated by a blank line (FR-003)
- [ ] T013 [US1] Reconcile server start-on-demand in `plugins/gemma/scripts/gemma-client.mjs` — probe first, start detached only if absent, bounded startup wait, never double-start on a healthy probe (FR-002)
- [ ] T014 [US1] Enforce the stdout/stderr split in `plugins/gemma/scripts/gemma-client.mjs` — payload only on stdout; all notices, warnings and diagnostics on stderr
- [ ] T015 [US1] Implement the model-switch reload warning in `plugins/gemma/scripts/gemma-client.mjs`, emitted before the request with its approximate cost (FR-026)
- [ ] T016 [US1] Implement `--stop` in `plugins/gemma/scripts/gemma-client.mjs` to terminate both server and watchdog and clear runtime state (FR-005)
- [ ] T017 [US1] Replace every raw failure path in `plugins/gemma/scripts/gemma-client.mjs` with a message naming the missing prerequisite or diagnostic command (Principle III)
- [ ] T018 [US1] Create `plugins/gemma/commands/ask.md` sending a prompt and reporting the response (FR-001), delegating the honesty policy to the `gemma-usage` skill by reference and never restating it inline (FR-009)
- [ ] T019 [US1] Create `plugins/gemma/commands/stop.md` for manual lifecycle control
- [ ] T020 [US1] Verify Scenario 1 of `quickstart.md` end-to-end and confirm SC-001

**Checkpoint**: US1 is independently shippable. This is the MVP.

---

## Phase 4: User Story 2 — Repair a silently-CPU model (P1)

**Goal**: Diagnose and repair models that would silently serve on the fallback processor.

**Independent test**: Diagnose a slow-path model, dry-run, apply in place, confirm the accelerator is reported and responses are measurably faster with correct output.

- [ ] T021 [US2] Reconcile the `resolve` subcommand in `plugins/gemma/tools/litertlm_backend.py` to list every model with its resolved backend and flag `cpu` results (FR-011)
- [ ] T022 [P] [US2] Reconcile the `show` subcommand in `plugins/gemma/tools/litertlm_backend.py` to dump section metadata with long-value truncation (FR-012)
- [ ] T023 [US2] Reconcile round-trip validation in `plugins/gemma/tools/litertlm_backend.py` — content-compare unpack/repack and abort without writing if lossy (FR-014)
- [ ] T024 [US2] Reconcile the bounds check in `plugins/gemma/tools/litertlm_backend.py` against `BLOCK_SIZE - 32`, aborting rather than overrunning into the payload (FR-015)
- [ ] T025 [US2] Reconcile the `check` dry-run subcommand so it performs all validation and writes nothing (FR-016)
- [ ] T026 [US2] Reconcile idempotency in `plugins/gemma/tools/litertlm_backend.py` so an already-correct file reports no change and performs no write (FR-017)
- [ ] T027 [US2] Make reversal first-class in `plugins/gemma/tools/litertlm_backend.py` — `--backend cpu` restores the prior declaration, documented alongside `patch` rather than as a side effect (FR-018)
- [ ] T028 [US2] Add the `--yes` flag to `patch` in `plugins/gemma/tools/litertlm_backend.py`, required for non-interactive invocation by another command (FR-019, `contracts/litertlm-backend-cli.md`)
- [ ] T029 [US2] Implement the core write in `plugins/gemma/tools/litertlm_backend.py` — add or correct `backend_constraint` on the main section only, touching no bytes at or beyond the first block boundary, with the header and the `header_end` value at offset 24 both flushed and fsynced before exit (FR-013, `contracts/litertlm-backend-cli.md` §6–§7)
- [ ] T030 [US2] Verify Scenario 3 of `quickstart.md` on a real model — baseline payload checksum, dry run, patch, re-checksum, re-patch idempotency, reverse, re-checksum — confirming SC-004, SC-005 and SC-011
- [ ] T031 [US2] Measure and record the repaired-vs-fallback speedup on a warm server to confirm SC-002, stating model, hardware and conditions (constitution Additional Constraints)

**Checkpoint**: the CPU-fallback trap is both visible and fixable, safely and reversibly.

---

## Phase 5: User Story 3 — Confirm the stack is ready (P2)

**Goal**: One command checks every prerequisite in order and names the single next action.

**Independent test**: On a machine missing a prerequisite, the check identifies the specific gap and its fix.

- [ ] T032 [US3] Reconcile `--check` in `plugins/gemma/scripts/gemma-client.mjs` to report readiness without starting anything
- [ ] T033 [US3] Create `plugins/gemma/commands/setup.md` checking, in order: runtime installed → model imported → no model silently on the slow path → server reachable, reporting the first unmet condition with its corrective action (FR-020)
- [ ] T034 [US3] Add the confirmation-gated repair flow to `plugins/gemma/commands/setup.md` — report the finding, ask once, invoke `patch --yes` only on explicit consent, and leave the system unchanged and usable if declined (FR-019, SC-013)
- [ ] T035 [US3] Add accelerator-memory reporting to `plugins/gemma/commands/setup.md`, warning on thin margins and stating that a benchmark pass does not prove usability (FR-021, research R7)
- [ ] T036 [US3] Document per-repository model gating in `plugins/gemma/commands/setup.md` — Gemma 3 gated, Gemma 4 not, `litert-community` conversions distinct from vendor repositories — with a command to check rather than assume (FR-022, research R6)
- [ ] T037 [US3] Verify Scenario 4 of `quickstart.md`, including declining the repair offer and confirming via payload checksum that nothing was written (SC-013)

**Checkpoint**: a first-time user can reach a working answer from the readiness command alone.

---

## Phase 6: User Story 4 — See what each model will do (P2)

**Goal**: Make the invisible backend property inspectable during ongoing use.

**Independent test**: With two models differing in configured path, one command reports both sizes and both paths.

- [ ] T038 [US4] Create `plugins/gemma/commands/models.md` pairing `litert-lm list` with `litertlm_backend.py resolve` and explaining why the second is the one that matters
- [ ] T039 [US4] Document single-model residency and reload cost in `plugins/gemma/commands/models.md`, warning against interleaving models in a loop (data-model.md, Serving Process invariant)
- [ ] T040 [US4] Document the disk-cost multiplier in `plugins/gemma/commands/models.md` — per-backend compiled caches roughly double on-disk size — and that `litert-lm delete` removes model and caches together
- [ ] T041 [US4] Point `cpu`-resolving models at the repair procedure from `plugins/gemma/commands/models.md`
- [ ] T042 [US4] Verify Scenario 2 of `quickstart.md` and confirm SC-003

---

## Phase 7: User Story 6 — Install from the author's repository (P2)

**Goal**: Anyone with the URL can install, and cannot mistake the project for official.

**Independent test**: From a machine with no prior knowledge, follow only the README to register the source and install.

- [ ] T043 [US6] Write `README.md` with the unofficial, unaffiliated disclaimer **above the fold**, before any instruction to run something (FR-028, SC-008)
- [ ] T044 [US6] Document install and update in `README.md` — `/plugin marketplace add` then `/plugin install gemma@gemma-local` — noting that `/plugin` needs an interactive terminal session
- [ ] T045 [US6] Document prerequisites and the honest capability boundary in `README.md`, including what the plugin deliberately does not do and why (FR-034)
- [ ] T046 [US6] Document the measured performance figures in `README.md` with model, hardware and conditions stated, and never presenting a cold-start figure as steady-state (constitution Additional Constraints)
- [ ] T047 [US6] Verify Scenario 0 of `quickstart.md` on a clean install and confirm SC-008 by reading order

---

## Phase 8: User Story 5 — Offline diff review (P3)

**Goal**: A free, offline smoke pass over a diff, reported with the observations screened.

**Independent test**: On a diff with one real defect and one merely suspicious passage, the assistant verifies each observation and names those that did not hold up.

- [ ] T048 [US5] Create `plugins/gemma/commands/review.md` piping `git diff` into the client with a reviewer system instruction (FR-007)
- [ ] T049 [US5] Add the screening protocol to `plugins/gemma/commands/review.md` — verify each observation against the actual code, report survivors, state plainly which failed, name the two expected failure modes (false positives, plausible filler)
- [ ] T050 [US5] Handle the empty-diff case in `plugins/gemma/commands/review.md` so it reports nothing to review rather than inviting invented findings
- [ ] T051 [US5] Verify Scenario 7 of `quickstart.md`, confirming an uncritical relay is treated as a failure of the scenario

---

## Phase 9: User Story 7 — Get accelerator memory back when idle (P2)

**Goal**: Accelerator memory is released automatically when the model goes unused, and the next question still works.

**Independent test**: Ask a question, observe memory rise, wait past the idle period with no activity, confirm memory returns to baseline with no user action, then ask again and confirm it answers.

Ordered after US1 because idle behaviour is unverifiable before invocation works.

- [ ] T052 [US7] Create `plugins/gemma/scripts/idle-watchdog.mjs` implementing the poll loop of `contracts/runtime-state.md` — exit if disabled or unreachable, skip while `in-flight > 0`, honour the idle timeout (FR-023)
- [ ] T053 [US7] Write the `stopping` marker before terminating the server in `plugins/gemma/scripts/idle-watchdog.mjs`, and clear it with `server.pid` after exit
- [ ] T054 [US7] Implement the single-supervisor rule in `plugins/gemma/scripts/idle-watchdog.mjs` — exit rather than compete with a watchdog already supervising this port
- [ ] T055 [US7] Implement the stale-activity backstop in `plugins/gemma/scripts/idle-watchdog.mjs` so a crashed client cannot pin accelerator memory indefinitely via a leaked `in-flight` (US7 acceptance scenario 4)
- [ ] T056 [US7] Add activity accounting to `plugins/gemma/scripts/gemma-client.mjs` — `last-activity` before and after, `in-flight` incremented before and decremented on **every** exit path including error and interrupt (FR-024)
- [ ] T057 [US7] Add the `stopping` interlock to `plugins/gemma/scripts/gemma-client.mjs` — wait for exit and start fresh rather than connecting to a dying server (FR-025)
- [ ] T058 [US7] Add restart-reason reporting to `plugins/gemma/scripts/gemma-client.mjs` so a watchdog restart is distinguishable from a first-ever start (FR-025)
- [ ] T059 [US7] Start the watchdog from `plugins/gemma/scripts/gemma-client.mjs` only when starting a server and only if none is supervising
- [ ] T060 [US7] Verify Scenario 5 of `quickstart.md` — confirm accelerator memory returns to baseline (SC-012) and, separately, that a generation longer than the idle timeout completes uninterrupted (FR-024)
- [ ] T061 [US7] Verify Scenario 6 of `quickstart.md` for the model-switch warning (FR-026)
- [ ] T069 [US7] Verify the disabled case — `--idle-timeout 0` keeps the server running past the period (US7 acceptance scenario 5)

**Checkpoint**: accelerator memory is reclaimed automatically without ever truncating work.

---

## Phase 10: Polish & Cross-Cutting

- [ ] T062 [P] Audit all five command files for Principle I compliance — every output-relaying command references the shared skill; none restates the policy inline (SC-007, FR-009)
- [ ] T063 [P] Audit both tools for hardcoded absolute paths or platform-specific separators (FR-031)
- [ ] T064 Verify Scenario 8 of `quickstart.md` on both Windows and a Unix-family environment, confirming SC-009 and SC-010
- [ ] T065 Verify `LITERT_LM_SITE_PACKAGES` override works and that an absent runtime yields an actionable message rather than `ImportError` (FR-032)
- [ ] T066 [P] Confirm a clean checkout runs both tools with no install or dependency-resolution step (FR-033, SC-010, Principle III)
- [ ] T067 Re-run the full Constitution Check from plan.md against the built artifacts and record the result
- [ ] T068 Record the `litert-lm` version every documented behaviour was observed against, and note which workarounds a future release is expected to retire (constitution Additional Constraints)
- [ ] T070 **Verify no egress** — capture network destinations for a full request cycle and assert the only one contacted is the configured local host and port; confirm no credential is requested and no per-request cost is incurred (FR-006, Principle II)
- [ ] T071 **Verify the first-run journey** — from an environment missing every prerequisite, reach a working first answer using only `/gemma:setup` output, with no external research, and record where the guidance was insufficient (SC-006)

---

## Dependencies

```
Phase 1 (Setup)
   └─> Phase 2 (Foundational) ─────────────────────────┐
          ├─> Phase 3 (US1, P1) ── MVP ────────────────┤
          │      └─> Phase 9 (US7, P2)                 │
          ├─> Phase 4 (US2, P1) ───────────────────────┤
          │      └─> Phase 5 (US3, P2)  [needs patch --yes from T028]
          │      └─> Phase 6 (US4, P2)  [needs resolve from T021]
          ├─> Phase 7 (US6, P2)                        │
          └─> Phase 8 (US5, P3)  [needs client from Phase 3]
                                                        └─> Phase 10 (Polish)
```

**Genuine cross-story dependencies** (everything else is independent):

- **US3 depends on US2** — the confirmation-gated repair (T034) needs `patch --yes` (T028).
- **US4 depends on US2** — the models view (T038) needs `resolve` (T021).
- **US5 depends on US1** — review pipes through the client.
- **US7 depends on US1** — idle behaviour is unverifiable before invocation works.
- **US6 depends on nothing functionally**, but T046 needs figures produced by T031.
- **T071 depends on US3** — the first-run journey is verified through `/gemma:setup` (T033–T036).

## Parallel Opportunities

- **Phase 1**: T002–T005 are independent files → fully parallel after T001.
- **Phase 2**: T009 and T010 touch the same file → sequential. T007 and T008 are independent → parallel.
- **US1 vs US2**: different files (`gemma-client.mjs` vs `litertlm_backend.py`) → the two P1 stories can proceed in parallel by two workers.
- **US6 (README)**: parallel with all implementation except T046.
- **Phase 10**: T062, T063, T066 are independent audits → parallel.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** That yields a working offline ask command. It will
be slow on an unrepaired model, which is honest but unimpressive.

**Recommended first increment = MVP + Phase 4 (US2).** US2 is what makes the tool worth using —
without it the headline benefit is silently lost. Both are P1 for this reason, and they are
parallelisable across two workers.

**Then**: Phase 9 (reclaims memory, the most user-visible remaining annoyance) → Phase 5/6
(discoverability) → Phase 7 (distribution) → Phase 8 (the weakest story) → Phase 10.

**Do not defer Phase 10's audits.** T062 in particular guards a NON-NEGOTIABLE principle, and
inline-policy drift is exactly the kind of defect that accumulates quietly while other work
proceeds.

---

## Summary

| Phase | Story | Tasks | Count |
|---|---|---|---|
| 1 | Setup | T001–T006 | 6 |
| 2 | Foundational | T007–T010 | 4 |
| 3 | US1 (P1) | T011–T020 | 10 |
| 4 | US2 (P1) | T021–T031 | 11 |
| 5 | US3 (P2) | T032–T037 | 6 |
| 6 | US4 (P2) | T038–T042 | 5 |
| 7 | US6 (P2) | T043–T047 | 5 |
| 8 | US5 (P3) | T048–T051 | 4 |
| 9 | US7 (P2) | T052–T061, T069 | 11 |
| 10 | Polish & verification | T062–T068, T070, T071 | 9 |
| | **Total** | | **71** |

**Post-analysis additions** (from the `/speckit-analyze` findings, all remediated):

| Task | Closes | Was |
|---|---|---|
| T069 | US7 acceptance scenario 5 | idle-disabled case untested |
| T070 | **C1** — FR-006, Principle II | no-egress claim had zero verifying tasks |
| T071 | **C2** — SC-006 | first-run journey had zero verifying tasks |
| T011, T018, T029, T066 | **T1** | implemented but cited no requirement ID |
| Phase 9 → US7 | **U1** | 10 tasks owned by no user story, so no independent-test criterion |
