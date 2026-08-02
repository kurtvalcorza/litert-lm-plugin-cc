# Feature Specification: Offline Review Launcher

**Feature Branch**: `002-offline-review-launcher`

**Created**: 2026-08-01

**Status**: Draft

**Input**: User description: "A first-class offline entry point for the local pass: a shell-agnostic launcher script, shipped in the plugin, that a user can run without Claude Code — resolving its own plugin root, validating and making explicit the diff range, failing loudly instead of feeding the model an empty prompt, guarding oversized diffs, and printing the verification obligations the slash command would otherwise carry."

## Context

`/litertlm:review` is agent-interpreted: the assistant runs the pipeline and screens the output.
That makes it unavailable in exactly the conditions that make a local pass attractive — Claude
Code offline, rate-limited, or out of quota. The underlying client needs neither an agent nor a
network, but driving it by hand puts four burdens on the user that the slash command otherwise
absorbs: locating the installed client, constructing a valid diff range, translating a Bash
example into their own shell, and noticing when a diff is too large to have been read whole.

This feature moves those four burdens into shipped code.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Get a local pass with no agent available (Priority: P1)

A developer is out of quota (or offline). They have uncommitted work they want a second set of
weights to look at before they leave it. From the repository they are working in, they run one
command in their own shell and get the model's response, framed as something they must verify
themselves.

**Why this priority**: This is the feature. Everything else either protects this path from
producing a misleading result or makes it reachable.

**Independent Test**: With the plugin installed from the marketplace and a model imported,
`cd` into an unrelated repository with uncommitted changes, run the launcher, and confirm a
response returns without Claude Code running and without any network call to a hosted provider.

**Acceptance Scenarios**:

1. **Given** the plugin is installed under the client's own cache directory and the current
   directory is a different repository, **When** the user runs the launcher, **Then** it finds
   the client without the user supplying any path.
2. **Given** the working tree has uncommitted changes, **When** the user runs the launcher with
   no range argument, **Then** it reviews the uncommitted diff and says which range it used.
3. **Given** a response is produced, **When** it is printed, **Then** it is preceded and
   followed by framing that names the model's limits and the caller's verification obligation.

---

### User Story 2 - Be told when nothing was reviewed (Priority: P1)

The user asks for a branch range against a base their repository does not have — `main` in a
repository that uses `master`, or a base that exists only on the remote. Instead of an answer
about nothing, they get an error naming the bad ref and the bases that would have worked.

**Why this priority**: An empty pass and a clean pass are indistinguishable in the output. This
is the defect that makes the hand-driven path actively dangerous rather than merely awkward, so
it ships with P1.

**Independent Test**: In a repository whose default branch is `master`, request a range against
`main`; confirm a non-zero exit, an error naming `main`, and that the model was never invoked.

**Acceptance Scenarios**:

1. **Given** a base ref that does not resolve locally, **When** the launcher runs, **Then** it
   exits non-zero, names the ref, and lists candidate bases that do resolve.
2. **Given** a base that resolves but shares no history with `HEAD`, **When** the launcher runs,
   **Then** it exits non-zero rather than sending a whole-repository diff.
3. **Given** a valid range that happens to be empty, **When** the launcher runs, **Then** it
   reports that there is nothing to review and does not invoke the model.

---

### User Story 3 - Not be told a partial read was a whole one (Priority: P2)

The user points the launcher at a large branch diff. Rather than silently sending more than the
model can attend to, the launcher refuses and tells them how to narrow it. If they choose to
proceed anyway, a coverage-unverified warning is attached to the output itself — the launcher
cannot tell a whole reply from a truncated one, so it says coverage is unchecked rather than
asserting the read was partial.

The override exists to **measure**, not to review: the guard is a single conservative number
while the real ceiling is model-dependent, and litert-lm 0.14.0 reports it nowhere, so
attempting a send is the only way a user learns their own. A reply means that request fit; a
failure means it did not. Nothing about that answer makes the pass count as coverage.

**Why this priority**: The failure is silent and the output looks identical to a complete pass,
so it cannot be left to the user to notice. It is P2 only because it needs the P1 path first.

