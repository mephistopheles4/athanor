// An outside configuration's build (ATH-11, docs/spec/0001-outside-configuration.md):
// the object path form, the combinations of dockerfile and context, and the
// files read from the configuration folder. The configuration folder is a
// temporary folder outside the tested repo. One top-level test per acceptance
// claim, with its cases as rows. outside.test.ts holds the other claims.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '#dist/index.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, tempDir, writeFiles, callsOf, tarFile, tarNames } from '../helpers.ts';
import type { Call, TarEntry } from '../helpers.ts';

const bareRepo = (t: TestContext, files: Record<string, string> = {}) => makeRepo(t, { files });
const buildTar = (calls: Call[]): TarEntry[] => callsOf(calls, 'build').at(-1)!.tar!;
const buildFile = (calls: Call[]): string => {
  const args = callsOf(calls, 'build').at(-1)!.args;
  return args[args.indexOf('-f') + 1] as string;
};
const inConfig = (path: string) => ({ config: path });
const commands = { test: ['true'] };
// A configuration folder with a Dockerfile and a file in `image/`, and a loose input.
const SIDE = { 'image/Dockerfile': 'FROM alpine:outside\n', 'image/lib/tool.sh': 'echo hi\r\n', 'extra/deps.lock': 'locked\n' };

function sideConfig(t: TestContext, config: Record<string, unknown>, files: Record<string, string> = SIDE): { folder: string; file: string } {
  const folder = tempDir(t, 'athanor-config-');
  writeFiles(folder, files);
  const file = join(folder, 'config.json');
  writeFileSync(file, JSON.stringify({ commands, ...config }));
  return { folder, file };
}

async function runWith(t: TestContext, repo: string, file: string) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), config: { file, from: 'flag' } });
  return { result, calls: docker.calls() };
}

// A run that must end before any build.
async function refused(t: TestContext, repo: string, file: string, says: RegExp) {
  const { result, calls } = await runWith(t, repo, file);
  assert.equal(result.exitCode, 125, JSON.stringify(result));
  assert.match(result.message!, says);
  assert.equal(callsOf(calls, 'build').length + callsOf(calls, 'run').length, 0, 'no build or run');
}

test('OC6 a string path is in the tested repo, the object form is in the configuration folder, and the repo configuration refuses the object form', async (t) => {
  isolate(t);
  const repo = bareRepo(t, { 'a.lock': 'from the repo\n' });
  const { file } = sideConfig(t, { dockerfile: 'test/Dockerfile', inputs: ['a.lock', inConfig('extra/deps.lock')] }, { ...SIDE, 'test/Dockerfile': 'FROM wrong\n', 'a.lock': 'wrong\n' });
  const { result, calls } = await runWith(t, repo, file);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(buildTar(calls), 'Dockerfile'), 'FROM alpine:3.20\n');
  assert.equal(tarFile(buildTar(calls), 'a.lock'), 'from the repo\n');
  assert.equal(tarFile(buildTar(calls), 'extra/deps.lock'), 'locked\n');

  const message = (key: string, place: string) => `"${key}" in ${place} must be a repo-relative path; { "config": ... } works only in an outside configuration.`;
  const rows = [
    { key: 'dockerfile', set: { dockerfile: inConfig('Dockerfile') } },
    { key: 'context', set: { context: inConfig('.') } },
    { key: 'inputs', set: { inputs: [inConfig('a')] } },
  ];
  for (const row of rows) {
    for (const json of [true, false]) {
      await t.test(`${row.key} in ${json ? 'athanor.json' : 'package.json'}`, async (t) => {
        const athanor = { ...baseConfig, ...row.set };
        const own = json
          ? makeRepo(t, { packageJson: false, files: { 'athanor.json': JSON.stringify(athanor) } })
          : makeRepo(t, { athanor });
        const docker = fake(t);
        const r = await run({ cwd: own, docker: docker.docker, prefix: uniquePrefix() });
        assert.equal(r.exitCode, 125);
        assert.equal(r.message, message(row.key, json ? 'athanor.json' : 'the "athanor" key in package.json'));
        assert.equal(docker.calls().length, 0);
      });
    }
  }
  const shapes = [{}, { config: '' }, { config: 3 }, { config: 'a', other: 1 }, { repo: 'a' }];
  for (const shape of shapes) {
    await t.test(`an outside configuration with context ${JSON.stringify(shape)}`, async (t) => {
      const bad = sideConfig(t, { dockerfile: 'test/Dockerfile', context: shape });
      await refused(t, repo, bad.file, /context/);
    });
  }
});

