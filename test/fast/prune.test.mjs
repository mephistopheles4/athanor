// prune's choices, and what athanor leaves alone. One top-level test per claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run, prune } from '../../src/index.mjs';
import { lockPath } from '../../src/slots.mjs';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf } from '../helpers.mjs';

const hex = (c) => c.repeat(32);
const DAY = 24 * 60 * 60 * 1000;

function mark(home, hash, ageDays) {
  mkdirSync(join(home, 'images'), { recursive: true });
  const file = join(home, 'images', hash);
  writeFileSync(file, '');
  const when = new Date(Date.now() - ageDays * DAY);
  utimesSync(file, when, when);
}

test('C14 prune removes athanor tags unused for n days, keeps newer ones and other images, and --dry-run removes nothing', async (t) => {
  const home = isolate(t);
  const docker = fake(t);
  for (const tag of [`athanor:${hex('a')}`, `athanor:${hex('b')}`, 'alpine:3.20', 'athanor-other:x']) docker.addImage(tag);
  mark(home, hex('a'), 10);
  mark(home, hex('b'), 2);

  const dry = await prune({ docker: docker.docker, days: 5, dryRun: true });
  assert.deepEqual(dry, { schema: 1, dryRun: true, removed: [`athanor:${hex('a')}`], kept: [`athanor:${hex('b')}`] });
  assert.equal(callsOf(docker.calls(), 'rmi').length, 0);

  const real = await prune({ docker: docker.docker, days: 5 });
  assert.deepEqual(real.removed, [`athanor:${hex('a')}`]);
  assert.deepEqual(callsOf(docker.calls(), 'rmi').map((c) => c.args.at(-1)), [`athanor:${hex('a')}`]);

  await t.test('without --days, pruneDays comes from the machine file, else 30', async (t) => {
    const home = isolate(t);
    const d = fake(t);
    d.addImage(`athanor:${hex('c')}`);
    mark(home, hex('c'), 10);
    assert.deepEqual((await prune({ docker: d.docker, dryRun: true })).removed, []);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ pruneDays: 7 }));
    assert.deepEqual((await prune({ docker: d.docker, dryRun: true })).removed, [`athanor:${hex('c')}`]);
  });
});

test('C26 athanor leaves alone what is not its own or is in use, and a prune before a run\'s slot leaves the run working', async (t) => {
  await t.test('prune keeps athanor:dev, an unmarked tag, and a tag in use by an athanor container', async (t) => {
    const home = isolate(t);
    const docker = fake(t);
    for (const tag of ['athanor:dev', `athanor:${hex('d')}`, `athanor:${hex('e')}`]) docker.addImage(tag);
    mark(home, hex('e'), 400);
    docker.addContainer('athanor-slot-1', { 'athanor.slot': '1' }, `athanor:${hex('e')}`);
    const result = await prune({ docker: docker.docker, days: 1 });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.kept.sort(), [`athanor:${hex('d')}`, `athanor:${hex('e')}`]);
    assert.ok(existsSync(join(home, 'images', hex('d'))), 'an unmarked tag gets a mark');
  });

  await t.test('a same-named container without athanor\'s label is left alone and the run exits 125', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: baseConfig });
    const docker = fake(t);
    const prefix = uniquePrefix();
    docker.addContainer(`${prefix}-slot-1`, { other: 'x' });
    const result = await run({ cwd: repo, docker: docker.docker, prefix });
    assert.equal(result.exitCode, 125);
    assert.match(result.message, /without athanor's label/);
    assert.equal(callsOf(docker.calls(), 'rm').length, 0);
    assert.equal(callsOf(docker.calls(), 'run').length, 0);
  });

  await t.test('an image pruned while the run waits for its slot is built again, never pulled', async (t) => {
    isolate(t, { ATHANOR_MAX_RUNS: '1' });
    const prefix = uniquePrefix();
    const holder = net.createServer((s) => s.end('{}\n'));
    await new Promise((r) => holder.listen(lockPath(prefix, 1), r));
    const repo = makeRepo(t, { athanor: baseConfig });
    const docker = fake(t);
    let waiting;
    const isWaiting = new Promise((r) => { waiting = r; });
    const pending = run({ cwd: repo, docker: docker.docker, prefix, onProgress: (l) => /waiting/.test(l) && waiting() });
    await isWaiting;
    for (const f of readdirSync(join(docker.dir, 'images'))) unlinkSync(join(docker.dir, 'images', f));
    await new Promise((r) => holder.close(r));
    const result = await pending;
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.equal(callsOf(docker.calls(), 'build').length, 2);
    const args = callsOf(docker.calls(), 'run')[0].args;
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
    assert.equal(callsOf(docker.calls(), 'pull').length, 0);
  });
});
