// The TypeScript toolchain (spec on issue 8): the source check reads .ts, a
// compile error fails the build, and the compiled boot script keeps LF.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolate, tempDir, writeFiles } from '../helpers.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, 'dist');
const build = join(root, 'scripts', 'build.mjs');
const sourceCheck = fileURLToPath(new URL('../../scripts/check-source.mjs', import.meta.url));
const check = (...dirs: string[]) => spawnSync(process.execPath, [sourceCheck, ...dirs], { encoding: 'utf8', shell: false });

test('T4 a compile error fails the build of a copy, which clears its dist/ first, and the run ends as a failure; the repo\'s dist/ is untouched', (t) => {
  isolate(t);
  const listing = () => readdirSync(dist).sort();
  const before = { names: listing(), index: readFileSync(join(dist, 'index.js')) };
  const copy = tempDir(t);
  cpSync(join(root, 'tsconfig.json'), join(copy, 'tsconfig.json'));
  cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true });
  writeFiles(copy, {
    // Without it the copy's .ts files build as CommonJS, and cli.ts's import.meta adds a second error.
    'package.json': '{ "type": "module" }\n',
    'src/planted.ts':"export const planted: number = 'not a number';\n",
    'dist/stale.mjs': 'export {};\n',
  });
  const r = spawnSync(process.execPath, [build, copy], { encoding: 'utf8', shell: false });
  assert.notEqual(r.status, 0, 'the build fails');
  const errors = (r.stdout + r.stderr).match(/^.*error TS\d+.*$/gm) ?? [];
  assert.equal(errors.length, 1, `only the planted error: ${errors.join('\n')}`);
  assert.match(errors[0], /planted\.ts.*error TS2322/);
  assert.equal(existsSync(join(copy, 'dist', 'stale.mjs')), false, 'the copy\'s dist/ was cleared first');
  assert.deepEqual(listing(), before.names);
  assert.deepEqual(readFileSync(join(dist, 'index.js')), before.index);

  // The runner, copied in, ends the run as a failure. Its build step is a stand-in
  // that runs this repo's build script on the copy, so the compiler is found.
  cpSync(join(root, 'test', 'run.mjs'), join(copy, 'test', 'run.mjs'));
  writeFiles(copy, {
    'scripts/build.mjs': `process.argv[2] = ${JSON.stringify(copy)};\nawait import(${JSON.stringify(pathToFileURL(build).href)});\n`,
  });
  const ran = spawnSync(process.execPath, [join(copy, 'test', 'run.mjs'), 'fast'], { encoding: 'utf8', shell: false });
  assert.equal(ran.status, 1, 'the run exits non-zero');
  assert.match(ran.stdout + ran.stderr, /planted\.ts.*error TS2322/);
  assert.equal(ran.stdout.trim().split('\n').at(-1), 'result: fast fail');
  assert.deepEqual(listing(), before.names);
});

test('T13 the boot script in the compiled output has no carriage return', async (t) => {
  isolate(t);
  const { BOOT } = await import('#dist/index.js');
  assert.match(BOOT, /^set -e\n/);
  assert.equal(BOOT.includes('\r'), false);
  assert.equal(readFileSync(join(dist, 'container-settings.js'), 'latin1').includes('\r'), false, 'dist/container-settings.js, which holds the boot script, has LF line endings');
});

test('T5 a shell use planted in a .ts file fails the source check', async (t) => {
  isolate(t);
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
  // Every other JavaScript and TypeScript extension the source check reads is read too.
  for (const ext of ['mts', 'cts', 'tsx', 'jsx']) {
    await t.test(`a .${ext} file`, () => {
      const dir = tempDir(t);
      writeFiles(dir, { [`src/bad.${ext}`]: `${bad[0]}\n` });
      const r = check(join(dir, 'src'));
      assert.equal(r.status, 1, `expected a failure for a .${ext} file`);
      assert.match(r.stderr, new RegExp(`bad\\.${ext}:\\d+: `));
    });
  }
});