test('OC7 a path that leaves the configuration folder, and a link inside a configuration-side context, exit 125', async (t) => {
  const rows: { name: string; config: (elsewhere: string) => Record<string, unknown>; link?: string; says: RegExp }[] = [
    { name: 'dockerfile through ..', config: () => ({ dockerfile: inConfig('../Dockerfile') }), says: /dockerfile.*outside the configuration folder/ },
    { name: 'an absolute dockerfile', config: (e) => ({ dockerfile: inConfig(join(e, 'Dockerfile')) }), says: /dockerfile.*relative to the configuration folder/ },
    { name: 'context through ..', config: () => ({ dockerfile: inConfig('image/Dockerfile'), context: inConfig('..') }), says: /context.*outside the configuration folder/ },
    { name: 'input through ..', config: () => ({ dockerfile: 'test/Dockerfile', inputs: [inConfig('../x')] }), says: /inputs.*outside the configuration folder/ },
    { name: 'a linked context', config: () => ({ dockerfile: inConfig('link/Dockerfile') }), link: 'link', says: /outside the configuration folder.*link/ },
    { name: 'a link inside the context', config: () => ({ dockerfile: inConfig('image/Dockerfile') }), link: 'image/lib/link', says: /image\/lib\/link.*not a regular file or folder/ },
    { name: 'a missing dockerfile', config: () => ({ dockerfile: inConfig('image/Nope') }), says: /dockerfile "image\/Nope" does not exist in the configuration folder/ },
    { name: 'a folder as the dockerfile', config: () => ({ dockerfile: inConfig('image') }), says: /dockerfile "image".*not a regular file/ },
    { name: 'a folder as an input', config: () => ({ dockerfile: 'test/Dockerfile', inputs: [inConfig('extra')] }), says: /inputs "extra".*not a regular file/ },
    { name: 'a file as the context', config: () => ({ dockerfile: inConfig('image/Dockerfile'), context: inConfig('extra/deps.lock') }), says: /context "extra\/deps\.lock".*not a folder/ },
    { name: 'a dockerfile outside its context', config: () => ({ dockerfile: inConfig('image/Dockerfile'), context: inConfig('extra') }), says: /Dockerfile.*outside the context folder/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = bareRepo(t);
      const elsewhere = tempDir(t, 'athanor-elsewhere-');
      writeFiles(elsewhere, { Dockerfile: 'FROM elsewhere\n' });
      const { folder, file } = sideConfig(t, row.config(elsewhere));
      // A junction needs no rights on Windows; elsewhere it is a plain symlink.
      if (row.link) symlinkSync(elsewhere, join(folder, row.link), 'junction');
      await refused(t, repo, file, row.says);
    });
  }
  await t.test('a pipe inside the context', { skip: process.platform === 'win32' ? 'no mkfifo on Windows' : false }, async (t) => {
    isolate(t);
    const repo = bareRepo(t);
    const { folder, file } = sideConfig(t, { dockerfile: inConfig('image/Dockerfile') });
    assert.equal(spawnSync('mkfifo', [join(folder, 'image', 'pipe')], { shell: false }).status, 0);
    await refused(t, repo, file, /image\/pipe.*not a regular file or folder/);
  });
});

