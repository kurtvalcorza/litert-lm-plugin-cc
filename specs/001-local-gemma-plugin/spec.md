# Feature Specification: Local Gemma Plugin for Claude Code

**Feature Branch**: `001-local-gemma-plugin`

**Created**: 2026-07-27

**Status**: Draft

**Input**: User description: "An unofficial Claude Code plugin, distributed from its own GitHub repo acting as a self-hosted marketplace, that lets a user call a local on-device Gemma model (via LiteRT-LM's OpenAI-compatible server) without API cost or network access. It must also ship a tool that repairs the CPU-fallback trap: models whose .litertlm metadata omits backend_constraint silently serve on CPU, and `litert-lm serve` has no --backend flag to override it. Scope: an ask command, a diff-review command with honesty guardrails, a setup/readiness command, a models command showing resolved backends, a shared usage-policy skill, and the metadata patch tool. Explicitly out of scope: background job lifecycle (status/cancel/result), session transfer, and an agentic tool-execution loop."

## Clarifications

### Session 2026-07-27

- Q: Should the readiness command repair a slow-path model automatically, or only diagnose it? → A: Auto-repair with confirmation — detect, explain, ask once, then repair.
- Q: Should repair write to a copy of the model or modify the original in place? → A: In place, no copy.
- Q: The serving process holds accelerator memory until stopped. What lifecycle policy? → A: Idle timeout auto-shutdown.
- Q: What happens when a request names a different model than the one loaded? → A: Warn that it forces a full reload, then proceed.

**Governance note**: the in-place decision conflicted with a constitution requirement to
operate on a copy. Rather than ignore it, Principle IV was amended (v1.0.0 → v2.0.0) to
require *reversibility* instead of *duplication*. See FR-018.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask the local model a question (Priority: P1)

A developer working in Claude Code wants a quick answer — an explanation of a regex, a
rephrasing, a summary of pasted text — without spending API tokens or sending the content
anywhere. They invoke a single command with their question and get an answer back in the
conversation, with the assistant clearly framing it as a small local model's opinion rather
than a verified fact.

**Why this priority**: This is the entire point of the feature. Every other story either
supports this one or verifies it is working. Shipping only this story yields a usable tool.

**Independent Test**: With the runtime installed and one model imported, invoke the ask
command with a factual question and confirm an answer returns, that no network request to
a hosted provider occurs, and that the assistant's framing does not assert the answer as
authoritative.

**Acceptance Scenarios**:

1. **Given** the local runtime is installed and a model is imported, **When** the user asks
   a question, **Then** an answer is returned and presented as a local-model opinion.
2. **Given** no local server is currently running, **When** the user asks a question,
   **Then** the server is started automatically and the answer still returns without the
   user taking a separate action.
3. **Given** a server is already running, **When** the user asks a second question,
   **Then** the existing server is reused rather than a second one started.
4. **Given** the user pipes file or command output alongside their question, **When** the
   command runs, **Then** the piped content is included as context for the answer.
5. **Given** the runtime is not installed, **When** the user asks a question, **Then** the
   failure names the missing prerequisite and the action that fixes it, rather than
   surfacing a raw error trace.

---

### User Story 2 - Repair a model that silently serves on CPU (Priority: P1)

A user has imported a model and it works, but responses are several times slower than the
hardware should allow. Nothing reports a problem. They run a tool that inspects each model,
identifies which will serve on the slow path, and repairs the affected model's own
configuration so it uses the accelerator — without re-downloading gigabytes and without
risking the model file.

**Why this priority**: Without this, the headline benefit of Story 1 is quietly lost on
affected models, and the user has no way to discover why. The serving component provides no
override, so repairing the model file is the only available remedy.

**Independent Test**: Take a model known to resolve to the slow path, run the inspection to
confirm the diagnosis, run the dry run, apply the repair in place, and confirm the model
now reports the accelerator and produces measurably faster responses while still generating
correct output.

**Acceptance Scenarios**:

