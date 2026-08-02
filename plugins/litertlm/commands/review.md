---
description: Offline second-opinion pass over your uncommitted diff — no API tokens
argument-hint: "[optional focus, e.g. 'error handling']"
---

Run the launcher:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-review.mjs" --focus "$ARGUMENTS"
```

It owns the mechanics — resolving the client, validating the range, refusing a diff too large
to have been read whole, and stopping rather than asking the model about nothing. Do not
reassemble that pipeline by hand here; the same script is what a user runs when Claude Code is
unavailable, and two copies of the rules would drift.

**Read its exit code before its output:**

| Code | What happened | What to do |
|---|---|---|
| 0 | A pass ran | Screen it — see below |
| 3 | The range was empty | Say so and stop. **Do not** widen the range or review the last commit instead: a reviewer given nothing invents findings, and that is worse than reporting nothing |
| 4 | Refused as oversized | Relay its narrowing advice and use `--path <pathspec>`. **Do not reach for `--allow-oversize` here, and do not relay it as a measurement** — it answers only whether the server comes back at all at that size. A reply under it does not show the whole diff was read, and a failure under it does not show size was the cause: an unknown model, a server that never started, and an empty 200 all fail identically. On litert-lm 0.14.0 the failure being avoided is a request the server refuses by breaking the HTTP response — which its client reports as a memory problem, sending you after VRAM instead of prompt size. Where a runtime truncates instead, the failure is a partial read that reads as a whole one. Both are worse than narrowing |
| 2 | Called wrong | Fix the invocation |
| 1 | Environment failure | Relay the message; it names the missing prerequisite |

Other ranges: `--base main` for a whole branch, `--base auto` to let it pick, `--staged` for
staged changes only. `--dry-run` reports what would be sent without starting anything.

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
