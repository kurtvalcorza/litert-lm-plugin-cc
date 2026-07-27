---
description: Ask the local on-device Gemma model a question — offline, no API tokens
argument-hint: "[prompt]"
---

Send `$ARGUMENTS` to the local model and report the answer.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "$ARGUMENTS"
```

Useful flags: `--system "<instruction>"`, `--model <id>`, `--max-tokens <n>`, `--json`.

Pipe file or command output in when the model needs context it cannot otherwise see:

```bash
cat src/thing.ts | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" "Explain what this does."
```

**Load the `gemma-usage` skill before reporting the result.** It holds the shared
policy on what this model is, what it cannot do, and how to present its output
honestly. The short version: it is a small on-device model with no tools and no
repo access, so treat the answer as a cheap second opinion, not as authority, and
say so plainly when it looks thin or wrong.
