// Slot limits with real OS locks, and status. One top-level test per claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, status } from '#dist/index.js';
import { statusLines } from '#dist/cli.js';
import { acquire, ask, askServer, lockPath, lockPort } from '#dist/slots.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf, together, waited } from '../helpers.ts';

// Hold a slot from this process with any answer line; returns a closer.
function holdSlot(t: TestContext, prefix: string, slot: number, line: string) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((s) => { s.on('error', () => {}); s.end(line); });
    server.once('error', reject);
    server.listen(lockPath(prefix, slot), () => {
      t.after(() => new Promise<void>((r) => server.close(() => r())));
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
      assert.match(result.message!, /ATHANOR_MAX_RUNS/);
      assert.equal(docker.calls().length, 0);
    });
  }

  await t.test('a run with limit 2 that finds a holder on slot 3 warns', async (t) => {
    isolate(t);
    const prefix = uniquePrefix();
    await holdSlot(t, prefix, 3, JSON.stringify({ slot: 3, pid: 1, started: 1, repo: 'x', limit: 3 }) + '\n');
    const repo = makeRepo(t, { athanor: baseConfig });
    const lines: string[] = [];
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
  // The run holds its slot until the checks are done, and is then interrupted.
  const docker = fake(t, { run: { hangMs: 20000 } });
  const done = new AbortController();
  t.after(() => done.abort());
  const pending = run({ cwd: repo, docker: docker.docker, prefix, signal: done.signal });
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
  done.abort();
  assert.equal((await pending).outcome, 'interrupted');

  process.env.ATHANOR_MAX_RUNS = '2';
  assert.equal((await status({ docker: docker.docker, prefix })).limitSource, 'environment');
  delete process.env.ATHANOR_MAX_RUNS;
  writeFileSync(join(home, 'config.json'), '{}');
  assert.equal((await status({ docker: docker.docker, prefix })).limitSource, 'default');

  await t.test('an answer whose start time is not a real date is skipped', async (t) => {
    const other = uniquePrefix();
    await holdSlot(t, other, 1, JSON.stringify({ slot: 1, pid: 5, started: 1e20, repo: 'x', limit: 2 }) + '\n');
    const s2 = await status({ docker: docker.docker, prefix: other });
    assert.equal(s2.slots[0].held, true);
    assert.equal(s2.slots[0].pid, undefined);
  });
});

const mac = process.platform === 'darwin';
const mine = () => ({ pid: process.pid, started: Date.now(), repo: 'mc' });
// The pid slot n's holder answers with. On macOS another program could hold a
// test's port, so a held or waiting check first checks whose answer it is.
async function holderPid(prefix: string, slot: number): Promise<number | undefined> {
  const asked = await ask(prefix, slot);
  return asked.held ? asked.answer?.pid : undefined;
}

test('MC1 on macOS a held run slot refuses a second holder, and answers on its loopback port', { skip: !mac && 'the loopback port lock is macOS only', timeout: 20000 }, async (t) => {
  const prefix = uniquePrefix();
  const held = await acquire({ prefix, limit: 1, info: mine() });
  t.after(() => held?.release());
  assert.equal(await holderPid(prefix, 1), process.pid);
  const line = await new Promise<string>((resolve, reject) => {
    let data = '';
    const socket = net.connect({ host: '127.0.0.1', port: lockPort(prefix, 'slot', 1)! });
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.equal(JSON.parse(line).pid, process.pid);
  assert.equal(await acquire({ prefix, limit: 1, info: mine(), signal: AbortSignal.timeout(1500) }), null);
  // On 127.0.0.1 only: the Mac's own network address does not reach the lock.
  const outside = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal);
  assert.ok(outside, 'this host has a network address to try');
  const reached = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: outside.address, port: lockPort(prefix, 'slot', 1)! });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
  assert.equal(reached, false, `the lock answers on ${outside.address}`);
});

