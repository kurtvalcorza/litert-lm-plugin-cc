# Contract: `gemma-client.mjs`

**Feature**: 001-local-gemma-plugin | **Consumers**: all plugin commands

The invocation surface. Stable across versions; commands depend only on what is written here.

## Invocation

```
node gemma-client.mjs [options] "<prompt>"
<stdin> | node gemma-client.mjs [options] ["<prompt>"]
```

Prompt may come from positional arguments, piped stdin, or both. When both are present the
positional prompt precedes the piped content, separated by a blank line — so
`git diff | ... "Review this."` reads as an instruction followed by its subject.

## Options

| Option | Default | Behaviour |
|---|---|---|
| `--model <id>` | `gemma4-e4b-gpu` | Model to serve. Naming one other than the loaded model emits a reload warning (FR-026). |
| `--system <text>` | none | System instruction, sent as the first message. |
| `--max-tokens <n>` | 800 | Response length cap. |
| `--port <n>` | 9379 | Server port. |
| `--idle-timeout <s>` | 900 | Idle seconds before the watchdog stops the server. `0` disables idle shutdown. |
| `--json` | off | Emit the raw response object rather than message text. |
| `--check` | — | Report readiness; start nothing; exit. |
| `--list` | — | List served model ids; exit. |
| `--stop` | — | Stop server and watchdog; exit. |
| `-h`, `--help` | — | Usage; exit. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Runtime failure (server unreachable, request rejected, model not found) |
| 2 | Usage error (unknown flag, no prompt supplied) |

Distinguishing 1 from 2 matters: a command wrapper can tell "you called this wrong" from "the
environment is not ready" without parsing text.

## Output

**stdout** carries the payload only — message text, or JSON under `--json`, or the id list under
`--list`. Nothing else. This keeps `... | node gemma-client.mjs ... > out.txt` clean.

**stderr** carries progress and diagnostics: server-start notices, reload warnings, restart
explanations. Never interleaved into stdout.

When the response is a tool call rather than text, stdout receives the `tool_calls` array as
JSON. The plugin executes nothing (FR-034); it surfaces the request and stops.

## Behavioural guarantees

1. **Start on demand** (FR-002) — probes first; starts a detached server only if absent; waits
   up to a bounded startup window; reuses any healthy server.
2. **Never double-start** — a probe returning healthy is authoritative. Two concurrent
   invocations must not produce two servers on one port.
3. **Model-switch warning** (FR-026) — before issuing a request naming a model other than the
   loaded one, warn on stderr that it forces a full reload and state the approximate cost.
4. **Restart transparency** (FR-025) — a request after a watchdog shutdown restarts the server
   without user action, and stderr explains why the request was slow, distinguishing this from
   a first-ever start.
5. **Stopping interlock** — if the `stopping` marker is present, wait for exit and start fresh
   rather than connecting to a dying server.
6. **Activity accounting** — `last-activity` updated and `in-flight` incremented before each
   request; `in-flight` decremented on every exit path including failure.
7. **Actionable failure** (Principle III) — every error names the missing prerequisite or the
   diagnostic command. A raw stack trace reaching the user is a defect.
8. **No egress** (FR-006) — the only network destination is the configured local host and port.

## Non-guarantees

- No conversation memory between invocations. Multi-turn works only by resending history, which
  this CLI does not do for you.
- No streaming. Responses arrive complete.
- No tool execution, job management, or session transfer (FR-034).
