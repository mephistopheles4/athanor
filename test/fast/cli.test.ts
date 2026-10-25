// The CLI as a child process: version, package shape, and command lines that
// end before Docker. One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultLine } from '#dist/cli.js';
import { cli } from '../helpers.ts';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('C20 no dependencies, Node >=24, and --version prints the package version', async () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.bin.athanor, 'bin/athanor.mjs');
  assert.equal(pkg.name, '@mephistopheles4/athanor');
  assert.equal(pkg.publishConfig.access, 'public', 'a scoped package publishes private unless told');
  const r = await cli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('V2 the result line says when the test exited on its own after the memory limit killed a process', () => {
  assert.equal(
    resultLine({ schema: 1, outcome: 'memory', exitCode: 137, containerExitCode: 0 }),
    "the test exited 0, but the memory limit killed a process in the container during the run (exit 137). The test's result may be incomplete. Raise memory in the repo configuration, or use less.",
  );
  assert.match(resultLine({ schema: 1, outcome: 'memory', exitCode: 137, containerExitCode: 3 }), /^the test exited 3, but the memory limit killed a process/);
  assert.equal(
    resultLine({ schema: 1, outcome: 'memory', exitCode: 137, containerExitCode: 137 }),
    'the memory limit ended the run (exit 137). Raise memory in the repo configuration, or use less.',
  );
});
