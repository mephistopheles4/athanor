// A run through the core with a fake Docker and real git: what reaches the
// container, the argument arrays, exit codes and outcomes, and git's state.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../src/index.mjs';
import { ask } from '../../src/slots.mjs';
import {
  makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf, collector, tarFile, tarNames, gitState, git, tempDir, writeFiles,
} from '../helpers.mjs';

const runWith = (t, repo, docker, extra = {}) =>
  run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });

const lastRunTar = (docker) => callsOf(docker.calls(), 'run').at(-1).tar;
const lastBuildTar = (docker) => callsOf(docker.calls(), 'build').at(-1).tar;

// The options of a recorded docker run, up to the image tag.
function runOptions(args, tag) {
  return args.slice(0, args.indexOf(tag));
}

test('C1 a run builds on first use, streams output, and exits with the command\'s exit code', async (t) => {
  for (const exitCode of [0, 3]) {
    await t.test(`exit ${exitCode}`, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: baseConfig });
      const docker = fake(t, { run: { exitCode, stdout: 'from the test\n', stderr: 'test stderr\n' } });
      const stdout = collector();
      const stderr = collector();
      const result = await runWith(t, repo, docker, { stdout, stderr });
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.outcome, exitCode === 0 ? 'pass' : 'fail');
      assert.equal(result.image.built, true);
      assert.equal(callsOf(docker.calls(), 'build').length, 1);
      assert.equal(stdout.text(), 'from the test\n');
      assert.equal(stderr.text().includes('test stderr\n'), true);
      assert.equal(stderr.text().includes('athanor-boot-ok'), false, 'the marker is consumed');
    });
  }
});

test('C2 a second run with unchanged inputs makes no build call', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t);
  const first = await runWith(t, repo, docker);
  const second = await runWith(t, repo, docker);
  assert.equal(first.image.built, true);
  assert.equal(second.image.built, false);
  assert.equal(second.image.tag, first.image.tag);
  assert.equal(callsOf(docker.calls(), 'build').length, 1);
});

test('C3 a clone and a worktree get the same tag; a changed input gives another', async (t) => {
  isolate(t);
  const athanor = { ...baseConfig, inputs: ['package-lock.json'] };
  const repo = makeRepo(t, { athanor, files: { 'package-lock.json': '{"v":1}\n' } });
  const docker = fake(t);
  const original = (await runWith(t, repo, docker)).image.tag;

  const clone = join(tempDir(t, 'athanor-clone-'), 'c');
  git(repo, ['clone', '-q', repo, clone]);
  const worktree = join(tempDir(t, 'athanor-wt-'), 'w');
  git(repo, ['worktree', 'add', '-q', worktree]);

  assert.match(original, /^athanor:[0-9a-f]{32}$/);
  assert.equal((await runWith(t, clone, docker)).image.tag, original);
  assert.equal((await runWith(t, worktree, docker)).image.tag, original);

  writeFileSync(join(repo, 'package-lock.json'), '{"v":2}\n');
  assert.notEqual((await runWith(t, repo, docker)).image.tag, original);
});

test('C4 an uncommitted edit reaches the container and git\'s state is unchanged', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { 'a.txt': 'committed\n', 'b.txt': 'b\n' } });
  writeFileSync(join(repo, 'a.txt'), 'edited\n');
  writeFileSync(join(repo, 'b.txt'), 'staged\n');
  git(repo, ['add', 'b.txt']);
  git(repo, ['stash', 'push', '-q', '--', 'b.txt']);
  git(repo, ['stash', 'apply', '-q']);
  const before = gitState(repo);
  const docker = fake(t);
  const result = await runWith(t, repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const tar = lastRunTar(docker);
  assert.equal(tarFile(tar, 'a.txt'), 'edited\n');
  assert.equal(tarFile(tar, 'b.txt'), 'staged\n');
  const after = gitState(repo);
  for (const key of ['stash', 'stage', 'status', 'refs']) assert.equal(after[key], before[key], key);
});

