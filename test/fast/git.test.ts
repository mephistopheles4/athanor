// git owns the tar stream of a commit (spec on issue 8, candidate 3): where
// its pinned settings live, and that they hold against the git configuration
// the archive does read. The archive runs in athanor's own git folder, so it
// never reads the repo's config; global config and the -c pins do apply.
// One top-level test per acceptance claim, and one for the stream's pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TarEntry } from '../helpers.ts';
import { run } from '#dist/index.js';
import { isolate, makeRepo, fake, uniquePrefix, baseConfig, callsOf, tarFile, tempDir } from '../helpers.ts';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

test('T11 git keeps its archive settings private, and the core gets the tar stream of a commit from git', async (t) => {
  isolate(t);
  const git = await import('#dist/git.js');
  assert.deepEqual(Object.keys(git).sort(), ['buildContext', 'clearStale', 'makeScratch', 'repoRoot', 'snapshot', 'tarStream'],
    'git exports these functions and no archive setting; a new export must keep the settings private');
  assert.equal(typeof git.tarStream, 'function');
  // Only the compiled git module starts git archive or names its settings.
  const startsArchive = /['"`](archive|core\.autocrlf=false|core\.eol=lf|tar\.umask=0022)['"`]/;
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
  assert.ok(modes(snapshot).every((m) => /664$/.test(m)), `the snapshot takes git's umask, unpinned: ${modes(snapshot)}`);
});
