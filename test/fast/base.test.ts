// A named base carried into the snapshot (issue 70, spec B1 to B9): the name
// check, the refusals, what the stream carries and what it leaves out. Each
// refusal exits 125 with a plain message. Each test is named by the claim it
// backs; B1, B4, B6 and B7 have two each.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, BOOT, BOOT_BASE_SHA1, BOOT_BASE_SHA256 } from '#dist/index.js';
import type { RunOptions, RunResult } from '#dist/index.js';
import { parseArgs } from '#dist/cli.js';
import type { Call, TarEntry } from '../helpers.ts';
import { makeRepo, isolate, fake, uniquePrefix, withCommands, cli, git, writeFiles, callsOf, tempDir, tarNames, gitState } from '../helpers.ts';

async function runIn(t: TestContext, repo: string, extra: RunOptions = {}) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });
  return { result, calls: docker.calls() };
}

function assertRefused(result: RunResult, calls: Call[], pattern: RegExp) {
  assert.equal(result.outcome, 'error', JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  assert.match(result.message!, pattern);
  assert.equal(calls.length, 0, 'no Docker call at all');
}

// The control set (C0, DEL, C1, U+2028, U+2029, Unicode format characters):
// none may reach a message raw.
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/u;
const CONTROLS = [['ESC', '\u001b'], ['C1 CSI', '\u009b'], ['a bidi override', '\u202e']] as const;

// A repo whose check command names a base in its object form.
const withBase = (base: unknown) => withCommands({ test: ['true'], check: { argv: ['true'], base } });

test('B1 a base name that is not a plain ref name exits 125 naming the flag, or the file and key', async (t) => {
  const refused = ['', '-x', '--upload-pack=x', 'main~1', 'main^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'main@{1}', 'a..b', 'a b', 'a\u0007b'];
  for (const name of refused) {
    await t.test(`--base ${JSON.stringify(name)}`, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }) });
      const { result, calls } = await runIn(t, repo, { base: name });
      assertRefused(result, calls, /--base/);
      assert.doesNotMatch(result.message!, RAW_CONTROL);
    });
    await t.test(`commands.check.base ${JSON.stringify(name)}`, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: withBase(name) });
      const { result, calls } = await runIn(t, repo, { name: 'check' });
      assertRefused(result, calls, /commands\.check\.base/);
      assert.match(result.message!, /package\.json/, 'the message names the file');
      assert.doesNotMatch(result.message!, RAW_CONTROL);
    });
  }
  await t.test('a non-string key value', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { files: { 'athanor.json': JSON.stringify(withBase(3)) } });
    const { result, calls } = await runIn(t, repo, { name: 'check' });
    assertRefused(result, calls, /athanor\.json.*commands\.check\.base/);
  });
  await t.test('--base with no name after it, on the command line', () => {
    assert.throws(() => parseArgs(['run', '--base']), /--base needs/);
    assert.throws(() => parseArgs(['run', '--base', '-x']), /--base needs/);
  });
  for (const [label, c] of CONTROLS) {
    await t.test(`${label}, in each place a name comes from, never reaches a message raw`, async (t) => {
      const home = isolate(t);
      const asFlag = await runIn(t, makeRepo(t, { athanor: withCommands({ test: ['true'] }) }), { base: `a${c}b` });
      assertRefused(asFlag.result, asFlag.calls, /--base/);
      const asKey = await runIn(t, makeRepo(t, { athanor: withBase(`a${c}b`) }), { name: 'check' });
      assertRefused(asKey.result, asKey.calls, /commands\.check\.base/);
      const inKey = await runIn(t, makeRepo(t, { athanor: withCommands({ test: { argv: ['true'], [`x${c}`]: 1 } }) }));
      assertRefused(inKey.result, inKey.calls, /unknown key/);
      const inName = await runIn(t, makeRepo(t, { athanor: withCommands({ test: ['true'] }) }), { name: `n${c}` });
      assertRefused(inName.result, inName.calls, /no command named/);
      // A command the repo itself names with the character, reached three more ways.
      const named = makeRepo(t, { athanor: withCommands({ test: ['true'], [`n${c}`]: { argv: ['true'], memory: '64g' } }) });
      const extraWords = await runIn(t, named, { name: `n${c}`, extraNames: [`w${c}`] });
      assertRefused(extraWords.result, extraWords.calls, /takes one command name/);
      const notArgs = await runIn(t, named, { name: `n${c}`, args: ['x'] });
      assertRefused(notArgs.result, notArgs.calls, /does not take arguments/);
      const ceiling = await runIn(t, named, { name: `n${c}` });
      assertRefused(ceiling.result, ceiling.calls, /above the machine ceiling/);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ [`m${c}`]: 1 }));
      const machineKey = await runIn(t, makeRepo(t, { athanor: withCommands({ test: ['true'] }) }));
      assertRefused(machineKey.result, machineKey.calls, /unknown key/);
      for (const r of [asFlag, asKey, inKey, inName, extraWords, notArgs, ceiling, machineKey]) {
        assert.doesNotMatch(r.result.message!, RAW_CONTROL, r.result.message);
        assert.ok(r.result.message!.includes(`\\u{${c.codePointAt(0)!.toString(16)}}`), `shown escaped: ${r.result.message}`);
      }
    });
  }
  await t.test('the CLI prints a refused name escaped, on stderr and in --json', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }) });
    const r = await cli(['run', '--json', '--base', 'a\u009bb'], { cwd: repo });
    assert.equal(r.code, 125, r.stderr);
    assert.doesNotMatch(r.stderr, RAW_CONTROL);
    const json = JSON.parse(r.stdout);
    assert.doesNotMatch(json.message, RAW_CONTROL);
    assert.match(json.message, /\\u\{9b\}/);
  });
});

