// The archive step carries the tree as committed (spec on issue 20, ADR 0020):
// no content filter runs, the tree's own attributes still apply, and no
// repository location from the host reaches the archive folder. Each test puts
// the host settings it needs in its own environment and temporary files, set
// after its repo is made and restored afterwards.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, cpSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf, tarFile, git, tempDir } from '../helpers.ts';
import type { TarEntry, Fake } from '../helpers.ts';

const runWith = (repo: string, docker: Fake) => run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
const lastRunTar = (docker: Fake): TarEntry[] => callsOf(docker.calls(), 'run').at(-1)!.tar!;
const lastBuildTar = (docker: Fake): TarEntry[] => callsOf(docker.calls(), 'build').at(-1)!.tar!;
const tarBytes = (entries: TarEntry[], name: string): Buffer => Buffer.from(entries.find((e) => e.name === name && e.type === '0')!.content!, 'base64');

// Set environment values for one test, and put the old ones back after it.
function setEnv(t: TestContext, values: Record<string, string>): void {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

// A file of git config, in a temporary folder.
function configFile(t: TestContext, text: string): string {
  const file = join(tempDir(t, 'athanor-gitconfig-'), 'config');
  writeFileSync(file, text);
  return file;
}

test('G2 a repository location from the host never reaches the archive folder', async (t) => {
  const rows: { name: string; env: (repo: string, copy: string) => Record<string, string> }[] = [
    { name: 'GIT_COMMON_DIR naming the repo\'s own git folder', env: (repo) => ({ GIT_COMMON_DIR: join(repo, '.git') }) },
    {
      name: 'GIT_COMMON_DIR naming a copy of the repo\'s git folder whose config defines the filter',
      env: (_repo, copy) => ({ GIT_COMMON_DIR: copy }),
    },
    { name: 'GIT_WORK_TREE naming the repo', env: (repo) => ({ GIT_WORK_TREE: repo }) },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, {
        athanor: baseConfig,
        files: { '.gitattributes': '*.txt filter=up\n', 'test/.gitattributes': '*.txt filter=up\n', 'a.txt': 'hello\n', 'test/b.txt': 'build\n' },
      });
      // A smudge command git runs through its shell: it writes a marker file,
      // with the path in forward slashes so Git for Windows' sh reads it.
      const mark = join(tempDir(t, 'athanor-marker-'), 'ran');
      const copy = join(tempDir(t, 'athanor-common-'), 'git');
      cpSync(join(repo, '.git'), copy, { recursive: true });
      appendFileSync(join(copy, 'config'), `[filter "up"]\n\tsmudge = "echo ran >> '${fwd(mark)}'; tr a-z A-Z"\n`);
      const config = readFileSync(join(repo, '.git', 'config'), 'utf8');
      setEnv(t, row.env(repo, copy));
      const docker = fake(t);
      const result = await runWith(repo, docker);
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.equal(readFileSync(join(repo, '.git', 'config'), 'utf8'), config, 'the repo\'s config is not written');
      assert.equal(tarFile(lastRunTar(docker), 'a.txt'), 'hello\n', 'the snapshot carries the committed bytes');
      assert.equal(tarFile(lastBuildTar(docker), 'b.txt'), 'build\n', 'the build context carries the committed bytes');
      assert.equal(existsSync(mark), false, 'the filter never ran');
    });
  }
});

test('G5 a required filter whose smudge always fails does not fail the run, and the file arrives as committed', async (t) => {
  isolate(t);
  const repo = makeRepo(t, {
    athanor: baseConfig,
    files: { '.gitattributes': '*.bin filter=store\n', 'test/.gitattributes': '*.bin filter=store\n', 'big.bin': 'pointer\n', 'test/c.bin': 'pointer\n' },
  });
  // The shape of Git LFS with no store: a pass-through clean, a smudge that fails, and required.
  setEnv(t, { GIT_CONFIG_GLOBAL: configFile(t, '[filter "store"]\n\tclean = cat\n\tsmudge = false\n\trequired = true\n') });
  const docker = fake(t);
  const result = await runWith(repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(lastRunTar(docker), 'big.bin'), 'pointer\n');
  assert.equal(tarFile(lastBuildTar(docker), 'c.bin'), 'pointer\n');
});

test('G6 the tree\'s own ident and working-tree-encoding attributes still apply', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { '.gitattributes': '*.id ident\nenc.txt working-tree-encoding=UTF-16LE\n', 'v.id': '$Id$\n' } });
  // The work tree holds the encoded form; git stores it as UTF-8.
  writeFileSync(join(repo, 'enc.txt'), Buffer.from('plain\n', 'utf16le'));
  git(repo, ['add', 'enc.txt']);
  git(repo, ['commit', '-q', '-m', 'encoded']);
  const blob = git(repo, ['rev-parse', 'HEAD:v.id']).trim();
  const docker = fake(t);
  const result = await runWith(repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(lastRunTar(docker), 'v.id'), `$Id: ${blob} $\n`);
  assert.deepEqual(tarBytes(lastRunTar(docker), 'enc.txt'), Buffer.from('plain\n', 'utf16le'));
});

