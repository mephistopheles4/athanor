// A Docker engine or builder off this machine is refused unless the machine
// configuration allows it (the spec on issue 33, L1 to L13). Each run goes
// through the core with a fake Docker; one top-level test per claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import type { RunOptions, RunResult } from '#dist/index.js';
import { ask } from '#dist/slots.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf } from '../helpers.ts';
import type { Fake } from '../helpers.ts';

interface Row {
  name: string;
  env?: Record<string, string>;
  scenario?: Record<string, unknown>;
  machine?: Record<string, unknown>;
}

// One run with its own state folder, machine file and fake Docker.
// callsBefore[i] is how many Docker calls the fake had recorded when progress[i] came.
async function runRow(t: TestContext, row: Row, extra: RunOptions = {}): Promise<{ result: RunResult; docker: Fake; progress: string[]; callsBefore: number[] }> {
  const home = isolate(t, row.env ?? {});
  if (row.machine) writeFileSync(join(home, 'config.json'), JSON.stringify(row.machine));
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t, row.scenario ?? {});
  const progress: string[] = [];
  const callsBefore: number[] = [];
  const onProgress = (l: string) => {
    progress.push(l);
    callsBefore.push(docker.calls().length);
  };
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), onProgress, ...extra });
  return { result, docker, progress, callsBefore };
}

const contacted = (docker: Fake): string[] => docker.calls().map((c) => c.args.slice(0, 2).join(' ')).filter((v) => v !== 'context inspect');
const remoteOptIn = { allowRemoteDocker: true };

test('L1 a local engine passes with no opt-out and no notice', async (t) => {
  const hosts = ['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine', 'npipe:////./PIPE/dockerDesktopLinuxEngine', 'tcp://127.0.0.1:2375', 'tcp://localhost:2375', 'tcp://[::1]:2375'];
  for (const host of hosts) {
    for (const from of ['DOCKER_HOST', 'a context'] as const) {
      await t.test(`${host} from ${from}`, async (t) => {
        const row: Row = from === 'DOCKER_HOST' ? { name: host, env: { DOCKER_HOST: host } } : { name: host, scenario: { contextHost: host } };
        const { result, progress } = await runRow(t, row);
        assert.equal(result.outcome, 'pass', JSON.stringify(result));
        assert.ok(!progress.some((l) => /another machine/.test(l)), progress.join('\n'));
      });
    }
  }
});

// Each with the endpoint and setting its notice names.
const engineRefusals: (Row & { shows: [string, string] })[] = [
  { name: 'an ssh DOCKER_HOST', env: { DOCKER_HOST: 'ssh://builder@10.0.0.5' }, shows: ['ssh://10.0.0.5', 'DOCKER_HOST ("ssh://10.0.0.5")'] },
  { name: 'a TLS-verified tcp DOCKER_HOST to another host', env: { DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '1' }, shows: ['tcp://10.0.0.5:2376', 'DOCKER_HOST ("tcp://10.0.0.5:2376")'] },
  { name: 'a context with a TLS-verified tcp endpoint to another host', env: { DOCKER_CONTEXT: 'remote' }, scenario: { contextHost: 'tcp://10.0.0.5:2376', contextTls: { docker: ['ca.pem', 'cert.pem', 'key.pem'] } }, shows: ['tcp://10.0.0.5:2376', 'DOCKER_CONTEXT ("remote")'] },
  { name: 'an npipe naming another server', env: { DOCKER_HOST: 'npipe:////otherbox/pipe/docker_engine' }, shows: ['npipe:////otherbox/pipe/docker_engine', 'DOCKER_HOST ("npipe:////otherbox/pipe/docker_engine")'] },
];

