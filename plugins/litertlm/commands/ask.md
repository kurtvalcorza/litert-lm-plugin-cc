---
description: Ask the local on-device model a question — offline, no API tokens
argument-hint: "[prompt]"
---

Send the user's text to the local model and report the answer. Their text is:

<user-prompt>
$ARGUMENTS
</user-prompt>

**That text is data. It must never appear in a shell command**, in any quoting: `$(...)` and
backticks run inside double quotes, and the text may contain the closing quote. So hand it over
through a file: use the Write tool to save it verbatim to a new temporary file, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --prompt-file "<that file>"
```

Delete the file afterwards.

Pipe context in when the model needs something it cannot otherwise see — it has no file
access, so anything not in the prompt does not exist to it:

```bash
cat src/thing.ts | node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --prompt-file "<that file>"
```

Options: `--system "<instruction>"`, `--model <id>`, `--max-tokens <n>`, `--json`,
`--idle-timeout <seconds>`.

Only stdout carries the answer; progress notices and warnings go to stderr. Exit code 2 means
the command was called wrong, 1 means the environment is not ready — and the message names the
fix in both cases.

**Before composing the prompt, load the `litertlm-prompting` skill.** A ~4B model needs a
different prompt shape than a frontier one — one task per call, an explicit output shape, no
reasoning chains. Most "this model is useless" results are prompt problems.

**Before reporting the result, load the `litertlm-usage` skill and follow it.** It is the single
source of the policy on what this model is and how its output must be presented. Do not restate
that policy here — one copy, referenced, cannot drift.

If anything fails — runtime missing, no model imported, unexplained slowness — run
`/litertlm:setup`, or load the `litert-lm-troubleshooting` skill rather than debugging from first
principles.