test('OC8 each combination of dockerfile and context gives its result, and a taken path exits 125', async (t) => {
  await t.test('an object dockerfile with no context: the context is its folder, configuration side', async (t) => {
    isolate(t);
    const { file } = sideConfig(t, { dockerfile: inConfig('image/Dockerfile') });
    const { result, calls } = await runWith(t, bareRepo(t), file);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(tarNames(buildTar(calls)), ['Dockerfile', 'lib/tool.sh']);
    assert.equal(buildFile(calls), 'Dockerfile');
    assert.equal(tarFile(buildTar(calls), 'Dockerfile'), 'FROM alpine:outside\n');
  });
  await t.test('both objects: the dockerfile is inside the context', async (t) => {
    isolate(t);
    const { file } = sideConfig(t, { dockerfile: inConfig('image/Dockerfile'), context: inConfig('.'), inputs: ['test/Dockerfile'] });
    const { result, calls } = await runWith(t, bareRepo(t), file);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(tarNames(buildTar(calls)), ['config.json', 'extra/deps.lock', 'image/Dockerfile', 'image/lib/tool.sh', 'test/Dockerfile']);
    assert.equal(buildFile(calls), 'image/Dockerfile');
  });
  await t.test('an object dockerfile with a string context: the repo\'s tree plus .athanor-dockerfile', async (t) => {
    isolate(t);
    const { file } = sideConfig(t, { dockerfile: inConfig('image/Dockerfile'), context: 'app' });
    const { result, calls } = await runWith(t, bareRepo(t, { 'app/main.js': 'main\n' }), file);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(tarNames(buildTar(calls)), ['.athanor-dockerfile', 'main.js']);
    assert.equal(buildFile(calls), '.athanor-dockerfile');
    assert.equal(tarFile(buildTar(calls), '.athanor-dockerfile'), 'FROM alpine:outside\n');
  });
  await t.test('a string dockerfile and context, with a configuration-side input', async (t) => {
    isolate(t);
    const { file } = sideConfig(t, { dockerfile: 'test/Dockerfile', context: 'test', inputs: [inConfig('extra/deps.lock')] });
    const { result, calls } = await runWith(t, bareRepo(t), file);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(tarNames(buildTar(calls)), ['Dockerfile', 'extra/deps.lock']);
  });
  const rows: { name: string; config: Record<string, unknown>; repo?: Record<string, string>; side?: Record<string, string>; says: RegExp }[] = [
    { name: 'a string dockerfile with an object context', config: { dockerfile: 'test/Dockerfile', context: inConfig('.') }, says: /can't be inside a context in the configuration folder/ },
    { name: 'a repo file at .athanor-dockerfile', config: { dockerfile: inConfig('image/Dockerfile'), context: '.' }, repo: { '.athanor-dockerfile': 'x\n' }, says: /"\.athanor-dockerfile".*already/ },
    { name: 'a repo folder at .athanor-dockerfile', config: { dockerfile: inConfig('image/Dockerfile'), context: '.' }, repo: { '.athanor-dockerfile/x': 'x\n' }, says: /"\.athanor-dockerfile".*already/ },
    { name: 'a repo input at .athanor-dockerfile', config: { dockerfile: inConfig('image/Dockerfile'), context: 'test', inputs: ['.athanor-dockerfile'] }, repo: { '.athanor-dockerfile': 'x\n' }, says: /"\.athanor-dockerfile".*already/ },
    { name: 'a configuration input at .athanor-dockerfile', config: { dockerfile: inConfig('image/Dockerfile'), context: 'test', inputs: [inConfig('.athanor-dockerfile')] }, side: { ...SIDE, '.athanor-dockerfile': 'x\n' }, says: /"\.athanor-dockerfile".*already/ },
    { name: 'a configuration input on a repo context file', config: { dockerfile: 'test/Dockerfile', context: '.', inputs: [inConfig('extra/deps.lock')] }, repo: { 'extra/deps.lock': 'x\n' }, says: /"extra\/deps\.lock".*already/ },
    { name: 'a repo input on a configuration context file', config: { dockerfile: inConfig('image/Dockerfile'), inputs: ['lib/tool.sh'] }, repo: { 'lib/tool.sh': 'x\n' }, says: /"lib\/tool\.sh".*already/ },
    { name: 'both inputs at one path', config: { dockerfile: 'test/Dockerfile', inputs: ['extra/deps.lock', inConfig('extra/deps.lock')] }, repo: { 'extra/deps.lock': 'x\n' }, says: /"extra\/deps\.lock".*already/ },
    { name: 'a configuration input under a repo file', config: { dockerfile: 'test/Dockerfile', context: '.', inputs: [inConfig('extra/deps.lock')] }, repo: { extra: 'x\n' }, says: /"extra\/deps\.lock".*already/ },
    { name: 'a configuration input where the context has a folder', config: { dockerfile: 'test/Dockerfile', context: '.', inputs: [inConfig('flat')] }, repo: { 'flat/x': 'x\n' }, side: { flat: 'y\n' }, says: /"flat".*already/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = bareRepo(t, row.repo);
      const { file } = sideConfig(t, row.config, row.side);
      await refused(t, repo, file, row.says);
    });
  }
});

