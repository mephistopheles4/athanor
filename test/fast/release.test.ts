// The release checks (spec on issue 6): the pack check that CI and the
// release workflow share, and the workflow check that keeps every checkout's
// token out of the clone, every cache off and every npm token out.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, writeFiles } from '../helpers.ts';

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

test('R2 the workflow check fails each broken rule, naming the file and line, and passes the repo\'s own workflows', async (t) => {
  const check = (dir?: string) => node([script('check-workflows.mjs'), ...(dir ? [dir] : [])], root);
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
  await t.test('the repo\'s own workflows pass', () => {
    const r = check();
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
  await t.test('an action name in another case is still read', () => {
    fails(workflow('      - uses: Actions/Checkout@0123456789012345678901234567890123456789'), 7, /persist-credentials: false/);
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
    fails(['name: planted', 'on: push', 'jobs:', '  one:', '    uses: ./.github/workflows/other.yml', '    secrets: inherit', ''].join('\n'), 6, /secret/);
  });
  await t.test('a .yaml file is read too', () => {
    fails(workflow('      - uses: actions/cache@0123456789012345678901234567890123456789'), 7, /cache/, 'planted.yaml');
  });
});
