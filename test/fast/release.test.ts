// The release checks (spec on issue 6): the pack check that CI and the
// release workflow share, and the workflow check that keeps every checkout's
// token out of the clone, every cache off and every npm token out.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, writeFiles } from '../helpers.ts';
import { buildTar } from '../tar.ts';
import type { TarSpec } from '../tar.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = (name: string) => join(root, 'scripts', name);
const node = (args: string[], cwd?: string) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', shell: false });

// Builds <dir>/package.tgz from the named entries only, so it holds no
// directory entry unless one is named. tar runs in <dir> with bare names,
// because GNU tar on Windows reads "C:" in a path as a remote host.
function tarball(dir: string, files: Record<string, string>, extraEntries: string[] = []): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const entry of extraEntries) mkdirSync(join(dir, entry), { recursive: true });
  const made = spawnSync('tar', ['-czf', 'package.tgz', ...Object.keys(files), ...extraEntries], { cwd: dir, encoding: 'utf8', shell: false });
  assert.equal(made.status, 0, made.stderr);
  return join(dir, 'package.tgz');
}

const allowed = {
  'package/package.json': '{}\n',
  'package/README.md': '# athanor\n',
  'package/LICENSE': 'MIT\n',
  'package/bin/athanor.mjs': 'export {};\n',
  'package/dist/index.js': 'export {};\n',
  'package/dist/index.d.ts': 'export {};\n',
  'package/dist/cli.mjs': 'export {};\n',
  'package/dist/cli.d.mts': 'export {};\n',
};

