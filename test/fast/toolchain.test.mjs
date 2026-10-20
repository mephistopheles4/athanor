// The TypeScript toolchain (spec on issue 8): the source check reads .ts, a
// compile error fails the build, and the compiled boot script keeps LF.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, writeFiles } from '../helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, 'dist');
const build = join(root, 'scripts', 'build.mjs');
const sourceCheck = fileURLToPath(new URL('../../scripts/check-source.mjs', import.meta.url));
const check = (...dirs) => spawnSync(process.execPath, [sourceCheck, ...dirs], { encoding: 'utf8', shell: false });

test('T4 a compile error fails the build of a copy, which clears its dist/ first, and the repo\'s dist/ is untouched', (t) => {
  const listing = () => readdirSync(dist).sort();
  const before = { names: listing(), index: readFileSync(join(dist, 'index.mjs')) };
  const copy = tempDir(t);
  cpSync(join(root, 'tsconfig.json'), join(copy, 'tsconfig.json'));
  cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true });
  writeFiles(copy, {
    'src/planted.ts': "export const planted: number = 'not a number';\n",
    'dist/stale.mjs': 'export {};\n',
  });
  const r = spawnSync(process.execPath, [build, copy], { encoding: 'utf8', shell: false });
  assert.notEqual(r.status, 0, 'the build fails');
  const errors = (r.stdout + r.stderr).match(/^.*error TS\d+.*$/gm) ?? [];
  assert.equal(errors.length, 1, `only the planted error: ${errors.join('\n')}`);
  assert.match(errors[0], /planted\.ts.*error TS2322/);
  assert.equal(existsSync(join(copy, 'dist', 'stale.mjs')), false, 'the copy\'s dist/ was cleared first');
  assert.deepEqual(listing(), before.names);
  assert.deepEqual(readFileSync(join(dist, 'index.mjs')), before.index);
});

test('T13 the boot script in the compiled output has no carriage return', async () => {
  const { BOOT } = await import('../../dist/index.mjs');
  assert.match(BOOT, /^set -e\n/);
  assert.equal(BOOT.includes('\r'), false);
  assert.equal(readFileSync(join(dist, 'index.mjs'), 'latin1').includes('\r'), false, 'dist/index.mjs has LF line endings');
});

test('T5 a shell use planted in a .ts file fails the source check', async (t) => {
  const bad = [
    "spawn('docker', [], { shell: true } as SpawnOptions);",
    "const o: SpawnOptions = {}; o.shell = true;",
    "import { exec } from 'node:child_process'; exec('ls');",
  ];
  for (const line of bad) {
    await t.test(line, () => {
      const dir = tempDir(t);
      writeFiles(dir, { 'src/bad.ts': `${line}\n` });
      const r = check(join(dir, 'src'));
      assert.equal(r.status, 1, `expected a failure for: ${line}`);
      assert.match(r.stderr, /bad\.ts:\d+: /);
    });
  }
});
