#!/usr/bin/env node
/**
 * litertlm-review — an offline diff pass with no agent in the loop.
 *
 * `/litertlm:review` is agent-interpreted: Claude Code assembles the pipeline and
 * screens the reply. That makes it unavailable in exactly the conditions that make
 * a local pass worth having — offline, rate-limited, out of quota. This is the same
 * pass as a plain command, so it survives those conditions.
 *
 * Contract: specs/002-offline-review-launcher/contracts/litertlm-review-cli.md
 *
 * Four things this exists to own, because a hand-typed pipeline gets each wrong:
 *
 *   1. FINDING THE CLIENT. After a marketplace install the client lives under
 *      ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/scripts/, and several
 *      versions coexist. No repo-relative path reaches it, and the caller is standing
 *      in a different repository anyway. Resolved here from import.meta.url instead.
 *
 *   2. THE RANGE. `git diff <base>...HEAD | client` puts the failure on the LEFT of a
 *      pipe: git exits 128, the pipe still opens, the client reads empty stdin and can
 *      still answer. An empty pass and a clean pass then look identical. Nothing here
 *      is piped — every git call's exit status is checked before the next step.
 *
 *   3. THE SHELL. This is Node, not shell, so PowerShell, cmd and POSIX all invoke it
 *      the same way. No backslash continuations, which are Bash-only (Principle VI).
 *
 *   4. SIZE. Past its limit the runtime does not answer at all — measured on litert-lm
 *      0.14.0, it breaks the HTTP response rather than replying from the part it read.
 *      Where a model does truncate instead, the reply is indistinguishable from a whole
 *      one (`litertlm-prompting`, rule 7). Oversize is refused by default either way:
 *      one failure mode is confusing, the other is invisible.
 *
 * Dependency-free by constitution (Principle III): Node standard library only.
 *
 * Unlike litertlm-client.mjs, whose stdout is payload-only so it can be piped, this
 * script's stdout IS the framed report — the framing is the deliverable, and a saved
 * transcript that dropped it would be the exact defect this guards against. Pipe the
 * client directly if you want bare text.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, 'litertlm-client.mjs');

/** Distinct codes so a caller can tell these apart without parsing text. */
const EXIT = {
  OK: 0,
  ENVIRONMENT: 1,   // git missing, not a repo, client gone, model call failed
  USAGE: 2,         // called wrong
  NOTHING: 3,       // valid range, empty diff — nothing was reviewed
  OVERSIZE: 4,      // refused: more input than the model can be trusted to have read
};

const DEFAULTS = {
  // MEASURED, not guessed — see the conditions below, because this figure does not
  // travel. It compensates for an upstream gap: litert-lm 0.14.0's `serve` runs at a
  // fixed max_num_tokens=4096 and offers no flag to raise it and no way to ask what it
  // is, so the only way to learn the ceiling is to walk into it.
  //
  // Measured 2026-08-02 against litert-lm 0.14.0 serving qwen3-4b-instruct (GPU backend,
  // RTX 5070 Ti Laptop 12 GB), sending real git diffs to /v1/chat/completions in this
  // script's exact framing — SYSTEM above, the prompt in callModel, max_tokens 1200. The
  // largest diff accepted was 8,256 B for one, 7,168 B for a second, 6,656 B for a third.
  // The cap is on TOKENS, so the byte figure moves with how densely a diff tokenises;
  // 6 KiB is a round number below the tightest of those three, not the largest that
  // would have cleared them — 6,656 B also cleared all three, and the margin is
  // deliberate, since three diffs do not bound the fourth. An earlier 32 KiB here reasoned
  // about where a 4B model's *attention* thins out, which sat ~4x above the point where
  // the request fails outright.
  //
  // Lowering --max-tokens does not buy room (1200 -> 100 moved the ceiling ~256 B), so
  // treat max_num_tokens as a prompt budget with the reply on top, not a shared pool.
  //
  // Obsolete when `serve` can be told a token budget, or reports the one it has. The
  // unreleased 0.15.0 config (~/.litert-lm/config.json) carries a per-model
  // max_num_tokens; once that ships, re-measure rather than assuming this number rose.
  maxBytes: 6 * 1024,
  maxTokens: 1200,
};

