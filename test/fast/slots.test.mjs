// Slot limits with real OS locks, and status. One top-level test per claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { run, status } from '../../dist/index.js';
import { lockPath } from '../../dist/slots.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf, together, waited } from '../helpers.mjs';

// Hold a slot from this process with any answer line; returns a closer.
function holdSlot(t, prefix, slot, line) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((s) => { s.on('error', () => {}); s.end(line); });
    server.once('error', reject);
    server.listen(lockPath(prefix, slot), () => {
      t.after(() => new Promise((r) => server.close(() => r())));
      resolve(server);
    });
  });
}


test('C9 ATHANOR_MAX_RUNS sets the limit, bad values exit 125, and a holder above the limit gives a warning', async (t) => {
  await t.test('with 3, three runs go at once', async (t) => {
    isolate(t, { ATHANOR_MAX_RUNS: '3' });
    const { results, progress } = await together(t, 3);
    assert.deepEqual(results.map((r) => r.slot).sort(), [1, 2, 3]);
    assert.equal(progress.some(waited), false, 'no run waited');
  });

  for (const value of ['0', '-1', 'x', '2.5', '']) {
    await t.test(`ATHANOR_MAX_RUNS=${JSON.stringify(value)} exits 125`, async (t) => {
      isolate(t, { ATHANOR_MAX_RUNS: value });
      const repo = makeRepo(t, { athanor: baseConfig });
      const docker = fake(t);
      const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
      assert.equal(result.exitCode, 125);
      assert.match(result.message, /ATHANOR_MAX_RUNS/);
      assert.equal(docker.calls().length, 0);
    });
  }

  await t.test('a run with limit 2 that finds a holder on slot 3 warns', async (t) => {
    isolate(t);
    const prefix = uniquePrefix();
    await holdSlot(t, prefix, 3, JSON.stringify({ slot: 3, pid: 1, started: 1, repo: 'x', limit: 3 }) + '\n');
    const repo = makeRepo(t, { athanor: baseConfig });
    const lines = [];
    const result = await run({ cwd: repo, docker: fake(t).docker, prefix, onProgress: (l) => lines.push(l) });
    assert.equal(result.outcome, 'pass');
    assert.ok(lines.some((l) => /warning: another caller uses a different run limit/.test(l)), lines.join('\n'));
  });
});

test('C13 status lists the limit and its source, each holder, and every athanor container, and starts none', async (t) => {
  const home = isolate(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ maxRuns: 3 }));
  const prefix = uniquePrefix();
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t, { run: { hangMs: 3000 } });
  const pending = run({ cwd: repo, docker: docker.docker, prefix });
  while (callsOf(docker.calls(), 'run').length === 0) await new Promise((r) => setTimeout(r, 50));
  docker.addContainer(`${prefix}-slot-3`, { 'athanor.slot': '3' });
  await holdSlot(t, prefix, 2, 'not json\n');
  const runsBefore = callsOf(docker.calls(), 'run').length;

  const s = await status({ docker: docker.docker, prefix });
  assert.equal(s.schema, 1);
  assert.equal(s.limit, 3);
  assert.equal(s.limitSource, 'file');
  assert.equal(s.slots.length, 3);
  const [one, two, three] = s.slots;
  assert.equal(one.slot, 1);
  assert.equal(one.pid, process.pid);
  assert.equal(one.repo, basename(repo));
  assert.equal(one.limit, 3);
  assert.equal(typeof one.started, 'number');
  assert.equal(two.held, true);
  assert.equal(two.pid, undefined, 'a malformed answer is skipped');
  assert.equal(three.held, undefined);
  assert.deepEqual(s.containers.sort((a, b) => a.slot - b.slot), [
    { name: `${prefix}-slot-1`, slot: 1, orphan: false },
    { name: `${prefix}-slot-3`, slot: 3, orphan: true },
  ]);
  assert.equal(callsOf(docker.calls(), 'run').length, runsBefore, 'status starts no container');
  await pending;

  process.env.ATHANOR_MAX_RUNS = '2';
  assert.equal((await status({ docker: docker.docker, prefix })).limitSource, 'environment');
  delete process.env.ATHANOR_MAX_RUNS;
  writeFileSync(join(home, 'config.json'), '{}');
  assert.equal((await status({ docker: docker.docker, prefix })).limitSource, 'default');

  await t.test('an answer whose repo name holds control characters is skipped', async (t) => {
    const other = uniquePrefix();
    await holdSlot(t, other, 1, JSON.stringify({ slot: 1, pid: 5, started: 1, repo: 'x\nslot 2: free\u001b[2J', limit: 2 }) + '\n');
    const s2 = await status({ docker: docker.docker, prefix: other });
    assert.equal(s2.slots[0].held, true);
    assert.equal(s2.slots[0].repo, undefined);
  });

  await t.test('an answer whose start time is not a real date is skipped', async (t) => {
    const other = uniquePrefix();
    await holdSlot(t, other, 1, JSON.stringify({ slot: 1, pid: 5, started: 1e20, repo: 'x', limit: 2 }) + '\n');
    const s2 = await status({ docker: docker.docker, prefix: other });
    assert.equal(s2.slots[0].held, true);
    assert.equal(s2.slots[0].pid, undefined);
  });
});