test('L2 L12 with no opt-out, an engine off this machine exits 125 before anything contacts it', async (t) => {
  const rows: Row[] = [
    ...engineRefusals,
    { name: 'an empty context host', scenario: { contextHost: '' } },
    { name: 'a dot-server pipe through the device namespace', env: { DOCKER_HOST: 'npipe:////./UNC/otherbox/pipe/x' } },
    { name: 'a dot-server pipe with a parent segment', env: { DOCKER_HOST: 'npipe:////./pipe/../../otherbox/pipe/x' } },
    // With TLS verified, so the plain tcp refusal (which runs first) lets them through to this one.
    { name: 'a tcp address whose user-info looks like a loopback host and port', env: { DOCKER_HOST: 'tcp://127.0.0.1:2375@10.0.0.5:2376', DOCKER_TLS_VERIFY: '1' } },
    { name: 'a value the URL parser rejects', env: { DOCKER_HOST: 'tcp://[not-a-host', DOCKER_TLS_VERIFY: '1' } },
    { name: 'a pipe named ..', env: { DOCKER_HOST: 'npipe:////./pipe/..' } },
    { name: 'a pipe named .', env: { DOCKER_HOST: 'npipe:////./pipe/.' } },
    { name: 'a loopback tcp address with user-info', env: { DOCKER_HOST: 'tcp://u@localhost:2375' } },
    // Docker reads a value with no "://" as a tcp host, here one named "unix" or "http".
    { name: 'a unix address with one slash', env: { DOCKER_HOST: 'unix:/var/run/docker.sock', DOCKER_TLS_VERIFY: '1' } },
    { name: 'an http address with one slash', env: { DOCKER_HOST: 'http:/localhost:2375', DOCKER_TLS_VERIFY: '1' } },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const { result, docker } = await runRow(t, row);
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.equal(result.outcome, 'error');
      assert.match(result.message!, /allowRemoteDocker/);
      assert.match(result.message!, /DOCKER_HOST|DOCKER_CONTEXT|Docker context/);
      assert.deepEqual(contacted(docker), [], 'no call that contacts the engine');
      if (row.env?.DOCKER_HOST) assert.deepEqual(docker.calls(), [], 'a DOCKER_HOST engine needs no call at all');
    });
  }
});

const engineNotice = /^using a Docker engine on another machine, .+ \(from .+\): your build context and snapshot go there\.$/;

test('L3 L9 with the opt-out, an engine off this machine runs, named once before the build, and the result gains no field', async (t) => {
  for (const row of engineRefusals) {
    await t.test(row.name, async (t) => {
      const { result, progress, callsBefore, docker } = await runRow(t, { ...row, machine: remoteOptIn });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      const notices = progress.filter((l) => engineNotice.test(l));
      assert.equal(notices.length, 1, progress.join('\n'));
      assert.ok(notices[0]!.includes(`, ${row.shows[0]} (from ${row.shows[1]}):`), notices[0]);
      // Before any image check or build: no such call was recorded when it came.
      const before = docker.calls().slice(0, callsBefore[progress.indexOf(notices[0]!)]);
      assert.ok(!before.some((c) => c.args[0] === 'build' || (c.args[0] === 'image' && c.args[1] === 'inspect')), before.map((c) => c.args.join(' ')).join('\n'));
      assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'image', 'outcome', 'ranMs', 'schema', 'slot', 'snapshot', 'untrackedLeftOut', 'waitedMs']);
    });
  }
});

test('L6 allowRemoteDocker is set only by the machine configuration, as true or false', async (t) => {
  const remote = { DOCKER_HOST: 'ssh://10.0.0.5' };
  await t.test('in a repo configuration it is an unknown key', async (t) => {
    isolate(t, remote);
    const repo = makeRepo(t, { athanor: { ...baseConfig, allowRemoteDocker: true } });
    const docker = fake(t);
    const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix() });
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /unknown key "allowRemoteDocker"/);
  });
  await t.test('a non-boolean in the machine file', async (t) => {
    const { result } = await runRow(t, { name: 'string', env: remote, machine: { allowRemoteDocker: 'yes' } });
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /allowRemoteDocker must be true or false/);
  });
  await t.test('an environment variable has no effect', async (t) => {
    const { result } = await runRow(t, { name: 'env', env: { ...remote, ATHANOR_ALLOW_REMOTE_DOCKER: 'true' } });
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /allowRemoteDocker/);
  });
});

const tls = { docker: ['ca.pem', 'cert.pem', 'key.pem'] };
const builderNotice = /^using a buildx builder on another machine, .+ \(.+, .+\): your build context goes there\.$/;
const cannotInspectNotice = /^using a buildx builder athanor could not inspect \(from .+\): your build context may go to another machine(, and athanor cannot pin it for this run)?\.$/;