// A repo with history: the initial commit c0; main moves on to b1 and b2, with
// an annotated tag v1 at b1; the topic branch (checked out) moves on from c0 to
// t1. origin/main is a remote-tracking ref at b2. The merge base is c0.
function historyRepo(t: TestContext, athanor: unknown = withCommands({ test: ['true'], check: { argv: ['true'], base: 'origin/main' } })) {
  const repo = makeRepo(t, { athanor });
  const head = (): string => git(repo, ['rev-parse', 'HEAD']).trim();
  const commit = (file: string): string => {
    writeFiles(repo, { [file]: `${file}\n` });
    git(repo, ['add', '--', file]);
    git(repo, ['commit', '-q', '-m', file]);
    return head();
  };
  const c0 = head();
  const b1 = commit('b1.txt');
  git(repo, ['tag', '-a', '-m', 'v1', 'v1']);
  const b2 = commit('b2.txt');
  git(repo, ['update-ref', 'refs/remotes/origin/main', b2]);
  git(repo, ['checkout', '-q', '-b', 'topic', c0]);
  const t1 = commit('t1.txt');
  return { repo, c0, b1, b2, t1, commit };
}

test('B1 a base name is resolved to one branch, remote-tracking branch or tag, and anything else exits 125', async (t) => {
  const refusedAsFlag: Array<[string, (repo: string) => void, RegExp]> = [
    ['HEAD', () => {}, /^(?![\s\S]*refs\/heads\/HEAD)[\s\S]*--base/],
    ['@', () => {}, /^(?![\s\S]*refs\/heads\/@)[\s\S]*--base/],
    ['refs/stash', (repo) => { writeFiles(repo, { 't1.txt': 'edited\n' }); git(repo, ['stash', '-q']); }, /--base/],
    ['refs/heads/athanor', (repo) => git(repo, ['branch', 'athanor']), /reserved/],
    ['athanor/x', (repo) => git(repo, ['branch', 'athanor/x']), /reserved/],
    ['nope', () => {}, /fetch it, or name a ref that exists/],
    ['dup', (repo) => { git(repo, ['branch', 'dup']); git(repo, ['tag', 'dup']); git(repo, ['config', 'core.warnAmbiguousRefs', 'false']); }, /ambiguous/],
  ];
  for (const [name, setup, says] of refusedAsFlag) {
    await t.test(`--base ${name}`, async (t) => {
      isolate(t);
      const { repo } = historyRepo(t);
      setup(repo);
      const { result, calls } = await runIn(t, repo, { base: name });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message!, says);
      assert.equal(callsOf(calls, 'run').length, 0, 'no container');
      assert.equal(result.slot, undefined, 'no slot was taken');
    });
  }
  await t.test('a remote\'s HEAD that points at a branch whose name holds a bidi override', async (t) => {
    isolate(t);
    const { repo, b2 } = historyRepo(t);
    const bidi = String.fromCharCode(0x202e);
    git(repo, ['update-ref', `refs/remotes/origin/a${bidi}b`, b2]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/a${bidi}b`]);
    const { result, calls } = await runIn(t, repo, { base: 'origin/HEAD' });
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /control or invisible formatting character/);
    assert.doesNotMatch(result.message!, RAW_CONTROL);
    assert.equal('base' in result, false, 'no base in the result');
    assert.equal(callsOf(calls, 'run').length, 0, 'no container');
    assert.equal(result.slot, undefined, 'no slot was taken');
  });
  await t.test('an all-capitals tag gets advice that works, and a key is never told to name a local branch', async (t) => {
    isolate(t);
    const { repo, b2 } = historyRepo(t, withCommands({ test: ['true'], check: { argv: ['true'], base: 'RELEASE' } }));
    git(repo, ['tag', 'RELEASE', b2]);
    const asFlag = await runIn(t, repo, { base: 'RELEASE' });
    assert.equal(asFlag.result.exitCode, 125, JSON.stringify(asFlag.result));
    assert.match(asFlag.result.message!, /refs\/tags\/RELEASE/);
    const asKey = await runIn(t, repo, { name: 'check' });
    assert.equal(asKey.result.exitCode, 125, JSON.stringify(asKey.result));
    assert.match(asKey.result.message!, /refs\/tags\/RELEASE/);
    assert.doesNotMatch(asKey.result.message!, /refs\/heads\//, 'a key may not name a local branch, so it is never advised to');
    const followed = await runIn(t, repo, { base: 'refs/tags/RELEASE' });
    assert.equal(followed.result.outcome, 'pass', 'the advice works');
  });
  await t.test('a name that resolves through a symbolic ref is refused, naming the full ref to give', async (t) => {
    isolate(t);
    const { repo, b2 } = historyRepo(t, withCommands({ test: ['true'], check: { argv: ['true'], base: 'origin' } }));
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    for (const extra of [{ base: 'origin' }, { base: 'origin/HEAD' }, { name: 'check' }]) {
      const { result, calls } = await runIn(t, repo, extra);
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message!, /symbolic ref/);
      assert.match(result.message!, /refs\/remotes\/origin\/main/, 'it names the ref to give');
      assert.equal(callsOf(calls, 'run').length, 0, 'no container');
      assert.equal(result.slot, undefined, 'no slot was taken');
    }
    const direct = await runIn(t, repo, { base: 'origin/main' });
    assert.equal(direct.result.base?.tip, b2, 'the name it points at is taken');
  });
  await t.test('a raw commit id', async (t) => {
    isolate(t);
    const { repo, b2 } = historyRepo(t);
    const { result, calls } = await runIn(t, repo, { base: b2 });
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /--base/);
    assert.equal(callsOf(calls, 'run').length, 0, 'no container');
  });
  await t.test('a command\'s base naming a local branch is refused, while --base takes it', async (t) => {
    isolate(t);
    const { repo, b2, c0 } = historyRepo(t, withCommands({ test: ['true'], check: { argv: ['true'], base: 'main' } }));
    const asKey = await runIn(t, repo, { name: 'check' });
    assert.equal(asKey.result.exitCode, 125, JSON.stringify(asKey.result));
    assert.match(asKey.result.message!, /commands\.check\.base.*package\.json.*remote-tracking branch or a tag/);
    const asFlag = await runIn(t, repo, { name: 'check', base: 'main' });
    assert.equal(asFlag.result.outcome, 'pass', JSON.stringify(asFlag.result));
    assert.deepEqual(asFlag.result.base, { ref: 'refs/heads/main', tip: b2, mergeBase: c0 });
  });
  for (const [name, ref] of [['origin/main', 'refs/remotes/origin/main'], ['v1', 'refs/tags/v1']] as const) {
    await t.test(`${name} is taken from both the flag and the key`, async (t) => {
      isolate(t);
      const { repo, b1, b2, c0 } = historyRepo(t, withCommands({ test: ['true'], check: { argv: ['true'], base: name } }));
      const tip = name === 'v1' ? b1 : b2;
      for (const extra of [{ base: name }, { name: 'check' }]) {
        const { result } = await runIn(t, repo, extra);
        assert.equal(result.outcome, 'pass', JSON.stringify(result));
        assert.deepEqual(result.base, { ref, tip, mergeBase: c0 }, 'a tag is carried as its commit');
      }
    });
  }
});

test('B2 --base overrides a command\'s base, works with any command, and a key reaches only its own command', async (t) => {
  isolate(t);
  const { repo, b1, b2 } = historyRepo(t);
  const over = await runIn(t, repo, { name: 'check', base: 'v1' });
  assert.equal(over.result.base?.ref, 'refs/tags/v1', JSON.stringify(over.result));
  assert.equal(over.result.base?.tip, b1);
  const noKey = await runIn(t, repo, { name: 'test', base: 'origin/main' });
  assert.equal(noKey.result.base?.tip, b2, 'a named command with no base key');
  const whole = await runIn(t, repo, { command: ['true'], base: 'origin/main' });
  assert.equal(whole.result.base?.tip, b2, 'a command given whole after --');
  const other = await runIn(t, repo, { name: 'test' });
  assert.equal(other.result.outcome, 'pass');
  assert.equal('base' in other.result, false, 'the check command\'s key does not reach the test command');
});

test('B5 replace refs, grafts and inherited git settings do not change the merge base', async (t) => {
  isolate(t);
  const { repo, c0, t1, b1 } = historyRepo(t);
  // A replacement of t1 whose parent is b1, and a graft giving t1 the parent b1:
  // either one, if git honoured it, would move the merge base to b1.
  const tree = git(repo, ['rev-parse', `${t1}^{tree}`]).trim();
  const fakeT1 = git(repo, ['commit-tree', tree, '-p', b1, '-m', 'replacement']).trim();
  git(repo, ['replace', t1, fakeT1]);
  assert.equal(git(repo, ['merge-base', 'origin/main', 'HEAD']).trim(), b1, 'the host git sees the replacement');
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  writeFileSync(join(gitDir, 'info', 'grafts'), `${t1} ${b1}\n`);
  // A promisor setting in the inherited environment would make the repo look like a partial clone.
  const saved = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = "'remote.x.promisor'='true'";
  t.after(() => { if (saved === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = saved; });
  const { result } = await runIn(t, repo, { name: 'check' });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(result.base?.mergeBase, c0);
});

test('B7 a base that cannot be carried exits 125 before a slot is taken and before any container', async (t) => {
  const cases: Array<[string, (t: TestContext) => { repo: string; extra?: RunOptions }, RegExp]> = [
    ['a tracked .athanor-base', (t) => { const h = historyRepo(t); h.commit('.athanor-base'); return { repo: h.repo }; }, /\.athanor-base.*rename/i],
    ['an untracked .athanor-base with --untracked', (t) => { const h = historyRepo(t); writeFiles(h.repo, { '.athanor-base/x': 'x\n' }); return { repo: h.repo, extra: { untracked: true } }; }, /\.athanor-base.*rename/i],
    ['unrelated histories', (t) => {
      const h = historyRepo(t);
      git(h.repo, ['checkout', '-q', '--orphan', 'other']);
      git(h.repo, ['commit', '-q', '-m', 'unrelated']);
      return { repo: h.repo };
    }, /no merge base/i],
    ['a shallow host repo', (t) => {
      const h = historyRepo(t);
      const clone = tempDir(t, 'athanor-shallow-');
      git(clone, ['clone', '-q', '--depth', '1', '--branch', 'topic', `file://${h.repo}`, '.']);
      git(clone, ['update-ref', 'refs/remotes/origin/main', h.t1]);
      return { repo: clone };
    }, /shallow.*--unshallow/i],
    ['a partial clone', (t) => {
      const h = historyRepo(t);
      git(h.repo, ['config', 'uploadpack.allowFilter', 'true']);
      const clone = tempDir(t, 'athanor-partial-');
      git(clone, ['clone', '-q', '--filter=blob:none', '--branch', 'topic', `file://${h.repo}`, '.']);
      assert.equal(git(clone, ['config', '--type=bool', 'remote.origin.promisor']).trim(), 'true', 'the clone is partial');
      return { repo: clone };
    }, /partial clone/i],
    ['extensions.partialClone with no promisor remote', (t) => {
      const h = historyRepo(t);
      git(h.repo, ['config', 'extensions.partialClone', 'origin']);
      return { repo: h.repo };
    }, /partial clone/i],
    ['a promisor remote set by hand to yes', (t) => {
      const h = historyRepo(t);
      git(h.repo, ['config', 'remote.origin.promisor', 'yes']);
      return { repo: h.repo };
    }, /partial clone/i],
  ];
  for (const [label, setup, says] of cases) {
    await t.test(label, async (t) => {
      isolate(t);
      const { repo, extra } = setup(t);
      const before = git(repo, ['count-objects', '-v']);
      const { result, calls } = await runIn(t, repo, { base: 'origin/main', ...extra });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message!, says);
      assert.equal(callsOf(calls, 'run').length, 0, 'no container');
      assert.equal(result.slot, undefined, 'no slot was taken');
      assert.equal(git(repo, ['count-objects', '-v']), before, 'no object was fetched or written');
    });
  }
});