test('R1 the pack check passes only the allowed entries with dist/index.d.ts, and names what it refuses', async (t) => {
  const check = (tgz: string) => node([script('check-pack.mjs'), tgz]);

  await t.test('a tarball of allowed entries passes', () => {
    const r = check(tarball(tempDir(t), allowed));
    assert.equal(r.status, 0, r.stderr);
  });
  await t.test('an extra entry fails and is named', () => {
    const r = check(tarball(tempDir(t), { ...allowed, 'package/src/index.ts': 'export {};\n' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/src\/index\.ts/);
  });
  await t.test('an entry that only begins like an allowed one fails and is named', () => {
    const r = check(tarball(tempDir(t), { ...allowed, 'package/dist/index.js.map': '{}\n', 'package/README.md.bak': 'old\n' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/dist\/index\.js\.map/);
    assert.match(r.stderr, /package\/README\.md\.bak/);
  });
  await t.test('a directory entry fails and is named', () => {
    const r = check(tarball(tempDir(t), allowed, ['package/extra']));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/extra\//);
  });
  await t.test('a file in a folder under bin/, or not .mjs in bin/, fails and is named', () => {
    const r = check(tarball(tempDir(t), { ...allowed, 'package/bin/sub/x.mjs': 'export {};\n', 'package/bin/x.js': 'export {};\n' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/bin\/sub\/x\.mjs/);
    assert.match(r.stderr, /package\/bin\/x\.js/);
  });
  await t.test('an entry outside package/ fails and is named', () => {
    const r = check(tarball(tempDir(t), { ...allowed, 'x/package/README.md': '# other\n' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x\/package\/README\.md/);
  });
  await t.test('a file in a folder under dist/ fails and is named', () => {
    const r = check(tarball(tempDir(t), { ...allowed, 'package/dist/sub/x.js': 'export {};\n' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/dist\/sub\/x\.js/);
  });
  await t.test('a missing dist/index.d.ts fails and says so', () => {
    const { 'package/dist/index.d.ts': _, ...rest } = allowed;
    const r = check(tarball(tempDir(t), rest));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /package\/dist\/index\.d\.ts/);
  });
  await t.test('a file that is not a tarball fails and says so', () => {
    const dir = tempDir(t);
    writeFiles(dir, { 'not.tgz': 'plain text\n' });
    const r = check(join(dir, 'not.tgz'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not list/);
  });
});

// A workflow whose one job runs the given steps, written as YAML lines.
const workflow = (...steps: string[]) => ['name: planted', 'on: push', 'jobs:', '  one:', '    runs-on: ubuntu-24.04', '    steps:', ...steps, ''].join('\n');
const checkout = ['      - uses: actions/checkout@0123456789012345678901234567890123456789 # v7', '        with:', '          persist-credentials: false'];
const setupNode = ['      - uses: actions/setup-node@0123456789012345678901234567890123456789 # v7', '        with:', "          node-version: '24'", '          package-manager-cache: false'];

test('R2 the workflow check fails each broken rule, naming the file and line', async (t) => {
  const check = (dir: string) => node([script('check-workflows.mjs'), dir], root);
  const planted = (yaml: string, name = 'planted.yml') => {
    const dir = tempDir(t);
    writeFiles(dir, { [name]: yaml });
    return check(dir);
  };
  const fails = (yaml: string, line: number, what: RegExp, name = 'planted.yml') => {
    const r = planted(yaml, name);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`${name.replace('.', '\\.')}:${line}: `));
    assert.match(r.stderr, what);
  };

  await t.test('a workflow that keeps every rule passes, so the shared fixtures are clean', () => {
    const r = planted(workflow(...checkout, ...setupNode, '      - run: node --version'));
    assert.equal(r.status, 0, r.stderr);
  });
  await t.test('a checkout without persist-credentials fails', () => {
    fails(workflow('      - uses: actions/checkout@0123456789012345678901234567890123456789'), 7, /persist-credentials: false/);
  });
  await t.test('a checkout with persist-credentials other than false fails', () => {
    fails(workflow(checkout[0], checkout[1], '          persist-credentials: true'), 9, /persist-credentials/);
    fails(workflow(checkout[0], checkout[1], '          persist-credentials: ${{ inputs.keep }}'), 9, /persist-credentials/);
  });
  await t.test('setup-node without package-manager-cache: false fails', () => {
    fails(workflow(setupNode[0], setupNode[1], setupNode[2]), 7, /package-manager-cache: false/);
    fails(workflow(setupNode[0], setupNode[1], setupNode[2], '          package-manager-cache: true'), 7, /package-manager-cache: false/);
  });
  await t.test('a setting outside the with: block does not count', () => {
    fails(workflow(checkout[0], '        env:', '          persist-credentials: false'), 7, /persist-credentials: false/);
    fails(workflow(setupNode[0], setupNode[1], setupNode[2], '        env:', '          package-manager-cache: false'), 7, /package-manager-cache: false/);
  });
  await t.test('a step does not borrow the inputs of the step after it', () => {
    fails(workflow('      - uses: actions/checkout@0123456789012345678901234567890123456789', ...checkout), 7, /persist-credentials: false/);
    fails(workflow('      - uses: actions/setup-node@0123456789012345678901234567890123456789', ...setupNode), 7, /package-manager-cache: false/);
  });
  await t.test('an action name or an input key in another case is still read', () => {
    fails(workflow('      - uses: Actions/Checkout@0123456789012345678901234567890123456789'), 7, /persist-credentials: false/);
    fails(workflow(checkout[0], checkout[1], '          Persist-Credentials: True'), 9, /persist-credentials/);
    fails(workflow(...setupNode, '          Registry-Url: https://registry.npmjs.org'), 11, /registry-url/);
  });
  await t.test('setup-node with a cache input fails', () => {
    fails(workflow(...setupNode, '          cache: npm'), 11, /cache/);
  });
  await t.test('setup-node with a registry-url input fails', () => {
    fails(workflow(...setupNode, '          registry-url: https://registry.npmjs.org'), 11, /registry-url/);
  });
  await t.test('each cache action fails', async () => {
    for (const action of ['actions/cache', 'actions/cache/restore', 'actions/cache/save']) {
      fails(workflow(`      - uses: ${action}@0123456789012345678901234567890123456789`), 7, /cache/);
    }
  });
  await t.test('a flow-style with on checkout or setup-node fails', () => {
    fails(workflow(checkout[0], '        with: { persist-credentials: false }'), 8, /flow style/);
    fails(workflow(setupNode[0], "        with: { node-version: '24', package-manager-cache: false }"), 8, /flow style/);
  });
  await t.test('a step written in flow style fails', () => {
    fails(workflow('      - { uses: actions/checkout@0123456789012345678901234567890123456789 }'), 7, /flow style/);
  });
  await t.test('a step whose uses comes after its name is still read', () => {
    fails(workflow('      - name: Check out', '        uses: actions/checkout@0123456789012345678901234567890123456789'), 8, /persist-credentials: false/);
  });
  await t.test('an npm token or a secret fails', async () => {
    fails(workflow('      - run: npm publish', '        env:', '          NODE_AUTH_TOKEN: x'), 9, /token/);
    fails(workflow("      - run: echo '//registry.npmjs.org/:_authToken=x' > .npmrc"), 7, /token/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: ${{ secrets.NPM }}'), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', "          T: ${{ secrets['NPM'] }}"), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: ${{ toJSON(secrets) }}'), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: ${{ toJSON(secrets.*) }}'), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: ${{ SECRETS.NPM }}'), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: ${{ secrets }}'), 9, /secret/);
    fails(workflow('      - run: echo "$T"', '        env:', '          T: >-', '            ${{', '            secrets.NPM }}'), 11, /secret/);
    fails(['name: planted', 'on: push', 'jobs:', '  one:', '    uses: ./.github/workflows/other.yml', '    secrets: inherit', ''].join('\n'), 6, /secret/);
  });
  await t.test('a .yaml file is read too', () => {
    fails(workflow('      - uses: actions/cache@0123456789012345678901234567890123456789'), 7, /cache/, 'planted.yaml');
  });
});

// The release ref check (spec on issue 88, S1 and S3): the version forms a
// release may have, and the tag name that must match them.
const checkRef = (t: TestContext, ref: string, version: string | null, extra: string[] = []) => {
  const dir = tempDir(t);
  const path = join(dir, 'package.json');
  if (version !== null) writeFileSync(path, JSON.stringify({ name: 'planted', version }));
  return node([script('check-release-ref.mjs'), '--ref', ref, '--package', path, ...extra], dir);
};

test('F1 the release ref check accepts X.Y.Z and X.Y.Z-rc.N and refuses every other version form, naming it', async (t) => {
  await t.test('a stable version and an rc version pass', () => {
    for (const version of ['0.2.0', '1.10.25', '10.0.0', '0.2.0-rc.1', '1.0.0-rc.12']) {
      const r = checkRef(t, `refs/tags/v${version}`, version);
      assert.equal(r.status, 0, `${version}: ${r.stderr}`);
    }
  });
  await t.test('each other form is refused, with the version and the two allowed forms named', () => {
    const bad = ['0.2.0-beta.1', '0.2.0-rc.0', '0.2.0-rc.01', '0.2.0-rc', '0.2.0-rc.1.2', '1.02.3', '01.2.3', '1.2.03', '0.2.0+build', '0.2.0-rc.1+build', 'v0.2.0', '0.2', '0.2.0.1', '0.2.x', '', ' 0.2.0', '0.2.0\n', '0.2.0-RC.1', '-1.2.3'];
    for (const version of bad) {
      const r = checkRef(t, `refs/tags/v${version}`, version);
      assert.equal(r.status, 1, `${JSON.stringify(version)} should be refused: ${r.stdout}`);
      assert.ok(r.stderr.includes(JSON.stringify(version)), `${JSON.stringify(version)} should be named: ${r.stderr}`);
      assert.match(r.stderr, /X\.Y\.Z \(a stable release/);
      assert.match(r.stderr, /X\.Y\.Z-rc\.N \(a release candidate/);
    }
  });
  await t.test('a version that is not text is refused', () => {
    for (const version of [2, null, ['0.2.0']]) {
      const dir = tempDir(t);
      writeFiles(dir, { 'package.json': JSON.stringify({ version }) });
      const r = node([script('check-release-ref.mjs'), '--ref', 'refs/tags/v0.2.0', '--package', join(dir, 'package.json')], dir);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /X\.Y\.Z-rc\.N/);
    }
  });
});

test('F2 the release ref check refuses a tag name that is not v plus the version, and a ref that is not a tag', async (t) => {
  await t.test('a tag that names another version is refused, with both named', () => {
    const r = checkRef(t, 'refs/tags/v0.2.1', '0.2.0');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /v0\.2\.1/);
    assert.match(r.stderr, /v0\.2\.0/);
  });
  await t.test('a tag with no v, an rc tag on a stable version and a stable tag on an rc version are refused', () => {
    assert.equal(checkRef(t, 'refs/tags/0.2.0', '0.2.0').status, 1);
    assert.equal(checkRef(t, 'refs/tags/v0.2.0-rc.1', '0.2.0').status, 1);
    assert.equal(checkRef(t, 'refs/tags/v0.2.0', '0.2.0-rc.1').status, 1);
    assert.equal(checkRef(t, 'refs/tags/vv0.2.0', '0.2.0').status, 1);
  });
  await t.test('a ref that is not a tag is refused and named', () => {
    for (const ref of ['refs/heads/main', 'refs/heads/v0.2.0', 'refs/pull/v0.2.0', 'refs/pull/5/merge', 'v0.2.0', 'refs/tags/', 'refs/tags', '']) {
      const r = checkRef(t, ref, '0.2.0');
      assert.equal(r.status, 1, `${JSON.stringify(ref)}: ${r.stdout}`);
      assert.match(r.stderr, /not a tag of that form/);
    }
    // A tag that passes the prefix but has more after the version fails on the name.
    const extra = checkRef(t, 'refs/tags/v0.2.0/extra', '0.2.0');
    assert.equal(extra.status, 1, extra.stdout);
    assert.match(extra.stderr, /the tag must be "v0\.2\.0"|not a tag of that form/);
  });
  await t.test('a missing, unreadable or odd package file is refused with a plain message', () => {
    const missing = checkRef(t, 'refs/tags/v0.2.0', null);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /package\.json/);
    const dir = tempDir(t);
    writeFiles(dir, { 'bad.json': '{ not json', 'array.json': '[]', 'none.json': '{}' });
    for (const file of ['bad.json', 'array.json', 'none.json']) {
      const r = node([script('check-release-ref.mjs'), '--ref', 'refs/tags/v0.2.0', '--package', join(dir, file)], dir);
      assert.equal(r.status, 1, file);
      assert.match(r.stderr, /package\.json/);
    }
  });
  await t.test('it takes arguments only: a missing, repeated or unknown one is refused, and the environment is never read or printed', () => {
    assert.equal(node([script('check-release-ref.mjs')]).status, 2);
    assert.equal(node([script('check-release-ref.mjs'), '--ref', 'refs/tags/v0.2.0']).status, 2);
    assert.equal(checkRef(t, 'refs/tags/v0.2.0', '0.2.0', ['--ref', 'refs/tags/v0.2.0']).status, 2);
    assert.equal(checkRef(t, 'refs/tags/v0.2.0', '0.2.0', ['--other', 'x']).status, 2);
    const dir = tempDir(t);
    writeFiles(dir, { 'package.json': JSON.stringify({ version: '0.2.1' }) });
    const env = { ...process.env, GITHUB_REF: 'refs/tags/v0.2.1', GITHUB_REF_NAME: 'v0.2.1', GH_TOKEN: 'planted-secret-value' };
    const r = spawnSync(process.execPath, [script('check-release-ref.mjs'), '--ref', 'refs/tags/v0.2.0', '--package', join(dir, 'package.json')], { cwd: dir, env, encoding: 'utf8', shell: false });
    assert.equal(r.status, 1, 'the ref argument decides, not GITHUB_REF');
    assert.ok(!(r.stdout + r.stderr).includes('planted-secret-value'));
  });
});

// The release rules of the workflow check (spec on issue 88, S9): F6 to F8.
// A workflow whose one job can mint an identity token, with the given `on:` lines
// (the first is line 2).
const tokenWorkflow = (on: string[]) => ['name: planted', ...on, 'permissions: {}', 'jobs:', '  one:', '    runs-on: ubuntu-24.04', '    permissions:', '      id-token: write', '    steps:', '      - run: node --version', ''].join('\n');
const onTags = ['on:', '  push:', '    tags:', "      - 'v*'"];
// Two jobs: check holds the given steps, publish names the environment npm and holds its own.
const twoJobs = (checkSteps: string[], publishSteps: string[], environment = '    environment: npm') =>
  ['name: planted', 'on: push', 'jobs:', '  check:', '    runs-on: ubuntu-24.04', '    steps:', ...checkSteps, '  publish:', '    runs-on: ubuntu-24.04', environment, '    steps:', ...publishSteps, ''].join('\n');
const releaseChecker = (t: TestContext, yaml: string, name = 'planted.yml') => {
  const dir = tempDir(t);
  writeFiles(dir, { [name]: yaml });
  return node([script('check-workflows.mjs'), dir], root);
};
const releaseFails = (t: TestContext, yaml: string, line: number, what: RegExp) => {
  const r = releaseChecker(t, yaml);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`planted\\.yml:${line}: `));
  assert.match(r.stderr, what);
};

// F5 runs the marked block of release.yml's publish job with sh. A host with
// no sh skips it by name; Linux proves it, in athanor's run and in CI.
const hasSh = spawnSync('sh', ['-c', 'exit 0'], { shell: false }).status === 0;

function tagRuleBlock(): string {
  const lines = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);
  const begins = lines.flatMap((l, i) => (l.trim() === '# release-tag-rule begin' ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === '# release-tag-rule end' ? [i] : []));
  assert.equal(begins.length, 1, 'release.yml has one begin marker');
  assert.equal(ends.length, 1, 'release.yml has one end marker');
  const pad = lines[begins[0]].match(/^ */)![0].length;
  return lines.slice(begins[0] + 1, ends[0]).map((l) => l.slice(pad)).join('\n') + '\n';
}

// The `run:` lines of the named step of release.yml, as the shell gets them.
function stepRun(name: string): string {
  const lines = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `release.yml has a step named ${name}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const pad = lines[runAt].match(/^ */)![0].length + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^ */)![0].length >= pad); i++) body.push(lines[i].slice(pad));
  return body.join('\n') + '\n';
}

// The value of one `env:` key of the named step of release.yml, as written.
function stepEnv(name: string, key: string): string {
  const lines = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `release.yml has a step named ${name}`);
  for (let i = at + 1; i < lines.length && !/^\s+- name:/.test(lines[i]); i++) {
    const m = lines[i].match(new RegExp(`^\\s+${key}: (.*)$`));
    if (m) return m[1].trim();
  }
  assert.fail(`step ${name} has no ${key} in its env`);
}

test('F5 publish stops unless the tarball\'s package.json version equals the file-name version and the tag\'s, and takes the dist-tag from it alone', { skip: hasSh ? false : 'no sh on this host; the block is proven on Linux, in athanor\'s run and in CI' }, async (t) => {
  const block = tagRuleBlock();
  const manifest = (version: unknown) => JSON.stringify({ name: '@mephistopheles4/athanor', version, description: 'CANARYTEXT' });
  const member = (content: string) => ({ name: 'package/package.json', content });
  const readme = { name: 'package/README.md', content: '# athanor\n' };
  const run = (entries: Buffer | TarSpec[], opts: { file?: string; ref?: string } = {}) => {
    const dir = tempDir(t);
    const file = opts.file ?? 'mephistopheles4-athanor-0.2.0.tgz';
    writeFileSync(join(dir, file), Buffer.isBuffer(entries) ? entries : gzipSync(buildTar(entries)));
    // Paths are relative to the folder the block runs in, so a drive letter
    // on a Windows host with sh never reaches tar.
    const env = { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, TARBALL: file, REF_NAME: opts.ref ?? 'v0.2.0', DIST_TAG_FILE: 'dist-tag' };
    const r = spawnSync('sh', ['-c', block], { cwd: dir, env, encoding: 'utf8', shell: false });
    return { r, distTag: existsSync(join(dir, 'dist-tag')) ? readFileSync(join(dir, 'dist-tag'), 'utf8') : null };
  };
  // It stops for the reason named, so a bad case can't pass by failing early.
  const stops = (entries: Parameters<typeof run>[0], why: RegExp, opts: Parameters<typeof run>[1] = {}) => {
    const { r, distTag } = run(entries, opts);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.equal(distTag, null, 'no dist-tag is written when it stops');
    assert.match(r.stderr, why);
    assert.ok(!/CANARYTEXT/i.test(r.stdout + r.stderr), 'no text from the tarball is printed');
  };
  const notInName = /not the version in its file name/;
  const notInTag = /not the version of the tag/;
  const notForm = /is not X\.Y\.Z or X\.Y\.Z-rc\.N/;

  await t.test('the block holds no expression and writes to none of the files that carry values between steps', () => {
    assert.ok(!block.includes('${{'));
    assert.ok(!/GITHUB_(ENV|OUTPUT|STEP_SUMMARY)/.test(block));
  });
  await t.test('a stable version everywhere gives latest, and an rc version everywhere gives next', () => {
    const stable = run([member(manifest('0.2.0')), readme]);
    assert.equal(stable.r.status, 0, stable.r.stderr);
    assert.equal(stable.distTag, 'latest\n');
    const rc = run([member(manifest('0.2.0-rc.1')), readme], { file: 'mephistopheles4-athanor-0.2.0-rc.1.tgz', ref: 'v0.2.0-rc.1' });
    assert.equal(rc.r.status, 0, rc.r.stderr);
    assert.equal(rc.distTag, 'next\n');
    const big = run([member(manifest('10.20.30-rc.12'))], { file: 'mephistopheles4-athanor-10.20.30-rc.12.tgz', ref: 'v10.20.30-rc.12' });
    assert.equal(big.distTag, 'next\n');
  });
  await t.test('a version inside the tarball that differs from the file name, or from the tag, stops it', () => {
    stops([member(manifest('0.2.1'))], notInName);
    stops([member(manifest('0.2.0'))], notInTag, { ref: 'v0.2.1' });
    stops([member(manifest('0.2.0-rc.1'))], notInName, { ref: 'v0.2.0-rc.1' });
    stops([member(manifest('0.2.0'))], notInName, { file: 'mephistopheles4-athanor-0.2.0-rc.1.tgz', ref: 'v0.2.0-rc.1' });
    stops([member(manifest('0.2.0'))], /not named v plus the version/, { ref: '0.2.0' });
  });
  await t.test('a version that is not one of the two forms stops it, even when all three agree', () => {
    for (const version of ['0.02.0', '0.2.0-rc.0', '0.2.0-rc.01', '0.2.0-beta.1', '0.2.0+build', '0.2', '1.2.3.4', 'v0.2.0', '0.2.0-RC.1']) {
      stops([member(manifest(version))], /file name is not X\.Y\.Z or X\.Y\.Z-rc\.N/, { file: `mephistopheles4-athanor-${version}.tgz`, ref: `v${version}` });
    }
  });
  await t.test('a file name that is not a release tarball name stops it', () => {
    stops([member(manifest('0.2.0'))], /not a release tarball name/, { file: 'athanor-0.2.0.tgz' });
    stops([member(manifest('0.2.0'))], /not a release tarball name/, { file: 'mephistopheles4-athanor-0.2.0.tar.gz' });
  });
  await t.test('a manifest that is not JSON, not an object or without a text version stops it', () => {
    const unreadable = /holds no readable version/;
    stops([member('{ not json CANARYTEXT')], unreadable);
    stops([member('[]')], unreadable);
    stops([member('null')], unreadable);
    stops([member(manifest(2))], unreadable);
    stops([member(manifest(null))], unreadable);
    stops([member('{}')], unreadable);
    stops([member(manifest('0.2.0\n9.9.9'))], unreadable);
  });
  await t.test('a tarball with no package/package.json member stops it', () => {
    const none = /holds no package\/package\.json member/;
    stops([readme], none);
    stops([{ name: 'x/package/package.json', content: manifest('0.2.0') }, { name: 'package/package.json.bak', content: manifest('0.2.0') }], none);
    stops([{ name: 'package/', type: '5' }], none);
  });
  await t.test('a tarball with two package/package.json members stops it, whatever they hold', () => {
    stops([member(manifest('0.2.0')), member(manifest('0.2.0'))], /exactly one/);
    stops([member(manifest('9.9.9')), member(manifest('0.2.0'))], /exactly one/);
    stops([member(manifest('0.2.0')), { name: 'package/package.json', type: '2', linkname: 'README.md' }], /exactly one/);
  });
  await t.test('an entry outside package/ stops it, so the manifest npm reads is the one the block read', () => {
    // npm drops the first folder of every entry, so another folder's package.json would be its manifest.
    stops([member(manifest('0.2.0')), { name: 'other/package.json', content: manifest('0.2.0-rc.1') }], /outside package\//);
    stops([member(manifest('0.2.0')), { name: 'package', content: 'x' }], /outside package\//);
    stops([member(manifest('0.2.0')), { name: 'packages/x.txt', content: 'x' }], /outside package\//);
    // An entry name is tarball text too: it must not reach the output.
    stops([member(manifest('0.2.0')), { name: 'CANARYTEXT/package.json', content: manifest('0.2.0-rc.1') }], /outside package\//);
  });
  await t.test('an entry whose path has a .. or . or empty segment stops it', () => {
    for (const name of ['package/../package/package.json', 'package/./package.json', 'package//package.json', 'package/x/..', 'package/CANARYTEXT//x']) {
      // busybox lists package/./package.json as package/package.json, so it stops as a second member.
      stops([member(manifest('0.2.0')), { name, content: manifest('0.2.0-rc.1') }], /odd path|exactly one/);
    }
  });
  await t.test('a package/package.json that is a link or a folder stops it', () => {
    stops([readme, { name: 'package/package.json', type: '2', linkname: 'README.md' }], /not a regular file/);
    stops([readme, { name: 'package/package.json', type: '1', linkname: 'package/README.md' }], /not a regular file/);
    stops([{ name: 'package/package.json', type: '5' }], /not a regular file/);
  });
  await t.test('a file that is not a gzip tar stops it', () => {
    stops(Buffer.from('not a tarball CANARYTEXT\n'), /Could not list/);
    stops(gzipSync(Buffer.from('plain text, not a tar stream CANARYTEXT\n')), /Could not list|no package\/package\.json member/);
  });
  await t.test('the stage step gives npm the dist-tag the block chose, and stops before npm for anything else', () => {
    const stage = stepRun('Stage the tarball');
    // Both steps name one dist-tag file, and it is not in the folder `check` produces.
    const bindFile = stepEnv('Bind the dist-tag to the tarball\'s own version', 'DIST_TAG_FILE');
    assert.equal(stepEnv('Stage the tarball', 'DIST_TAG_FILE'), bindFile, 'both steps use the same dist-tag file');
    assert.ok(bindFile.startsWith('${{ runner.temp }}/') && !bindFile.startsWith(stepEnv('Bind the dist-tag to the tarball\'s own version', 'RELEASE_DIR')), 'the dist-tag file is outside the release folder');
    // The step runs in the release folder, as on the runner; the paths are relative to it.
    const attempt = (distTag: string | null) => {
      const dir = tempDir(t);
      mkdirSync(join(dir, 'release'));
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'release', 'mephistopheles4-athanor-0.2.0.tgz'), 'x');
      writeFileSync(join(dir, 'bin', 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$RUNNER_TEMP/npm-args"\nprintf \'{"@x/y":{"stageId":"stage-1"}}\\n\'\n', { mode: 0o755 });
      if (distTag !== null) writeFileSync(join(dir, 'dist-tag'), distTag);
      const env = { PATH: `${join(dir, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, RUNNER_TEMP: '..', GITHUB_STEP_SUMMARY: '../summary', DIST_TAG_FILE: '../dist-tag' };
      const r = spawnSync('sh', ['-c', stage], { cwd: join(dir, 'release'), env, encoding: 'utf8', shell: false });
      const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
      return { r, args: read('npm-args'), summary: read('summary') };
    };
    for (const tag of ['next', 'latest']) {
      const { r, args, summary } = attempt(`${tag}\n`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(args ?? '', new RegExp(`^stage publish \\./mephistopheles4-athanor-0\\.2\\.0\\.tgz --tag ${tag} `));
      assert.equal((args ?? '').split('--tag').length - 1, 1, 'npm gets exactly one --tag');
      assert.match(summary ?? '', new RegExp(`dist-tag: ${tag}\\n`));
    }
    for (const bad of ['beta\n', '', '\n', 'next latest\n', 'latest\nnext\n', 'NEXT\n', null]) {
      const { r, args } = attempt(bad);
      assert.notEqual(r.status, 0, `${JSON.stringify(bad)} should stop the step`);
      assert.equal(args, null, `${JSON.stringify(bad)}: npm must not run`);
    }
  });
});

