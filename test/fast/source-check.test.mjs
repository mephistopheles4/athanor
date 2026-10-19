// The source check: no shell use anywhere in the source (S5, C16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, writeFiles } from '../helpers.mjs';

const script = fileURLToPath(new URL('../../scripts/check-source.mjs', import.meta.url));
const check = (...dirs) => spawnSync(process.execPath, [script, ...dirs], { encoding: 'utf8', shell: false });

test('C16 the source check passes on athanor and fails on each kind of shell use', async (t) => {
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);

  const bad = [
    "spawn('docker', [], { shell: true });",
    "spawnSync('git', args, {shell:true})",
    "import { exec } from 'node:child_process'; exec('ls');",
    "child_process.execSync('ls')",
    "execFile('git', ['x'], { shell: 'bash' })",
    "execFileSync('git', [], { shell: true })",
  ];
  for (const line of bad) {
    await t.test(line, () => {
      const dir = tempDir(t);
      writeFiles(dir, { 'src/bad.mjs': `${line}\n` });
      const r = check(join(dir, 'src'));
      assert.equal(r.status, 1, `expected a failure for: ${line}`);
      assert.match(r.stderr, /bad\.mjs:1/);
    });
  }
});
