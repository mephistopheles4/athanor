// athanor serve (issue 35). One top-level test per acceptance claim, E1 to E10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { run, serve, status, prune, SERVE_BOOT } from '#dist/index.js';
import type { ServeOptions, ServeResult, Serving } from '#dist/index.js';
import { readMachineConfig, resolveServerConfig, resolveServerLimit } from '#dist/run-config.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf } from '../helpers.ts';
import { collector, gitState, cli, tempDir } from '../helpers.ts';
import { serveCommand } from '#dist/cli.js';
import type { Fake, RepoOptions } from '../helpers.ts';
import { askServer, tryServerLock } from '#dist/slots.js';

const server = { argv: ['node', 'server.js'], port: 4321 };
const withServers = (servers: unknown) => ({ ...baseConfig, servers });

test('E1 Config: servers and maxServers are read and checked before any Docker call', async (t) => {
  const bad: { name: string; servers: unknown; says: RegExp }[] = [
    { name: 'no argv', servers: { dev: { port: 1 } }, says: /servers\.dev\.argv/ },
    { name: 'empty argv', servers: { dev: { argv: [], port: 1 } }, says: /servers\.dev\.argv/ },
    { name: 'port 0', servers: { dev: { ...server, port: 0 } }, says: /servers\.dev\.port/ },
    { name: 'port 65536', servers: { dev: { ...server, port: 65536 } }, says: /servers\.dev\.port/ },
    { name: 'port 1.5', servers: { dev: { ...server, port: 1.5 } }, says: /servers\.dev\.port/ },
    { name: 'port as a string', servers: { dev: { ...server, port: '4321' } }, says: /servers\.dev\.port/ },
    { name: 'no port', servers: { dev: { argv: ['x'] } }, says: /servers\.dev\.port/ },
    { name: 'absolute writable', servers: { dev: { ...server, writable: ['/etc'] } }, says: /servers\.dev\.writable/ },
    { name: 'writable with ..', servers: { dev: { ...server, writable: ['a/../b'] } }, says: /servers\.dev\.writable/ },
    { name: 'writable with a control character', servers: { dev: { ...server, writable: ['a\nb'] } }, says: /servers\.dev\.writable/ },
    { name: 'repeated writable', servers: { dev: { ...server, writable: ['a', 'a'] } }, says: /servers\.dev\.writable/ },
    { name: 'writable inside another', servers: { dev: { ...server, writable: ['a', 'a/b'] } }, says: /servers\.dev\.writable/ },
    { name: 'timeoutMinutes', servers: { dev: { ...server, timeoutMinutes: 5 } }, says: /servers\.dev\.timeoutMinutes/ },
    { name: 'args', servers: { dev: { ...server, args: true } }, says: /servers\.dev\.args/ },
    { name: 'a name under both keys', servers: { test: server }, says: /commands\.test.*servers\.test|servers\.test.*commands\.test/ },
  ];
  for (const row of bad) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: withServers(row.servers) });
      const docker = fake(t);
      const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
      assert.equal(result.exitCode, 125);
      assert.match(result.message!, row.says);
      assert.match(result.message!, /package\.json/);
      assert.equal(docker.calls().length, 0);
    });
  }
  await t.test('athanor.json is read too', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { packageJson: false, files: { 'athanor.json': JSON.stringify(withServers({ dev: { ...server, args: true } })) } });
    const result = await run({ cwd: repo, docker: fake(t).docker, prefix: uniquePrefix() });
    assert.match(result.message!, /athanor\.json.*servers\.dev\.args/);
  });
  for (const value of [0, 1.5]) {
    await t.test(`maxServers ${value}`, async (t) => {
      const home = isolate(t);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ maxServers: value }));
      const repo = makeRepo(t, { athanor: baseConfig });
      const result = await run({ cwd: repo, docker: fake(t).docker, prefix: uniquePrefix() });
      assert.equal(result.exitCode, 125);
      assert.match(result.message!, /maxServers/);
    });
  }
  await t.test('maxServers is machine-only and defaults to 2', async (t) => {
    const home = isolate(t);
    assert.equal(resolveServerLimit(readMachineConfig(home)).limit, 2);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxServers: 3 }));
    assert.deepEqual(resolveServerLimit(readMachineConfig(home)), { limit: 3, source: 'file' });
    const repo = makeRepo(t, { athanor: { ...baseConfig, maxServers: 3 } });
    const result = await run({ cwd: repo, docker: fake(t).docker, prefix: uniquePrefix() });
    assert.match(result.message!, /unknown key "maxServers"/);
  });
  await t.test('a server resolves, and its memory above maxMemory is refused', async (t) => {
    const home = isolate(t);
    const repo = makeRepo(t, { athanor: withServers({ dev: { ...server, writable: ['a'], memory: '4g' } }) });
    const cfg = resolveServerConfig(repo, readMachineConfig(home), 'dev');
    assert.deepEqual([cfg.argv, cfg.port, cfg.writable, cfg.limits.memory], [server.argv, 4321, ['a'], '4g']);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxMemory: '2g' }));
    assert.throws(() => resolveServerConfig(repo, readMachineConfig(home), 'dev'), /above the machine ceiling maxMemory/);
  });
  await t.test('an unknown server name lists the server names', async (t) => {
    const home = isolate(t);
    const repo = makeRepo(t, { athanor: withServers({ dev: server, docs: server }) });
    assert.throws(() => resolveServerConfig(repo, readMachineConfig(home), 'nope'), /no server named "nope".*dev, docs/);
  });
  await t.test('athanor run of a server name says to use athanor serve', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: withServers({ dev: server }) });
    const docker = fake(t);
    const result = await run({ cwd: repo, name: 'dev', docker: docker.docker, prefix: uniquePrefix() });
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /athanor serve dev/);
    assert.equal(docker.calls().length, 0);
  });
});

