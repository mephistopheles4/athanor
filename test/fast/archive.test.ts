// The archive step carries the tree as committed (spec on issue 20, ADR 0020):
// no content filter runs, and no host git config, template, attribute or
// GIT_* variable changes a byte or a mode of either tar stream. Each test puts
// the host settings it needs in its own environment and temporary files, set
// after its repo is made and restored afterwards. A filter here is a smudge
// command git runs through its shell: it appends to a marker file and
// upper-cases the content, so a run that used it shows both.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, cpSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// A marker file and the smudge command that writes it. The path is written
// with forward slashes inside single quotes, so Git for Windows' sh reads it.
function marker(t: TestContext): { path: string; smudge: string } {
  const path = join(tempDir(t, 'athanor-marker-'), 'ran');
  return { path, smudge: `echo ran >> '${path.replace(/\\/g, '/')}'; tr a-z A-Z` };
}

// A file of git config, in a temporary folder.
function configFile(t: TestContext, text: string): string {
  const file = join(tempDir(t, 'athanor-gitconfig-'), 'config');
  writeFileSync(file, text);
  return file;
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

// A repo whose attributes name the filter `up` for .txt files, at the root and
// in the build context, with one such file in each stream.
const filtered = (t: TestContext): string => makeRepo(t, {
  athanor: baseConfig,
  files: { '.gitattributes': '*.txt filter=up\n', 'test/.gitattributes': '*.txt filter=up\n', 'a.txt': 'hello\n', 'test/b.txt': 'build\n' },
});

// Run, and check both streams carry the committed bytes and the filter never ran.
async function runFiltered(t: TestContext, repo: string, mark: string): Promise<void> {
  const docker = fake(t);
  const result = await runWith(repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(lastRunTar(docker), 'a.txt'), 'hello\n', 'the snapshot carries the committed bytes');
  assert.equal(tarFile(lastBuildTar(docker), 'b.txt'), 'build\n', 'the build context carries the committed bytes');
  assert.equal(existsSync(mark), false, 'the filter never ran');
}

test('G1 a filter the repo names and the global config defines never runs, and both streams carry the committed bytes', async (t) => {
  isolate(t);
  const repo = filtered(t);
  const m = marker(t);
  setEnv(t, { GIT_CONFIG_GLOBAL: configFile(t, `[filter "up"]\n\tsmudge = "${m.smudge}"\n`) });
  await runFiltered(t, repo, m.path);
});

// git's quoting for GIT_CONFIG_PARAMETERS: each item in single quotes, a quote as '\''.
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

test('G2 a filter defined elsewhere on the host never runs either', async (t) => {
  const rows: { name: string; skip?: string | false; env: (t: TestContext, repo: string, smudge: string) => Record<string, string> }[] = [
    { name: 'GIT_CONFIG_COUNT, KEY_0 and VALUE_0', env: (_t, _r, smudge) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.up.smudge', GIT_CONFIG_VALUE_0: smudge }) },
    {
      name: 'the same three names in lower case, on Windows',
      skip: process.platform !== 'win32' && 'Windows matches variable names without regard to case',
      env: (_t, _r, smudge) => ({ git_config_count: '1', git_config_key_0: 'filter.up.smudge', git_config_value_0: smudge }),
    },
    { name: 'GIT_CONFIG_PARAMETERS', env: (_t, _r, smudge) => ({ GIT_CONFIG_PARAMETERS: sq(`filter.up.smudge=${smudge}`) }) },
    { name: 'GIT_CONFIG_SYSTEM naming a file', env: (t, _r, smudge) => ({ GIT_CONFIG_SYSTEM: configFile(t, `[filter "up"]\n\tsmudge = "${smudge}"\n`) }) },
    {
      name: 'GIT_COMMON_DIR naming a copy of the repo\'s git folder whose config defines it',
      env: (t, repo, smudge) => {
        const copy = join(tempDir(t, 'athanor-common-'), 'git');
        cpSync(join(repo, '.git'), copy, { recursive: true });
        appendFileSync(join(copy, 'config'), `[filter "up"]\n\tsmudge = "${smudge}"\n`);
        return { GIT_COMMON_DIR: copy };
      },
    },
    {
      name: 'a template\'s config, the template named by GIT_TEMPLATE_DIR',
      env: (t, _r, smudge) => {
        const template = tempDir(t, 'athanor-template-');
        writeFileSync(join(template, 'config'), `[filter "up"]\n\tsmudge = "${smudge}"\n`);
        return { GIT_TEMPLATE_DIR: template };
      },
    },
    {
      name: 'a template\'s config, the template named by init.templateDir in the global config',
      env: (t, _r, smudge) => {
        const template = tempDir(t, 'athanor-template-');
        writeFileSync(join(template, 'config'), `[filter "up"]\n\tsmudge = "${smudge}"\n`);
        return { GIT_CONFIG_GLOBAL: configFile(t, `[init]\n\ttemplateDir = ${fwd(template)}\n`) };
      },
    },
  ];
  for (const row of rows) {
    await t.test(row.name, { skip: row.skip ?? false }, async (t) => {
      isolate(t);
      const repo = filtered(t);
      const m = marker(t);
      setEnv(t, row.env(t, repo, m.smudge));
      await runFiltered(t, repo, m.path);
    });
  }
});

// A tree, written into the repo, whose .gitattributes is the given text.
function attributesTree(repo: string, text: string): string {
  const write = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: text, encoding: 'utf8', shell: false });
  const tree = spawnSync('git', ['mktree'], { cwd: repo, input: `100644 blob ${write.stdout.trim()}\t.gitattributes\n`, encoding: 'utf8', shell: false });
  return tree.stdout.trim();
}

