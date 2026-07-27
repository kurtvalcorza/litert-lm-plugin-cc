#!/usr/bin/env node
/**
 * gemma-client — talk to a local LiteRT-LM server from Claude Code.
 *
 * `litert-lm serve` exposes an OpenAI-compatible API. This wraps it so a local
 * model can be called as a one-shot command, starting the server on demand and
 * reusing it across calls.
 *
 * Deliberately dependency-free: Node's built-in fetch and child_process only.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9379,
  model: 'gemma4-e4b-gpu',
  maxTokens: 800,
  // Engine init for a cold multi-GB model is slow; the request itself must outwait it.
  requestTimeoutMs: 15 * 60 * 1000,
  startupTimeoutMs: 60 * 1000,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, prompt: '', system: null, json: false, action: 'chat' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--model': opts.model = argv[++i]; break;
      case '--system': opts.system = argv[++i]; break;
      case '--max-tokens': opts.maxTokens = Number(argv[++i]); break;
      case '--port': opts.port = Number(argv[++i]); break;
      case '--json': opts.json = true; break;
      case '--stop': opts.action = 'stop'; break;
      case '--check': opts.action = 'check'; break;
      case '--list': opts.action = 'list'; break;
      case '-h': case '--help': opts.action = 'help'; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
        rest.push(a);
    }
  }
  opts.prompt = rest.join(' ');
  return opts;
}

const baseUrl = (o) => `http://${o.host}:${o.port}`;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function probe(opts, timeoutMs = 2000) {
  try {
    const res = await fetch(`${baseUrl(opts)}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureServer(opts, { quiet = false } = {}) {
  const existing = await probe(opts);
  if (existing) return existing;

  if (!quiet) console.error(`[gemma] starting litert-lm serve on ${baseUrl(opts)} ...`);
  const child = spawn(
    'litert-lm',
    ['serve', '--host', opts.host, '--port', String(opts.port)],
    { detached: true, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  child.unref();

  const deadline = Date.now() + opts.startupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(750);
    const up = await probe(opts);
    if (up) return up;
  }
  throw new Error(
    `litert-lm server did not come up on ${baseUrl(opts)} within ` +
    `${opts.startupTimeoutMs / 1000}s. Is 'litert-lm' on PATH? Try: litert-lm list`,
  );
}

async function chat(opts) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const res = await fetch(`${baseUrl(opts)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages,
      max_tokens: opts.maxTokens,
    }),
    signal: AbortSignal.timeout(opts.requestTimeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Server returned ${res.status}.\n${text.slice(0, 800)}\n\n` +
      `If this is a memory-mapping or "embedding lookup not initialized" error, the ` +
      `model does not fit at its default context on this GPU.`,
    );
  }
  return JSON.parse(text);
}

const HELP = `
gemma-client — call a local LiteRT-LM model (OpenAI-compatible)

Usage:
  gemma-client [options] "<prompt>"
  <stdin> | gemma-client [options] "<prompt>"

Options:
  --model <id>        Imported model id (default: ${DEFAULTS.model})
  --system <text>     System instruction
  --max-tokens <n>    Response cap (default: ${DEFAULTS.maxTokens})
  --port <n>          Server port (default: ${DEFAULTS.port})
  --json              Print the raw API response
  --check             Report readiness (CLI, server, models) and exit
  --list              List imported models and exit
  --stop              Shut the server down and exit
  -h, --help          This message

Notes:
  The server holds ONE model in VRAM at a time; naming a different model tears the
  engine down and re-initialises it. First call is slow (engine init); warm calls
  are fast. Use --stop to release VRAM.
`.trim();

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.action === 'help') {
    console.log(HELP);
    return;
  }

  if (opts.action === 'stop') {
    const up = await probe(opts);
    if (!up) { console.log('Server is not running.'); return; }
    const cmd = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "Get-Process litert-lm -ErrorAction SilentlyContinue | Stop-Process -Force"'
      : 'pkill -f "litert-lm serve"';
    spawn(cmd, { shell: true, stdio: 'ignore' }).unref();
    await sleep(1500);
    console.log('Server stopped; VRAM released.');
    return;
  }

  if (opts.action === 'check') {
    const up = await probe(opts);
    const lines = [
      `server   : ${up ? `up at ${baseUrl(opts)}` : 'not running (starts on demand)'}`,
    ];
    if (up) {
      const ids = (up.data ?? []).map((m) => m.id);
      lines.push(`models   : ${ids.length ? ids.join(', ') : '(none imported)'}`);
      lines.push(`default  : ${opts.model}${ids.includes(opts.model) ? '' : '  <-- NOT IMPORTED'}`);
    } else {
      lines.push(`default  : ${opts.model} (unverified — server down)`);
    }
    console.log(lines.join('\n'));
    return;
  }

  if (opts.action === 'list') {
    const up = await ensureServer(opts);
    for (const m of up.data ?? []) console.log(m.id);
    return;
  }

  const piped = await readStdin();
  if (piped) opts.prompt = opts.prompt ? `${opts.prompt}\n\n${piped}` : piped;
  if (!opts.prompt) {
    console.error('No prompt supplied (pass an argument or pipe input). Try --help.');
    process.exit(2);
  }

  await ensureServer(opts);
  const resp = await chat(opts);

  if (opts.json) {
    console.log(JSON.stringify(resp, null, 2));
  } else {
    const choice = resp.choices?.[0];
    if (choice?.message?.tool_calls) {
      console.log(JSON.stringify(choice.message.tool_calls, null, 2));
    } else {
      console.log(choice?.message?.content ?? '(empty response)');
    }
  }
}

main().catch((err) => {
  console.error(`[gemma] ${err.message}`);
  process.exit(1);
});