test('E3 Run unchanged: servers and maxServers do not change what athanor run does', async (t) => {
  const home = isolate(t);
  const call = async (athanor: unknown, config?: unknown) => {
    if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    const repo = makeRepo(t, { athanor });
    const docker = fake(t);
    const result = await run({ cwd: repo, docker: docker.docker, prefix: 'athanor-fixed' });
    assert.equal(result.outcome, 'pass');
    return callsOf(docker.calls(), 'run')[0]!.args;
  };
  const plain = await call(baseConfig);
  const withServer = await call(withServers({ dev: server }), { maxServers: 3 });
  assert.deepEqual(withServer, plain);
});

// ---- serve, with the fake Docker's serve mode -------------------------------

const devServer = { argv: ['node', 'server.js'], port: 3000 };
const serverRepo = (t: TestContext, servers: unknown = { dev: devServer }, extra: RepoOptions = {}) =>
  makeRepo(t, { athanor: withServers(servers), ...extra, files: { 'node_modules/.keep': '', 'cache/.keep': '', ...(extra.files ?? {}) } });

// Start a serve and wait for it to be serving, or to end.
function serveIn(t: TestContext, repo: string, docker: Fake, extra: Partial<ServeOptions> = {}) {
  const controller = new AbortController();
  const prefix = extra.prefix ?? uniquePrefix();
  let serving: Serving | undefined;
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const result = serve({
    cwd: repo, name: 'dev', docker: docker.docker, prefix, signal: controller.signal, portPollMs: 20,
    onServing: (s) => { serving = s; ready(); extra.onServing?.(s); },
    ...extra,
  });
  void result.then(ready, ready);
  t.after(async () => { controller.abort(); await result; });
  return { result, prefix, abort: () => controller.abort(), ready: readyPromise, serving: () => serving };
}

