---
description: Have the local model look over your uncommitted diff — offline, no API tokens
argument-hint: "[optional focus, e.g. 'error handling']"
---

Pipe local git state to the model and report what it says.

```bash
git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemma-client.mjs" \
  --system "You are a concise code reviewer. Report only concrete defects: bugs, unhandled errors, security issues. Cite the line. If you find nothing, say so." \
  --max-tokens 1200 \
  "Review this diff. Focus: $ARGUMENTS"
```

Use `git diff --staged` for staged-only, or `git diff main...HEAD` for a branch.

## Read this before reporting the output

This is a **small on-device model reading a diff with no repository context**. It
cannot open other files, resolve an import, run tests, or check whether a function
it suspects is actually called anywhere. Its review is a cheap offline smoke pass,
not a substitute for a real one.

Expect two failure modes and screen for both:

- **False positives** — confident objections to code that is fine, usually because
  the answer depends on context outside the diff.
- **Plausible filler** — generic advice ("consider adding error handling") phrased
  as if it were a finding.

So: **verify each claim against the actual code before repeating it.** Report the
ones that survive, say plainly that the rest did not, and do not present the model's
confidence as evidence. If a change matters, follow with a real review — Claude
directly, or a frontier-model reviewer.