1. **Given** a set of imported models, **When** the user runs the inspection, **Then** each
   model is listed with the processing path it will actually use, and slow-path models are
   visibly flagged.
2. **Given** a model that would serve on the slow path, **When** the user runs the dry run,
   **Then** the tool reports what it would change and writes nothing.
3. **Given** a validated repair, **When** the user applies it, **Then** only the model's
   small configuration region is rewritten and the large payload is left byte-identical.
4. **Given** a repair has already been applied, **When** the user runs it again, **Then**
   the tool reports there is nothing to do and performs no write.
5. **Given** a file whose configuration cannot be safely reproduced, **When** the user
   attempts a repair, **Then** the tool aborts and writes nothing.
6. **Given** a repaired model, **When** it is served, **Then** it reports the accelerator
   without the user passing any additional option.

---

### User Story 3 - Confirm the local stack is ready (Priority: P2)

A user setting this up for the first time, or returning to a machine after a while, wants a
single command that checks every prerequisite in order and tells them the one thing to do
next rather than making them diagnose a chain of failures.

**Why this priority**: Reduces first-run abandonment and prevents misattributing a setup gap
to a broken feature. Valuable, but the feature is usable without it once set up.

**Independent Test**: On a machine missing a prerequisite, run the readiness check and
confirm it identifies the specific gap and names the corrective action.

**Acceptance Scenarios**:

1. **Given** the runtime is absent, **When** the check runs, **Then** it reports the runtime
   as the blocking gap and gives the install action.
2. **Given** the runtime is present but no model is imported, **When** the check runs,
   **Then** it reports the missing model and gives an import action for a model that
   requires no licence acceptance.
3. **Given** everything is installed, **When** the check runs, **Then** it confirms
   readiness and reports which models would serve on the slow path.
4. **Given** available accelerator memory is below what the configured model needs, **When**
   the check runs, **Then** it warns that the model may pass a benchmark yet still fail in
   real use, and names the mitigation.

---

### User Story 4 - See what each model will actually do (Priority: P2)

A user with several imported models wants to know which one to use: how large each is, and
critically, which processing path each will take, since that is not visible in the runtime's
own listing.

**Why this priority**: Turns an invisible performance trap into an inspectable property.
Overlaps with Story 3 but serves ongoing use rather than first-run setup.

**Independent Test**: With at least two models imported that differ in configured path, run
the command and confirm both the sizes and the differing paths are reported.

**Acceptance Scenarios**:

1. **Given** several imported models, **When** the user lists them, **Then** each model's
   size and resolved processing path are shown together.
2. **Given** a specific model, **When** the user inspects it, **Then** its full stored
   configuration is displayed.
3. **Given** a model resolving to the slow path, **When** it is listed, **Then** the output
   points to the repair procedure.

---

### User Story 5 - Get an offline second opinion on a diff (Priority: P3)

A developer with uncommitted changes wants a free, offline sanity pass before asking for a
real review. They run one command, the local model reads the diff, and the assistant reports
only the observations that survive verification against the actual code.

**Why this priority**: Genuinely useful when offline or cost-conscious, but the weakest
story — a small model reviewing a context-free diff produces both false positives and
generic filler, so its output needs the most screening.

**Independent Test**: On a diff containing one real defect and one passage that merely looks
suspicious, run the command and confirm the assistant verifies each observation before
reporting, and explicitly states which did not hold up.

**Acceptance Scenarios**:

1. **Given** uncommitted changes, **When** the user requests a review, **Then** the diff is
   sent and observations are returned.
2. **Given** returned observations, **When** the assistant reports them, **Then** each has
   been checked against the actual code and unsupported ones are named as such.
3. **Given** no changes, **When** the user requests a review, **Then** the command reports
   there is nothing to review rather than inventing findings.
4. **Given** any review result, **When** it is reported, **Then** it is framed as a smoke
   pass and a stronger review is recommended for changes that matter.

---