const serverRuns = (docker: Fake) => callsOf(docker.calls(), 'run').filter((c) => c.args.some((a) => a.startsWith('athanor.server=')));
const containerFiles = (docker: Fake) => readdirSync(join(docker.dir, 'containers'));
const caps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETUID', 'SETGID'];
const proxies = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'];
const limitsAndControls = (memory: string) => [
  '--memory', memory, '--memory-swap', memory, '--pids-limit', '1024',
  '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', ...caps.flatMap((c) => ['--cap-add', c]),
  ...proxies.flatMap((n) => ['-e', `${n}=`]),
];

test('E2 Arguments: the docker run call is exactly the settings list, and the boot script is the fixed text', async (t) => {
  isolate(t);
  const repo = serverRepo(t, { dev: { ...devServer, writable: ['node_modules', 'cache'], memory: '1g' } });
  for (const hostPort of [undefined, 5000]) {
    const docker = fake(t);
    const run = serveIn(t, repo, docker, hostPort === undefined ? {} : { port: hostPort });
    await run.ready;
    const [call] = serverRuns(docker);
    const lock = run.serving()!.lock;
    const image = call!.args[call!.args.indexOf('athanor.server=' + lock) + 0 - 0 ];
    const tag = call!.args.find((a) => /^athanor:[0-9a-f]{32}$/.test(a))!;
    const expected = [
      'run', '-i', '--init', '--pull', 'never', '--log-driver', 'none',
      '--name', `${run.prefix}-server-${lock}`, '--label', `athanor.server=${lock}`, '--network', 'bridge',
      '-p', hostPort === undefined ? '127.0.0.1::3000' : '127.0.0.1:5000:3000',
      '--mount', `type=bind,src=${repo},dst=/home/node/work,readonly`,
      '--mount', 'type=volume,dst=/home/node/work/node_modules',
      '--mount', 'type=volume,dst=/home/node/work/cache',
      '-w', '/home/node/work',
      ...limitsAndControls('1g'),
      tag, 'sh', '-c', ['exec 3<&0', '( cat <&3 >/dev/null; kill -s TERM -1; sleep 5; kill -s KILL -1 ) &', 'echo athanor-boot-ok >&2', 'exec "$@" </dev/null 3<&-'].join('\n'),
      'athanor', 'node', 'server.js',
    ];
    assert.deepEqual(call!.args, expected);
    assert.equal(call!.args[call!.args.indexOf('-c') + 1], SERVE_BOOT);
    for (const bad of ['-v', '--privileged', '--network=host', '--net']) assert.ok(!call!.args.includes(bad), bad);
    run.abort();
    assert.equal((await run.result).outcome, 'stopped');
  }
});

test('E4 Checks before the container: each exits 125 with its message and starts no server', async (t) => {
  const rows: { name: string; says: RegExp; scenario?: Record<string, unknown>; servers?: unknown; machine?: unknown; files?: Record<string, string>; port?: number; remove?: string; link?: string; label?: string }[] = [
    { name: 'WORKDIR empty', scenario: { workdir: '' }, says: /WORKDIR/ },
    { name: 'WORKDIR /', scenario: { workdir: '/' }, says: /WORKDIR/ },
    { name: 'WORKDIR relative', scenario: { workdir: 'work' }, says: /WORKDIR/ },
    { name: 'WORKDIR with a comma', scenario: { workdir: '/a,b' }, says: /WORKDIR holds a comma/ },
    { name: 'a missing writable folder', servers: { dev: { ...devServer, writable: ['cache', 'gone/deep'] } }, says: /"gone\/deep" does not exist.*mkdir -p gone\/deep/ },
    { name: 'a writable folder the image cannot write', servers: { dev: { ...devServer, writable: ['cache'] } }, scenario: { missingWritable: ['cache'] }, says: /\/home\/node\/work\/cache.*RUN mkdir -p cache/ },
    { name: 'a writable folder that is a link', servers: { dev: { ...devServer, writable: ['linked'] } }, link: 'linked', says: /"linked" is a link/ },
    { name: 'a repo path with a comma', label: 'athanor,repo-', says: /repo folder's path holds a comma/ },
    { name: 'a port of 0', port: 0, says: /--port/ },
    { name: 'an engine off this machine', scenario: { contextHost: 'ssh://user@example.test' }, says: /needs a Docker engine on this machine/ },
    { name: 'an engine off this machine, with allowRemoteDocker', scenario: { contextHost: 'ssh://user@example.test' }, machine: { allowRemoteDocker: true }, says: /needs a Docker engine on this machine/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const home = isolate(t);
      if (row.machine) writeFileSync(join(home, 'config.json'), JSON.stringify(row.machine));
      const repo = serverRepo(t, row.servers, { ...(row.label ? { label: row.label } : {}) });
      if (row.link) {
        mkdirSync(join(repo, 'real'));
        try {
          symlinkSync(join(repo, 'real'), join(repo, row.link), 'junction');
        } catch {
          t.skip('this platform does not let the test make a link');
          return;
        }
      }
      const docker = fake(t, row.scenario);
      const run = serveIn(t, repo, docker, row.port === undefined ? {} : { port: row.port });
      const result = await run.result;
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.equal(result.outcome, 'error');
      assert.match(result.message!, row.says);
      assert.equal(serverRuns(docker).length, 0, 'no server container');
      assert.equal(result.ranMs, undefined);
    });
  }
});