test('OC9 the tag follows configuration-side content, no repo filter runs on those files, and each has mode 100644', async (t) => {
  isolate(t);
  const mark = join(tempDir(t, 'athanor-marker-'), 'ran');
  const repo = bareRepo(t);
  // A clean filter on the paths the configuration-side files take in the tree.
  // No file of the repo's own matches, so git's own reads of the repo run it on none.
  writeFiles(repo, { '.git/info/attributes': '/Dockerfile filter=up\n*.sh filter=up\n*.lock filter=up\n' });
  appendFileSync(join(repo, '.git', 'config'), `[filter "up"]\n\tclean = "echo ran >> '${mark.replace(/\\/g, '/')}'; tr a-z A-Z"\n`);
  const { folder, file } = sideConfig(t, { dockerfile: inConfig('image/Dockerfile'), inputs: [inConfig('extra/deps.lock')] });
  chmodSync(join(folder, 'image', 'lib', 'tool.sh'), 0o755);
  const tag = async () => {
    const { result, calls } = await runWith(t, repo, file);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    return { tag: result.image!.tag, calls };
  };
  const first = await tag();
  const entries = buildTar(first.calls).filter((e) => e.type === '0');
  assert.equal(tarFile(entries, 'lib/tool.sh'), 'echo hi\r\n', 'the bytes as read');
  assert.equal(tarFile(entries, 'extra/deps.lock'), 'locked\n');
  // git archive writes a 100644 blob as 0644 under athanor's pinned tar.umask.
  assert.deepEqual(entries.map((e) => parseInt(e.mode, 8).toString(8)), ['644', '644', '644']);
  assert.equal(existsSync(mark), false, 'the filter never ran');
  assert.equal((await tag()).tag, first.tag, 'the same content');
  writeFileSync(join(folder, 'image', 'lib', 'tool.sh'), 'echo bye\n');
  assert.notEqual((await tag()).tag, first.tag, 'changed content');
});

test('OC15 a configuration-side context never puts a .git entry in the tree', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  const { file } = sideConfig(t, { dockerfile: inConfig('Dockerfile') }, {
    Dockerfile: 'FROM alpine\n', '.git/config': 'secret\n', 'sub/.GIT/HEAD': 'secret\n', 'nested/.git': 'gitdir: x\n', 'sub/kept': 'k\n', '.gitignore': 'g\n',
  });
  const { result, calls } = await runWith(t, repo, file);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.deepEqual(tarNames(buildTar(calls)), ['.gitignore', 'Dockerfile', 'config.json', 'sub/kept']);

  const rows = [
    { dockerfile: inConfig('.git/Dockerfile') },
    { dockerfile: inConfig('Dockerfile'), context: inConfig('.git') },
    { dockerfile: 'test/Dockerfile', inputs: [inConfig('.git/config')] },
  ];
  for (const [i, row] of rows.entries()) {
    await t.test(`a configured path inside .git, row ${i + 1}`, async (t) => {
      const bad = sideConfig(t, row, { Dockerfile: 'FROM alpine\n', '.git/Dockerfile': 'FROM x\n', '.git/config': 'secret\n' });
      await refused(t, repo, bad.file, /\.git/);
    });
  }
});