test('B8 a run with a base reports it on stderr and in the result', async (t) => {
  isolate(t);
  const { repo, b2, c0 } = historyRepo(t);
  const lines: string[] = [];
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), name: 'check', onProgress: (l) => lines.push(l) });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(result.schema, 1);
  assert.deepEqual(result.base, { ref: 'refs/remotes/origin/main', tip: b2, mergeBase: c0 });
  assert.ok(lines.includes(`base origin/main at ${b2.slice(0, 12)}, merge base ${c0.slice(0, 12)}.`), lines.join('\n'));
});

// The four files a run carried, read back from the stream the fake Docker saw.
function carried(calls: Call[]): { entries: TarEntry[]; files: Record<string, Buffer> } {
  const entries = callsOf(calls, 'run').at(-1)!.tar!;
  const files: Record<string, Buffer> = {};
  for (const e of entries) {
    if (e.type === '0' && e.name.startsWith('.athanor-base/')) files[e.name.slice('.athanor-base/'.length)] = Buffer.from(e.content!, 'base64');
  }
  return { entries, files };
}

// The carried files put into a fresh repo as the base boot script does, with
// host git: the pack, the shallow list, the refs, HEAD on refs/heads/athanor
// and the index read from the snapshot's tree.
function intoFreshRepo(t: TestContext, files: Record<string, Buffer>, format = 'sha1'): string {
  const dir = tempDir(t, 'athanor-fresh-');
  git(dir, ['init', '-q', `--object-format=${format}`]);
  const r = spawnSync('git', ['index-pack', '--stdin'], { cwd: dir, input: files.pack, shell: false });
  assert.equal(r.status, 0, String(r.stderr));
  const gitDir = join(dir, '.git');
  writeFileSync(join(gitDir, 'shallow'), files.shallow!);
  const u = spawnSync('git', ['update-ref', '--stdin'], { cwd: dir, input: files.refs, shell: false });
  assert.equal(u.status, 0, String(u.stderr));
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/athanor']);
  git(dir, ['read-tree', files.tree!.toString('utf8').trim()]);
  return dir;
}