### User Story 6 - Install the plugin from the author's own repository (Priority: P2)

A user who has been given the repository URL wants to install the plugin without it being
listed in any vendor-operated catalogue, and to be left in no doubt that it is unofficial.

**Why this priority**: Distribution is a prerequisite for anyone other than the author using
the feature, but the feature can be developed and used locally before it is solved.

**Independent Test**: From a machine with no prior knowledge of the project, follow only the
README to register the source and install the plugin, and confirm the commands appear.

**Acceptance Scenarios**:

1. **Given** only the repository URL, **When** the user follows the documented install
   steps, **Then** the plugin installs and its commands become available.
2. **Given** a user reading any entry point, **When** they encounter the project, **Then**
   its unofficial, unaffiliated status is stated before any usage instruction.
3. **Given** an installed plugin, **When** the upstream repository publishes an update,
   **Then** the user can update through the same mechanism they installed with.

---

### User Story 7 - Get accelerator memory back when idle (Priority: P2)

A user asks a question, gets an answer, and moves on to something else. The model is holding
several gigabytes of accelerator memory that they now want back for a game, a training run, or
another tool — without having to remember to run a teardown command. The memory is released on
its own, and the next question still works without any extra step.

**Why this priority**: On a machine with constrained accelerator memory, a server silently
holding several GB after a single question is the most user-visible annoyance in the whole
feature. Not P1 only because the feature is functional without it — just inconsiderate.

**Independent Test**: Ask a question, observe accelerator memory rise, wait past the configured
idle period without further activity, and confirm memory returns to baseline with no user
action. Then ask again and confirm it answers.

**Acceptance Scenarios**:

1. **Given** a server is running and no request has been made for longer than the idle period,
   **When** the period elapses, **Then** the server stops and accelerator memory is released
   without the user running anything.
2. **Given** a request is still generating, **When** the idle period elapses mid-generation,
   **Then** shutdown is deferred and the response completes uninterrupted.
3. **Given** the server was stopped by the idle timer, **When** the user asks another question,
   **Then** it is answered without a separate action, and the user is told why it was slower.
4. **Given** a client crashed while a request was in flight, **When** enough time passes,
   **Then** the server still shuts down rather than holding memory indefinitely.
5. **Given** the user sets the idle period to disabled, **When** time passes with no activity,
   **Then** the server keeps running.

---

### Edge Cases

- The local server is unreachable, or fails to start within a bounded wait: the user gets a
  message naming the likely cause and a diagnostic action, not a hang or a stack trace.
- A request names a model that is not imported: the failure identifies the unknown model and
  lists what is available.
- A request names a different model than the one currently loaded: the user is warned that
  serving is single-model and that switching forces a full reload, then the switch proceeds.
- The idle timer expires while a request is still being processed: shutdown is deferred until
  the request completes; a long generation is never truncated by the timer.
- A request arrives in the window between the idle timer firing and the process exiting: the
  request must either be served or trigger a clean restart, never fail with a connection error.
- The user declines the readiness command's repair offer: nothing is written, and the system
  remains usable on the slow path rather than being left in a half-configured state.
- The user wants the original processing-path behaviour back after an in-place repair: the
  repair tool can reverse the declaration, and re-importing the model is a full fallback.
- A model's payload approaches available accelerator memory: it may pass a synthetic
  benchmark yet fail in real use, because the benchmark does not exercise every component.
  The mitigation is reducing the context allowance — which is unavailable when serving, so
  such a model cannot be served at all and this must be stated rather than discovered.
- Model repair is attempted on a file whose configuration region has no spare room: the tool
  aborts rather than overrunning into the payload.
- Model repair is interrupted mid-write: the user is told how to detect and recover the
  affected file.
- The user asks a question requiring repository knowledge: the response must not imply the
  model consulted files it cannot read.
- The upstream runtime gains a native way to select the processing path: the repair tool
  becomes unnecessary and must not silently keep modifying files without cause.