test('C5 untracked files are left out and counted by default, included with --untracked; ignored ones never', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { '.gitignore': 'secret.env\n' } });
  writeFiles(repo, { 'new.test.mjs': 'new\n', 'secret.env': 'KEY=1\n' });
  const before = git(repo, ['ls-files', '--stage']);
  const docker = fake(t);

  const plain = await runWith(t, repo, docker);
  assert.equal(plain.untrackedLeftOut, 1);
  assert.equal(plain.snapshot.untracked, false);
  assert.equal(tarFile(lastRunTar(docker), 'new.test.mjs'), undefined);
  assert.equal(tarFile(lastRunTar(docker), 'secret.env'), undefined);
  assert.equal(git(repo, ['ls-files', '--stage']), before);

  const withUntracked = await runWith(t, repo, docker, { untracked: true });
  assert.equal(withUntracked.snapshot.untracked, true);
  assert.equal(tarFile(lastRunTar(docker), 'new.test.mjs'), 'new\n');
  assert.equal(tarFile(lastRunTar(docker), 'secret.env'), undefined);
  assert.equal(git(repo, ['ls-files', '--stage']), before);
});

test('C10 a run removes its slot\'s leftover athanor container before starting its own', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t);
  const prefix = uniquePrefix();
  docker.addContainer(`${prefix}-slot-1`, { 'athanor.slot': '1' });
  const result = await run({ cwd: repo, docker: docker.docker, prefix });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const calls = docker.calls().map((c) => c.args);
  const removeAt = calls.findIndex((a) => a[0] === 'rm' && a.at(-1) === `${prefix}-slot-1`);
  const runAt = calls.findIndex((a) => a[0] === 'run');
  assert.ok(removeAt !== -1 && removeAt < runAt, 'the leftover is removed before the new run');
});

test('C11 a command past the time limit ends with exit 124 and its container is gone', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t, { run: { hangMs: 20000 } });
  const prefix = uniquePrefix();
  const started = Date.now();
  const result = await run({ cwd: repo, docker: docker.docker, prefix, timeLimitSeconds: 1, graceSeconds: 2 });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.exitCode, 124);
  assert.ok(Date.now() - started < 10000, 'ended by the host-side timer');
  const args = callsOf(docker.calls(), 'run')[0].args;
  assert.ok(args.includes('ATHANOR_GRACE_LIMIT=3'), 'the in-container timer is the limit plus the grace');
  assert.equal(readdirSync(join(docker.dir, 'containers')).length, 0, 'the container is gone');
});

test('C12 an interrupt removes the container, frees the slot and returns 130', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t, { run: { hangMs: 20000 } });
  const prefix = uniquePrefix();
  const controller = new AbortController();
  const stderr = collector();
  const pending = run({ cwd: repo, docker: docker.docker, prefix, signal: controller.signal, stderr });
  while (callsOf(docker.calls(), 'run').length === 0) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.exitCode, 130);
  assert.equal(readdirSync(join(docker.dir, 'containers')).length, 0, 'the container is gone');
  assert.equal((await ask(prefix, 1)).held, false, 'the slot is free');
});

test('C16 a command with shell characters reaches the container as the same literal arguments', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t);
  const command = ['node', 'x.mjs', 'a; rm -rf /', 'b && c', '$(whoami)', "it's", '"quoted"', 'two words', '`tick`'];
  await runWith(t, repo, docker, { command });
  const args = callsOf(docker.calls(), 'run')[0].args;
  assert.deepEqual(args.slice(args.length - command.length), command);
  assert.equal(args[args.length - command.length - 1], 'athanor', '$0 for sh -c');
});

test('C19 no host environment value, host folder or socket reaches the container', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t);
  const result = await runWith(t, repo, docker);
  const options = runOptions(callsOf(docker.calls(), 'run')[0].args, result.image.tag);
  assert.ok(options.includes('--log-driver') && options[options.indexOf('--log-driver') + 1] === 'none');
  for (const banned of ['--env', '-v', '--volume', '--mount', '--privileged', '--env-file', '--net', '--add-host']) {
    assert.equal(options.includes(banned), false, banned);
  }
  const networks = options.flatMap((o, i) => (o === '--network' ? [options[i + 1]] : []));
  assert.deepEqual(networks, ['none']);
  const envs = options.flatMap((o, i) => (o === '-e' ? [options[i + 1]] : []));
  assert.equal(envs.length, 1);
  assert.match(envs[0], /^ATHANOR_GRACE_LIMIT=\d+$/);
  for (const [flag, value] of [['--pids-limit', '1024'], ['--security-opt', 'no-new-privileges'], ['--memory', '2g'], ['--memory-swap', '2g'], ['--cpus', '2'], ['--pull', 'never']]) {
    assert.equal(options[options.indexOf(flag) + 1], value, flag);
  }
});