// What a check that compares with the base asks git, inside and on the host.
// `path` is a file at the merge base; `atBase` one at the base's tip.
function sameAnswers(host: string, fresh: string, base: string, path: string, atBase = path): void {
  const mb = git(host, ['merge-base', base, 'HEAD']).trim();
  assert.equal(git(fresh, ['merge-base', base, 'HEAD']).trim(), mb, 'the same merge base');
  assert.equal(git(fresh, ['merge-base', '--all', base, 'HEAD']), git(host, ['merge-base', '--all', base, 'HEAD']), 'the same merge bases');
  assert.equal(git(fresh, ['show', `${mb}:${path}`]), git(host, ['show', `${mb}:${path}`]), 'the same file at the merge base');
  assert.equal(git(fresh, ['show', `${base}:${atBase}`]), git(host, ['show', `${base}:${atBase}`]), 'the same file at the base');
  assert.equal(git(fresh, ['fsck', '--connectivity-only', '--no-dangling']).trim(), '', 'a clean connectivity check');
}

test('B3 the carried files give the host\'s merge base, files and snapshot tree in a fresh repo', async (t) => {
  await t.test('a diverged branch', async (t) => {
    isolate(t);
    const { repo } = historyRepo(t);
    const { result, calls } = await runIn(t, repo, { name: 'check' });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    const fresh = intoFreshRepo(t, carried(calls).files);
    sameAnswers(repo, fresh, 'origin/main', 'package.json', 'b2.txt');
    assert.equal(git(fresh, ['write-tree']).trim(), git(repo, ['rev-parse', 'HEAD^{tree}']).trim(), 'the index is the snapshot\'s tree');
    assert.equal(git(fresh, ['rev-parse', 'refs/heads/athanor']).trim(), git(repo, ['rev-parse', 'HEAD']).trim());
  });
  await t.test('a base that merged a side line forking below the merge base', async (t) => {
    isolate(t);
    const { repo, commit, c0 } = historyRepo(t);
    git(repo, ['checkout', '-q', '-b', 'side', c0]);
    commit('s1.txt');
    git(repo, ['checkout', '-q', 'main']);
    const m1 = commit('m1.txt');
    git(repo, ['checkout', '-q', 'topic']);
    git(repo, ['rebase', '-q', m1]);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-edit', 'side']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', 'topic']);
    const { result, calls } = await runIn(t, repo, { name: 'check' });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.equal(result.base?.mergeBase, m1);
    const { files } = carried(calls);
    assert.ok(files.shallow!.toString('utf8').trim().split('\n').length >= 2, 'the side line\'s root is listed shallow too');
    sameAnswers(repo, intoFreshRepo(t, files), 'origin/main', 'm1.txt');
    assert.equal(git(intoFreshRepo(t, files), ['show', 'origin/main:s1.txt']), 's1.txt\n', 'the side line\'s file is at the base');
  });
  await t.test('a sha256 repo', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }), objectFormat: 'sha256' });
    const c0 = git(repo, ['rev-parse', 'HEAD']).trim();
    writeFiles(repo, { 'b.txt': 'b\n' });
    git(repo, ['add', 'b.txt']);
    git(repo, ['commit', '-q', '-m', 'b']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'topic', c0]);
    writeFiles(repo, { 't.txt': 't\n' });
    git(repo, ['add', 't.txt']);
    git(repo, ['commit', '-q', '-m', 't']);
    const { result, calls } = await runIn(t, repo, { base: 'origin/main' });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    sameAnswers(repo, intoFreshRepo(t, carried(calls).files, 'sha256'), 'origin/main', 'package.json', 'b.txt');
  });
  await t.test('HEAD an ancestor of the base, and the base an ancestor of HEAD', async (t) => {
    isolate(t);
    const { repo, b1 } = historyRepo(t);
    git(repo, ['checkout', '-q', '-B', 'topic', b1]);
    const behind = await runIn(t, repo, { name: 'check' });
    assert.equal(behind.result.base?.mergeBase, b1, JSON.stringify(behind.result));
    sameAnswers(repo, intoFreshRepo(t, carried(behind.calls).files), 'origin/main', 'b1.txt');
    git(repo, ['checkout', '-q', '-B', 'topic', 'origin/main']);
    writeFiles(repo, { 'ahead.txt': 'ahead\n' });
    git(repo, ['add', 'ahead.txt']);
    git(repo, ['commit', '-q', '-m', 'ahead']);
    const ahead = await runIn(t, repo, { name: 'check' });
    sameAnswers(repo, intoFreshRepo(t, carried(ahead.calls).files), 'origin/main', 'b2.txt');
  });
  await t.test('two merge bases', async (t) => {
    isolate(t);
    const { repo, commit, c0 } = historyRepo(t);
    git(repo, ['checkout', '-q', '-b', 'x', c0]);
    const x1 = commit('x1.txt');
    git(repo, ['checkout', '-q', '-b', 'y', c0]);
    const y1 = commit('y1.txt');
    git(repo, ['checkout', '-q', 'x']);
    git(repo, ['merge', '-q', '--no-edit', y1]);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', 'y']);
    git(repo, ['merge', '-q', '--no-edit', x1]);
    assert.equal(git(repo, ['merge-base', '--all', 'origin/main', 'HEAD']).trim().split('\n').length, 2, 'the fixture has two merge bases');
    const { result, calls } = await runIn(t, repo, { name: 'check' });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    sameAnswers(repo, intoFreshRepo(t, carried(calls).files), 'origin/main', 'package.json');
  });
  await t.test('a run from a linked worktree', async (t) => {
    isolate(t);
    const { repo } = historyRepo(t);
    const linked = join(tempDir(t, 'athanor-linked-'), 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked, 'topic']);
    const { result, calls } = await runIn(t, linked, { name: 'check' });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    sameAnswers(linked, intoFreshRepo(t, carried(calls).files), 'origin/main', 'package.json', 'b2.txt');
  });
  await t.test('a tracked file that .gitignore matches, an uncommitted edit and an untracked file', async (t) => {
    isolate(t);
    const { repo } = historyRepo(t);
    writeFiles(repo, { '.gitignore': 'ignored.txt\n', 'ignored.txt': 'kept\n' });
    git(repo, ['add', '-f', '.gitignore', 'ignored.txt']);
    git(repo, ['commit', '-q', '-m', 'files']);
    const clean = await runIn(t, repo, { name: 'check' });
    assert.equal(clean.result.outcome, 'pass', JSON.stringify(clean.result));
    const fresh = intoFreshRepo(t, carried(clean.calls).files);
    assert.equal(git(fresh, ['write-tree']).trim(), git(repo, ['rev-parse', 'HEAD^{tree}']).trim(), 'the ignored file is in the index as committed');
    writeFiles(repo, { 't1.txt': 'edited\n' });
    const stashed = await runIn(t, repo, { name: 'check' });
    assert.equal(stashed.result.outcome, 'pass', JSON.stringify(stashed.result));
    const stashFiles = carried(stashed.calls).files;
    assert.equal(stashFiles.refs!.toString('utf8').split('\n')[1], `update refs/heads/athanor ${git(repo, ['rev-parse', 'HEAD']).trim()}`, 'the snapshot sits on the host\'s HEAD, not on the stash commit');
    assert.equal(git(intoFreshRepo(t, stashFiles), ['show', ':t1.txt']), 'edited\n', 'the uncommitted edit is in the index');
    writeFiles(repo, { 'new.txt': 'new\n' });
    const edited = await runIn(t, repo, { name: 'check', untracked: true });
    assert.equal(edited.result.outcome, 'pass', JSON.stringify(edited.result));
    const inside = intoFreshRepo(t, carried(edited.calls).files);
    assert.equal(git(inside, ['show', ':t1.txt']), 'edited\n', 'the uncommitted edit is in the index');
    assert.equal(git(inside, ['show', ':new.txt']), 'new\n', 'the untracked file is in the index');
    assert.equal(git(inside, ['show', ':ignored.txt']), 'kept\n');
  });
});

