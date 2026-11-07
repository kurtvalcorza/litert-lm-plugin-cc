/**
 * The review launcher and the data boundary into the client (RFC #18, PR E).
 *
 * Runs the real launcher in a scratch git repository against a fake chat server held in
 * this process, which can therefore read back exactly what arrived. Nothing here needs
 * litert-lm, a GPU or the network.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'plugins', 'litertlm', 'scripts');
const REVIEW = join(SCRIPTS, 'litertlm-review.mjs');
const CLIENT = join(SCRIPTS, 'litertlm-client.mjs');
const WATCHDOG = join(SCRIPTS, 'idle-watchdog.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'litertlm-review-test-'));
const runtime = join(scratch, 'runtime');
mkdirSync(runtime);

const requests = [];
let reply = () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) });
let port;
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake' }] }));
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const { status, body: out } = reply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(out);
  });
});

before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));
after(async () => {
  // The client attaches a watchdog to any server it finds. Ended through its own record,
  // not --stop, so this cleanup does not depend on socket discovery working on this host.
  try {
    const record = readFileSync(join(runtime, String(port), 'watchdog.pid'), 'utf8');
    process.kill(Number.parseInt(record, 10), 'SIGKILL');
  } catch { /* none started, or already gone */ }
  server.closeAllConnections();
  server.close();
  // Last, and retried: Windows holds a directory while a process has it as its cwd.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Asynchronous on purpose: a sync spawn would freeze the server these clients talk to. */
function run(exe, args, { cwd = scratch, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LITERT_LM_PLUGIN_RUNTIME: runtime,
        LITERT_LM_PLUGIN_MODEL: 'fake',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const review = (cwd, ...args) =>
  run(process.execPath, [REVIEW, '--port', String(port), ...args], { cwd });
const client = (...args) => run(process.execPath, [CLIENT, '--port', String(port), ...args]);

let repoCount = 0;
function repo() {
  repoCount += 1;
  const dir = join(scratch, `repo-${repoCount}`);
  mkdirSync(dir);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  writeFileSync(join(dir, 'tracked.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'tracked.txt'), 'two\n');
  return { dir, git };
}

/** Text no shell could survive, were this ever to reach one. */
const hostile = (marker) => [
  `$(node -e "require('fs').writeFileSync('${marker}','x')")`,
  `\`touch ${marker}\``,
  `"; touch ${marker}; "`,
  `'; touch ${marker}; '`,
  'line two\nline three',
  '%PATH% ^& | > < \\ ¯\\_(ツ)_/¯',
].join(' ');

describe('review coverage', () => {
  test('a complete pass over tracked changes exits 0', async () => {
    const { dir } = repo();
    const r = await review(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /NOT COVERED/);
  });

  test('an untracked file in scope makes the pass incomplete', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'new.txt'), 'never sent\n');
    const r = await review(dir);
    assert.equal(r.status, 5, 'it ran, but not over the whole working tree');
    assert.match(r.stdout, /NOT COVERED/);
    assert.match(r.stdout, /ok/, 'the report is still delivered');
  });

  test('an untracked file outside --path is not a gap', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'new.txt'), 'out of scope\n');
    assert.equal((await review(dir, '--path', 'tracked.txt')).status, 0);
  });

  test('--staged is not affected by untracked files', async () => {
    const { dir, git } = repo();
    git('add', 'tracked.txt');
    writeFileSync(join(dir, 'new.txt'), 'not part of the staged range\n');
    assert.equal((await review(dir, '--staged')).status, 0);
  });

  test('an ignored file is not a gap', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'ignored.txt\n');
    writeFileSync(join(dir, 'ignored.txt'), 'nobody expects this reviewed\n');
    assert.equal((await review(dir)).status, 0);
  });

  test('--dry-run reports the gap and still exits 0, having reviewed nothing', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    const before_ = requests.length;
    const r = await review(dir, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /excluded/);
    assert.equal(requests.length, before_);
  });
});

