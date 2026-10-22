// The docker tier: real Docker with a small Alpine fixture. Every test uses its
// own state folder and name prefix, so no live session's slots are touched.
// One top-level test per acceptance claim.
import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, status } from '#dist/index.js';
import type { RunOptions } from '#dist/index.js';
import { ask } from '#dist/slots.js';
import { makeRepo, isolate, uniquePrefix, collector, cli, tempDir, bin } from '../helpers.ts';

const driver = join(dirname(fileURLToPath(import.meta.url)), 'driver.ts');
const FIXTURE = {
  'test/Dockerfile': 'FROM alpine:3.20\nRUN apk add --no-cache git\n',
};
const config = { dockerfile: 'test/Dockerfile', commands: { test: ['sh', '-c', 'echo fixture-ok'] } };
const builtTags = new Set<string>();
after(() => {
  for (const tag of builtTags) spawnSync('docker', ['rmi', '-f', tag], { shell: false });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fixtureRepo(t: TestContext, files: Record<string, string> = {}) {
  return makeRepo(t, { athanor: config, files: { ...FIXTURE, ...files } });
}

async function runReal(t: TestContext, repo: string, extra: RunOptions = {}) {
  const stdout = collector();
  const stderr = collector();
  const result = await run({ cwd: repo, prefix: extra.prefix ?? uniquePrefix(), stdout, stderr, ...extra });
  if (result.image?.tag) builtTags.add(result.image.tag);
  return { result, stdout: stdout.text(), stderr: stderr.text() };
}

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8', shell: false });
}

function runningCount(prefix: string) {
  const r = docker(['ps', '--filter', `name=^${prefix}-slot-`, '--format', '{{.Names}}']);
  return r.stdout.split('\n').filter(Boolean).length;
}

function startDriver(options: Record<string, unknown>) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', driver, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out, err })));
  return { child, done, err: () => err };
}

async function until(check: () => unknown, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('C1 a run builds the image, runs the command, streams output and exits with its code', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t);
  const pass = await runReal(t, repo);
  assert.equal(pass.result.outcome, 'pass', JSON.stringify(pass.result) + pass.stderr);
  assert.equal(pass.stdout, 'fixture-ok\n');
  const fail = await runReal(t, repo, { command: ['sh', '-c', 'echo failing >&2; exit 3'] });
  assert.equal(fail.result.outcome, 'fail');
  assert.equal(fail.result.exitCode, 3);
  assert.match(fail.stderr, /failing/);
});

test('J9 a repo with only athanor.json (no package.json) runs its command and passes', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { packageJson: false, files: { ...FIXTURE, 'athanor.json': JSON.stringify(config) } });
  const { result, stdout, stderr } = await runReal(t, repo);
  assert.equal(result.outcome, 'pass', JSON.stringify(result) + stderr);
  assert.equal(stdout, 'fixture-ok\n');
});

test('C2 a warm run makes no build and adds at most 5 seconds to the container\'s run time', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t);
  await runReal(t, repo);
  const started = Date.now();
  const warm = await runReal(t, repo);
  const wall = Date.now() - started;
  assert.equal(warm.result.image!.built, false);
  assert.ok(wall - warm.result.ranMs! <= 5000, `wall ${wall} ms, container ${warm.result.ranMs} ms`);
});

test('C4 an uncommitted edit reaches the container', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t, { 'a.txt': 'committed\n' });
  writeFileSync(join(repo, 'a.txt'), 'edited\n');
  const r = await runReal(t, repo, { command: ['cat', 'a.txt'] });
  assert.equal(r.result.outcome, 'pass', r.stderr);
  assert.equal(r.stdout, 'edited\n');
});

test('C6 inside a run, a host name does not resolve and a raw IP cannot be reached', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t);
  const script = [
    'if nslookup example.com >/dev/null 2>&1; then echo dns-worked; exit 1; fi',
    'if wget -q -T 5 -O /dev/null http://1.1.1.1/; then echo ip-worked; exit 2; fi',
    'echo offline',
  ].join('\n');
  const r = await runReal(t, repo, { command: ['sh', '-c', script] });
  assert.equal(r.result.outcome, 'pass', r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'offline');
});

