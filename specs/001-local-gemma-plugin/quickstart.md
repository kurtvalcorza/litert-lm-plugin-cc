# Quickstart & Validation Guide

**Feature**: 001-local-gemma-plugin | **Date**: 2026-07-27

Runnable scenarios that prove the feature works. Each maps to a user story and its success
criteria. Run them in order — later scenarios assume earlier ones passed.

## Prerequisites

- Node.js ≥18, Python ≥3.9, `git`
- The runtime: `uv tool install litert-lm` (no binary in GitHub Releases; PyPI is the channel)
- ~4 GB free disk for the default model, plus roughly as much again for compiled caches
- An accelerator is optional; without one, scenarios 2 and 3 report CPU and SC-002 is skipped

## Scenario 0 — Install from the repository (US6, SC-008)

```bash
# In Claude Code
/plugin marketplace add kurtvalcorza/gemma-plugin-cc
/plugin install gemma@gemma-local
```

**Expected**: install succeeds; `/gemma:ask`, `/gemma:review`, `/gemma:setup`, `/gemma:models`,
`/gemma:stop` appear.

**Verify SC-008**: open the README. The unofficial, unaffiliated statement appears *before* any
instruction to run something. If you reach a command first, SC-008 fails.

> `/plugin` opens an interactive dialog and is unavailable in non-interactive sessions. Run it
> from an interactive `claude` terminal.

## Scenario 1 — First answer (US1, SC-001)

```bash
litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm gemma4-e4b
node plugins/gemma/scripts/gemma-client.mjs --model gemma4-e4b "Reply with exactly: READY"
```

**Expected**: `READY` on stdout. Server-start notice on stderr, not stdout. First call pays
engine init; subsequent calls are fast.

**Verify no egress**: no credential is requested and the only network activity is the import
above. Nothing in the answer path leaves the machine.

## Scenario 2 — Diagnose the CPU-fallback trap (US2/US4, SC-003)

```bash
python plugins/gemma/tools/litertlm_backend.py resolve
```

**Expected**: every model listed with its resolved backend. A freshly imported `gemma4-e4b`
reports `cpu  <-- serves on CPU`. This is the trap: nothing else reports it.

```bash
python plugins/gemma/tools/litertlm_backend.py show ~/.litert-lm/models/gemma4-e4b/model.litertlm
```

**Expected**: the `tf_lite_prefill_decode` section has `model_type` and
`prefer_activation_type` but **no** `backend_constraint`. That absence is the whole bug.

## Scenario 3 — Repair, and prove it is safe (US2, SC-002/004/005/011)

Record a baseline first — it is the only way to verify SC-002 and SC-005 afterwards.

Every command below is shell-portable: `payload_checksum.py` expands `~` itself, because
PowerShell does not expand it inside quoted arguments. Only the timing command differs
between shells.

```bash
# Baseline payload checksum (header excluded — a repair changes the header by design)
python plugins/gemma/tools/payload_checksum.py ~/.litert-lm/models/gemma4-e4b/model.litertlm
```

Timed baseline response — pick the line for your shell:

```bash
# POSIX
time node plugins/gemma/scripts/gemma-client.mjs --model gemma4-e4b "Write exactly 120 words about edge computing."
```

```powershell
# PowerShell
Measure-Command { node plugins/gemma/scripts/gemma-client.mjs --model gemma4-e4b "Write exactly 120 words about edge computing." }
```

Dry run, then apply:

```bash
python plugins/gemma/tools/litertlm_backend.py check ~/.litert-lm/models/gemma4-e4b/model.litertlm
python plugins/gemma/tools/litertlm_backend.py patch ~/.litert-lm/models/gemma4-e4b/model.litertlm
```

**Expected from `check`**: `round-trip (no change): N -> N bytes, content identical: True`, then
the new size against the limit and `FITS`. **Nothing is written.**

**Expected from `patch`**: the same validation, then `header rewritten: end X -> Y`.

**Verify SC-004**: `patch` completes in under 5 seconds and downloads nothing.

**Verify SC-005**: re-run the payload checksum — identical to the baseline. Re-run `patch` —
reports `already gpu, nothing to do` and does not write.

> Reference observation: an unpatched `gemma4-e4b` and a patched `gemma4-e4b-gpu` both hash to
> `edcc3078160bbbac3048b68a042ae29293b8266e5ed65b713e34b6e961efb1b0` over 3,659,530,240 bytes.
> Identical payloads across a repair is exactly what this scenario is asserting.

**Verify SC-002**: `resolve` now reports `gpu`; re-time the same prompt on a warm server. Expect
at least 3x faster. (Reference: 2.6 s vs 12.9 s, ≈4.96x, on a 12 GB RTX 5070 Ti Laptop GPU.)