**Independent Test**: Run against a range whose diff exceeds the size limit; confirm refusal
with the measured size, the limit, and the largest contributing paths. Re-run with the override
and confirm the warning appears alongside the response.

**Acceptance Scenarios**:

1. **Given** a diff larger than the configured limit, **When** the launcher runs, **Then** it
   refuses, reports measured size against the limit, and names the files that dominate it.
2. **Given** the same diff and an explicit override, **When** the launcher runs, **Then** the
   response is accompanied by a statement that coverage was partial and unidentifiable.

---

### User Story 4 - Know what will be sent before sending it (Priority: P3)

Before spending the first slow call, the user asks what the launcher would do: which range,
how many files, how large, whether it is within the limit.

**Why this priority**: A convenience that also makes the other three stories cheap to verify.

**Independent Test**: Run the preview mode and confirm it reports range, file count, and size,
starts no server, and produces no model output.

**Acceptance Scenarios**:

1. **Given** any valid invocation, **When** preview mode is requested, **Then** the launcher
   reports what it would send and exits without starting a server or invoking the model.

---

### Edge Cases

- **Not a repository.** The current directory has no repository. The launcher must say so and
  name what it expected, not surface a raw tool error.
- **Version control absent.** The version-control tool is not installed or not on PATH. The
  launcher must name the missing prerequisite.
- **The client is missing.** The launcher was copied somewhere without its sibling client. It
  must name the exact path it looked for.
- **Detached HEAD / no commits.** A repository with no commit at all cannot produce a range;
  the launcher must fail with that reason rather than an empty prompt.
- **Binary and generated files.** These inflate size without being reviewable text; the size
  report must reflect what is actually sent.
- **A brand-new file.** A working-tree comparison sees tracked content only, so a file the
  project does not yet track is invisible to it — frequently the most review-worthy thing
  present. Reporting "nothing to review" while one sits there, or passing over everything
  except it, both overstate coverage.
- **An option given an empty value.** A caller interpolating an unset variable supplies an
  empty string. Treating that as "not supplied" silently substitutes a different range for the
  one asked for.
- **Interruption.** The user aborts mid-call. The launcher must not leave state that keeps the
  server pinned alive.
- **A response that is empty or only a tool call.** Must be reported as such, not as a clean
  pass.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The launcher MUST resolve the location of the inference client from its own
  installed location, not from the current working directory and not from a
  repository-relative path.
- **FR-002**: If the client cannot be found, the launcher MUST fail naming the absolute path it
  expected, and MUST NOT fall back to any guessed location.
- **FR-003**: The launcher MUST run identically on Windows PowerShell, Windows cmd, and POSIX
  shells, and MUST NOT depend on shell-specific quoting or line continuation.
- **FR-004**: The launcher MUST be invocable as a single command with no line continuation.
- **FR-005**: The diff range MUST be explicit and configurable by the caller.
- **FR-006**: The default range, when the caller supplies none, MUST be the uncommitted working
  tree, matching the existing slash command.
- **FR-007**: The launcher MUST validate every ref it was given before invoking the model, and
  MUST abort with a non-zero exit if any does not resolve.
- **FR-008**: A validation failure MUST name the ref that failed and list candidate bases that
  do resolve in this repository.
- **FR-009**: The launcher MUST verify that the base and the current head share history before
  using a symmetric range, and MUST abort otherwise.
- **FR-010**: The launcher MUST NOT invoke the model with an empty or whitespace-only diff. An
  empty range MUST be reported as "nothing to review" with a distinct exit status.
- **FR-011**: Failure of the diff step MUST stop the run. It MUST NOT be possible for a failed
  diff to reach the model as empty input.
- **FR-012**: The launcher MUST measure the diff and refuse, by default, to send one larger than
  a configured size limit.
- **FR-013**: A size refusal MUST report the measured size, the limit, the number of files, and
  the paths contributing most of the size, and MUST name the ways to narrow the range.
- **FR-014**: The size limit MUST be adjustable, and an explicit override MUST exist to send an
  oversized diff anyway.