test('B4 with a base the stream carries exactly four more files, and only the carried commits\' objects', async (t) => {
  isolate(t);
  const { repo, commit, c0, b1, b2 } = historyRepo(t);
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const MARK = 'zq-marker-';
  git(repo, ['remote', 'add', 'other', `https://${MARK}remote.example/x.git`]);
  writeFileSync(join(gitDir, 'hooks', 'pre-commit'), `#!/bin/sh\necho ${MARK}hook\n`);
  git(repo, ['config', 'athanor.test', `${MARK}config`]);
  writeFiles(repo, { 't1.txt': `${MARK}stash\n` });
  git(repo, ['stash', '-q']);
  commit(`${MARK}reflog.txt`);
  git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
  git(repo, ['notes', 'add', '-m', `${MARK}note`, 'HEAD']);
  git(repo, ['branch', 'outside', c0]);
  git(repo, ['checkout', '-q', 'outside']);
  commit(`${MARK}outside.txt`);
  git(repo, ['checkout', '-q', 'topic']);

  const without = await runIn(t, repo, { name: 'test' });
  const plain = tarNames(callsOf(without.calls, 'run').at(-1)!.tar!);
  const { result, calls } = await runIn(t, repo, { name: 'check' });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const { entries, files } = carried(calls);
  assert.deepEqual(tarNames(entries), [...plain, '.athanor-base/pack', '.athanor-base/refs', '.athanor-base/shallow', '.athanor-base/tree'].sort());
  assert.ok(!plain.some((n) => n.startsWith('.athanor-base')), 'a run without a base carries none of them');

  const fresh = intoFreshRepo(t, files);
  const kinds = new Set(git(fresh, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)']).trim().split('\n'));
  assert.deepEqual([...kinds].sort(), ['blob', 'commit', 'tree'], 'only commit, tree and blob objects');
  const packed = git(fresh, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)']).trim().split('\n')
    .filter((l) => l.startsWith('commit ')).map((l) => l.slice(7)).sort();
  const expected = [...git(repo, ['rev-list', b2, 'HEAD', '--not', c0]).trim().split('\n'), c0].sort();
  assert.deepEqual(packed, expected, 'the commits are exactly the carried set');
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  assert.equal(files.refs!.toString('utf8'), `update refs/remotes/origin/main ${b2}\nupdate refs/heads/athanor ${head}\n`);
  assert.ok(b1 && packed.includes(b1));
  const everything = git(fresh, ['cat-file', '--batch-all-objects', '--batch']);
  assert.ok(!everything.includes(MARK), 'no marker in any carried object');
  const rest = entries.filter((e) => e.type === '0' && e.name !== '.athanor-base/pack').map((e) => Buffer.from(e.content!, 'base64').toString('utf8')).join('\n');
  assert.ok(!rest.includes(MARK), 'no marker anywhere else in the stream');
});

test('B6 without a base the stream, the boot script and the result are as they were', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }), files: { '.athanor-base/x': 'x\n' } });
  const { result, calls } = await runIn(t, repo);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal('base' in result, false);
  const run1 = callsOf(calls, 'run').at(-1)!;
  assert.deepEqual(tarNames(run1.tar!), ['.athanor-base/x', 'package.json', 'test/Dockerfile'], 'a tracked .athanor-base rides as any file');
  assert.equal(run1.args[run1.args.indexOf('-c') + 1], BOOT, 'the boot script is BOOT');
});

