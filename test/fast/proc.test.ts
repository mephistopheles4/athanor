// Captured child output (issue 22): each stream is decoded once, so a
// multibyte character split across chunks comes back as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { call } from '#dist/proc.js';
import { AthanorError } from '#dist/errors.js';
import { tempDir } from '../helpers.ts';

test('I22 captured output with a multibyte character split across chunks comes back as written', async () => {
  // Write the two bytes of "é" in separate writes, a pause apart, on both streams.
  const script = `
    const [a, b] = [Buffer.from([0xc3]), Buffer.from([0xa9])];
    process.stdout.write(a); process.stderr.write(a);
    setTimeout(() => { process.stdout.write(b); process.stderr.write(b); }, 100);`;
  const ended = await call([process.execPath, '-e', script]);
  assert.equal(ended.stdout, 'é');
  assert.equal(ended.stderr, 'é');
});

// G8: git and docker start by name, and one that PATH does not hold is named in
// a plain message. A missing working folder is not reported that way.
test('G8 a program PATH does not hold ends in a plain message', async (t) => {
  const name = 'athanor-no-such-program';
  await assert.rejects(call([name]),
    (error: unknown) => error instanceof AthanorError && error.message === `${name} was not found on PATH. Install it, or add its folder to PATH, then run again.`);
  const ended = await call([name], { cwd: join(tempDir(t), 'gone') });
  assert.equal(ended.code, null);
});