/** Role stays stable; the task goes in the prompt (`litertlm-prompting`, rule 6). */
const SYSTEM = 'You are a concise code reviewer. Report only concrete defects: bugs, '
  + 'unhandled errors, security issues. Cite the file and line. If you find nothing, say so '
  + 'plainly. If you are unsure, say so rather than guessing.';

/** Bases worth trying for `--base auto`, and worth naming when a given base fails. */
const CANDIDATE_BASES = [
  'main', 'master', 'develop', 'trunk',
  'origin/main', 'origin/master', 'origin/develop',
];

class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const usage = (m) => new ExitError(EXIT.USAGE, m);

// Sub-kilobyte values matter here: a --max-bytes of 50 rendered as "0.0 KB" reads as
// a bug in the guard rather than as the number the caller passed.
const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * Run git and insist on its exit status.
 *
 * `allowFail` marks the calls whose failure IS the answer — "does this ref resolve?"
 * — and nothing else. Every other call aborts the run on a non-zero status, which is
 * the whole difference between this and a shell pipeline.
 */
function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    maxBuffer: 512 * 1024 * 1024,   // a branch diff can be large; ENOBUFS here would look like an empty diff
    windowsHide: true,
  });

  if (r.error) {
    if (r.error.code === 'ENOENT') {
      throw new ExitError(EXIT.ENVIRONMENT,
        `'git' was not found on PATH.\n`
        + '  This reads your diff with git. Install it, or run from a shell where git resolves.\n'
        + '  Check: git --version');
    }
    throw new ExitError(EXIT.ENVIRONMENT, `could not run git (${r.error.message}).`);
  }

  const stdout = r.stdout ?? Buffer.alloc(0);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString('utf8').trim();

  if (r.status !== 0 && !allowFail) {
    throw new ExitError(EXIT.ENVIRONMENT,
      `git ${args.join(' ')} failed (exit ${r.status}).${stderr ? `\n  ${stderr}` : ''}`);
  }
  return { status: r.status, stdout, text: stdout.toString('utf8'), stderr };
}

const resolves = (ref) =>
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }).status === 0;

const sharesHistory = (ref) =>
  git(['merge-base', ref, 'HEAD'], { allowFail: true }).status === 0;