test('MC2 a slot is free within 2 seconds of its holder being hard-killed', { skip: process.platform === 'win32' && 'macOS and Linux; the probe covers the Windows pipe', timeout: 20000 }, async (t) => {
  const prefix = uniquePrefix();
  const script = `
    import { acquire } from ${JSON.stringify(import.meta.resolve('#dist/slots.js'))};
    await acquire({ prefix: ${JSON.stringify(prefix)}, limit: 1, info: { pid: process.pid, started: Date.now(), repo: 'mc' } });
    console.log('ready');
    setInterval(() => {}, 1 << 30);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], shell: false });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error('the holder ended before it held the slot')));
  });
  assert.equal(await holderPid(prefix, 1), child.pid);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const next = await acquire({ prefix, limit: 1, info: mine(), signal: AbortSignal.timeout(2000) });
  t.after(() => next?.release());
  assert.equal(next?.slot, 1);
});

test('MC3 with every slot held, another caller is told once, waits, and gets the slot that is released', { timeout: 30000 }, async (t) => {
  const prefix = uniquePrefix();
  const take = (signal?: AbortSignal, onWait?: () => void) => acquire({ prefix, limit: 2, info: mine(), signal, onWait });
  const first = await take();
  const second = await take();
  t.after(async () => { await first?.release(); await second?.release(); });
  assert.equal(await holderPid(prefix, 1), process.pid);
  assert.equal(await holderPid(prefix, 2), process.pid);

  const stop = new AbortController();
  let settled = false;
  let told = 0;
  const waiting = take(stop.signal, () => { told++; }).finally(() => { settled = true; });
  await sleep(2500);
  assert.equal(settled, false, 'it has no slot while both are held');
  stop.abort();
  assert.equal(await waiting, null);
  assert.equal(told, 1);

  let toldAgain = 0;
  let isWaiting: () => void = () => {};
  const onceWaiting = new Promise<void>((resolve) => { isWaiting = resolve; });
  const third = take(AbortSignal.timeout(10000), () => { toldAgain++; isWaiting(); });
  await onceWaiting;
  await first?.release();
  const got = await third;
  t.after(() => got?.release());
  assert.equal(got?.slot, 1);
  assert.equal(toldAgain, 1);
});

test('MC4 each lock has one port, and a lock number above 65 has none', async (t) => {
  for (let n = 1; n <= 65; n++) {
    assert.equal(lockPort('athanor', 'slot', n), 47300 + n);
    assert.equal(lockPort('athanor', 'server', n), 47400 + n);
  }
  const prefix = uniquePrefix();
  for (const kind of ['slot', 'server'] as const) {
    assert.equal(lockPort('athanor', kind, 66), null);
    assert.equal(lockPort(prefix, kind, 66), null);
    for (const n of [1, 65]) {
      const hashed = createHash('sha256').update(`${prefix}-${kind}-${n}`).digest().readUInt32BE(0);
      const port = lockPort(prefix, kind, n);
      assert.equal(port, 20000 + (hashed % 27000));
      assert.ok(port! >= 20000 && port! <= 46999);
      assert.equal(lockPort(prefix, kind, n), port);
    }
  }
  assert.deepEqual(lockPath(prefix, 1, 'server', 'darwin'), { host: '127.0.0.1', port: lockPort(prefix, 'server', 1) });
  assert.equal(lockPath(prefix, 66, 'slot', 'darwin'), null);
  assert.deepEqual(await askServer(prefix, 70000), { held: false });

  // A server number comes from a container label. Under athanor's own prefix
  // these give no usable port, so nothing is connected to.
  await t.test('on macOS a label that gives no usable port is held by nobody', { skip: !mac && 'the loopback port lock is macOS only' }, async () => {
    for (const n of [NaN, -50000]) assert.deepEqual(await askServer('athanor', n), { held: false });
  });
});

test('MC6 on macOS a port another program holds shows as a held slot, with how to find that program', async (t) => {
  await t.test('the macOS status line names the port; the Linux and Windows lines keep their old wording', () => {
    const result: Parameters<typeof statusLines>[0] = {
      schema: 1, limit: 2, limitSource: 'default', slots: [{ slot: 1 }, { slot: 2, held: true }], containers: [],
      serverLimit: 1, serverLimitSource: 'default', servers: [{ server: 1, held: true }], serverContainers: [],
    };
    const hint = (port: number) => `held, by a program that gave no athanor answer, on 127.0.0.1:${port}. To see which, run lsof -nP -iTCP:${port} -sTCP:LISTEN.`;
    const onMac = statusLines(result, 'darwin');
    for (const line of ['slot 1: free.', `slot 2: ${hint(47302)}`, `server 1: ${hint(47401)}`]) assert.ok(onMac.includes(line), onMac.join('\n'));
    for (const platform of ['linux', 'win32'] as const) {
      const lines = statusLines(result, platform);
      for (const line of ['slot 1: free.', 'slot 2: free.', 'server 1: held.']) assert.ok(lines.includes(line), lines.join('\n'));
    }
  });

  await t.test('a plain listener on a slot\'s port holds it, and a run waits', { skip: !mac && 'the loopback port lock is macOS only', timeout: 30000 }, async (t) => {
    isolate(t, { ATHANOR_MAX_RUNS: '1' });
    const prefix = uniquePrefix();
    const port = lockPort(prefix, 'slot', 1)!;
    const open = new Set<net.Socket>();
    const other = net.createServer((socket) => { open.add(socket); socket.on('error', () => {}); });
    await new Promise<void>((resolve, reject) => {
      other.once('error', reject);
      other.listen({ host: '127.0.0.1', port }, () => resolve());
    });
    t.after(() => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      other.close(() => resolve());
    }));
    const docker = fake(t);
    const s = await status({ docker: docker.docker, prefix });
    assert.equal(s.slots[0]!.held, true);
    assert.equal(s.slots[0]!.pid, undefined);
    const lines = statusLines(s, 'darwin', prefix);
    assert.ok(lines.some((l) => l.startsWith('slot 1: held') && l.includes(`-iTCP:${port} `)), lines.join('\n'));

    const repo = makeRepo(t, { athanor: baseConfig });
    const stop = new AbortController();
    const progress: string[] = [];
    let settled = false;
    const pending = run({ cwd: repo, docker: docker.docker, prefix, signal: stop.signal, onProgress: (l) => progress.push(l) })
      .finally(() => { settled = true; });
    while (!settled && !waited(progress)) await sleep(50);
    await sleep(2500);
    assert.equal(settled, false, 'the run is still waiting');
    stop.abort();
    const result = await pending;
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.slot, undefined);
    assert.equal(callsOf(docker.calls(), 'run').length, 0);
  });
});

test('MC13 on Linux and Windows the lock addresses are the same strings as before', () => {
  const prefix = uniquePrefix();
  for (const [kind, n] of [['slot', 1], ['server', 3], ['slot', 66]] as const) {
    assert.equal(lockPath(prefix, n, kind, 'win32'), `\\\\.\\pipe\\${prefix}-${kind}-${n}`);
    assert.equal(lockPath(prefix, n, kind, 'linux'), `\0${prefix}-${kind}-${n}`);
  }
  if (!mac) assert.equal(lockPath(prefix, 1), lockPath(prefix, 1, 'slot', process.platform));
});