**Verify SC-011 (reversibility)**:

```bash
python plugins/gemma/tools/litertlm_backend.py patch ~/.litert-lm/models/gemma4-e4b/model.litertlm --backend cpu
python plugins/gemma/tools/litertlm_backend.py resolve       # back to cpu
python plugins/gemma/tools/litertlm_backend.py patch ~/.litert-lm/models/gemma4-e4b/model.litertlm
```

Checksum the payload again — still identical across all three writes.

## Scenario 3b — No egress (FR-006, Principle II)

The central promise needs an observation, not an assertion.

```bash
# POSIX — capture destinations for one full request cycle
sudo tcpdump -n -c 200 'not host 127.0.0.1' &
node plugins/gemma/scripts/gemma-client.mjs "Summarise this sentence."
```

```powershell
# PowerShell — connections owned by the client and server processes
Get-NetTCPConnection | Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1','0.0.0.0','::' } |
  Select-Object RemoteAddress, RemotePort, OwningProcess, State
```

**Expected**: no connection attributable to the client or server leaves the loopback interface.
No credential is requested at any point, and no per-request charge is incurred.

**Note**: model import (Scenario 1) *does* use the network and is the documented exception. Run
this scenario against an already-imported model so the two are not confused.

## Scenario 4 — Readiness, including the confirmation gate (US3, SC-006/013)

```bash
/gemma:setup
```

**Expected**: each prerequisite checked in order; the first unmet one named with its fix. On a
model resolving to `cpu`, the command explains the finding and **asks before repairing**.

**Verify SC-013**: decline. Nothing is written — confirm via `payload_checksum.py`. The system
remains usable on the slow path.

**Verify SC-006 (the first-run journey)**: this is the scenario's hardest assertion and needs a
genuinely unprepared environment — a fresh WSL distro or a machine without the runtime. Starting
from nothing installed, reach a working first answer using **only** what `/gemma:setup` tells
you, consulting no other documentation. Record every point where the guidance was insufficient;
each one is a defect in the readiness command, not in the tester.

**Verify FR-021**: with a model whose size approaches available accelerator memory, the check
warns that a benchmark pass does not prove usability. (Gemma 4 12B is the reference case: it
benchmarks fine but fails under `run` and `serve`, and cannot be served at all because `serve`
has no context cap.)

## Scenario 5 — Idle shutdown (SC-012, FR-023/024/025)

```bash
node plugins/gemma/scripts/gemma-client.mjs --idle-timeout 60 "Say hi."
nvidia-smi --query-gpu=memory.used --format=csv    # accelerator memory held
# wait past the timeout
nvidia-smi --query-gpu=memory.used --format=csv    # returned to baseline
```

**Verify FR-024**: issue a request that generates for longer than the idle timeout. It MUST
complete — the watchdog must not truncate it.

**Verify FR-025**: after shutdown, ask again. It answers without any separate action, and stderr
explains the restart.

## Scenario 6 — Model-switch warning (FR-026)

```bash
node plugins/gemma/scripts/gemma-client.mjs --model gemma4-e4b "One word."
node plugins/gemma/scripts/gemma-client.mjs --model qwen3-0.6b-int4 "One word."
```

**Expected**: the second call warns on stderr that it forces a full reload and states the
approximate cost, then proceeds.

## Scenario 7 — Diff review honesty (US5, SC-007)

Stage a change containing one real defect and one passage that merely looks suspicious.

```bash
/gemma:review
```

**Expected**: observations returned; the assistant verifies each against the actual code before
repeating it, and states plainly which did not hold up. **A report that relays every observation
uncritically is a failure of this scenario**, regardless of what the model said.

**Verify SC-007**: read all five command files. Every one that relays model output carries
verification guidance by referencing the shared skill. Any command restating the policy inline
is a defect (FR-009).

## Scenario 8 — Portability (SC-009/010)

From a clean checkout, on both Windows and a Unix-family environment:

```bash
node plugins/gemma/scripts/gemma-client.mjs --check
python plugins/gemma/tools/litertlm_backend.py resolve
```

**Verify SC-010**: no `npm install`, no `pip install`, no lockfile resolution — the tools run
directly from the checkout.

**Verify FR-032**: with the runtime installed somewhere non-standard, set
`LITERT_LM_SITE_PACKAGES` and confirm the tool finds it. Unset it with the runtime absent and
confirm the error names the install command rather than raising `ImportError`.

## Teardown

```bash
node plugins/gemma/scripts/gemma-client.mjs --stop
```
