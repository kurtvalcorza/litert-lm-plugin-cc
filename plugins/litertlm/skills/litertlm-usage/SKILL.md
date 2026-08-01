---
name: litertlm-usage
description: How to present output from the local LiteRT-LM model honestly. Load this before relaying anything the local model produced.
---

# Using the local model honestly

This is the **single source** of the policy. Commands reference it; they do not restate it.
If you find this guidance duplicated inside a command file, that is a defect — divergent copies
drift, and they drift toward overclaiming.

## What this model is

A small on-device model, served locally by LiteRT-LM. It runs on the user's own hardware, costs
nothing per request, and sends nothing off the machine.

**Do not assume which model.** The shipped default is Gemma 4 E4B, but any litert-lm model can
be served, `LITERT_LM_PLUGIN_MODEL` changes the default per machine, and `--model` changes it
per call. Check rather than state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/litertlm-client.mjs" --check
```

Everything below applies to **whatever small model is loaded** — the guidance is about the size
class, roughly 0.5B–4B, not about any one family.

## What it cannot do

It is **an endpoint, not an agent**. It has:

- **No file access.** It cannot open, read, or list anything.
- **No command execution.** It cannot run tests, compile, or check anything.
- **No repository awareness.** It does not know your project exists.
- **No iteration.** One prompt in, one response out. It cannot investigate.
- **No memory between calls.** Each request starts cold unless history is resent.

It answers **only** from the text placed in its prompt. If something was not pasted or piped
in, the model did not see it — and any claim it makes about that thing is invention, however
confident it sounds.

## How to report its output

1. **Verify before repeating.** Check each substantive claim against the actual source — the
   file, the code, the docs. Report what survives.
2. **Say what did not survive.** Naming the claims you discarded is more useful than quietly
   dropping them; it tells the user how much to trust the rest.
3. **Never present it as authority.** Attribute it: "the local model suggests…", not "this is…".
   The user asked a 4B model; do not launder that into a verdict.
4. **Fluency is not evidence.** A well-formed, confident paragraph is the *expected* failure
   mode of a small model, not a signal of correctness. Do not let prose quality substitute for
   checking.
5. **Escalate when it matters.** If the question needs real codebase reasoning, or the answer
   would drive a decision that is costly to get wrong, say so and point at the stronger tool —
   Claude directly, or a frontier-model reviewer. Do not imply parity.

## The two failure modes to expect

- **Confident wrongness.** Plausible, well-structured, incorrect. Most likely where the answer
  depends on context outside the prompt.
- **Plausible filler.** Generic advice ("consider adding error handling") phrased as though it
  were a specific finding. Real-sounding, contentless.

Screen for both. An uncritical relay of model output is a failure of the task, regardless of
what the model said.

## When it is genuinely the right tool

- Offline, or when you want zero API spend
- Explaining a snippet, regex, error string, or config that is fully present in the prompt
- Drafting, rephrasing, summarising pasted text
- Anything privacy-sensitive that should not leave the machine
- Smoke-testing local inference itself

## Operational facts worth passing on

- First call after idle pays engine initialisation; later calls are much faster.
- The server holds **one model at a time**. Naming another forces a full reload — do not
  interleave models in a loop.
- The server shuts down on its own after an idle period, releasing accelerator memory. The
  next call restarts it transparently, just more slowly.