test('E5 Ready: serving reports the published port on 127.0.0.1, and a stop ends stopped 130', async (t) => {
  isolate(t);
  const repo = serverRepo(t);
  await t.test('a stop after serving', async (t) => {
    const docker = fake(t, { serve: { stdout: 'listening\n' } });
    const out = collector();
    const run = serveIn(t, repo, docker, { stdout: out });
    await run.ready;
    const serving = run.serving()!;
    assert.match(serving.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(serving.url, `http://127.0.0.1:${serving.port}/`);
    assert.equal(serving.server, 'dev');
    run.abort();
    const result = await run.result;
    assert.deepEqual([result.outcome, result.exitCode], ['stopped', 130]);
    assert.match(out.text(), /listening/);
    assert.deepEqual(containerFiles(docker), []);
  });
  await t.test('a port on 0.0.0.0 ends error 125 and the container is removed', async (t) => {
    const docker = fake(t, { portAnswer: '0.0.0.0:41234' });
    const result = await serveIn(t, repo, docker).result;
    assert.deepEqual([result.outcome, result.exitCode], ['error', 125]);
    assert.match(result.message!, /not on 127\.0\.0\.1/);
    assert.deepEqual(containerFiles(docker), []);
  });
  await t.test('a port that never answers ends error 125 and the container is removed', async (t) => {
    const docker = fake(t, { portNever: true });
    const result = await serveIn(t, repo, docker, { portWaitMs: 300 }).result;
    assert.deepEqual([result.outcome, result.exitCode], ['error', 125]);
    assert.match(result.message!, /did not report the published port within 30 seconds/);
    assert.deepEqual(containerFiles(docker), []);
  });
  await t.test('a server that exits while the stop is handled still ends stopped 130', async (t) => {
    const docker = fake(t, { rmFails: true, serve: { exitAfterMs: 400, exitCode: 3 } });
    const run = serveIn(t, repo, docker, { onServing: () => run.abort() });
    const result = await run.result;
    assert.deepEqual([result.outcome, result.exitCode], ['stopped', 130]);
  });
});

test('E6 End: each way a server ends has its outcome, and the container goes with -v', async (t) => {
  const rows = [
    { name: 'exits 3', serve: { exitAfterMs: 100, exitCode: 3 }, outcome: 'exited', exitCode: 3 },
    { name: 'exits 0', serve: { exitAfterMs: 100, exitCode: 0 }, outcome: 'exited', exitCode: 0 },
    { name: 'the memory kill', serve: { exitAfterMs: 100, oom: true }, outcome: 'memory', exitCode: 137 },
    { name: 'docker run fails', serve: { runFails: true }, outcome: 'error', exitCode: 125 },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = serverRepo(t);
      const docker = fake(t, { serve: row.serve });
      const run = serveIn(t, repo, docker, { portPollMs: 500 });
      const result = await run.result;
      assert.deepEqual([result.outcome, result.exitCode], [row.outcome, row.exitCode], JSON.stringify(result));
      if (row.outcome === 'error') assert.equal(result.ranMs, undefined, 'the container never started');
      else assert.equal(typeof result.ranMs, 'number');
      assert.ok(callsOf(docker.calls(), 'rm').some((c) => c.args.includes('-v') && c.args.includes('-f')), 'rm -f -v');
      assert.deepEqual(containerFiles(docker), []);
      const free = await askServer(run.prefix, 1);
      assert.equal(free.held, false, 'the lock is free');
    });
  }
});