test('C21 a run changes nothing in the repo and leaves no temporary index behind', async (t) => {
  const home = isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { 'a.txt': 'a\n' } });
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  writeFiles(repo, { 'loose.txt': 'x\n' });
  const before = gitState(repo);
  const docker = fake(t);
  for (const untracked of [false, true]) {
    const result = await runWith(t, repo, docker, { untracked });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
  }
  assert.deepEqual(gitState(repo), before);
  assert.deepEqual(readdirSync(join(home, 'runs')), [], 'no temporary index or object folder is left');
});

test('C25 a run never passes on a partial snapshot, and each failure gets its outcome', async (t) => {
  const rows = [
    { name: 'tar fails in the container', run: { tarFails: true }, outcome: 'error', exitCode: 125 },
    { name: 'the test itself exits 125', run: { exitCode: 125 }, outcome: 'fail', exitCode: 125 },
    { name: 'docker run fails before the test', run: { runFails: true, marker: false }, outcome: 'error', exitCode: 125 },
    { name: 'no marker: the image breaks the contract', run: { marker: false, exitCode: 0 }, outcome: 'error', exitCode: 125, says: /image contract/ },
    { name: 'the memory limit', run: { exitCode: 137, oom: true }, outcome: 'memory', exitCode: 137 },
    { name: 'docker inspect fails', run: { exitCode: 0 }, inspectFails: true, outcome: 'error', exitCode: 125 },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: baseConfig });
      const docker = fake(t, { run: row.run, inspectFails: row.inspectFails });
      const result = await runWith(t, repo, docker);
      assert.equal(result.outcome, row.outcome, JSON.stringify(result));
      assert.equal(result.exitCode, row.exitCode);
      if (row.says) assert.match(result.message, row.says);
    });
  }
});

test('C28 only the hashed set reaches the build', async (t) => {
  isolate(t);
  const athanor = { ...baseConfig, dockerfile: 'test/Dockerfile', context: 'test', inputs: ['package-lock.json'] };
  const repo = makeRepo(t, {
    athanor,
    files: {
      'test/Dockerfile': 'FROM alpine\nCOPY package-lock.json /\n',
      'test/.gitignore': 'ignored.txt\n',
      'test/kept.txt': 'kept\n',
      'package-lock.json': '{}\n',
      'outside.txt': 'outside\n',
    },
  });
  writeFiles(repo, { 'test/ignored.txt': 'ignored\n', 'test/untracked.txt': 'untracked\n' });
  const docker = fake(t);
  const first = await runWith(t, repo, docker);
  assert.equal(first.outcome, 'pass', JSON.stringify(first));
  assert.deepEqual(tarNames(lastBuildTar(docker)), ['.gitignore', 'Dockerfile', 'kept.txt', 'package-lock.json']);
  const buildArgs = callsOf(docker.calls(), 'build')[0].args;
  assert.deepEqual(buildArgs.slice(-3), ['-f', 'Dockerfile', '-']);

  git(repo, ['config', 'tar.umask', '0077']);
  docker.setScenario({});
  for (const f of readdirSync(join(docker.dir, 'images'))) unlinkSync(join(docker.dir, 'images', f));
  const second = await runWith(t, repo, docker);
  assert.equal(second.image.tag, first.image.tag);
  const modes = lastBuildTar(docker).filter((e) => e.type === '0').map((e) => e.mode);
  assert.ok(modes.every((m) => /644$/.test(m)), `modes ${modes}`);

  await t.test('a Dockerfile outside the context exits 125 before any build', async (t) => {
    const outside = makeRepo(t, { athanor: { ...baseConfig, dockerfile: 'Dockerfile', context: 'test' }, files: { Dockerfile: 'FROM alpine\n', 'test/x.txt': 'x\n' } });
    const d = fake(t);
    const result = await runWith(t, outside, d);
    assert.equal(result.exitCode, 125);
    assert.match(result.message, /outside the context folder/);
    assert.equal(callsOf(d.calls(), 'build').length, 0);
  });

  await t.test('an input whose place is taken by a file under context exits 125', async (t) => {
    const clash = makeRepo(t, {
      athanor: { ...baseConfig, context: 'test', inputs: ['package-lock.json'] },
      files: { 'test/package-lock.json': 'a\n', 'package-lock.json': 'b\n' },
    });
    const d = fake(t);
    const result = await runWith(t, clash, d);
    assert.equal(result.exitCode, 125);
    assert.match(result.message, /already is/);
  });
});

