// An outside configuration (ATH-11, docs/spec/0001-outside-configuration.md):
// a configuration file named by --config or ATHANOR_CONFIG, read instead of the
// repo configuration. The configuration folder is a temporary folder outside the
// tested repo unless the test says otherwise. One top-level test per acceptance
// claim, with its cases as rows.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { run, serve } from '#dist/index.js';
import type { RunOptions, Serving } from '#dist/index.js';
import { serveCommand } from '#dist/cli.js';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, tempDir, writeFiles, callsOf, cli, collector } from '../helpers.ts';
import type { Fake } from '../helpers.ts';

type From = 'flag' | 'environment';

// A configuration folder holding `config.json` and any other files.
function configFolder(t: TestContext, config: unknown, files: Record<string, string> = {}): { folder: string; file: string } {
  const folder = tempDir(t, 'athanor-config-');
  writeFiles(folder, files);
  const file = join(folder, 'config.json');
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return { folder, file };
}

// A repo with no athanor files at all.
const bareRepo = (t: TestContext, files: Record<string, string> = {}) => makeRepo(t, { files });

async function runWith(t: TestContext, repo: string, file: string, extra: RunOptions = {}, from: From = 'flag', docker: Fake = fake(t)) {
  const progress: string[] = [];
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), config: { file, from }, onProgress: (l) => progress.push(l), ...extra });
  return { result, progress, calls: docker.calls() };
}

const commandOf = (docker: { args: string[] }[], words: number) => docker.at(-1)!.args.slice(-words);

test('OC1 run with an outside configuration runs the named command on a repo with none, and exits with its code', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  const { file } = configFolder(t, { ...baseConfig, commands: { unit: ['node', 'unit.js'] } });
  const { result, calls } = await runWith(t, repo, file, { name: 'unit' }, 'flag', fake(t, { run: { exitCode: 3 } }));
  assert.equal(result.outcome, 'fail', JSON.stringify(result));
  assert.equal(result.exitCode, 3);
  assert.deepEqual(commandOf(callsOf(calls, 'run'), 2), ['node', 'unit.js']);

  await t.test('the core refuses a relative file', async (t) => {
    const r = await runWith(t, repo, relative(repo, file));
    assert.equal(r.result.exitCode, 125);
    assert.match(r.result.message!, /absolute/);
    assert.equal(r.calls.length, 0);
  });
});

test('OC2 serve with an outside configuration starts the named server from it', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  const { file } = configFolder(t, { ...baseConfig, servers: { dev: { argv: ['node', 'outside-server.js'], port: 3000 } } });
  const docker = fake(t, { serve: { exitCode: 0, exitAfterMs: 400 } });
  let serving: Serving | undefined;
  const result = await serve({ cwd: repo, name: 'dev', docker: docker.docker, prefix: uniquePrefix(), portPollMs: 20, config: { file, from: 'flag' }, onServing: (s) => { serving = s; } });
  assert.equal(result.outcome, 'exited', JSON.stringify(result));
  assert.ok(serving, 'it served');
  assert.deepEqual(serving.config, { file, from: 'flag' });
  assert.deepEqual(commandOf(callsOf(docker.calls(), 'run'), 2), ['node', 'outside-server.js']);

  await t.test('the serving JSON line carries config', async (t) => {
    const lines: Record<string, unknown>[] = [];
    const docker = fake(t, { serve: { exitCode: 0, exitAfterMs: 400 } });
    await serveCommand({ json: true, name: 'dev', config: file }, {
      cwd: repo, env: {}, docker: docker.docker, prefix: uniquePrefix(), portPollMs: 20,
      line: (o) => lines.push(o as Record<string, unknown>), say: () => {}, stdout: collector(), stderr: collector(), signal: new AbortController().signal,
    });
    assert.deepEqual(lines.find((l) => l.event === 'serving')!.config, { file, from: 'flag' });
    assert.equal('config' in lines.find((l) => l.event === 'ended')!, false);
  });
});

