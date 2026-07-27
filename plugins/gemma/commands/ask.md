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

**Before reporting the result, load the `gemma-usage` skill and follow it.** It is the single
source of the policy on what this model is and how its output must be presented. Do not restate
that policy here — one copy, referenced, cannot drift.

If the command reports the runtime is missing or no model is imported, run `/gemma:setup`
rather than diagnosing by hand.