test('C7 U6 the container gets the memory, CPU, process and privilege limits', async (t) => {
  isolate(t);
  const prefix = uniquePrefix();
  const repo = fixtureRepo(t);
  const pending = runReal(t, repo, { prefix, command: ['sleep', '6'] });
  const name = `${prefix}-slot-1`;
  let inspected: any;
  await until(() => {
    const r = docker(['inspect', '--format', '{{json .HostConfig}}', name]);
    if (r.status === 0) inspected = JSON.parse(r.stdout);
    return r.status === 0;
  }, 120000, 'the container to start');
  await pending;
  assert.equal(inspected.Memory, 2 * 1024 ** 3);
  assert.equal(inspected.MemorySwap, 2 * 1024 ** 3);
  assert.equal(inspected.NanoCpus, 0, 'no CPU limit unless one is configured');
  assert.equal(inspected.PidsLimit, 1024);
  assert.ok(inspected.SecurityOpt.includes('no-new-privileges'));
  assert.equal(inspected.NetworkMode, 'none');
  assert.deepEqual(inspected.Binds ?? [], []);
});

test('C8 with the default limit, three runs never have more than two containers at once', async (t) => {
  isolate(t);
  const prefix = uniquePrefix();
  const repo = fixtureRepo(t);
  await runReal(t, repo); // build first, so all three start together
  const progress: string[][] = [[], [], []];
  let most = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      most = Math.max(most, runningCount(prefix));
      await sleep(150);
    }
  })();
  let midStatus;
  const runs = progress.map((lines) => runReal(t, repo, { prefix, command: ['sleep', '3'], onProgress: (l) => lines.push(l) }));
  await until(() => runningCount(prefix) === 2, 60000, 'two containers to run');
  midStatus = await status({ prefix });
  const results = await Promise.all(runs);
  sampling = false;
  await sampler;
  assert.ok(most <= 2, `at most two containers ran at once, saw ${most}`);
  assert.equal(most, 2);
  assert.equal(progress.filter((l) => l.some((x) => /waiting for a free run slot/.test(x))).length, 1);
  assert.ok(results.every((r) => r.result.outcome === 'pass'));
  assert.equal(midStatus.slots.filter((s) => s.pid !== undefined).length, 2, 'status sees both holders');
  assert.equal(midStatus.containers.length, 2);
});

test('K2 the container bounding and effective capability sets are exactly the six', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t);
  const r = await runReal(t, repo, { command: ['grep', '^Cap', '/proc/self/status'] });
  assert.equal(r.result.outcome, 'pass', JSON.stringify(r.result) + r.stderr);
  const mask = (name: string) => BigInt(`0x${new RegExp(`^${name}:\\s*([0-9a-f]+)$`, 'm').exec(r.stdout)![1]}`);
  // CHOWN 0, DAC_OVERRIDE 1, FOWNER 3, KILL 5, SETGID 6, SETUID 7.
  assert.equal(mask('CapBnd'), 0xebn);
  assert.equal(mask('CapEff'), 0xebn);
});

test('K4 a test that switches user is still ended by the in-container time limit after the caller is hard-killed', async (t) => {
  const home = isolate(t);
  const dockerfile = 'FROM alpine:3.20\nRUN apk add --no-cache git su-exec\n';
  const repo = makeRepo(t, { athanor: config, files: { 'test/Dockerfile': dockerfile } });
  await runReal(t, repo);
  const prefix = uniquePrefix();
  t.after(() => { docker(['rm', '-f', `${prefix}-slot-1`]); });
  // The orphan case of C11 with a test that switched user: keep the timings in step with it.
  const killed = startDriver({ cwd: repo, prefix, home, command: ['su-exec', '1000', 'sleep', '600'], timeLimitSeconds: 3, graceSeconds: 2 });
  await until(() => runningCount(prefix) === 1, 60000, 'the container to start');
  const startedAt = Date.now();
  killed.child.kill('SIGKILL');
  await killed.done;
  await until(() => runningCount(prefix) === 0, 30000, 'the orphan to end itself');
  assert.ok(Date.now() - startedAt <= 15000, 'it ended within the time limit plus the grace, with slack, far short of the sleep');
});