function requireRepo() {
  const top = git(['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.status !== 0) {
    throw new ExitError(EXIT.ENVIRONMENT,
      `${process.cwd()} is not inside a git repository.\n`
      + '  Run this from the repository whose diff you want a second opinion on.');
  }
  if (!resolves('HEAD')) {
    throw new ExitError(EXIT.ENVIRONMENT,
      'this repository has no commits yet, so there is no HEAD to diff against.\n'
      + '  Commit something first, or review the files directly with litertlm-client.mjs.');
  }
  return top.text.trim();
}

/** The remote's default branch, if the clone recorded one. `origin/HEAD` is often absent. */
function originHead() {
  const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (r.status !== 0) return null;
  return r.text.trim().replace(/^refs\/remotes\//, '') || null;
}

const knownBases = () => {
  const head = originHead();
  const ordered = head ? [...CANDIDATE_BASES.slice(0, 4), head, ...CANDIDATE_BASES.slice(4)]
    : CANDIDATE_BASES;
  return [...new Set(ordered)].filter(resolves);
};

/**
 * Name what WOULD have worked. "main does not exist" is a dead end; "main does not
 * exist, master and origin/master do" is a fix.
 */
function baseHint() {
  const found = knownBases();
  return found.length
    ? `  Bases that resolve here: ${found.join(', ')}\n  Pass one with --base <ref>.`
    : '  No conventional base resolves here either. List yours with: git branch -a';
}

function resolveBase(requested) {
  if (requested !== 'auto') {
    if (!resolves(requested)) {
      throw new ExitError(EXIT.USAGE,
        `--base '${requested}' does not resolve to a commit in this repository.\n${baseHint()}`);
    }
    if (!sharesHistory(requested)) {
      // Without a merge base, `a...b` degenerates toward a whole-repository diff.
      throw new ExitError(EXIT.USAGE,
        `--base '${requested}' resolves, but shares no history with HEAD.\n`
        + '  A three-dot range needs a common ancestor; without one this would send far more\n'
        + '  than the changes you meant. Pick a base on the same history.\n'
        + baseHint());
    }
    return requested;
  }

  const picked = knownBases().find(sharesHistory);
  if (!picked) {
    throw new ExitError(EXIT.USAGE,
      '--base auto found no branch that both resolves here and shares history with HEAD.\n'
      + `  Tried: ${CANDIDATE_BASES.join(', ')}\n`
      + '  Name yours explicitly with --base <ref>.');
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ...DEFAULTS,
    base: null, staged: false, paths: [], focus: '',
    allowOversize: false, dryRun: false,
    model: null, port: null, action: 'review',
  };
  const rest = [];

  const needValue = (flag, value) => {
    if (value === undefined) throw usage(`${flag} requires a value`);
    return value;
  };
  /**
   * Reject an empty value for the flags that decide WHAT gets sent.
   *
   * `--base "$SOMEVAR"` with the variable unset arrives here as an empty string, which
   * is falsy — so `if (opts.base)` would skip the range entirely and quietly review the
   * working tree instead. The caller asked for a branch and would have got something
   * else with no error, which is the silently-wrong-range failure this script exists to
   * prevent. --focus is deliberately NOT in this set: review.md passes `--focus
   * "$ARGUMENTS"`, and an empty focus legitimately means "no focus".
   */
  const needNonEmpty = (flag, value) => {
    const v = needValue(flag, value);
    if (!v.trim()) {
      throw usage(`${flag} was given an empty value — an unset shell variable, most likely.\n`
        + '  Refusing rather than silently ignoring it and sending something you did not ask for.');
    }
    return v;
  };
  const needInt = (flag, value, min) => {
    const n = Number(needValue(flag, value));
    if (!Number.isInteger(n) || n < min) {
      throw usage(`${flag} requires an integer >= ${min} (got "${value}")`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base': opts.base = needNonEmpty(a, argv[++i]); break;
      case '--staged': opts.staged = true; break;
      case '--path': opts.paths.push(needNonEmpty(a, argv[++i])); break;
      case '--focus': opts.focus = needValue(a, argv[++i]); break;
      case '--max-bytes': opts.maxBytes = needInt(a, argv[++i], 1); break;
      case '--allow-oversize': opts.allowOversize = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--model': opts.model = needNonEmpty(a, argv[++i]); break;
      case '--max-tokens': opts.maxTokens = needInt(a, argv[++i], 1); break;
      case '--port': opts.port = needInt(a, argv[++i], 1); break;
      case '-h': case '--help': opts.action = 'help'; break;
      default:
        // An unknown flag must not become focus text. A silently-absorbed typo would
        // change what is reviewed without saying so.
        if (a.startsWith('-')) throw usage(`Unknown flag: ${a}`);
        rest.push(a);
    }
  }

  if (opts.base && opts.staged) {
    throw usage('--base and --staged name different ranges; pass one.');
  }

  const positional = rest.join(' ').trim();
  if (positional && opts.focus) {
    throw usage('focus given twice (--focus and a positional argument); pass one.');
  }
  opts.focus = opts.focus || positional;
  return opts;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function collectDiff(opts) {
  const pathspec = opts.paths.length ? ['--', ...opts.paths] : [];

  if (opts.staged) {
    return { range: 'staged changes (git diff --staged)', buf: git(['diff', '--staged', ...pathspec]).stdout };
  }
  if (opts.base) {
    const base = resolveBase(opts.base);
    const expr = `${base}...HEAD`;
    return { range: `${expr}${opts.base === 'auto' ? '  (--base auto chose this)' : ''}`, buf: git(['diff', expr, ...pathspec]).stdout };
  }
  return { range: 'uncommitted changes (git diff HEAD)', buf: git(['diff', 'HEAD', ...pathspec]).stdout };
}

/**
 * Files git can see but a diff against HEAD cannot.
 *
 * `git diff HEAD` compares tracked content only, so a brand-new file is invisible to it
 * — frequently the most review-worthy thing in the tree. Left unsaid, an untracked-only
 * working tree reports "nothing to review" while the new file sits there, and a mixed
 * tree produces a confident pass over everything except the new file. Both read as
 * fuller coverage than they are, which is the same defect as an unflagged oversized
 * diff, so it gets the same treatment: said out loud.
 *
 * Only meaningful for the working-tree range. Untracked files are by definition neither
 * staged nor in a committed range.
 */
function untrackedFiles(paths) {
  const args = ['ls-files', '--others', '--exclude-standard'];
  if (paths.length) args.push('--', ...paths);
  return git(args).text.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Per-file byte counts, taken from the diff text itself rather than a second git call,
 * so the numbers describe exactly what would be sent — binary stubs and all.
 */
function fileSizes(text) {
  return text.split(/^diff --git /m).slice(1).map((part) => {
    const header = part.slice(0, part.indexOf('\n'));
    const m = header.match(/ b\/(.*)$/);
    return {
      name: m ? m[1] : header.trim(),
      bytes: Buffer.byteLength(`diff --git ${part}`, 'utf8'),
    };
  }).sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Framing
//
// Principle I: this surface may not describe the model as reviewing or understanding
// a codebase, must tell the caller to verify, and must name the stronger tool. There
// is no agent on this path, so the script says it or nobody does.
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(76);

const OVERSIZE_STAMP = (bytes, limit) =>
  `!! PARTIAL COVERAGE: ${kb(bytes)} against a ${kb(limit)} guard, sent under\n`
  + '!! --allow-oversize. If a reply comes back, the model attended to as much as fit and\n'
  + '!! reports nothing about the rest — and neither the reply nor this script can tell you\n'
  + '!! which part. Treat silence about a file as no information.\n'
  + '!! Measured on LiteRT-LM 0.14.0, the likelier outcome is no reply at all: past its\n'
  + '!! limit the server breaks the HTTP response rather than answering from what it read.';

const FOOTER = [
  'What you just read came from a small on-device model given nothing but the diff text.',
  'It has no file access, no shell, no repository awareness, and no way to check itself.',
  '',
  'Before acting on any of it:',
  '  1. Open the file and check the claim. Expect most not to survive.',
  '  2. Count what you discarded. That number is how much to trust the rest.',
  '  3. Two failure modes dominate: confident objections to correct code, and generic',
  '     advice ("consider adding error handling") shaped like a specific finding.',
  '',
  'This was a free offline smoke pass, not a review. For anything that matters, follow it',
  'with a real one — Claude directly, or /code-review.',
].join('\n');

// ---------------------------------------------------------------------------

const HELP = `
litertlm-review — offline second-opinion pass over a diff, with no agent in the loop

Usage:
  node litertlm-review.mjs [options] ["<focus>"]

Range (default: uncommitted changes, matching /litertlm:review):
  --base <ref>        Review <ref>...HEAD. 'auto' picks the first conventional base
                      that resolves here and shares history with HEAD.
  --staged            Review staged changes only.
  --path <pathspec>   Narrow to a path. Repeatable.

Guards:
  --max-bytes <n>     Refuse a diff larger than this (default: ${DEFAULTS.maxBytes}).
  --allow-oversize    Send it anyway; the reply is stamped as partial coverage.
  --dry-run           Report the range and size, send nothing, start nothing.

Passed to the client:
  --model <id>        Model id (default: the client's — see Readiness below)
  --max-tokens <n>    Response cap (default: ${DEFAULTS.maxTokens})
  --port <n>          Server port
  -h, --help          This message

Exit codes:
  0 reviewed   1 environment failure   2 usage error
  3 nothing to review (empty diff)     4 refused as oversized

The model runs on this machine. Nothing in your diff leaves it.
Readiness:  node litertlm-client.mjs --check
`.trim();

// ---------------------------------------------------------------------------

/** Checked before any work, so a broken install is not reported halfway through a report. */
function requireClient() {
  if (existsSync(CLIENT)) return;
  throw new ExitError(EXIT.ENVIRONMENT,
    'the client this launcher drives is missing.\n'
    + `  Expected it at: ${CLIENT}\n`
    + '  It ships beside this script; a copy moved out of the plugin cannot work.\n'
    + '  Reinstall: /plugin install litertlm@litert-lm-local');
}

function callModel(opts, diffBuf) {
  const prompt = 'Review this diff. Put each defect on its own line, citing the file and line. '
    + 'If you find none, say so.'
    + (opts.focus ? ` Attend to this above all: ${opts.focus}` : '');

  const args = [CLIENT, '--system', SYSTEM, '--max-tokens', String(opts.maxTokens)];
  if (opts.model) args.push('--model', opts.model);
  if (opts.port) args.push('--port', String(opts.port));
  args.push(prompt);

  // execPath, not 'node': the runtime already running us is the one known to exist.
  // stderr is inherited so the client's own progress and diagnostics reach the user
  // unchanged; Ctrl-C reaches the child through the console group, where its existing
  // SIGINT handler releases the in-flight marker.
  const r = spawnSync(process.execPath, args, {
    input: diffBuf,
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (r.error) {
    throw new ExitError(EXIT.ENVIRONMENT, `could not run the client (${r.error.message}).`);
  }
  if (r.status !== 0) {
    // The client already explained itself on stderr; adding to it would only compete.
    // Its code is deliberately collapsed to ENVIRONMENT: the caller did not write that
    // invocation, so surfacing the client's exit 2 as "you called this wrong" would
    // point them at their own command line for a fault that is not there.
    throw new ExitError(EXIT.ENVIRONMENT, null);
  }
  return (r.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.action === 'help') { process.stdout.write(`${HELP}\n`); return; }

  requireClient();
  requireRepo();

  const { range, buf } = collectDiff(opts);
  const text = buf.toString('utf8');
  const bytes = buf.length;

  // Only the working-tree range can have a blind spot here; see untrackedFiles.
  const untracked = (!opts.staged && !opts.base) ? untrackedFiles(opts.paths) : [];
  const untrackedNote = untracked.length
    ? `${untracked.length} untracked file${untracked.length === 1 ? '' : 's'} `
      + `(${untracked.slice(0, 3).join(', ')}${untracked.length > 3 ? ', …' : ''})`
    : null;

  if (!text.trim()) {
    throw new ExitError(EXIT.NOTHING,
      `nothing to review — ${range} is empty.\n`
      + '  Stopping rather than asking the model about nothing: given an empty diff it will\n'
      + '  still answer, and that answer is indistinguishable from a clean pass.'
      + (opts.paths.length ? `\n  Your --path filter was: ${opts.paths.join(', ')}` : '')
      + (untrackedNote
        ? `\n\n  Not empty in the sense you may mean — here it found ${untrackedNote}.\n`
          + '  A diff against HEAD compares tracked content, so git cannot see them yet.\n'
          + '  Include them without committing:  git add -N <path>'
        : ''));
  }

  const files = fileSizes(text);
  const out = process.stdout;

  if (opts.dryRun) {
    out.write(`${RULE}\n`);
    out.write(`range    : ${range}\n`);
    if (opts.paths.length) out.write(`paths    : ${opts.paths.join(', ')}\n`);
    out.write(`files    : ${files.length}\n`);
    out.write(`size     : ${kb(bytes)} against a ${kb(opts.maxBytes)} guard\n`);
    if (untrackedNote) out.write(`excluded : ${untrackedNote} — invisible to a diff against HEAD\n`);
    for (const f of files.slice(0, 10)) out.write(`  ${kb(f.bytes).padStart(9)}  ${f.name}\n`);
    if (files.length > 10) out.write(`  ${' '.repeat(9)}  ... and ${files.length - 10} more\n`);
    out.write(`${RULE}\n`);
  }

  if (bytes > opts.maxBytes && !opts.allowOversize) {
    const top = files.slice(0, 5).map((f) => `    ${kb(f.bytes).padStart(9)}  ${f.name}`).join('\n');
    throw new ExitError(EXIT.OVERSIZE,
      `refusing to send ${kb(bytes)}; the guard is ${kb(opts.maxBytes)} `
      + `(${files.length} file${files.length === 1 ? '' : 's'}).\n`
      + '  Past its limit litert-lm 0.14.0 breaks the HTTP response rather than answering, so\n'
      + '  sending this would most likely just fail. Where a model truncates instead, it answers\n'
      + '  from the part it read and nothing here can tell you which part.\n\n'
      + `  Largest contributors:\n${top}\n\n`
      + '  Narrow it:   --path <pathspec>   (repeatable)\n'
      + '  Raise it:    --max-bytes <n>\n'
      + '  Send anyway: --allow-oversize    (the reply is then stamped partial)');
  }

  const oversize = bytes > opts.maxBytes;
  if (opts.dryRun) {
    out.write(oversize
      ? `${OVERSIZE_STAMP(bytes, opts.maxBytes)}\n`
      : 'within the guard — this would be sent.\n');
    return;
  }

  out.write(`${RULE}\n`);
  out.write(`local pass over ${range}\n`);
  out.write(`${files.length} file${files.length === 1 ? '' : 's'}, ${kb(bytes)}`);
  out.write(opts.focus ? `, focus: ${opts.focus}\n` : '\n');
  if (untrackedNote) {
    out.write(`NOT COVERED: ${untrackedNote} — untracked, so a diff against HEAD cannot see\n`);
    out.write('them. Silence about a new file below means it was never sent. git add -N to include.\n');
  }
  if (oversize) out.write(`\n${OVERSIZE_STAMP(bytes, opts.maxBytes)}\n`);
  out.write(`${RULE}\n\n`);

  const answer = callModel(opts, buf);

  if (!answer || answer === '(empty response)') {
    throw new ExitError(EXIT.ENVIRONMENT,
      'the model returned no text.\n'
      + '  This is not a clean pass — it is a failed one. Retry, or raise --max-tokens if the\n'
      + '  budget was spent before the first word (reasoning-variant models do this).');
  }

  if (answer.startsWith('[') && /"function"|"name"\s*:/.test(answer)) {
    // The client surfaces tool calls and executes nothing (FR-034). Say what happened
    // rather than letting a JSON blob read as findings.
    out.write('The model emitted a tool call rather than a reply. Nothing was executed:\n\n');
  }

  out.write(`${answer}\n\n`);
  out.write(`${RULE}\n`);
  if (oversize) out.write(`${OVERSIZE_STAMP(bytes, opts.maxBytes)}\n\n`);
  out.write(`${FOOTER}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof ExitError) {
    if (err.message) process.stderr.write(`[litertlm-review] ${err.message}\n`);
    process.exit(err.code);
  }
  process.stderr.write(`[litertlm-review] ${err.message}\n`);
  process.exit(EXIT.ENVIRONMENT);
}