## Requirements *(mandatory)*

### Functional Requirements

**Invocation and inference**

- **FR-001**: Users MUST be able to send a prompt to a locally running model and receive its
  response, from within their assistant session, in a single command.
- **FR-002**: The system MUST start the local serving process automatically when it is not
  already running, and MUST reuse an already-running one.
- **FR-003**: Users MUST be able to supply additional context by piping file or command
  output into the request.
- **FR-004**: Users MUST be able to override, per invocation, which model is used, the
  response length limit, and any system-level instruction.
- **FR-005**: The system MUST provide a way to shut the serving process down and release
  accelerator memory.
- **FR-006**: The system MUST NOT transmit prompts, file contents, or diffs to any remote
  inference service, and MUST NOT require credentials or incur per-request cost.

**Honesty guardrails**

- **FR-007**: Every command that relays model output MUST instruct the assistant to verify
  claims against the underlying source before repeating them, and to state which claims did
  not survive verification.
- **FR-008**: The system MUST describe the model's actual capability boundary — no file
  access, no command execution, no repository awareness, no iteration — wherever a user
  might otherwise assume more.
- **FR-009**: The shared usage policy MUST live in one place that individual commands
  reference, so the guidance cannot drift between commands.
- **FR-010**: Where a stronger tool is more appropriate, commands MUST say so rather than
  implying parity.

**Diagnosis and repair**

- **FR-011**: The system MUST report, for every imported model, which processing path it
  will actually use when served.
- **FR-012**: The system MUST allow inspection of a single model's full stored configuration.
- **FR-013**: The system MUST be able to add or correct a model's processing-path declaration
  by modifying only that model's own configuration region, leaving the payload untouched.
- **FR-014**: Any modification MUST be preceded by a validation that reproduces the existing
  configuration exactly, and MUST abort without writing if that validation fails.
- **FR-015**: Any modification MUST be bounds-checked against the file's layout and MUST
  abort rather than overrun into the payload.
- **FR-016**: A dry-run mode MUST perform all validation and write nothing, and documentation
  MUST present it before the mutating operation.
- **FR-017**: Repair MUST be idempotent — re-running against an already-correct file reports
  no change and performs no write.
- **FR-018**: Repair MUST modify the model in place, and MUST be reversible: the same tool
  MUST be able to restore the previous processing-path declaration. Documentation MUST state
  both the reversal command and that re-importing the model is a full fallback. Operating on
  a copy MUST remain available but MUST NOT be required.
- **FR-019**: The readiness command MAY perform a repair, but only after reporting what it
  found and obtaining explicit confirmation for that specific action. It MUST NOT modify any
  model file without a confirmation in the same invocation, and declining MUST leave the
  system unchanged and still usable.

**Readiness**

- **FR-020**: The system MUST verify, in order, that the runtime is installed, a model is
  imported, no model is silently on the slow path, and the server is reachable — reporting
  the first unmet condition and its corrective action.
- **FR-021**: The readiness check MUST report available accelerator memory against the
  configured model's needs and warn when the margin is insufficient.
- **FR-022**: Documentation MUST state which model sources require licence acceptance and
  which do not, and MUST NOT assume this is uniform across a vendor's model families.

**Serving lifecycle**

- **FR-023**: The serving process MUST shut itself down after a bounded idle period, releasing
  accelerator memory without user action. The idle period MUST be configurable and its default
  MUST be documented.
- **FR-024**: Idle shutdown MUST NOT interrupt an in-flight request, and MUST NOT occur while
  a request is being processed.
- **FR-025**: After an idle shutdown, the next request MUST transparently restart the server;
  the user MUST NOT have to take a separate action, though they MUST be told why the request
  is slower.
- **FR-026**: When a request names a model other than the one currently loaded, the system
  MUST warn that this forces a full reload and state the approximate cost, then proceed.

**Distribution**

- **FR-027**: The repository MUST be installable as its own distribution source, without
  requiring a listing in any vendor-operated catalogue.
