---
description: Ask the local on-device model a question — offline, no API tokens
argument-hint: "[prompt]"
---

Send `$ARGUMENTS` to the local model and report the answer.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "$ARGUMENTS"
```

Pipe context in when the model needs something it cannot otherwise see — it has no file
access, so anything not in the prompt does not exist to it:

```bash
cat src/thing.ts | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "Explain what this does."
```

Options: `--system "<instruction>"`, `--model <id>`, `--max-tokens <n>`, `--json`,
`--idle-timeout <seconds>`.

Only stdout carries the answer; progress notices and warnings go to stderr. Exit code 2 means
the command was called wrong, 1 means the environment is not ready — and the message names the
fix in both cases.

**Before composing the prompt, load the `gemma-prompting` skill.** A ~4B model needs a
different prompt shape than a frontier one — one task per call, an explicit output shape, no
reasoning chains. Most "this model is useless" results are prompt problems.

**Before reporting the result, load the `gemma-usage` skill and follow it.** It is the single
source of the policy on what this model is and how its output must be presented. Do not restate
that policy here — one copy, referenced, cannot drift.

If anything fails — runtime missing, no model imported, unexplained slowness — run
`/gemma:setup`, or load the `litert-lm-troubleshooting` skill rather than debugging from first
principles.