test('F6 npm stage publish is always run with --tag', async (t) => {
  await t.test('a stage publish with --tag passes, also when --tag sits on a continuation line', () => {
    assert.equal(releaseChecker(t, workflow('      - run: npm stage publish ./x.tgz --tag next')).status, 0);
    assert.equal(releaseChecker(t, workflow('      - run: |', '          npm stage publish ./x.tgz --provenance \\', '            --tag "$TAG"')).status, 0);
    assert.equal(releaseChecker(t, workflow('      - run: |', '          npm stage publish ./x.tgz --tag=latest')).status, 0);
  });
  await t.test('a stage publish with no --tag fails, indented or in a run block', () => {
    releaseFails(t, workflow('      - run: npm stage publish ./x.tgz --provenance'), 7, /--tag/);
    releaseFails(t, workflow('      - run: |', '          set -e', '          npm stage publish "./$tgz" --provenance --access public'), 9, /--tag/);
    releaseFails(t, workflow('      - run: |', '          npm stage publish ./x.tgz \\', '            --provenance'), 8, /--tag/);
  });
  await t.test('a --tag that only appears in a later command or an echo does not count', () => {
    releaseFails(t, workflow('      - run: |', '          npm stage publish ./x.tgz', '          echo --tag next'), 8, /--tag/);
  });
  await t.test('an echo that mentions the command, and a comment, are not commands', () => {
    assert.equal(releaseChecker(t, workflow('      - run: echo "npm stage publish ./x.tgz"', '      # npm stage publish ./x.tgz')).status, 0);
  });
});

