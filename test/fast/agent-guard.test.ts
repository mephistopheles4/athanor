// The agent test hook (ADR 0024): .claude/hooks/athanor-guard.mjs refuses a
// host run of the fast tier while athanor is on the machine, and the runner
// takes --host-fallback=<reason> as the named way out. Claims H1 to H4 are in
// the PR that added the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = join(root, '.claude', 'hooks', 'athanor-guard.mjs');
const runner = join(root, 'test', 'run.mjs');

// A folder that holds an athanor the probe finds and runs, printing a version,
// in the shape an npm global install leaves on this platform.
function fakeAthanor(dir: string): string {
  const pkg = join(dir, 'node_modules', '@mephistopheles4', 'athanor', 'bin');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'athanor.mjs'), "console.log('0.1.0');\n");
  if (process.platform === 'win32') writeFileSync(join(dir, 'athanor.cmd'), '@echo off\r\n');
  else {
    writeFileSync(join(dir, 'athanor'), `#!${process.execPath}\nconsole.log('0.1.0');\n`);
    chmodSync(join(dir, 'athanor'), 0o755);
  }
  return dir;
}

function runHook(input: unknown, path: string, cwd?: string): string {
  const env = { ...process.env, PATH: path, Path: path };
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), env, cwd, encoding: 'utf8', shell: false });
  assert.equal(r.status, 0, 'the hook always exits 0');
  assert.equal(r.stderr, '');
  return r.stdout;
}

const call = (command: string, tool = 'Bash') => ({ tool_name: tool, tool_input: { command } });

test('H1 a host run of the fast tier is refused while athanor is on the machine', (t) => {
  const path = fakeAthanor(tempDir(t));
  for (const [command, tool] of [
    ['node test/run.mjs fast', 'Bash'],
    ['cd x && node ./test/run.mjs fast run', 'Bash'],
    ['node test\\run.mjs fast', 'PowerShell'],
    ['npm ci; & node test/run.mjs fast', 'PowerShell'],
    ['npm ci; node test/run.mjs fast', 'Bash'],
    ['nohup node test/run.mjs fast', 'Bash'],
  ]) {
    const out = JSON.parse(runHook(call(command!, tool), path));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /athanor run fast/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /--host-fallback=/);
  }
});

test('H2 everything else passes in silence: no athanor, the docker tier, a named fallback, other commands, bad input', (t) => {
  const path = fakeAthanor(tempDir(t));
  const none = tempDir(t);
  assert.equal(runHook(call('node test/run.mjs fast'), none), '', 'athanor missing');
  // A relative entry that would find an athanor from the working folder is never searched.
  const here = tempDir(t);
  fakeAthanor(join(here, 'rel'));
  assert.equal(runHook(call('node test/run.mjs fast'), 'rel', here), '', 'a relative PATH entry is not searched');
  for (const command of [
    'node test/run.mjs docker',
    "node test/run.mjs fast --host-fallback='docker is stopped'",
    'athanor run fast',
    "echo 'x; node test/run.mjs fast'",
    'echo "x && node test/run.mjs fast"',
    'node scripts/check-source.mjs',
  ]) assert.equal(runHook(call(command), path), '', command);
  assert.equal(runHook({ tool_name: 'Read', tool_input: { command: 'node test/run.mjs fast' } }, path), '');
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8', shell: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('H3 the runner takes --host-fallback=<reason> on the fast tier only, prints it, and refuses a bad reason without echoing it', (t) => {
  const runs = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', shell: false });
  // A copy with no build script beside it prints the reason, then fails at
  // the build, so this repo's dist/ is never rebuilt under the running tests.
  const copy = join(tempDir(t), 'test', 'run.mjs');
  mkdirSync(dirname(copy));
  copyFileSync(runner, copy);
  const ok = spawnSync(process.execPath, [copy, 'fast', '--host-fallback=docker is stopped'], { encoding: 'utf8', shell: false });
  assert.match(ok.stdout, /^host fallback: docker is stopped$/m);
  for (const [args, why] of [
    [['fast', '--host-fallback'], /after =/],
    [['fast', '--host-fallback='], /needs a reason/],
    [['fast', '--host-fallback=see C:\\secret\\path'], /plain words/],
    [['fast', '--host-fallback=docker', 'is', 'stopped'], /quote/],
    [['fast', '--host-fallback=no', 'docker'], /quote/],
    [['fast', '--host-fallback=a supercalifragilisticexpia word'], /plain words/],
    [['fast', `--host-fallback=${'word '.repeat(17)}`], /plain words/],
    [['docker', '--host-fallback=docker is stopped'], /fast tier only/],
  ] as const) {
    const r = runs(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, why);
    assert.doesNotMatch(r.stdout + r.stderr, /secret/);
  }
});

test('H4 the tracked settings file runs the hook before every Bash and PowerShell call, and holds nothing else', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings), ['hooks']);
  const [entry] = settings.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Bash|PowerShell');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/athanor-guard.mjs'], timeout: 15 }]);
});