test('C10 a hard-killed caller frees its slot, and the next run removes the old container first', async (t) => {
  const home = isolate(t);
  const prefix = uniquePrefix();
  const repo = fixtureRepo(t);
  await runReal(t, repo);
  const killed = startDriver({ cwd: repo, prefix, home, maxRuns: 1, command: ['sleep', '60'] });
  await until(() => runningCount(prefix) === 1, 60000, 'the first container');
  killed.child.kill('SIGKILL');
  await killed.done;
  assert.equal((await ask(prefix, 1)).held, false, 'the slot is free after the hard kill');
  assert.equal(runningCount(prefix), 1, 'the orphan is still running');
  const s = await status({ prefix });
  assert.equal(s.containers[0].orphan, true);

  let most = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { most = Math.max(most, runningCount(prefix)); await sleep(100); }
  })();
  process.env.ATHANOR_MAX_RUNS = '1';
  const next = await runReal(t, repo, { prefix, command: ['echo', 'next'] });
  sampling = false;
  await sampler;
  assert.equal(next.result.outcome, 'pass', next.stderr);
  assert.equal(next.result.slot, 1);
  assert.ok(most <= 1, `never more than the limit: saw ${most}`);
  assert.equal(runningCount(prefix), 0);
});

test('C11 the time limit ends a run with 124, and a hard-killed caller\'s container ends by itself', async (t) => {
  const home = isolate(t);
  const repo = fixtureRepo(t);
  await runReal(t, repo);
  const prefix = uniquePrefix();
  const timed = await runReal(t, repo, { prefix, command: ['sleep', '60'], timeLimitSeconds: 3, graceSeconds: 2 });
  assert.equal(timed.result.outcome, 'timeout');
  assert.equal(timed.result.exitCode, 124);
  assert.equal(docker(['ps', '-a', '--filter', `name=^${prefix}-slot-`, '-q']).stdout.trim(), '', 'the container is gone');

  const prefix2 = uniquePrefix();
  const killed = startDriver({ cwd: repo, prefix: prefix2, home, command: ['sleep', '120'], timeLimitSeconds: 3, graceSeconds: 2 });
  await until(() => runningCount(prefix2) === 1, 60000, 'the container to start');
  const startedAt = Date.now();
  killed.child.kill('SIGKILL');
  await killed.done;
  await until(() => runningCount(prefix2) === 0, 30000, 'the orphan to end itself');
  assert.ok(Date.now() - startedAt <= 15000, 'it ended within the time limit plus the grace, with slack');
  docker(['rm', '-f', `${prefix2}-slot-1`]);
});

test('C12 Ctrl-C to the CLI removes the container, frees the slot and exits 130 promptly', { skip: process.platform === 'win32' ? 'a test cannot send Ctrl-C to a child process on Windows; the manual check in C22 covers it' : false }, async (t) => {
  // The CLI has no prefix option, so this uses athanor's real slot names; CI runs it on Linux with no other caller.
  const home = isolate(t);
  const repo = fixtureRepo(t);
  await runReal(t, repo);
  const child = spawn(process.execPath, [bin, 'run', '--json', '--', 'sleep', '60'], { cwd: repo, env: { ...process.env, ATHANOR_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await until(() => runningCount('athanor') >= 1, 60000, 'the container to start');
  const at = Date.now();
  child.kill('SIGINT');
  const code = await done;
  assert.ok(Date.now() - at < 10000, 'the interrupt stops the run promptly');
  assert.equal(code, 130, err);
  assert.equal(JSON.parse(out).outcome, 'interrupted');
  const slot = JSON.parse(out).slot;
  assert.equal(docker(['ps', '-a', '--filter', `name=^athanor-slot-${slot}$`, '-q']).stdout.trim(), '');
  assert.equal((await ask('athanor', slot)).held, false);
});

test('C25 a failing tar in the container ends the run as error before the test starts', async (t) => {
  isolate(t);
  // An image whose tar always fails, so the boot script must stop before its marker.
  const dockerfile = [
    'FROM alpine:3.20',
    "RUN printf '#!/bin/sh\\nexit 1\\n' > /usr/local/bin/tar && chmod +x /usr/local/bin/tar",
    '',
  ].join('\n');
  const repo = makeRepo(t, { athanor: config, files: { 'test/Dockerfile': dockerfile } });
  const r = await runReal(t, repo, { command: ['echo', 'should-not-run'] });
  assert.equal(r.result.outcome, 'error', JSON.stringify(r.result) + r.stderr);
  assert.equal(r.result.exitCode, 125);
  assert.equal(r.stdout.includes('should-not-run'), false);
});

test('C15 with --json, stdout holds exactly one JSON object and everything else goes to stderr', async (t) => {
  const home = tempDir(t, 'athanor-home-');
  const repo = fixtureRepo(t);
  const r = await cli(['run', '--json', '--', 'sh', '-c', 'echo to-stdout; echo to-stderr >&2'], { cwd: repo, env: { ATHANOR_HOME: home } });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, r.stdout);
  const result = JSON.parse(lines[0]);
  if (result.image?.tag) builtTags.add(result.image.tag);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'image', 'outcome', 'ranMs', 'schema', 'slot', 'snapshot', 'untrackedLeftOut', 'waitedMs']);
  assert.equal(result.schema, 1);
  assert.equal(result.outcome, 'pass');
  assert.equal(typeof result.snapshot.id, 'string');
  assert.equal(result.snapshot.untracked, false);
  assert.match(r.stderr, /to-stdout/);
  assert.match(r.stderr, /to-stderr/);

  const failing = await cli(['run', '--json', '--', 'sh', '-c', 'exit 3'], { cwd: repo, env: { ATHANOR_HOME: home } });
  assert.equal(failing.code, 3, failing.stderr);
  assert.equal(JSON.parse(failing.stdout).outcome, 'fail');

  const s = await cli(['status', '--json'], { cwd: repo, env: { ATHANOR_HOME: home } });
  assert.equal(s.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(s.stdout)).sort(), ['containers', 'limit', 'limitSource', 'schema', 'slots']);
  const p = await cli(['prune', '--json', '--dry-run'], { cwd: repo, env: { ATHANOR_HOME: home } });
  assert.equal(p.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(p.stdout)).sort(), ['dryRun', 'kept', 'removed', 'schema']);
});