test('F7 the job that names environment npm has no checkout, and no workflow runs npm publish, npm dist-tag or npm stage approve', async (t) => {
  const checkoutStep = ['      - uses: actions/checkout@0123456789012345678901234567890123456789', '        with:', '          persist-credentials: false'];
  await t.test('a checkout in another job than the one naming the environment passes', () => {
    assert.equal(releaseChecker(t, twoJobs(checkoutStep, ['      - run: node --version'])).status, 0);
  });
  await t.test('a checkout in the job that names environment npm fails, at the checkout, also in another case or with quotes', () => {
    releaseFails(t, twoJobs(['      - run: node --version'], checkoutStep), 12, /environment: npm/);
    releaseFails(t, twoJobs(['      - run: node --version'], checkoutStep, "    environment: 'npm'"), 12, /environment: npm/);
    releaseFails(t, twoJobs(['      - run: node --version'], ['      - uses: Actions/Checkout@0123456789012345678901234567890123456789', '        with:', '          persist-credentials: false']), 12, /environment: npm/);
  });
  await t.test('a checkout after a step in the same job fails too', () => {
    releaseFails(t, twoJobs(['      - run: node --version'], ['      - run: node --version', ...checkoutStep]), 13, /environment: npm/);
  });
  await t.test('npm publish, npm dist-tag and npm stage approve fail as commands, indented, in a run block or after a continuation', () => {
    releaseFails(t, workflow('      - run: npm publish'), 7, /npm publish/);
    releaseFails(t, workflow('      - run: |', '          set -e', '          npm publish --provenance'), 9, /npm publish/);
    releaseFails(t, workflow('      - run: npm dist-tag add @x/y@1.0.0 latest'), 7, /npm dist-tag/);
    releaseFails(t, workflow('      - run: npm stage approve 123'), 7, /npm stage approve/);
    releaseFails(t, workflow('      - run: |', '          echo start \\', '            done', '          npm   publish'), 10, /npm publish/);
  });
  await t.test('an echo that mentions a forbidden command, and a comment, are not flagged', () => {
    assert.equal(releaseChecker(t, workflow('      - run: |', '          echo "approve with npm stage approve $id"', '          # npm publish', '      # npm dist-tag add x latest')).status, 0);
  });
  await t.test('release.yml and the other workflows of this repo keep the rules', () => {
    const r = node([script('check-workflows.mjs')], root);
    assert.equal(r.status, 0, r.stderr);
  });
});

