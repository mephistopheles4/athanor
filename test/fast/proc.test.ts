// Captured child output (issue 22): each stream is decoded once, so a
// multibyte character split across chunks comes back as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, delimiter, dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { call, findProgram } from '#dist/proc.js';
import { AthanorError } from '#dist/errors.js';

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

// G8 (H2 on issue 20): git and docker start by a full path from one of PATH's
// absolute entries, never from the working folder or a relative entry. node
// itself stands in for the program, so the test runs nothing and plants nothing.
test('G8 a program is found only in PATH\'s absolute entries, never in the working folder or a relative entry', () => {
  const dir = dirname(process.execPath);
  const name = parse(process.execPath).name;
  const elsewhere = tmpdir();
  const skipped = (path: string, cwd: string) => assert.throws(() => findProgram(name, { path, cwd }),
    (error: unknown) => error instanceof AthanorError && error.message === `${name} was not found on PATH. Install it, or add its folder to PATH, then run again.`);
  // The working folder holds node and is on PATH as an absolute entry: skipped.
  skipped(dir, dir);
  // A relative entry naming node's folder from the working folder: skipped.
  skipped(['.', '', basename(dir)].join(delimiter), dirname(dir));
  // An absolute entry after the skipped ones: the full path to node.
  assert.equal(findProgram(name, { path: ['.', '', basename(dir), dir].join(delimiter), cwd: elsewhere }), join(dir, basename(process.execPath)));
});