const PROXY_NAMES = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy',
  'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy',
];

test('P1 the Docker client\'s proxy settings do not reach the container', async (t) => {
  isolate(t);
  const repo = fixtureRepo(t);
  // Build the image first, with the normal configuration: under a fake proxy
  // the fixture's apk add would fail.
  const built = await runReal(t, repo);
  assert.equal(built.result.outcome, 'pass', JSON.stringify(built.result) + built.stderr);
  // A scratch configuration folder drops the active context, so keep the
  // engine the normal configuration reaches.
  const inspected = docker(['context', 'inspect']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const host = JSON.parse(inspected.stdout)[0].Endpoints.docker.Host as string;
  // Set after isolate(t), not through it: the endpoint is only known once the
  // image is built with the normal configuration. isolate() restores it.
  const savedConfig = process.env.DOCKER_CONFIG;
  t.after(() => {
    if (savedConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = savedConfig;
  });
  const secret = 'athanor-fake-secret';
  const proxy = `http://athanor-fake-user:${secret}@proxy.invalid:3128`;
  const envOf = async (config: object) => {
    const dir = tempDir(t, 'athanor-docker-config-');
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    process.env.DOCKER_CONFIG = dir;
    const r = await runReal(t, repo, { command: ['env'] });
    assert.equal(r.result.outcome, 'pass', JSON.stringify(r.result) + r.stderr);
    assert.equal(r.result.image!.built, false, 'the image is reused, not rebuilt under the fake proxy');
    return r;
  };
  const baseline = await envOf({});
  const proxied = await envOf({ proxies: { default: {
    httpProxy: proxy, httpsProxy: proxy, ftpProxy: proxy, noProxy: 'athanor-fake-host.invalid', allProxy: proxy,
  } } });
  const lines = proxied.stdout.split('\n').filter(Boolean);
  for (const name of PROXY_NAMES) {
    assert.ok(lines.includes(`${name}=`), `${name} is set and empty`);
  }
  assert.equal((proxied.stdout + proxied.stderr).includes(secret), false, 'the fake proxy password is nowhere in the output');
  assert.equal((proxied.stdout + proxied.stderr).includes('athanor-fake-host'), false, 'the fake noProxy value is nowhere in the output');
  const names = (out: string) => out.split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('='))).sort();
  assert.deepEqual(names(proxied.stdout), names(baseline.stdout), 'the same variable names as with no proxy settings');
});