- **FR-028**: Every entry point MUST state the project's unofficial, unaffiliated status
  before usage instructions.
- **FR-029**: Project metadata MUST identify the individual author rather than any vendor.
- **FR-030**: Upstream projects MUST be credited by name and licence.

**Portability**

- **FR-031**: All commands and tools MUST work on Windows, WSL, Linux, and macOS.
- **FR-032**: Locating an installed dependency MUST try documented per-platform candidates
  and MUST accept an environment-variable override.
- **FR-033**: Tools MUST run from a clean checkout with no install step and no third-party
  dependency resolution.

**Out of scope**

- **FR-034**: The system MUST NOT implement background job lifecycle management, session
  transfer into another agent, or an autonomous tool-execution loop. These depend on a
  persistent agent runtime that the local serving component does not provide.

### Key Entities

- **Model**: A locally stored model file, identified by a user-assigned id. Carries a size,
  an embedded configuration region, and a declared processing path that may be absent.
- **Processing path declaration**: The stored property determining whether a model serves on
  the accelerator or the fallback processor. When absent, the fallback is chosen silently.
- **Serving process**: A local, single-model process exposing an inference interface. Holds
  one model at a time; naming another causes a reload.
- **Usage policy**: The single shared statement of what the model is, what it cannot do, and
  how its output must be presented.
- **Distribution source**: The repository, acting as its own installable catalogue entry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with the runtime installed and a model imported can get an answer from
  a single command without any prior configuration step.
- **SC-002**: On hardware with a capable accelerator, a repaired model answers a short
  request at least 3x faster than the same model on the fallback processor, measured on a
  warm server.
- **SC-003**: A user can determine which of their models would serve on the slow path in one
  command, without reading any file by hand.
- **SC-004**: Repairing a model completes in under 5 seconds and re-downloads nothing,
  regardless of model size.
- **SC-005**: Across repeated repairs on a correct file, the file's payload remains
  byte-identical and no additional write occurs.
- **SC-006**: A first-time user on a machine missing every prerequisite reaches a working
  first answer using only the readiness command's guidance, with no external research.
- **SC-007**: Every command that relays model output carries verification guidance; a review
  of all such commands finds no exception.
- **SC-008**: A reader encountering any entry point learns the project is unofficial before
  any instruction telling them to run something.
- **SC-009**: All commands and tools execute successfully on at least one Windows and one
  Unix-family environment.
- **SC-010**: A clean checkout runs every tool with no install or dependency-resolution step.
- **SC-011**: An in-place repair is fully reversible: reversing it and re-inspecting reports
  the original processing path, and the model's payload is byte-identical to before.
- **SC-012**: Accelerator memory returns to its pre-session baseline within the configured
  idle period after the last request, without the user running anything.
- **SC-013**: No model file is written by the readiness command without a confirmation given
  in that same invocation.

## Assumptions

- The user installs and manages the underlying runtime themselves; this project wraps it and
  does not vendor, bundle, or install it.
- The user has already obtained at least one model, or will follow the documented import
  step. Model acquisition requires network access; nothing else does.
- A capable accelerator is desirable but not required — the feature remains functional, just
  slower, without one.
- The serving component's lack of a processing-path override is treated as a current-version
  limitation rather than permanent. If upstream adds native selection or per-model
  configuration, the repair tool becomes a compatibility shim for older versions.
- Correcting a processing-path declaration does not alter model weights or outputs; it
  changes only where computation runs. Output equivalence is verified by observation, not
  assumed.
- The default model is a matter of documentation rather than a hard dependency; the system is
  model-agnostic and any imported model may be named.
- Users invoke this through an assistant session rather than as a standalone product, so the
  honesty guardrails are addressed to the assistant relaying the output.
- The repository is the unit of distribution; there is no separate build or release artifact.

*(Both previously deferred decisions were resolved in the 2026-07-27 clarification session —
see [Clarifications](#clarifications).)*