- **FR-015**: When an oversized diff is sent, the launcher MUST state — both before the response
  and again after it — that the model attended to only part of the input and that which part
  cannot be determined.
- **FR-016**: The launcher MUST print, after every response, the caller's obligation to verify
  each claim against the actual source and to disregard those that do not survive.
- **FR-017**: The launcher MUST NOT describe the model as reviewing, analysing, or understanding
  the codebase, and MUST name the stronger tool to use when the result matters.
- **FR-018**: The launcher MUST NOT make any network request other than those the existing
  client already makes to the local server. Diffs MUST NOT leave the machine.
- **FR-019**: The launcher MUST use only the language standard library, with no install step and
  no dependency manifest.
- **FR-020**: Every prerequisite failure MUST produce an actionable message naming the missing
  prerequisite, never a bare stack trace.
- **FR-021**: The launcher MUST offer a preview mode that performs all validation and size
  measurement, starts no server, and invokes no model.
- **FR-022**: Exit statuses MUST distinguish success, caller error, nothing-to-review, size
  refusal, and environment failure.
- **FR-023**: The launcher MUST allow narrowing the diff to specific paths.
- **FR-024**: The launcher MUST pass the model id, response cap, and server port through to the
  client so a machine-level default can be overridden per call.
- **FR-025**: The slash command MUST route through the same launcher, so the online and offline
  paths share one implementation of range validation and size guarding.
- **FR-026**: The README MUST document the offline invocation for both a POSIX shell and
  PowerShell, and MUST NOT claim a turnkey command does not exist once one does.
- **FR-027**: An option that selects what gets sent MUST reject an empty value rather than
  treating it as absent, and MUST say that an unset variable is the likely cause.
- **FR-028**: When the range cannot see files that are present but untracked, the launcher MUST
  say so — in the nothing-to-review message when the range is empty, and alongside the response
  when it is not — and MUST name how to include them without committing.
- **FR-029**: The documented invocations MUST fail with a named cause when the launcher cannot
  be located, and MUST NOT stall waiting for input.

### Key Entities

- **Launcher invocation**: the range (base ref or working tree), optional path filters, optional
  focus text, size limit, and override flag.
- **Diff payload**: the text actually sent, plus its measured size, file count, and per-file
  sizes.
- **Range decision**: which range was used and why — caller-supplied, or the working-tree
  default — reported so the user can tell an empty pass from a clean one.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with the plugin installed can obtain a local pass over their uncommitted
  work from any repository on the machine with one command and no path editing.
- **SC-002**: 100% of invocations naming an unresolvable base exit non-zero without producing
  model output.
- **SC-003**: 100% of invocations whose diff is empty report that fact rather than producing
  model output.
- **SC-004**: No invocation produces a response that reads as complete coverage when the input
  exceeded the size limit.
- **SC-005**: The same command text works unchanged in PowerShell and in a POSIX shell.
- **SC-006**: The launcher runs from a clean checkout with no install step.
- **SC-007**: Every response is accompanied by the verification obligation and by a pointer to a
  stronger tool.
- **SC-008**: The documented offline invocation is reproducible from a marketplace install with
  no knowledge of the plugin's version number.

## Assumptions

- The user has already installed the plugin and imported a model while online. Bootstrapping the
  stack itself remains the job of the readiness command and is out of scope here.
- A runtime for the launcher and the version-control tool are already present; the launcher
  detects and names them rather than installing them.
- ~~The size limit is a heuristic about where a small model's attention degrades, not a hard
  context boundary.~~ **Falsified 2026-08-02.** There is a hard boundary, and it is far lower
  than this assumed: `serve` runs at a fixed `max_num_tokens` and stops answering past it. The
  limit is now bisected per model rather than estimated, and the default is set below the
  measured ceiling. It stays adjustable, and is still not presented as an exact capacity —
  the boundary is on tokens, so no byte figure is exact for an arbitrary diff.
- Chunking an oversized diff into several passes is out of scope: multiple passes over a
  fragmented diff would compound the false-positive rate the honesty policy already warns about.
- The offline path has no agent to screen output. The launcher therefore states the obligation
  and cannot discharge it; a human must.
