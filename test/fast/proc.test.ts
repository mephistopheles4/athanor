// Captured child output (issue 22): each stream is decoded once, so a
// multibyte character split across chunks comes back as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, delimiter, dirname, join, parse, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { call, findProgram, programNames } from '#dist/proc.js';
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
// absolute entries, never from the working folder or a relative entry, and on
// Windows only by a name Windows can start. node itself stands in for the
// program, so the test runs nothing and plants nothing.
test('G8 a program is found only in PATH\'s absolute entries, never in the working folder or a relative entry', () => {
  const dir = dirname(process.execPath);
  const name = parse(process.execPath).name;
  const elsewhere = tmpdir();
  const skipped = (path: string, cwd: string) => assert.throws(() => findProgram(name, { path, cwd }),
    (error: unknown) => error instanceof AthanorError && error.message === `${name} was not found on PATH. Install it, or add its folder to PATH, then run again.`);
  const windows = process.platform === 'win32';
  // The working folder holds node and is on PATH as an absolute entry: skipped,
  // however the entry spells it.
  skipped(dir, dir);
  skipped(dir + sep, dir);
  if (windows) skipped(dir.toUpperCase(), dir);
  // A relative entry naming node's folder from the working folder: skipped.
  skipped(['.', '', basename(dir)].join(delimiter), dirname(dir));
  // On Windows, entries that hang off a drive or its current folder are
  // relative too: skipped.
  if (windows) {
    const { root } = parse(dir);
    skipped(root.slice(0, 2) + basename(dir), dirname(dir));
    skipped(dir.slice(root.length - 1), dirname(dir));
  }
  // The names tried in each folder: on Windows, a name with no extension only
  // with .com, then .exe, since Windows cannot start it as given.
  assert.deepEqual(programNames('git'), windows ? ['git.com', 'git.exe'] : ['git']);
  assert.deepEqual(programNames('git.exe'), ['git.exe']);
  // An absolute entry after the skipped ones: the full path to node.
  assert.equal(findProgram(name, { path: ['.', '', basename(dir), dir].join(delimiter), cwd: elsewhere }), join(dir, basename(process.execPath)));
});
