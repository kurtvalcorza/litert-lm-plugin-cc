/**
 * Ownership tests — nothing gets signalled that we cannot prove is ours.
 *
 * These cover the two ways the plugin used to mistake something else for its own
 * server, both of which were reproduced on a real host before being fixed:
 *
 *   1. Any 2xx from /v1/models counted as ownership, so `--stop` terminated an
 *      unrelated OpenAI-compatible server on the port and reported success.
 *   2. A live pid in a state file counted as ownership, so a pid reused within one
 *      boot session sent SIGTERM to a bystander.
 *
 * Real processes, real sockets, real signals — the defects lived in the gap between
 * what the code believed about a pid and what the OS knew, which a mock cannot show.
 *
 * Run: node --test tests/
 *
 * Node standard library only, like everything else here (constitution, Principle III).
 * Uses a scratch LITERT_LM_PLUGIN_RUNTIME and spare ports, so a real server on the
 * default port is never touched.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  formatPidRecord, isLitertLmServeCommand, parsePidRecord, pidsOnPort, recordIsStale,
  signallablePid, startToken,
} from '../plugins/litertlm/scripts/process-identity.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'litertlm', 'scripts');
const CLIENT = join(SCRIPTS, 'litertlm-client.mjs');
const WATCHDOG = join(SCRIPTS, 'idle-watchdog.mjs');

// Ports nothing else on a developer machine is likely to want. Each test gets its
// own, so a leftover process from a failed run cannot poison the next test.
const PORT = {
  stranger: 9931, reuse: 9932, watchdogStranger: 9933, watchdogPid: 9934,
  staleState: 9935, discovery: 9936,
};

const spawned = [];
const reap = (child) => { spawned.push(child); return child; };
after(() => {
  for (const c of spawned) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
});

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const runtimeDir = () => mkdtempSync(join(tmpdir(), 'litertlm-test-'));

/**
 * Poll until `predicate` holds, or give up.
 *
 * Not a stylistic preference. A watchdog claims its slot only after establishing its
 * own identity, which on Windows means starting PowerShell — measured between 0.9s
 * idle and 3.4s cold. A fixed sleep either races that under load (this suite spawns
 * plenty) or pads every run with the worst case. Polling does neither.
 */