test('OC3 the flag wins over ATHANOR_CONFIG, an empty variable counts as unset, and a bad flag value exits 125', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  const named = (word: string) => configFolder(t, { ...baseConfig, commands: { test: ['echo', word] } });
  const flag = named('flag');
  const variable = named('variable');
  // The CLI against a Docker engine that is not there: a configuration that was
  // found gets as far as the Docker checks, and its source line says which.
  const env = { DOCKER_HOST: 'tcp://203.0.113.1:2376' };
  const rows = [
    { name: 'the variable alone', args: [], set: variable.file, line: /using the configuration from ATHANOR_CONFIG\./ },
    { name: 'the flag over the variable', args: ['--config', flag.file], set: variable.file, line: /using the configuration from --config\./ },
    { name: 'a relative flag path is taken from the current folder', args: ['--config', relative(repo, flag.file)], set: '', line: /using the configuration from --config\./ },
    { name: 'a relative variable path too', args: [], set: relative(repo, variable.file), line: /using the configuration from ATHANOR_CONFIG\./ },
    { name: 'an empty variable counts as unset', args: [], set: '', line: /There is no repo configuration/ },
  ];
  for (const command of [['run'], ['serve', 'dev']]) {
    for (const row of rows) {
      await t.test(`${command[0]}: ${row.name}`, async () => {
        const r = await cli([...command, ...row.args], { cwd: repo, env: { ...env, ATHANOR_CONFIG: row.set } });
        assert.equal(r.code, 125, r.stderr);
        assert.match(r.stderr, row.line);
      });
    }
    for (const value of [[''], ['-x'], []]) {
      await t.test(`${command[0]}: --config ${JSON.stringify(value)}`, async () => {
        const r = await cli([...command, '--config', ...value], { cwd: repo });
        assert.equal(r.code, 125);
        assert.match(r.stderr, /--config needs the path of a configuration file/);
      });
    }
  }
});

test('OC4 every run with an outside configuration prints the source line, and replaced names the repo configuration it stands in for', async (t) => {
  const own = { dockerfile: 'nope', commands: { test: ['false'] } };
  const rows: { name: string; files: Record<string, string>; replaced?: 'athanor.json' | 'package.json' }[] = [
    { name: 'no repo configuration', files: {} },
    { name: 'athanor.json', files: { 'athanor.json': JSON.stringify(own) }, replaced: 'athanor.json' },
    { name: 'an athanor.json that does not parse', files: { 'athanor.json': '{' }, replaced: 'athanor.json' },
    { name: 'the package.json key', files: { 'package.json': JSON.stringify({ athanor: own }) }, replaced: 'package.json' },
    { name: 'both', files: { 'athanor.json': '{}', 'package.json': JSON.stringify({ athanor: own }) }, replaced: 'athanor.json' },
    { name: 'a package.json without the key', files: { 'package.json': '{}' } },
    { name: 'a broken package.json', files: { 'package.json': '{ not json' } },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { packageJson: false, files: row.files });
      const { file } = configFolder(t, baseConfig);
      for (const [from, words] of [['flag', '--config'], ['environment', 'ATHANOR_CONFIG']] as const) {
        const { result, progress } = await runWith(t, repo, file, {}, from);
        assert.equal(result.outcome, 'pass', JSON.stringify(result));
        const tail = row.replaced ? `, not the repo's ${row.replaced}.` : '.';
        assert.deepEqual(progress.filter((l) => l.startsWith('using the configuration')), [`using the configuration from ${words}${tail}`]);
        assert.deepEqual(result.config, { file, from, ...(row.replaced ? { replaced: row.replaced } : {}) });
      }
    });
  }
  await t.test('serve prints it too', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { files: { 'athanor.json': '{}' } });
    const { file } = configFolder(t, { ...baseConfig, servers: { dev: { argv: ['x'], port: 3000 } } });
    const progress: string[] = [];
    await serve({ cwd: repo, name: 'dev', docker: fake(t, { serve: { exitCode: 0, exitAfterMs: 400 } }).docker, prefix: uniquePrefix(), portPollMs: 20, config: { file, from: 'environment' }, onProgress: (l) => progress.push(l) });
    assert.ok(progress.includes('using the configuration from ATHANOR_CONFIG, not the repo\'s athanor.json.'), progress.join('\n'));
  });
});

test('OC5 the JSON has config only with an outside configuration, and is otherwise unchanged', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const plain = await run({ cwd: repo, docker: fake(t).docker, prefix: uniquePrefix() });
  assert.deepEqual(Object.keys(plain), ['schema', 'image', 'snapshot', 'untrackedLeftOut', 'waitedMs', 'slot', 'ranMs', 'outcome', 'exitCode']);
  const { file } = configFolder(t, baseConfig);
  const { result } = await runWith(t, repo, file);
  assert.equal(result.schema, 1);
  assert.deepEqual(result.config, { file, from: 'flag', replaced: 'package.json' });
  assert.deepEqual(Object.keys(result).filter((k) => k !== 'config'), Object.keys(plain));

  await t.test('the serving line without one has no config', async (t) => {
    const served = makeRepo(t, { athanor: { ...baseConfig, servers: { dev: { argv: ['x'], port: 3000 } } } });
    const lines: Record<string, unknown>[] = [];
    await serveCommand({ json: true, name: 'dev' }, {
      cwd: served, env: {}, docker: fake(t, { serve: { exitCode: 0, exitAfterMs: 400 } }).docker, prefix: uniquePrefix(), portPollMs: 20,
      line: (o) => lines.push(o as Record<string, unknown>), say: () => {}, stdout: collector(), stderr: collector(), signal: new AbortController().signal,
    });
    assert.deepEqual(Object.keys(lines.find((l) => l.event === 'serving')!), ['schema', 'event', 'server', 'url', 'port', 'lock']);
  });
});

