// The strict fake Docker (spec on issue 8, T12): its `run` handling accepts only
// the options athanor uses, and finds the image after the options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fake } from '../helpers.mjs';

test('T12 the fake Docker exits non-zero on an unknown run option, and finds the image after the options', (t) => {
  const f = fake(t);
  const dockerRun = (args) => {
    const [exe, ...rest] = f.docker;
    return spawnSync(exe, [...rest, 'run', ...args], { input: '', encoding: 'utf8', shell: false });
  };
  const typo = dockerRun(['-i', '--netwrk', 'none', '--name', 'c1', 'athanor:img', 'sh']);
  assert.notEqual(typo.status, 0, 'a typo in an option fails');
  assert.match(typo.stderr, /unknown run option --netwrk/);

  // An option value of `sh` must not be taken for the boot command.
  const ok = dockerRun(['-i', '--name', 'sh', '--network', 'none', 'athanor:img', 'sh', '-c', 'true']);
  assert.equal(ok.status, 0, ok.stderr);
  const container = JSON.parse(readFileSync(join(f.dir, 'containers', 'sh.json'), 'utf8'));
  assert.equal(container.image, 'athanor:img');
});
