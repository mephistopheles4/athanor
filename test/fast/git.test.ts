// git owns the tar stream of a commit (spec on issue 8, candidate 3): where
// its pinned settings live, and that they hold against a hostile global git
// config. The archive runs in athanor's own git folder in a clean environment
// (ADR 0020), so it reads neither the repo's config nor the global one; only
// that folder and the -c pins apply.
// One top-level test per acceptance claim, and one for the stream's pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TarEntry } from '../helpers.ts';
import { run } from '#dist/index.js';
import { isolate, makeRepo, fake, uniquePrefix, baseConfig, callsOf, tarFile, tempDir, writeFiles, git, gitState } from '../helpers.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

test('T11 git keeps its archive settings private, and the core gets the tar stream of a commit from git', async (t) => {
  isolate(t);
  const git = await import('#dist/git.js');
  assert.deepEqual(Object.keys(git).sort(), ['buildContext', 'clearStale', 'makeScratch', 'packBase', 'repoRoot', 'resolveBase', 'snapshot', 'tarStream'],
    'git exports these functions and no archive setting; a new export must keep the settings private');
  assert.equal(typeof git.tarStream, 'function');
  // Only the compiled git module starts git archive or names its settings.
  const startsArchive = /['"`](archive|core\.autocrlf=false|core\.eol=lf|tar\.umask=0022|tar\.umask=0002|\* -export-ignore -export-subst -filter\\n)['"`]|['"`]core\.attributesFile=/;
  const compiled = readdirSync(dist).filter((f) => /\.m?js$/.test(f));
  assert.ok(compiled.includes('git.js'));
  for (const file of compiled) {
    const text = readFileSync(join(dist, file), 'utf8');
    assert.equal(startsArchive.test(text), file === 'git.js', `${file} ${file === 'git.js' ? 'starts' : 'does not start'} git archive`);
  }
});

test('T11 the tar streams keep their pinned line endings and file modes against the global git config', async (t) => {
  isolate(t);
  const repo = makeRepo(t, {
    athanor: baseConfig,
    files: { '.gitattributes': '* text\n', 'test/.gitattributes': '* text\n', 'test/lf.sh': 'one\ntwo\n', 'run.sh': 'a\nb\n' },
  });
  // Settings that would give CRLF and group-writable files if a pin were lost.
  const global = join(tempDir(t), 'gitconfig');
  writeFileSync(global, '[core]\n\tautocrlf = true\n\teol = crlf\n[tar]\n\tumask = 0002\n');
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const snapshot = callsOf(docker.calls(), 'run').at(-1)!.tar!;
  const build = callsOf(docker.calls(), 'build').at(-1)!.tar!;
  assert.equal(tarFile(snapshot, 'run.sh'), 'a\nb\n', 'the snapshot keeps LF');
  assert.equal(tarFile(build, 'lf.sh'), 'one\ntwo\n', 'the build context keeps LF');
  const modes = (entries: TarEntry[]) => entries.filter((e) => e.type === '0').map((e) => e.mode);
  assert.ok(modes(build).every((m) => /644$/.test(m)), `the build context pins its file modes (ADR 0006): ${modes(build)}`);
  assert.ok(modes(snapshot).every((m) => /664$/.test(m)), `the snapshot pins git's default umask (ADR 0020): ${modes(snapshot)}`);
});

// A file staged with `git add -N` (intent to add) made every run exit 125
// ("not uptodate"); issue 46, spec M8 and M9. The snapshot holds it at its
// working-tree content, and the repo's own state does not change (ADR 0007).
test('M8 a file added with git add -N is in the snapshot at its working-tree content, and the repo is unchanged', async (t) => {
  const rows: { name: string; config: Record<string, unknown>; setup: Record<string, string>; modified: boolean; untracked: boolean; red: boolean }[] = [
    { name: 'a -N file alone', config: baseConfig, setup: { 'new.txt': 'intent\n' }, modified: false, untracked: false, red: true },
    { name: 'a -N file beside a modified file', config: baseConfig, setup: { 'new.txt': 'intent\n' }, modified: true, untracked: false, red: true },
    { name: 'a -N file under context, also in the build tar', config: { ...baseConfig, context: 'test' }, setup: { 'test/new.txt': 'intent\n' }, modified: false, untracked: false, red: true },
    // The --untracked path builds a fresh index, so this row is a guard and is green on the base.
    { name: 'a -N file with --untracked', config: baseConfig, setup: { 'new.txt': 'intent\n' }, modified: false, untracked: true, red: false },
  ];
  for (const row of rows) {
    await t.test(`${row.name}${row.red ? '' : ' (guard)'}`, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: row.config, files: { 'tracked.txt': 'one\n' } });
      writeFiles(repo, row.setup);
      const [path] = Object.keys(row.setup);
      git(repo, ['add', '-N', '--', path]);
      // A different length, so git's stat check sees the change at once.
      if (row.modified) writeFiles(repo, { 'tracked.txt': 'changed longer\n' });
      const before = gitState(repo);
      const docker = fake(t);
      const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), untracked: row.untracked });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      const snapshot = callsOf(docker.calls(), 'run').at(-1)!.tar!;
      assert.equal(tarFile(snapshot, path), 'intent\n', 'the snapshot holds the -N file at its working-tree content');
      if (row.modified) assert.equal(tarFile(snapshot, 'tracked.txt'), 'changed longer\n');
      if (row.config.context !== undefined) {
        const build = callsOf(docker.calls(), 'build').at(-1)!.tar!;
        assert.equal(tarFile(build, 'new.txt'), 'intent\n', 'the build context holds the -N file under context');
      }
      assert.deepEqual(gitState(repo), before, 'the index file, status, refs and stash list are unchanged');
    });
  }
});

test('M9 a -N file since deleted is in neither tar, and the run passes', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: { ...baseConfig, context: 'test' }, files: { 'tracked.txt': 'one\n' } });
  writeFiles(repo, { 'test/gone.txt': 'intent\n', 'gone.txt': 'intent\n' });
  git(repo, ['add', '-N', '--', 'test/gone.txt', 'gone.txt']);
  unlinkSync(join(repo, 'test', 'gone.txt'));
  unlinkSync(join(repo, 'gone.txt'));
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(callsOf(docker.calls(), 'run').at(-1)!.tar!, 'gone.txt'), undefined);
  assert.equal(tarFile(callsOf(docker.calls(), 'build').at(-1)!.tar!, 'gone.txt'), undefined);
});
