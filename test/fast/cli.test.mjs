// The CLI as a child process: version, package shape, and command lines that
// end before Docker. One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cli } from '../helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));

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
