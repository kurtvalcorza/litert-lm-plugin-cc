---
description: Offline second-opinion pass over your uncommitted diff — no API tokens
argument-hint: "[optional focus, e.g. 'error handling']"
---

Check there is something to review first:

```bash
git diff HEAD --stat
```

**If the diff is empty, stop and say so.** Do not fall back to reviewing the last commit or the
working tree at large — a reviewer given nothing will invent findings, and that is worse than
reporting nothing.

Otherwise send it:

```bash
git diff HEAD | node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" \
  --system "You are a concise code reviewer. Report only concrete defects: bugs, unhandled errors, security issues. Cite the line. If you find nothing, say so plainly." \
  --max-tokens 1200 \
  "Review this diff. Focus: $ARGUMENTS"
```

Use `git diff --staged` for staged-only, or `git diff main...HEAD` for a whole branch. Narrow
very large diffs to a path — the model has a finite context and will silently attend to only
part of an oversized input.

## Screening the output — this is the work

**Load the `litertlm-usage` skill and follow it.** What follows is only the diff-specific part.

This is a small on-device model reading a diff **with no repository context**. It cannot open
another file, resolve an import, run a test, or check whether a function it suspects is called
anywhere. So:

1. **Verify every observation against the actual code before repeating it.** Open the file.
   Check the claim.
2. **Report the ones that survive.** State plainly that the others did not, and how many.
3. **Do not pad.** If nothing survives, say the pass found nothing — that is a good outcome and
   far more useful than a list of maybes.

Two failure modes to expect, both common here:

- **False positives** — confident objections to correct code, usually because the answer
  depends on context outside the diff.
- **Plausible filler** — generic advice ("consider adding error handling") dressed as a
  specific finding.

**An uncritical relay of this model's output is a failure of the task**, regardless of what the
model said.

Close by framing it accurately: a free offline smoke pass, not a review. For anything that
matters, follow with a real one — Claude directly, or `/code-review`.