test('E7 The limit: a full machine refuses at once, two servers get two locks, and a server holds no run slot', async (t) => {
  await t.test('maxServers 1: the second serve exits 125 within 3 seconds', async (t) => {
    const home = isolate(t);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxServers: 1 }));
    const repo = serverRepo(t);
    const prefix = uniquePrefix();
    const first = serveIn(t, repo, fake(t), { prefix });
    await first.ready;
    const began = Date.now();
    const second = await serveIn(t, repo, fake(t), { prefix }).result;
    assert.ok(Date.now() - began < 3000, 'within 3 seconds');
    assert.deepEqual([second.outcome, second.exitCode], ['error', 125]);
    assert.match(second.message!, /all 1 servers are in use/);
    first.abort();
    await first.result;
  });
  await t.test('maxServers 2: locks 1 and 2 and two container names; no run slot is held', async (t) => {
    const home = isolate(t);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxServers: 2, maxRuns: 1 }));
    const repo = serverRepo(t);
    const prefix = uniquePrefix();
    const dockerA = fake(t);
    const dockerB = fake(t);
    const a = serveIn(t, repo, dockerA, { prefix });
    await a.ready;
    const b = serveIn(t, repo, dockerB, { prefix });
    await b.ready;
    assert.deepEqual([a.serving()!.lock, b.serving()!.lock].sort(), [1, 2]);
    assert.notEqual(a.serving()!.port, undefined);
    const names = [...serverRuns(dockerA), ...serverRuns(dockerB)].map((c) => c.args[c.args.indexOf('--name') + 1]);
    assert.deepEqual(new Set(names).size, 2);
    const result = await run({ cwd: repo, docker: fake(t).docker, prefix });
    assert.equal(result.outcome, 'pass');
    assert.equal(result.slot, 1);
    assert.ok((result.waitedMs ?? 0) < 1000, 'the run did not wait');
    a.abort();
    b.abort();
    await Promise.all([a.result, b.result]);
  });
});

test('E8 The sweep: a leftover whose lock is free is removed, a live one is not, an unlabelled one stops serve', async (t) => {
  await t.test('a leftover container at a free lock is removed with -v', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t);
    const prefix = uniquePrefix();
    docker.addContainer(`${prefix}-server-2`, { 'athanor.server': '2' });
    const run = serveIn(t, repo, docker, { prefix });
    await run.ready;
    assert.equal(run.serving()!.lock, 1);
    const removed = callsOf(docker.calls(), 'rm').filter((c) => c.args.includes('-v')).map((c) => c.args.at(-1));
    assert.ok(removed.includes(`${prefix}-server-2`), JSON.stringify(removed));
    run.abort();
    await run.result;
  });
  await t.test('a container whose lock a live process holds is not touched', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t);
    const prefix = uniquePrefix();
    const held = await tryServerLock(prefix, 2, 2, { pid: process.pid, started: Date.now(), repo: 'x', name: 'other' });
    t.after(() => held!.release());
    docker.addContainer(`${prefix}-server-2`, { 'athanor.server': '2' });
    const run = serveIn(t, repo, docker, { prefix });
    await run.ready;
    const removed = callsOf(docker.calls(), 'rm').map((c) => c.args.at(-1));
    assert.ok(!removed.includes(`${prefix}-server-2`), JSON.stringify(removed));
    assert.ok(containerFiles(docker).includes(encodeURIComponent(`${prefix}-server-2`) + '.json'));
    run.abort();
    await run.result;
  });
  await t.test('a container with that name and no label stops serve and is not removed', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t);
    const prefix = uniquePrefix();
    docker.addContainer(`${prefix}-server-1`, {});
    const result = await serveIn(t, repo, docker, { prefix }).result;
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /without athanor's label/);
    assert.ok(containerFiles(docker).includes(encodeURIComponent(`${prefix}-server-1`) + '.json'));
    assert.equal(serverRuns(docker).length, 0);
  });
});