test('B6 with a base the boot script is the fixed one for the repo\'s object format', async (t) => {
  for (const [format, script] of [['sha1', BOOT_BASE_SHA1], ['sha256', BOOT_BASE_SHA256]] as const) {
    await t.test(format, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }), objectFormat: format });
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      const { result, calls } = await runIn(t, repo, { base: 'origin/main' });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      const args = callsOf(calls, 'run').at(-1)!.args;
      assert.equal(args[args.indexOf('-c') + 1], script);
      assert.notEqual(script, BOOT);
    });
  }
});

test('B9 a run with a base leaves the repo as it was and no scratch folder behind', async (t) => {
  const home = isolate(t);
  const { repo } = historyRepo(t);
  writeFiles(repo, { 't1.txt': 'edited\n' });
  const before = gitState(repo);
  const { result } = await runIn(t, repo, { name: 'check' });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.deepEqual(gitState(repo), before, 'stash, index, status, refs and objects are unchanged');
  assert.deepEqual(readdirSync(join(home, 'runs')), [], 'no scratch folder is left');

  // The copy of the history goes as soon as the stream is written, while the container still runs.
  const folder = tempDir(t, 'athanor-pack-');
  writeFileSync(join(folder, 'keep.txt'), 'kept\n');
  const hanging = fake(t, { run: { hangMs: 3000 } });
  const running = run({ cwd: repo, docker: hanging.docker, prefix: uniquePrefix(), name: 'check', basePackFolder: folder });
  let done = false;
  void running.then(() => { done = true; });
  const deadline = Date.now() + 20_000;
  while (existsSync(join(folder, 'pack')) || callsOf(hanging.calls(), 'run').length === 0) {
    assert.ok(Date.now() < deadline, 'the pack is removed once streamed');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(done, false, 'the pack went before the run ended');
  assert.equal((await running).outcome, 'pass');
  assert.ok(existsSync(join(folder, 'keep.txt')), 'only the four files are removed, not the folder they were written in');
});

test('B7 a failure while building the pack exits 125, frees the slot and leaves no scratch folder', async (t) => {
  // One slot, so a slot the failed run kept would hold the next run until its timer.
  const home = isolate(t, { ATHANOR_MAX_RUNS: '1' });
  const { repo } = historyRepo(t);
  const docker = fake(t);
  const prefix = uniquePrefix();
  // A file where the pack's folder should be, so pack-objects cannot write.
  const blocked = join(tempDir(t, 'athanor-blocked-'), 'file');
  writeFileSync(blocked, '');
  const result = await run({ cwd: repo, docker: docker.docker, prefix, name: 'check', basePackFolder: blocked });
  assert.equal(result.exitCode, 125, JSON.stringify(result));
  assert.match(result.message!, /pack/);
  assert.equal(callsOf(docker.calls(), 'run').length, 0, 'no container');
  assert.deepEqual(readdirSync(join(home, 'runs')), [], 'no scratch folder is left');
  const again = await run({ cwd: repo, docker: docker.docker, prefix, name: 'check', signal: AbortSignal.timeout(30_000) });
  assert.equal(again.outcome, 'pass', `the slot was freed: ${JSON.stringify(again)}`);
  assert.equal(again.slot, 1);
  // A folder where the pack file should land, so the step that writes the four files fails.
  const taken = tempDir(t, 'athanor-taken-');
  writeFiles(taken, { 'pack/held': 'x\n' });
  const files = await run({ cwd: repo, docker: docker.docker, prefix, name: 'check', basePackFolder: taken, signal: AbortSignal.timeout(30_000) });
  assert.equal(files.exitCode, 125, JSON.stringify(files));
  assert.match(files.message!, /could not write the base's pack/);
  assert.equal(files.message!.includes(taken), false, 'the message names no path');
  assert.deepEqual(readdirSync(join(home, 'runs')), [], 'no scratch folder is left');
});

test('B4 a repo that limits its pack size still carries one pack', async (t) => {
  isolate(t);
  const { repo, commit } = historyRepo(t);
  writeFileSync(join(repo, 'big.bin'), randomBytes(3 * 1024 * 1024));
  git(repo, ['add', 'big.bin']);
  git(repo, ['commit', '-q', '-m', 'big']);
  commit('after.txt');
  git(repo, ['config', 'pack.packSizeLimit', '1m']);
  const { result, calls } = await runIn(t, repo, { name: 'check' });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const { files } = carried(calls);
  assert.equal(git(intoFreshRepo(t, files), ['cat-file', '-t', 'HEAD:big.bin']).trim(), 'blob', 'the large file is in the one pack');
});