test('C29 a remote engine, context or builder exits 125 naming the setting, with no build or run', async (t) => {
  const rows = [
    { name: 'DOCKER_HOST tcp', env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' }, says: /DOCKER_HOST/ },
    { name: 'context with a tcp endpoint', env: { DOCKER_CONTEXT: 'remote' }, scenario: { contextHost: 'tcp://10.0.0.5:2376' }, says: /DOCKER_CONTEXT/ },
    { name: 'remote builder', env: { BUILDX_BUILDER: 'far' }, scenario: { builderDriver: 'remote', builderEndpoint: 'tcp://10.0.0.5:1234' }, says: /BUILDX_BUILDER/ },
    { name: 'cloud builder', env: { BUILDX_BUILDER: 'cloud-x' }, scenario: { builderDriver: 'cloud' }, says: /BUILDX_BUILDER/ },
    { name: 'docker-container builder on tcp', scenario: { builderDriver: 'docker-container', builderEndpoint: 'tcp://10.0.0.5:2376' }, says: /builder/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t, row.env ?? {});
      const repo = makeRepo(t, { athanor: baseConfig });
      const docker = fake(t, row.scenario ?? {});
      const result = await runWith(t, repo, docker);
      assert.equal(result.exitCode, 125, JSON.stringify(result));
      assert.match(result.message, row.says);
      assert.equal(callsOf(docker.calls(), 'build').length + callsOf(docker.calls(), 'run').length, 0);
    });
  }
  await t.test('local settings pass: npipe host, docker-container on a local endpoint, no buildx', async (t) => {
    for (const [env, scenario] of [
      [{ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, {}],
      [{}, { builderDriver: 'docker-container', builderEndpoint: 'unix:///var/run/docker.sock' }],
      [{}, { buildx: 'missing' }],
    ]) {
      isolate(t, env);
      const repo = makeRepo(t, { athanor: baseConfig });
      const result = await runWith(t, repo, fake(t, scenario));
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
    }
  });
});

test('C30 a run leaves the repo\'s object count unchanged in both snapshot modes', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { 'a.txt': 'a\n' } });
  writeFileSync(join(repo, 'a.txt'), 'a brand new blob\n');
  writeFiles(repo, { 'u.txt': 'another new blob\n' });
  const before = git(repo, ['count-objects', '-v']);
  const docker = fake(t);
  await runWith(t, repo, docker);
  await runWith(t, repo, docker, { untracked: true });
  assert.equal(git(repo, ['count-objects', '-v']), before);
});

test('C32 with core.autocrlf=true, a file stored with LF arrives with LF in the snapshot and the build', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig, files: { 'test/lf.sh': 'one\ntwo\n', 'run.sh': 'a\nb\n' } });
  git(repo, ['config', 'core.autocrlf', 'true']);
  for (const f of ['test/lf.sh', 'run.sh']) unlinkSync(join(repo, f));
  git(repo, ['checkout', '--', '.']);
  const docker = fake(t);
  const result = await runWith(t, repo, docker);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(tarFile(lastRunTar(docker), 'run.sh'), 'a\nb\n');
  assert.equal(tarFile(lastBuildTar(docker), 'lf.sh'), 'one\ntwo\n');
  assert.ok(existsSync(join(repo, 'run.sh')));
});