test('L5 a buildx builder off this machine is refused unless the machine allows it', async (t) => {
  const tlsRemote = { builderDriver: 'remote', builderNodes: [{ endpoint: 'tcp://10.0.0.5:1234', options: 'cacert="/certs/ca.pem"' }] };
  const containerRemote = { builderDriver: 'docker-container', builderEndpoints: ['far'], contexts: { far: { host: 'tcp://10.0.0.5:2376', tls } } };
  const otherContext = { builderDriver: 'docker', builderName: 'far', builderEndpoints: ['far'], contexts: { far: { host: 'tcp://10.0.0.5:2376', tls } } };
  const refused: Row[] = [
    { name: 'a remote driver at a TLS tcp address to another host', scenario: tlsRemote },
    { name: 'a kubernetes driver', scenario: { builderDriver: 'kubernetes', builderEndpoints: ['kubernetes:///buildkit?deployment=x'] } },
    { name: 'a docker-container node at a remote address', scenario: { builderDriver: 'docker-container', builderEndpoints: ['ssh://10.0.0.5'] } },
    { name: 'a docker-container node named for a context with a remote endpoint', scenario: containerRemote },
    { name: 'a docker-driver builder whose node names another context with a remote endpoint', env: { BUILDX_BUILDER: 'far' }, scenario: otherContext },
    { name: 'a node named for a context whose lookup fails', scenario: { builderDriver: 'docker-container', builderEndpoints: ['gone'], contexts: { gone: null } } },
    { name: 'a node name that fails the context-name pattern', scenario: { builderDriver: 'docker-container', builderEndpoints: ['-x'] } },
    { name: 'a docker-container builder with no endpoint line', scenario: { builderDriver: 'docker-container', builderNodes: [{}] } },
    { name: 'a failing buildx inspect', scenario: { buildxFails: true } },
    { name: 'a header Error line', scenario: { builderHeaderError: 'failed to find node' } },
    { name: 'a node block that repeats Endpoint', scenario: { builderNodes: [{ endpoint: 'default', repeatEndpoint: 'default' }] } },
  ];
  for (const row of refused) {
    await t.test(`refused: ${row.name}`, async (t) => {
      const { result, docker } = await runRow(t, row);
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.equal(callsOf(docker.calls(), 'build').length, 0);
      assert.ok(!docker.calls().some((c) => c.args[0] === 'context' && c.args.includes('-x')), 'a bad name is never looked up');
    });
  }
  const passes: Row[] = [
    { name: 'a docker-driver builder of a local context', scenario: { builderDriver: 'docker', builderEndpoints: ['default'] } },
    { name: 'a docker-container node at unix://', scenario: { builderDriver: 'docker-container', builderEndpoints: ['unix:///var/run/docker.sock'], loadRequired: true } },
    { name: 'a docker-container node named for a local context', scenario: { builderDriver: 'docker-container', builderEndpoints: ['desktop-linux'], contexts: { 'desktop-linux': 'unix:///home/u/.docker/desktop/docker.sock' }, loadRequired: true } },
  ];
  for (const row of passes) {
    await t.test(`passes: ${row.name}`, async (t) => {
      const { result, progress } = await runRow(t, row);
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.ok(!progress.some((l) => /another machine/.test(l)), progress.join('\n'));
    });
  }
  await t.test('passes: buildx missing, with no buildx inspect call', async (t) => {
    const { result, docker } = await runRow(t, { name: 'missing', scenario: { buildx: 'missing' } });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.ok(!docker.calls().some((c) => c.args[0] === 'buildx' && c.args[1] === 'inspect'));
  });
  await t.test('refused: buildx present and inspect failing with "unknown command"', async (t) => {
    const { result } = await runRow(t, { name: 'unknown', scenario: { buildxFails: true, buildxFailText: 'ERROR: unknown command "inspect" for "buildx"' } });
    assert.equal(result.exitCode, 125, JSON.stringify(result));
  });
  const optIn: Row[] = [
    { name: 'the TLS remote driver', scenario: tlsRemote },
    { name: 'a docker-container node named for a remote TLS context', scenario: containerRemote },
    { name: 'another context\'s docker-driver builder', env: { BUILDX_BUILDER: 'far' }, scenario: otherContext },
  ];
  for (const row of optIn) {
    await t.test(`with allowRemoteDocker: ${row.name} runs, named before the build`, async (t) => {
      const { result, progress } = await runRow(t, { ...row, machine: remoteOptIn });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.equal(progress.filter((l) => builderNotice.test(l)).length, 1, progress.join('\n'));
      assert.match(progress[0]!, builderNotice);
    });
  }
});