test('E10 The repo is unchanged: a serve that starts, serves and stops changes nothing in the repo and leaves no scratch folder', async (t) => {
  const home = isolate(t);
  const repo = serverRepo(t, { dev: { ...devServer, writable: ['cache'] } }, { files: { 'a.txt': 'a\n' } });
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  const before = gitState(repo);
  const filesBefore = readdirSync(repo, { recursive: true, encoding: 'utf8' }).sort();
  const gitFolder = () => readdirSync(join(repo, '.git'), { recursive: true, encoding: 'utf8' }).map((f) => `${f}:${statSync(join(repo, '.git', f)).size}`).sort();
  const gitBefore = gitFolder();
  const run = serveIn(t, repo, fake(t));
  await run.ready;
  run.abort();
  assert.equal((await run.result).outcome, 'stopped');
  assert.deepEqual(gitState(repo), before);
  assert.deepEqual(gitFolder(), gitBefore);
  assert.deepEqual(readdirSync(repo, { recursive: true, encoding: 'utf8' }).sort(), filesBefore);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(readdirSync(join(home, 'runs')), []);
});

test('E5 JSON: with --json, stdout holds one serving line then one ended line; every failure leaves one ended line', async (t) => {
  await t.test('serving then stopped', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t, { serve: { stdout: 'hello from the server\n' } });
    const lines: unknown[] = [];
    const said: string[] = [];
    const out = collector();
    const err = collector();
    const controller = new AbortController();
    const done = serveCommand({ json: true, name: 'dev' }, {
      line: (o) => { lines.push(o); if ((o as { event: string }).event === 'serving') controller.abort(); },
      say: (l) => said.push(l), stdout: out, stderr: err, signal: controller.signal,
      docker: docker.docker, prefix: uniquePrefix(), portPollMs: 20, cwd: repo,
    });
    assert.equal(await done, 130);
    assert.equal(lines.length, 2);
    const [serving, ended] = lines as Record<string, unknown>[];
    assert.deepEqual(Object.keys(serving!), ['schema', 'event', 'server', 'url', 'port', 'lock']);
    assert.match(serving!.url as string, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(serving!.server, 'dev');
    assert.deepEqual([ended!.event, ended!.outcome, ended!.exitCode], ['ended', 'stopped', 130]);
    assert.equal(typeof ended!.ranMs, 'number');
    assert.match(err.text(), /hello from the server/);
    assert.equal(out.text(), '');
    assert.match(said.join('\n'), /serving dev at http:\/\/127\.0\.0\.1:\d+\/ \(stop with Ctrl-C\)\./);
    assert.match(said.at(-1)!, /the server was stopped and cleaned up \(exit 130\)\./);
  });
  await t.test('without --json the server output goes to stdout and nothing is written as JSON', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t, { serve: { stdout: 'hello\n' } });
    const lines: unknown[] = [];
    const out = collector();
    const controller = new AbortController();
    const code = await serveCommand({ json: false, name: 'dev' }, {
      line: (o) => lines.push(o), say: (l) => { if (/^serving /.test(l)) controller.abort(); },
      stdout: out, stderr: collector(), signal: controller.signal, docker: docker.docker, prefix: uniquePrefix(), portPollMs: 20, cwd: repo,
    });
    assert.equal(code, 130);
    assert.deepEqual(lines, []);
    assert.match(out.text(), /hello/);
  });
  const failures: { name: string; args: string[]; cwd?: 'plain' }[] = [
    { name: 'a bad --port', args: ['serve', 'dev', '--json', '--port', 'x'] },
    { name: 'a --port with no value', args: ['serve', 'dev', '--json', '--port'] },
    { name: 'no server name', args: ['serve', '--json'] },
    { name: 'a configuration error', args: ['serve', 'dev', '--json'], cwd: 'plain' },
  ];
  for (const row of failures) {
    await t.test(row.name, async (t) => {
      const home = isolate(t);
      const r = await cli(row.args, { cwd: tempDir(t), env: { ATHANOR_HOME: home } });
      assert.equal(r.code, 125);
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines.length, 1, r.stdout);
      const ended = JSON.parse(lines[0]!);
      assert.deepEqual([ended.schema, ended.event, ended.outcome, ended.exitCode], [1, 'ended', 'error', 125]);
      assert.equal(typeof ended.message, 'string');
      assert.equal(ended.ranMs, undefined);
    });
  }
});

