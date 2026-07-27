---
name: gemma-prompting
description: How to prompt a small on-device model so it performs. Load this before composing a prompt for the local model — habits that work on frontier models actively hurt here.
---

# Prompting a small local model

The default is Gemma 4 E4B, roughly a 4B-class model. It is not a small Claude. Prompting
habits that work on a frontier model — layered instructions, implied reasoning, "think about
X then do Y" — degrade its output sharply.

Most "this model is useless" conclusions are prompt problems. Fix the prompt before concluding
the model can't do it.

*(For how to **report** what it returns, see the `gemma-usage` skill. This skill is about
getting a good answer; that one is about not overselling it.)*

## The rules that matter most

### 1. One task per call

Compound instructions are where small models fall apart first. Each additional clause competes
for attention and the later ones get dropped or half-served.

```
BAD   Review this function, suggest fixes, and rewrite it with tests.
GOOD  List the defects in this function. One per line.
```

If you need three things, make three calls. They cost nothing.

### 2. State the output shape

Left unspecified, it will produce prose padding. Given a shape, it fills the shape.

```
BAD   What's wrong with this regex?
GOOD  Explain this regex in exactly three bullet points: what it matches,
      what it rejects, one edge case.
```

### 3. Everything it needs must be in the prompt

It has no file access and no repository awareness. Any reference to something not pasted or
piped in will be answered by invention, fluently. Paste the code. Pipe the diff.

### 4. Do not ask for reasoning chains

"Think step by step before answering" reliably makes it worse — it generates plausible-looking
reasoning that doesn't constrain the final answer, and burns context doing it. Ask for the
answer. If you want the reasoning, ask for it as a separate, second call.

### 5. Prefer closed questions to open ones

It is markedly better at judging than at generating.

```
WEAKER    How should I structure this module?
STRONGER  Here are two structures, A and B. Which has fewer failure modes, and why?
```

### 6. Use `--system` for the role, the prompt for the task

Keep the role stable and the task specific. Roles that constrain output length work well:

```bash
--system "You are a terse technical reviewer. Answer in under 100 words. \
If you are unsure, say so rather than guessing."
```

The "say so rather than guessing" clause measurably reduces confident invention. Worth
including whenever the answer might be outside what you supplied.

### 7. Keep input short

A long prompt is silently truncated at the context limit, and you will not be told. Narrow a
large diff to one file. Excerpt the relevant function rather than pasting the module. If the
input feels big, it is.

### 8. Set `--max-tokens` to what you actually want

It fills the budget it is given. A 900-token budget on a yes/no question produces 900 tokens of
justification.

## Where it is genuinely strong

- Explaining a self-contained snippet, regex, error string, or config
- Rephrasing, summarising, tightening prose you supply
- Closed comparisons between options you spell out
- Naming things, drafting boilerplate
- Extracting structure from unstructured text you paste in

## Where it will fail regardless of prompting

- Anything requiring repository knowledge
- Multi-step reasoning where step three depends on step one
- Precise arithmetic
- Recalling specific API signatures or version details — it will confabulate them fluently

For those, use Claude directly. No amount of prompt engineering closes a capability gap.

## Multi-turn and tool calling

Both work, with caveats:

- **Multi-turn** requires you to resend the whole history in `messages`; the client does not do
  this for you. Each call is otherwise independent.
- **Tool calling** returns correctly-shaped `tool_calls`, but nothing executes them — the
  plugin surfaces the request and stops. Keep tool schemas small; a large tool array crowds out
  the actual prompt.