test('L8 a builder sent in clear, or whose transport athanor could not read, needs allowPlainTcp too', async (t) => {
  const rows: Row[] = [
    { name: 'a remote driver at plain tcp', scenario: { builderDriver: 'remote', builderEndpoints: ['tcp://10.0.0.5:1234'] } },
    { name: 'an http node', scenario: { builderDriver: 'remote', builderEndpoints: ['http://10.0.0.5:1234'] } },
    { name: 'a docker-container node at a raw plain tcp address', scenario: { builderDriver: 'docker-container', builderEndpoints: ['tcp://10.0.0.5:2375'] } },
    { name: 'a node named for a context with a plain tcp endpoint', scenario: { builderDriver: 'docker-container', builderEndpoints: ['far'], contexts: { far: 'tcp://10.0.0.5:2375' } } },
    { name: 'a two-node remote builder where one node has no cacert', scenario: { builderDriver: 'remote', builderNodes: [{ endpoint: 'tcp://10.0.0.5:1234', options: 'cacert="/c/ca.pem"' }, { endpoint: 'tcp://10.0.0.6:1234' }] } },
    { name: 'a node whose label text holds a driver-options line', scenario: { builderDriver: 'remote', builderNodes: [{ endpoint: 'tcp://10.0.0.5:1234', after: 'Labels:\nDriver Options:   cacert="/c/ca.pem"\n' }] } },
    { name: 'a failing buildx inspect', scenario: { buildxFails: true } },
    { name: 'zero endpoints', scenario: { builderDriver: 'docker-container', builderNodes: [{}] } },
    { name: 'a failed context lookup', scenario: { builderDriver: 'docker-container', builderEndpoints: ['gone'], contexts: { gone: null } } },
    { name: 'a kubernetes driver', scenario: { builderDriver: 'kubernetes', builderEndpoints: ['kubernetes:///buildkit?deployment=x'] } },
    // buildx connection helpers: athanor never reads how their traffic travels.
    { name: 'a remote node through the docker-container helper naming a context', scenario: { builderDriver: 'remote', builderEndpoints: ['docker-container://buildkitd?context=far'] } },
    { name: 'a remote node through the kube-pod helper', scenario: { builderDriver: 'remote', builderEndpoints: ['kube-pod://buildkitd-0'] } },
  ];
  await t.test('with neither key, a remote plain tcp node names allowPlainTcp first, as the engine does', async (t) => {
    const { result } = await runRow(t, rows[0]!);
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /allowPlainTcp/);
  });
  for (const row of rows) {
    await t.test(`refused with allowRemoteDocker alone: ${row.name}`, async (t) => {
      const { result, docker } = await runRow(t, { ...row, machine: remoteOptIn });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message!, /allowPlainTcp/);
      assert.equal(callsOf(docker.calls(), 'build').length, 0);
    });
    await t.test(`passes with both keys: ${row.name}`, async (t) => {
      const { result, progress } = await runRow(t, { ...row, machine: { allowRemoteDocker: true, allowPlainTcp: true } });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.ok(progress.some((l) => builderNotice.test(l) || cannotInspectNotice.test(l)), progress.join('\n'));
      // With no builder name to pin, the run says so (BUILDX_BUILDER is unset here).
      if (progress.some((l) => cannotInspectNotice.test(l))) assert.ok(progress.some((l) => /cannot pin it for this run/.test(l)), progress.join('\n'));
    });
  }
});