test('F8 every workflow that names id-token write starts only on a push of tags v*', async (t) => {
  await t.test('a push of tags v* in block form or flow form passes', () => {
    assert.equal(releaseChecker(t, tokenWorkflow(onTags)).status, 0);
    assert.equal(releaseChecker(t, tokenWorkflow(['on:', '  push:', "    tags: ['v*']"])).status, 0);
    assert.equal(releaseChecker(t, tokenWorkflow(['on:', '  push:', '    tags:', '      - "v*" # the release tags'])).status, 0);
  });
  await t.test('each other trigger fails, at its line', () => {
    releaseFails(t, tokenWorkflow([...onTags, '  workflow_dispatch:']), 6, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  workflow_dispatch:', '  push:', '    tags:', "      - 'v*'"]), 3, /v\*/);
    releaseFails(t, tokenWorkflow([...onTags, '  pull_request:']), 6, /v\*/);
    releaseFails(t, tokenWorkflow(['on: push']), 2, /v\*/);
    releaseFails(t, tokenWorkflow(['on: [push, workflow_dispatch]']), 2, /v\*/);
    releaseFails(t, tokenWorkflow(['on: { push: { tags: ["v*"] } }']), 2, /v\*/);
  });
  await t.test('another key under push fails: branches, paths, tags-ignore', () => {
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    branches:', '      - main', '    tags:', "      - 'v*'"]), 4, /v\*/);
    releaseFails(t, tokenWorkflow([...onTags, '    paths:', "      - 'src/**'"]), 6, /v\*/);
    releaseFails(t, tokenWorkflow([...onTags, '    tags-ignore:', "      - 'v0.*'"]), 6, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    tags-ignore:', "      - 'v0.*'"]), 4, /v\*/);
  });
  await t.test('a wider or extra tag pattern fails', () => {
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    tags:', "      - '*'"]), 5, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    tags:', "      - '**'"]), 5, /v\*/);
    releaseFails(t, tokenWorkflow([...onTags, "      - 'x*'"]), 6, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:', "    tags: ['v*', 'x*']"]), 4, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:']), 3, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    tags:']), 3, /v\*/);
    releaseFails(t, tokenWorkflow(['on:', '  push:', '    tags:', "      - 'v**'"]), 5, /v\*/);
  });
  await t.test('a workflow with id-token write and no on: fails', () => {
    const r = releaseChecker(t, ['name: planted', 'jobs:', '  one:', '    permissions:', '      id-token: write', '    steps:', '      - run: node --version', ''].join('\n'));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /on:/);
  });
});
