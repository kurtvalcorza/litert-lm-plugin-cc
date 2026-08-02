# Contract: `litertlm-review.mjs`

**Feature**: 002-offline-review-launcher | **Consumers**: `/litertlm:review`, and users directly

The offline entry point. `litertlm-client.mjs` remains the pipe-clean primitive; this is the
turnkey surface built on it, and it is what runs when no agent is available.

## Invocation

```
node litertlm-review.mjs [options] ["<focus>"]
```

Nothing is piped. Every step's exit status is checked before the next, which is the difference
between this and a hand-typed `git diff … | client` — there, git's failure sits on the left of
a pipe that still opens, the client receives an empty diff, and the model still returns a
response.

## Options

| Option | Default | Behaviour |
|---|---|---|
| `--base <ref>` | — | Review `<ref>...HEAD`. `auto` picks the first conventional base that both resolves here and shares history with `HEAD`, and says which it chose. |
| `--staged` | — | Review staged changes only. Mutually exclusive with `--base`. |
| `--path <pathspec>` | — | Narrow the diff. Repeatable. |
| `--focus <text>` | — | Emphasis for the prompt. May also be given positionally; giving both is a usage error. |
| `--max-bytes <n>` | 6144 | Refuse a request larger than this — the diff **plus** `--focus`, which travels with it. The default is a margin below a measured ceiling, not itself a measured boundary: on litert-lm 0.14.0 the largest diff accepted in this script's framing was 6,656–8,256 B for `qwen3-4b-instruct` and 12,288–15,360 B for `gemma4-e4b`, so the tighter model sets it. |
| `--allow-oversize` | off | Send an oversized diff; the reply is stamped coverage-unverified. |
| `--dry-run` | off | Report range and size; start nothing, send nothing. |
| `--model <id>` | client's | Passed through. |
| `--max-tokens <n>` | 1200 | Passed through. |
| `--port <n>` | client's | Passed through. |
| `-h`, `--help` | — | Usage; exit. |

Default range when none is given: the uncommitted working tree (`git diff HEAD`), matching
`/litertlm:review`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | A pass ran |
| 1 | Environment failure — git missing, not a repository, no commits, client absent, model call failed |
| 2 | Usage error — unknown flag, empty value for a range-selecting option, unresolvable base, base sharing no history with `HEAD` |
| 3 | Nothing to review — the range resolved and its diff is empty |
| 4 | Refused as oversized |

3 and 4 exist as distinct codes because both are *successful* runs that produced no review, and
a caller that cannot tell them from 0 will report a clean pass. `/litertlm:review` branches on
them explicitly.

## Output

**stdout** carries the framed report: a header naming the range, file count and size; the
model's reply; and the verification footer. This deliberately differs from
`litertlm-client.mjs`, whose stdout is payload-only so it can be piped — here the framing *is*
the deliverable, and a saved transcript that dropped it would be the exact defect the script
guards against.

**stderr** carries errors, and the client's own progress notices pass through unaltered.

## Behavioural guarantees

1. **Self-locating** — the client is resolved from `import.meta.url`, never from the working
   directory or a repository-relative path. Several plugin versions coexist under the client's
   cache directory; each copy drives its own sibling.
2. **No empty prompt** — an empty or whitespace-only diff exits 3 without invoking the model.
   A failed git call aborts the run; it cannot arrive as empty input.
3. **Refs validated first** — `--base` is checked with `rev-parse --verify` and `merge-base`
   before anything is sent, and a failure names the bases that *do* resolve here.
4. **Empty values rejected** — `--base`, `--path` and `--model` refuse an empty string rather
   than treating it as absent. `--base "$VAR"` with `VAR` unset would otherwise be falsy, skip
   the range, and quietly review the working tree instead. `--focus` is exempt: `review.md`
   passes `--focus "$ARGUMENTS"`, where empty legitimately means no focus.
5. **Untracked files declared** — the working-tree range compares tracked content, so a
   brand-new file is invisible to it. Their count and names appear in the nothing-to-review
   message, in `--dry-run`, and above the response, with `git add -N` named as the way to
   include them. Not applicable to `--staged` or a committed range.
6. **Oversize refused by default** — the guard derives from a measurement and is set below it:
   the server was bisected per model, and the default sits under the tightest ceiling observed
   rather than at it. So a diff just over the guard is often still accepted in full — the guard
   is deliberately conservative, not the server's own boundary. Overriding it stamps a
   coverage-unverified warning both above and below the reply. That stamp does **not** assert
   the reply was partial, because nothing on this path can distinguish a whole reply from a
   truncated one.
7. **Shell-agnostic** — a single Node invocation with no continuations, identical under
   PowerShell, cmd and POSIX shells (Principle VI).
8. **Standard library only** — no manifest, no install step (Principle III). Missing
   prerequisites are named: `git`, and the sibling client.
9. **Local only** — the only network traffic is the client's existing calls to the local server
   (Principle II).
10. **Framed, never authoritative** — every reply is followed by the verification obligation and
   a pointer to the stronger tool (Principle I). On this path no agent exists to do it.

## Non-goals

- **Chunking an oversized diff into several passes.** Fragmenting a diff removes the very
  context that keeps the false-positive rate down; several confident partial answers are worse
  than one refusal.
- **Screening the output.** The script states the obligation. It cannot discharge it, and says
  so rather than implying it did.