test('L13 a stopped engine says Start Docker, and each builder refusal says what to do next', async (t) => {
  await t.test('a stopped engine', async (t) => {
    const { result, docker } = await runRow(t, { name: 'down', scenario: { engineDown: true } });
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /Docker is not reachable.*Start Docker/s);
    assert.doesNotMatch(result.message!, /allowRemoteDocker/);
    assert.ok(!docker.calls().some((c) => c.args[0] === 'buildx'));
  });
  await t.test('a remote builder names a local builder and the opt-out with the machine file', async (t) => {
    const { result } = await runRow(t, { name: 'far', scenario: { builderDriver: 'docker-container', builderEndpoints: ['ssh://10.0.0.5'] } });
    assert.match(result.message!, /docker buildx use default/);
    assert.match(result.message!, /"allowRemoteDocker": true in the machine configuration \(.*config\.json\)/);
  });
  await t.test('a builder athanor cannot inspect says to install or repair buildx', async (t) => {
    const { result } = await runRow(t, { name: 'broken', scenario: { buildxFails: true } });
    assert.match(result.message!, /install or repair buildx/i);
  });
});

test('L4 no user name, password or control character from an endpoint is shown', async (t) => {
  // Built from parts, so the source never spells an address with a user and password in it.
  const userInfo = ['alice', 'p@ss'].join(':') + '@';
  const secret = `ssh://${userInfo}build-box`;
  const hidden = (texts: string[], bits = ['alice', 'p@ss', 'ss@']) => {
    for (const text of texts) for (const bit of bits) assert.ok(!text.includes(bit), `"${bit}" shown in: ${text}`);
  };
  // The shape of the Docker CLI's own error when its ssh connection helper fails.
  const sshFailure = (host: string) => `error during connect: Get "http://docker.example/v1.47/version": command [ssh -l alice -p 22 -o ConnectTimeout=30 -T -- ${host} docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=alice@${host}: Permission denied (publickey).`;
  const rows: (Row & { extra?: string })[] = [
    { name: 'an ssh DOCKER_HOST, refused', env: { DOCKER_HOST: secret } },
    { name: 'an ssh DOCKER_HOST, named in the notice', env: { DOCKER_HOST: secret }, machine: remoteOptIn },
    { name: 'a plain tcp DOCKER_HOST', env: { DOCKER_HOST: `tcp://${userInfo}10.0.0.5:2375` } },
    { name: 'a builder node, refused', scenario: { builderDriver: 'docker-container', builderEndpoints: [`${secret}:22`] } },
    { name: 'a builder node, named in the notice', scenario: { builderDriver: 'docker-container', builderEndpoints: [`${secret}:22`] }, machine: remoteOptIn },
    { name: 'docker version failure text that repeats the endpoint', env: { DOCKER_HOST: secret }, machine: remoteOptIn, scenario: { engineDown: true, engineDownText: `error during connect: ${secret}: connection refused` } },
    { name: 'buildx inspect failure text that repeats the endpoint', scenario: { buildxFails: true, buildxFailText: `ERROR: failed to dial ${secret}:22` } },
    { name: 'the ssh helper\'s failure text for the engine', env: { DOCKER_HOST: 'ssh://alice@build-box' }, machine: remoteOptIn, scenario: { engineDown: true, engineDownText: sshFailure('build-box') } },
    { name: 'the ssh helper\'s failure text for the builder', env: { DOCKER_HOST: 'ssh://alice@build-box' }, machine: { allowRemoteDocker: true, allowPlainTcp: true }, scenario: { buildxFails: true, buildxFailText: sshFailure('build-box') } },
  ];
  // Every row puts the endpoint into a message or a notice, so hiding is not vacuous.
  const named = (texts: string[]) => assert.ok(texts.some((t) => /build-box|10\.0\.0\.5/.test(t)), texts.join('\n'));
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const { result, progress } = await runRow(t, row);
      hidden([...progress, result.message ?? '', JSON.stringify(result)]);
      named([...progress, result.message ?? '']);
    });
  }
  // A password with a character the URL rules end the user-info at.
  for (const odd of ['p/ss', 'p?ss', 'p#ss', 'p ss']) {
    await t.test(`a password holding "${odd[1]}"`, async (t) => {
      const host = `ssh://${['alice', odd].join(':')}@build-box`;
      const { result, progress } = await runRow(t, { name: odd, env: { DOCKER_HOST: host } });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      hidden([...progress, result.message ?? '', JSON.stringify(result)], ['alice', odd, `${odd[2]}ss@`]);
      named([result.message ?? '']);
    });
  }
  await t.test('a context host with a control character is shown escaped', async (t) => {
    const { result } = await runRow(t, { name: 'esc', scenario: { contextHost: 'tcp://10.0.0.5:2376\u001b[31m', contextTls: tls } });
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.ok(!result.message!.includes('\u001b'));
    assert.match(result.message!, /\\x1b\[31m/);
  });
});

