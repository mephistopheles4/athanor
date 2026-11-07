// The CLI as a child process: version, package shape, and command lines that
// end before Docker. One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultLine } from '#dist/cli.js';
import { cli } from '../helpers.ts';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('C20 --version prints the package version', async () => {
  const r = await cli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('V2 the result line says when the test exited on its own after the memory limit killed a process', () => {
  const line = (containerExitCode: number) => resultLine({ schema: 1, outcome: 'memory', exitCode: 137, containerExitCode });
  assert.match(line(0), /^the test exited 0, but the memory limit killed a process/);
  assert.match(line(3), /^the test exited 3, but the memory limit killed a process/);
  assert.match(line(137), /^the memory limit ended the run/);
});