test('G3 attributes from outside the tree change no byte', async (t) => {
  const rows: { name: string; env: (t: TestContext, repo: string) => Record<string, string> }[] = [
    {
      name: 'the file the global config\'s core.attributesFile names',
      env: (t) => {
        const attributes = join(tempDir(t, 'athanor-attrs-'), 'attributes');
        writeFileSync(attributes, '*.txt ident\n');
        return { GIT_CONFIG_GLOBAL: configFile(t, `[core]\n\tattributesFile = ${fwd(attributes)}\n`) };
      },
    },
    {
      name: 'git\'s default global attributes file under XDG_CONFIG_HOME',
      env: (t) => {
        const xdg = tempDir(t, 'athanor-xdg-');
        mkdirSync(join(xdg, 'git'));
        writeFileSync(join(xdg, 'git', 'attributes'), '*.txt ident\n');
        return { XDG_CONFIG_HOME: xdg };
      },
    },
    { name: 'GIT_ATTR_SOURCE naming a tree', env: (_t, repo) => ({ GIT_ATTR_SOURCE: attributesTree(repo, '*.txt ident\n') }) },
    {
      name: 'a template\'s config that sets attr.tree',
      env: (t, repo) => {
        const template = tempDir(t, 'athanor-template-');
        writeFileSync(join(template, 'config'), `[attr]\n\ttree = ${attributesTree(repo, '*.txt ident\n')}\n`);
        return { GIT_TEMPLATE_DIR: template };
      },
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: baseConfig, files: { 'a.txt': '$Id$\n', 'test/b.txt': '$Id$\n' } });
      setEnv(t, row.env(t, repo));
      const docker = fake(t);
      const result = await runWith(repo, docker);
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.equal(tarFile(lastRunTar(docker), 'a.txt'), '$Id$\n', 'the snapshot keeps $Id$ unexpanded');
      assert.equal(tarFile(lastBuildTar(docker), 'b.txt'), '$Id$\n', 'the build context keeps $Id$ unexpanded');
    });
  }
});

test('G4 a host tar.umask changes no file mode in either stream', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { 'a.txt': 'a\n', 'test/tool.sh': 'echo hi\n' } });
  git(repo, ['update-index', '--chmod=+x', 'test/tool.sh']);
  git(repo, ['commit', '-q', '-m', 'exec']);
  setEnv(t, { GIT_CONFIG_GLOBAL: configFile(t, '[tar]\n\tumask = 0077\n') });
  const docker = fake(t);
  const result = await runWith(repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const mode = (entries: TarEntry[], name: string): string => entries.find((e) => e.name === name)!.mode;
  assert.match(mode(lastRunTar(docker), 'a.txt'), /664$/);
  assert.match(mode(lastRunTar(docker), 'test/tool.sh'), /775$/);
  assert.match(mode(lastBuildTar(docker), 'Dockerfile'), /644$/);
  assert.match(mode(lastBuildTar(docker), 'tool.sh'), /755$/);
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

test('G7 the image tag hashes the format athanor-image-v2 and the build context\'s tree', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const tree = git(repo, ['rev-parse', 'HEAD:test']).trim();
  const docker = fake(t);
  const result = await runWith(repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const expected = createHash('sha256').update(`athanor-image-v2\n${tree}`).digest('hex').slice(0, 32);
  assert.equal(result.image!.tag, `athanor:${expected}`);
});