test('L10 every Docker call after the context is read keeps the checked context and builder, and the run\'s own settings', async (t) => {
  const { result, docker } = await runRow(t, { name: 'pin', env: { DOCKER_TLS_VERIFY: '1' }, scenario: { builderName: 'local-builder' } });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const calls = docker.calls();
  assert.deepEqual(calls[0]!.args, ['context', 'inspect']);
  const later = calls.slice(1);
  assert.ok(later.some((c) => c.args[0] === 'build') && later.some((c) => c.args[0] === 'run'));
  // The builder's name is pinned once the first check has read it: from the
  // first call that is not part of that check.
  const checkDone = calls.findIndex((c) => !['context', 'version', 'buildx'].includes(c.args[0]!));
  assert.ok(checkDone > 0);
  for (const [i, c] of later.entries()) {
    assert.equal(c.env?.context, 'fake', c.args.join(' '));
    if (i + 1 >= checkDone) assert.equal(c.env?.builder, 'local-builder', c.args.join(' '));
    assert.equal(c.env?.tlsVerify, '1', c.args.join(' '));
    assert.equal(c.env?.hasPath, true, c.args.join(' '));
  }
});

test('L11 a context or builder that changes while the run waits for its slot ends the run before docker run', async (t) => {
  const rows: Row[] = [
    // With buildx missing, only the engine is compared.
    { name: 'the pinned context now points at another machine', scenario: { contextHostLater: 'ssh://10.0.0.5', buildx: 'missing' }, machine: remoteOptIn },
    { name: 'the pinned builder now has a node on another machine', scenario: { builderDriver: 'docker-container', builderEndpoints: ['unix:///var/run/docker.sock'], builderNodesLater: ['ssh://10.0.0.5'], loadRequired: true }, machine: remoteOptIn },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const prefix = uniquePrefix();
      const { result, docker } = await runRow(t, row, { prefix });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.equal(result.outcome, 'error');
      assert.match(result.message!, /changed while the run waited/);
      assert.equal(callsOf(docker.calls(), 'run').length, 0);
      assert.equal(result.slot, 1, 'the run had its slot');
      assert.equal((await ask(prefix, 1)).held, false, 'the slot is free');
    });
  }
});

test('L15 the engine\'s own docker builder gets no second notice', async (t) => {
  const rows: Row[] = [
    // As real Docker answers: with DOCKER_HOST set, the default builder's node is the "default" context, which is DOCKER_HOST.
    { name: 'a remote DOCKER_HOST and its default builder', env: { DOCKER_HOST: 'ssh://10.0.0.5' }, scenario: { builderName: 'default', builderEndpoints: ['default'] } },
    { name: 'a remote context and its own builder', env: { DOCKER_CONTEXT: 'remote' }, scenario: { contextHost: 'ssh://10.0.0.5', builderName: 'fake', builderEndpoints: ['fake'] } },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const { result, progress } = await runRow(t, { ...row, machine: remoteOptIn });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.equal(progress.filter((l) => /another machine/.test(l)).length, 1, progress.join('\n'));
      assert.match(progress[0]!, engineNotice);
    });
  }
});

test('L7 the opt-out does not let a plain tcp engine through', async (t) => {
  // A host and port with no scheme is plain tcp to Docker.
  for (const host of ['tcp://10.0.0.5:2375', '10.0.0.5:2375']) {
    await t.test(host, async (t) => {
      const { result, docker } = await runRow(t, { name: 'plain', env: { DOCKER_HOST: host }, machine: remoteOptIn });
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message!, /without TLS.*allowPlainTcp/s);
      assert.deepEqual(docker.calls(), []);
    });
  }
});