describe('bounding diff acquisition', () => {
  test('a diff past the acquisition cap is refused as oversized, not read', async () => {
    const { dir } = repo();
    // Past 32 MiB, in lines, so it is a text diff rather than a one-line binary stub.
    writeFileSync(join(dir, 'tracked.txt'), `${'x'.repeat(79)}\n`.repeat(450_000));
    const before_ = requests.length;
    const r = await review(dir, '--allow-oversize');
    assert.equal(r.status, 4, `${r.stderr}`);
    assert.match(r.stderr, /--path/);
    assert.equal(requests.length, before_, 'nothing may be sent');
  });

  test('a diff under the cap still reaches the size guard with its numbers', async () => {
    const { dir } = repo();
    writeFileSync(join(dir, 'tracked.txt'), `${'y'.repeat(79)}\n`.repeat(2000));
    const r = await review(dir);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /Largest contributors/);
  });
});

describe('arguments as data', () => {
  test('--prompt-file delivers hostile text byte for byte', async () => {
    const marker = join(scratch, 'pwned-prompt');
    const text = hostile(marker);
    const file = join(scratch, 'prompt.txt');
    writeFileSync(file, text);
    const before_ = requests.length;
    const r = await client('--prompt-file', file);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(requests.length, before_ + 1);
    assert.equal(requests.at(-1).messages.at(-1).content, text);
    assert.equal(existsSync(marker), false);
  });

  test('--focus-file carries hostile text into the review prompt', async () => {
    const marker = join(scratch, 'pwned-focus');
    const text = hostile(marker);
    const file = join(scratch, 'focus.txt');
    writeFileSync(file, text);
    const { dir } = repo();
    const r = await review(dir, '--focus-file', file);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(requests.at(-1).messages.at(-1).content.includes(text));
    assert.equal(existsSync(marker), false);
  });

  test('an empty focus file means no focus', async () => {
    const file = join(scratch, 'empty.txt');
    writeFileSync(file, '');
    const { dir } = repo();
    assert.equal((await review(dir, '--focus-file', file)).status, 0);
  });

  test('a missing file is a usage error, not an empty prompt', async () => {
    const gone = join(scratch, 'does-not-exist');
    assert.equal((await client('--prompt-file', gone)).status, 2);
    const { dir } = repo();
    assert.equal((await review(dir, '--focus-file', gone)).status, 2);
  });

  test('the prompt file and a positional prompt cannot both be given', async () => {
    const file = join(scratch, 'one.txt');
    writeFileSync(file, 'one');
    assert.equal((await client('--prompt-file', file, 'two')).status, 2);
  });

  test('the command templates never put $ARGUMENTS in a shell command', () => {
    for (const name of ['ask.md', 'review.md']) {
      const text = readFileSync(join(ROOT, 'plugins', 'litertlm', 'commands', name), 'utf8');
      const fences = [...text.matchAll(/```(?:bash|sh|shell)[\s\S]*?```/g)].map((m) => m[0]);
      assert.ok(fences.length > 0, name);
      for (const fence of fences) {
        assert.doesNotMatch(fence, /\$ARGUMENTS|\$[0-9]/,
          `${name} would hand shell source containing user text to the agent`);
      }
    }
  });
});

describe('rejecting bad input early', () => {
  test('a ref that looks like an option is refused before git sees it', async () => {
    const { dir } = repo();
    const r = await review(dir, '--base', '--output=pwned');
    assert.equal(r.status, 2);
    assert.equal(existsSync(join(dir, 'pwned')), false);
  });

  for (const bad of ['0', '-1', '70000', '12.5', 'abc']) {
    test(`--port ${bad} is refused everywhere`, async () => {
      assert.equal((await run(process.execPath, [CLIENT, `--port=${bad}`].slice(0, 1)
        .concat(['--check', '--port', bad]))).status, 2);
      assert.equal((await run(process.execPath, [REVIEW, '--dry-run', '--port', bad])).status, 2);
      assert.equal((await run(process.execPath, [WATCHDOG, '--port', bad])).status, 2);
    });
  }
});

describe('a 200 that is not the answer', () => {
  test('an unparseable body gets the size guidance, not a SyntaxError', async () => {
    const previous = reply;
    reply = () => ({ status: 200, body: '{"choices":[{"mess' });
    try {
      const r = await client('hello');
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /SyntaxError|Unexpected end/);
      assert.match(r.stderr, /not valid JSON/);
      assert.match(r.stderr, /prompt/i);
    } finally {
      reply = previous;
    }
  });
});