async function waitFor(predicate, { timeout = 20_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try { ok = await predicate(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

const recordedPid = (dir) => {
  try {
    return parsePidRecord(readFileSync(join(dir, 'watchdog.pid'), 'utf8'))?.pid ?? null;
  } catch {
    return null;
  }
};

const stateDir = (runtime, port) => {
  const dir = join(runtime, String(port));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** An unrelated OpenAI-compatible server: right protocol, wrong owner. */
async function startStranger(port) {
  const src = `
    import { createServer } from 'node:http';
    createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'someone-elses-model' }] }));
    }).listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `;
  const child = reap(spawn(process.execPath, ['--input-type=module', '-e', src],
    { stdio: 'ignore', windowsHide: true }));
  await sleep(1200);
  assert.ok(alive(child.pid), 'the stranger should be running before the test starts');
  return child;
}

/** A process that is alive and innocent — stands in for one that inherited a pid. */
async function startBystander() {
  const child = reap(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true }));
  await sleep(600);
  return child;
}

const runClient = (args, runtime) => spawnSync(process.execPath, [CLIENT, ...args], {
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, LITERT_LM_PLUGIN_RUNTIME: runtime },
});

/**
 * Can this host discover who owns a socket at all?
 *
 * Windows always can. Elsewhere it needs `lsof` or `ss`, and minimal Linux images
 * routinely ship neither — on such a host `pidsOnPort` returns nothing, which is
 * indistinguishable from "the port is free", so the socket-owner tests would fail
 * for a reason that has nothing to do with ownership. Probed once against a socket
 * we know is listening rather than by sniffing for binaries, so the answer reflects
 * what actually works here.
 */
let portDiscoveryWorks = null;
async function canDiscoverPortOwners() {
  if (portDiscoveryWorks !== null) return portDiscoveryWorks;
  const probe = await startStranger(PORT.discovery);
  portDiscoveryWorks = pidsOnPort(PORT.discovery).includes(probe.pid);
  try { probe.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(300);
  return portDiscoveryWorks;
}

describe('the record that says a process is ours', () => {
  test('round-trips a live pid and its start token', () => {
    const record = parsePidRecord(formatPidRecord(process.pid));
    assert.equal(record.pid, process.pid);
    assert.ok(record.token, 'a live process must yield a token');
    assert.equal(signallablePid(record, Date.now()), process.pid);
  });

  test('reads a legacy tokenless record but refuses to act on it', () => {
    const record = parsePidRecord(String(process.pid));
    assert.equal(record.pid, process.pid, 'the pid is still readable');
    assert.equal(record.token, null);
    assert.equal(signallablePid(record, Date.now()), null, 'unprovable means untouchable');
  });

  test('rejects a token belonging to a different process', () => {
    const record = { pid: process.pid, token: `${startToken(process.pid)}0` };
    assert.equal(signallablePid(record, Date.now()), null);
  });

  test('rejects a record written before this boot', () => {
    const record = parsePidRecord(formatPidRecord(process.pid));
    assert.equal(signallablePid(record, 0), null, 'a pre-boot file names nobody now');
  });

  test('rejects junk without throwing', () => {
    for (const raw of ['', '   ', 'not-a-pid', '-1', '0']) {
      assert.equal(parsePidRecord(raw), null, `parsePidRecord(${JSON.stringify(raw)})`);
    }
    assert.equal(signallablePid(null, Date.now()), null);
  });

  // The two questions must not collapse into each other: the hygiene test has to
  // stay cheap and permissive, the authority test strict. A change that made them
  // agree everywhere would silently put a process lookup on the interactive path,
  // or — far worse — let an unprovable record authorise a signal.
  test('hygiene keeps a live tokenless record that authority refuses', () => {
    const record = parsePidRecord(String(process.pid));
    assert.equal(recordIsStale(record, Date.now()), false, 'not dead wood: the pid is alive');
    assert.equal(signallablePid(record, Date.now()), null, 'but still not signallable');
  });

  test('hygiene agrees whenever the record is genuinely dead', () => {
    for (const [record, writtenAt] of [
      [null, Date.now()],
      [{ pid: 999_999, token: 'x' }, Date.now()],
      [parsePidRecord(formatPidRecord(process.pid)), 0],
    ]) {
      assert.equal(recordIsStale(record, writtenAt), true);
      assert.equal(signallablePid(record, writtenAt), null);
    }
  });

  // `ps -o lstart=` yields a five-field time. Splitting the record on whitespace
  // kept only "Sun", so no recorded process on macOS was ever signallable and
  // shutdown silently fell back to socket-owner discovery alone.
  test('keeps a multi-word POSIX start token intact', () => {
    const token = 'Sun Aug 9 12:34:56 2026';
    const record = parsePidRecord(`4321 ${token}`);
    assert.equal(record.pid, 4321);
    assert.equal(record.token, token);
  });

  test('a single-field token is unaffected', () => {
    const record = parsePidRecord('4321 134307111202731270');
    assert.equal(record.pid, 4321);
    assert.equal(record.token, '134307111202731270');
  });
});

describe('recognising a litert-lm serve command line', () => {
  // Captured from a real three-stage launcher on Windows, plus the POSIX shapes.
  const OURS = [
    '"C:\\Users\\Kurt Valcorza\\.local\\bin\\litert-lm.exe" serve --port 9379',
    '"C:\\Users\\Kurt Valcorza\\AppData\\Roaming\\uv\\tools\\litert-lm\\Scripts\\python.exe" '
      + '"C:\\Users\\Kurt Valcorza\\.local\\bin\\litert-lm.exe" serve --port 9379',
    '"C:\\Users\\Kurt Valcorza\\AppData\\Roaming\\uv\\python\\cpython-3.12.12-windows-x86_64-none'
      + '\\python.exe" "C:\\Users\\Kurt Valcorza\\.local\\bin\\litert-lm.exe" serve --port 9379',
    '/home/kurt/.local/bin/litert-lm serve --port 9379',
    '/home/kurt/.local/bin/litert-lm serve',
    '/usr/bin/python3 -m litert_lm serve --port 9379',
  ];

  // Every one of these contains both "litert-lm"/"litert_lm" and a whole word
  // "serve" somewhere, and every one would have been signalled by a predicate that
  // searched for the two independently.
  const NOT_OURS = [
    'python /work/litert_lm/tools/server.py serve',
    'vim /home/kurt/litert-lm/serve notes.txt',
    'node /opt/litert-lm-tools/serve.js --port 9379',
    '/usr/bin/llama-server --port 9379 --model foo.gguf',
    'tail -f /var/log/litert-lm/serve.log',
    '',
  ];

  test('recognises every real launcher stage', () => {
    for (const cmdline of OURS) {
      assert.equal(isLitertLmServeCommand(cmdline), true, cmdline.slice(0, 80));
    }
  });

  test('rejects command lines that merely mention litert-lm and serve', () => {
    for (const cmdline of NOT_OURS) {
      assert.equal(isLitertLmServeCommand(cmdline), false, cmdline.slice(0, 80));
    }
  });

  test('rejects rather than guesses when a flag separates program from subcommand', () => {
    // A false negative, deliberately: the server is reported as a stranger and left
    // running, which is visible and recoverable. The opposite error is neither.
    assert.equal(isLitertLmServeCommand('/usr/bin/litert-lm --verbose serve'), false);
  });
});

describe('--stop', () => {
  test('leaves an unrelated /v1/models responder on the port running', async (t) => {
    if (!(await canDiscoverPortOwners())) {
      t.skip('no socket-owner discovery on this host (needs lsof or ss)');
      return;
    }
    const port = PORT.stranger;
    const runtime = runtimeDir();
    const stranger = await startStranger(port);

    const r = runClient(['--stop', '--port', String(port)], runtime);

    assert.equal(r.status, 0, `--stop should not fail: ${r.stderr}`);
    assert.ok(alive(stranger.pid), 'the stranger must survive --stop');
    assert.match(r.stderr, /left running/, 'and --stop must say it left something alone');
    assert.doesNotMatch(r.stdout, /Server stopped/,
      'reporting success over a server we never owned is the bug, not the fix');
  });

  test('does not signal a pid reused within this boot session', async () => {
    const port = PORT.reuse;
    const runtime = runtimeDir();
    const bystander = await startBystander();

    // Written now, so the pre-boot test passes and only identity can catch this.
    // No listener on the port either, so the recorded pid is the sole candidate.
    writeFileSync(join(stateDir(runtime, port), 'server.pid'), String(bystander.pid), 'utf8');

    const r = runClient(['--stop', '--port', String(port)], runtime);

    assert.equal(r.status, 0);
    assert.ok(alive(bystander.pid), 'a reused pid in server.pid must never be signalled');
  });

  test('does not signal a reused pid in watchdog.pid either', async () => {
    const port = PORT.watchdogPid;
    const runtime = runtimeDir();
    const bystander = await startBystander();

    writeFileSync(join(stateDir(runtime, port), 'watchdog.pid'), String(bystander.pid), 'utf8');

    const r = runClient(['--stop', '--port', String(port)], runtime);

    assert.equal(r.status, 0);
    assert.ok(alive(bystander.pid), 'a reused pid in watchdog.pid must never be signalled');
  });

  test('still clears stale state when nothing provable is ours', async () => {
    const port = PORT.staleState;
    const runtime = runtimeDir();
    const dir = stateDir(runtime, port);
    writeFileSync(join(dir, 'server.pid'), '999999', 'utf8');
    writeFileSync(join(dir, 'loaded-model'), 'gemma4-e4b', 'utf8');

    const r = runClient(['--stop', '--port', String(port)], runtime);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /state cleared/);
    for (const f of ['server.pid', 'loaded-model']) {
      assert.throws(() => readFileSync(join(dir, f), 'utf8'), `${f} should be gone`);
    }
  });
});

describe('the idle watchdog', () => {
  // The watchdog used to be the weaker reader of the two: it accepted a recorded pid
  // on bare liveness and killed whatever held the port. It now shares the client's
  // rule, so the client's guarantees have to hold when the watchdog is the one acting.
  test('will not terminate an unrelated server holding the port', { timeout: 60_000 },
    async (t) => {
      if (!(await canDiscoverPortOwners())) {
        t.skip('no socket-owner discovery on this host (needs lsof or ss)');
        return;
      }
      const port = PORT.watchdogStranger;
      const runtime = runtimeDir();
      const stranger = await startStranger(port);

      // Reachable (so the watchdog supervises rather than standing down) and long
      // since idle (so it decides to shut the "server" down on its first poll).
      const dir = stateDir(runtime, port);
      writeFileSync(join(dir, 'last-activity'), String(Date.now() - 600_000), 'utf8');

      const watchdog = reap(spawn(process.execPath,
        [WATCHDOG, '--port', String(port), '--idle-timeout', '1'],
        { stdio: 'ignore', windowsHide: true,
          env: { ...process.env, LITERT_LM_PLUGIN_RUNTIME: runtime } }));

      assert.ok(await waitFor(() => recordedPid(dir) === watchdog.pid),
        'the watchdog should have recorded itself with an identity');

      // One poll interval (5s) to decide it is idle, plus room to act on that.
      await sleep(12_000);

      assert.ok(alive(stranger.pid),
        'the watchdog must not terminate a server it cannot prove is ours');
    });

  // Two clients adopting one warm server both spawn a watchdog. The loser's watchdog
  // proves the winner owns the slot and exits — but if the loser's CLIENT then wrote
  // its dead pid over the record, the surviving watchdog would see an owner that is
  // not itself on its next poll and exit too, leaving the server unsupervised with
  // no watchdog at all. The claim must be exclusive, not a plain write.
  test('a losing claimant never overwrites a live watchdog record', { timeout: 30_000 },
    async () => {
      const port = PORT.watchdogPid + 40;
      const runtime = runtimeDir();
      const dir = stateDir(runtime, port);

      const winner = reap(spawn(process.execPath,
        [WATCHDOG, '--port', String(port), '--idle-timeout', '900'],
        { stdio: 'ignore', windowsHide: true,
          env: { ...process.env, LITERT_LM_PLUGIN_RUNTIME: runtime } }));
      assert.ok(await waitFor(() => recordedPid(dir) === winner.pid),
        'the first watchdog should claim the slot');

      // A second watchdog arrives, finds a proven owner, and stands down.
      const loser = reap(spawn(process.execPath,
        [WATCHDOG, '--port', String(port), '--idle-timeout', '900'],
        { stdio: 'ignore', windowsHide: true,
          env: { ...process.env, LITERT_LM_PLUGIN_RUNTIME: runtime } }));
      assert.ok(await waitFor(() => loser.exitCode !== null),
        'the second watchdog should have stood down');

      assert.equal(recordedPid(dir), winner.pid, 'the record must still name the survivor');
      assert.ok(alive(winner.pid), 'which is still running');
    });

  // The other half of an exclusive claim: it must not become a lock. A record left
  // by a crashed watchdog has to be reclaimable, or no watchdog ever starts on this
  // port again and the server holds accelerator memory until someone runs --stop.
  test('a stale record does not lock the slot', { timeout: 30_000 }, async () => {
    const port = PORT.watchdogPid + 60;
    const runtime = runtimeDir();
    const dir = stateDir(runtime, port);
    writeFileSync(join(dir, 'watchdog.pid'), '999999 pretend-token', 'utf8');

    const watchdog = reap(spawn(process.execPath,
      [WATCHDOG, '--port', String(port), '--idle-timeout', '900'],
      { stdio: 'ignore', windowsHide: true,
        env: { ...process.env, LITERT_LM_PLUGIN_RUNTIME: runtime } }));

    assert.ok(await waitFor(() => recordedPid(dir) === watchdog.pid),
      'the watchdog should have reclaimed the slot from a dead pid');
    assert.ok(alive(watchdog.pid), 'and should still be running');

    const claimed = parsePidRecord(readFileSync(join(dir, 'watchdog.pid'), 'utf8'));
    assert.ok(claimed?.token, 'with a real identity, not the placeholder');
    assert.notEqual(claimed?.token, 'pretend-token');
  });
});

describe('release metadata', () => {
  // A stale marketplace entry keeps installs resolving the previous version, so a
  // safety fix can ship in the repo and never reach anyone using it.
  test('the marketplace advertises the same version the plugin declares', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const plugin = JSON.parse(
      readFileSync(join(root, 'plugins', 'litertlm', '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplace = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));

    assert.equal(marketplace.metadata.version, plugin.version, 'marketplace metadata version');
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    assert.ok(entry, `marketplace should list a plugin named ${plugin.name}`);
    assert.equal(entry.version, plugin.version, 'marketplace plugins[].version');
  });
});