test('E9 status and prune: a server shows in status, an unheld container is an orphan, and prune keeps its image', async (t) => {
  await t.test('status reports the limit, the held server and its container', async (t) => {
    isolate(t);
    const repo = serverRepo(t);
    const docker = fake(t);
    const run = serveIn(t, repo, docker);
    await run.ready;
    const before = callsOf(docker.calls(), 'rm').length;
    const s = await status({ docker: docker.docker, prefix: run.prefix });
    assert.equal(s.schema, 1);
    assert.equal(s.serverLimit, 2);
    assert.equal(s.serverLimitSource, 'default');
    const entry = s.servers.find((e) => e.server === run.serving()!.lock)!;
    assert.deepEqual([entry.held, entry.pid, entry.name, entry.port], [true, process.pid, 'dev', run.serving()!.port]);
    assert.deepEqual(s.serverContainers, [{ name: `${run.prefix}-server-${run.serving()!.lock}`, server: run.serving()!.lock, orphan: false }]);
    assert.equal(callsOf(docker.calls(), 'rm').length, before, 'status removes nothing');
    docker.addContainer(`${run.prefix}-server-2`, { 'athanor.server': '2' });
    const after = await status({ docker: docker.docker, prefix: run.prefix });
    assert.equal(after.serverContainers.find((c) => c.server === 2)!.orphan, true);
    run.abort();
    await run.result;
  });
  await t.test('without servers, status still holds every field it holds today', async (t) => {
    isolate(t);
    const docker = fake(t);
    const s = await status({ docker: docker.docker, prefix: uniquePrefix() });
    assert.deepEqual(Object.keys(s), ['schema', 'limit', 'limitSource', 'slots', 'containers', 'serverLimit', 'serverLimitSource', 'servers', 'serverContainers']);
    assert.deepEqual([s.limit, s.limitSource, s.slots.length, s.containers], [2, 'default', 2, []]);
    assert.deepEqual(s.servers, [{ server: 1 }, { server: 2 }]);
  });
  await t.test('prune keeps the image of a server container past pruneDays', async (t) => {
    const home = isolate(t);
    const docker = fake(t);
    const tag = `athanor:${'f'.repeat(32)}`;
    docker.addImage(tag);
    mkdirSync(join(home, 'images'), { recursive: true });
    const mark = join(home, 'images', 'f'.repeat(32));
    writeFileSync(mark, '');
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(mark, old, old);
    docker.addContainer('athanor-server-1', { 'athanor.server': '1' }, tag);
    assert.deepEqual((await prune({ docker: docker.docker, days: 1, dryRun: true })).removed, []);
    rmSync(join(docker.dir, 'containers'), { recursive: true });
    assert.deepEqual((await prune({ docker: docker.docker, days: 1, dryRun: true })).removed, [tag]);
  });
});
