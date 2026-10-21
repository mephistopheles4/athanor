// Captured child output (issue 22): each stream is decoded once, so a
// multibyte character split across chunks comes back as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from '#dist/proc.js';

test('I22 captured output with a multibyte character split across chunks comes back as written', async () => {
  // Write the two bytes of "é" in separate writes, a pause apart, on both streams.
  const script = `
    const [a, b] = [Buffer.from([0xc3]), Buffer.from([0xa9])];
    process.stdout.write(a); process.stderr.write(a);
    setTimeout(() => { process.stdout.write(b); process.stderr.write(b); }, 100);`;
  const chunks: Buffer[] = [];
  const ended = await call([process.execPath, '-e', script], { onStdout: (c) => chunks.push(c) });
  assert.equal(chunks.length, 2, 'the output arrived in two chunks');
  assert.equal(ended.stdout, 'é');
  assert.equal(ended.stderr, 'é');
});