test('OC10 a missing, unreadable or invalid outside configuration exits 125 naming the path as given and its source', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  const folder = tempDir(t, 'athanor-config-');
  mkdirSync(join(folder, 'a-folder.json'));
  const rows = [
    { name: 'missing', content: undefined, file: 'gone.json', says: /could not be read/ },
    { name: 'a folder', content: undefined, file: 'a-folder.json', says: /could not be read/ },
    { name: 'not JSON', content: '{', file: 'broken.json', says: /not valid JSON/ },
    { name: 'a list', content: '[]', file: 'list.json', says: /must hold one JSON object/ },
    { name: 'an unknown key', content: JSON.stringify({ ...baseConfig, maxRuns: 3 }), file: 'unknown.json', says: /unknown key "maxRuns"/ },
    { name: 'a bad value', content: JSON.stringify({ ...baseConfig, memory: 'lots' }), file: 'bad.json', says: /memory must be/ },
    { name: 'no commands', content: JSON.stringify({ dockerfile: 'test/Dockerfile' }), file: 'nocommands.json', says: /commands must map/ },
    { name: 'an unknown command name', content: JSON.stringify({ ...baseConfig, commands: { other: ['x'] } }), file: 'noname.json', says: /no command named "test"/ },
  ];
  for (const row of rows) {
    if (row.content !== undefined) writeFileSync(join(folder, row.file), row.content);
    for (const [source, words] of [['flag', '--config'], ['environment', 'ATHANOR_CONFIG']] as const) {
      await t.test(`${row.name}, ${source}`, async () => {
        const given = relative(repo, join(folder, row.file));
        const r = await cli(source === 'flag' ? ['run', '--config', given] : ['run'], { cwd: repo, env: source === 'environment' ? { ATHANOR_CONFIG: given } : {} });
        assert.equal(r.code, 125, r.stderr);
        assert.match(r.stderr, row.says);
        assert.ok(r.stderr.includes(`${given} (from ${words})`), r.stderr);
        assert.ok(!r.stderr.includes(folder), 'not the absolute path');
      });
    }
  }
});

test('OC11 an outside configuration file inside the tested repo is accepted', async (t) => {
  isolate(t);
  const repo = bareRepo(t);
  writeFileSync(join(repo, 'local.athanor.json'), JSON.stringify(baseConfig));
  const { result } = await runWith(t, repo, join(repo, 'local.athanor.json'));
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
});

test('OC12 status and prune have no --config, the docker run options are unchanged, and machine ceilings hold', async (t) => {
  for (const command of ['status', 'prune']) {
    await t.test(`${command} --config`, async () => {
      const r = await cli([command, '--config', 'x.json']);
      assert.equal(r.code, 125);
      assert.match(r.stderr, new RegExp(`unknown flag "--config" for athanor ${command}`));
    });
  }
  await t.test('the docker run options, with ATHANOR_CONFIG set', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: baseConfig });
    const { file } = configFolder(t, baseConfig);
    process.env.ATHANOR_CONFIG = file;
    t.after(() => { delete process.env.ATHANOR_CONFIG; });
    const prefix = 'athanor-fixed12';
    const args = async (extra: RunOptions) => {
      const docker = fake(t);
      const result = await run({ cwd: repo, docker: docker.docker, prefix, ...extra });
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      return callsOf(docker.calls(), 'run')[0]!.args;
    };
    const outside = await args({ config: { file, from: 'environment' } });
    assert.deepEqual(outside, await args({}));
    assert.ok(!outside.some((a) => a.includes('ATHANOR_CONFIG') || a.includes(file)));
  });
  const ceilings = [
    { set: { memory: '9g' }, says: /memory 9g is above the machine ceiling maxMemory 8g.*config\.json \(from --config\)/ },
    { set: { timeoutMinutes: 500 }, says: /timeoutMinutes 500 is above the machine ceiling maxTimeoutMinutes 120/ },
    { set: { processes: 2000 }, says: /processes 2000 is above the machine ceiling maxProcesses 1024/ },
  ];
  for (const row of ceilings) {
    await t.test(`ceiling ${Object.keys(row.set)[0]}`, async (t) => {
      isolate(t);
      const repo = bareRepo(t);
      const { file } = configFolder(t, { ...baseConfig, ...row.set });
      const { result, calls } = await runWith(t, repo, file);
      assert.equal(result.exitCode, 125);
      assert.match(result.message!, row.says);
      assert.equal(calls.length, 0);
    });
  }
});
