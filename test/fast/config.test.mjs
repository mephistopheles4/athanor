// Configuration, paths, ceilings and environment values: each bad case exits
// 125 with a plain message, before any Docker call. One top-level test per
// acceptance claim, with its cases as rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../src/index.mjs';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, tempDir, callsOf, cli, together, waited } from '../helpers.mjs';

async function runIn(t, repo, extra = {}) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });
  return { result, calls: docker.calls() };
}

function assertSetupError(result, calls, pattern) {
  assert.equal(result.outcome, 'error', JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  assert.match(result.message, pattern);
  assert.equal(callsOf(calls, 'build').length + callsOf(calls, 'run').length, 0, 'no build or run');
}

test('C18 bad configuration and bad command lines exit 125 naming the problem; -- overrides the named command', async (t) => {
  const configRows = [
    { name: 'missing key', athanor: undefined, says: /no "athanor" key in package\.json.*add one/is },
    { name: 'unknown command name', athanor: baseConfig, runName: 'lint', says: /no command named "lint".*test/s },
    { name: 'string command', athanor: { ...baseConfig, commands: { test: 'npm test' } }, says: /commands\.test must be an array of strings/ },
    { name: 'array with a number', athanor: { ...baseConfig, commands: { test: ['node', 3] } }, says: /commands\.test must be an array of strings/ },
    { name: 'empty array', athanor: { ...baseConfig, commands: { test: [] } }, says: /commands\.test must be an array of strings/ },
    { name: 'no dockerfile', athanor: { commands: baseConfig.commands }, says: /"dockerfile" is required/ },
    { name: 'unknown key', athanor: { ...baseConfig, image: 'x' }, says: /unknown key "image"/ },
    { name: 'bad memory', athanor: { ...baseConfig, memory: '2gb' }, says: /memory must be digits followed by m or g/ },
    { name: 'bad cpus', athanor: { ...baseConfig, cpus: 0 }, says: /cpus must be a number greater than 0/ },
    { name: 'bad timeout', athanor: { ...baseConfig, timeoutMinutes: '5' }, says: /timeoutMinutes must be a number greater than 0/ },
    { name: 'inputs not a list', athanor: { ...baseConfig, inputs: 'a' }, says: /inputs must be a list of repo-relative paths/ },
    { name: 'no commits yet', athanor: baseConfig, commit: false, says: /no commits yet/ },
  ];
  for (const row of configRows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: row.athanor, commit: row.commit ?? true });
      const { result, calls } = await runIn(t, repo, { name: row.runName });
      assertSetupError(result, calls, row.says);
    });
  }

  const lineRows = [
    { args: [], says: /run, status, prune/ },
    { args: ['frobnicate'], says: /unknown subcommand "frobnicate".*run, status, prune/s },
    { args: ['run', '--bogus'], says: /unknown flag "--bogus"/ },
    { args: ['status', '--untracked'], says: /unknown flag "--untracked"/ },
    { args: ['prune', '--days', '0'], says: /--days must be a positive whole number/ },
    { args: ['prune', '--days', 'x'], says: /--days must be a positive whole number/ },
    { args: ['prune', '--days', '1.5'], says: /--days must be a positive whole number/ },
    { args: ['prune', '--days'], says: /--days must be a positive whole number/ },
    { args: ['run', 'a', 'b'], says: /one command name/ },
    { args: ['run', '--'], says: /nothing after --/ },
  ];
  for (const row of lineRows) {
    await t.test(`athanor ${row.args.join(' ')}`, async () => {
      const r = await cli(row.args);
      assert.equal(r.code, 125, r.stderr);
      assert.match(r.stderr, row.says);
    });
  }

  await t.test('a command after -- overrides the named one', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: baseConfig });
    const { result, calls } = await runIn(t, repo, { command: ['echo', 'hi'] });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(callsOf(calls, 'run')[0].args.slice(-2), ['echo', 'hi']);
  });
});

test('C17 a path outside the repo root exits 125 before any Docker call', async (t) => {
  const outside = tempDir(t, 'athanor-outside-');
  writeFileSync(join(outside, 'Dockerfile'), 'FROM alpine\n');
  const rows = [
    { name: 'dockerfile through ..', athanor: { ...baseConfig, dockerfile: '../Dockerfile' }, says: /dockerfile.*outside the repo/ },
    { name: 'absolute dockerfile', athanor: { ...baseConfig, dockerfile: join(outside, 'Dockerfile') }, says: /dockerfile.*outside the repo/ },
    { name: 'context through ..', athanor: { ...baseConfig, context: '..' }, says: /context.*outside the repo/ },
    { name: 'input through ..', athanor: { ...baseConfig, inputs: ['../x.lock'] }, says: /inputs.*outside the repo/ },
    { name: 'linked context', athanor: { ...baseConfig, context: 'link' }, link: true, says: /context.*outside the repo/ },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: row.athanor });
      if (row.link) symlinkSync(outside, join(repo, 'link'), 'junction');
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, row.says);
      assert.equal(calls.length, 0, 'no Docker call at all');
    });
  }
});

test('C31 a repo value above a machine ceiling exits 125 naming the key and the ceiling', async (t) => {
  const rows = [
    { set: { memory: '9g' }, says: /memory 9g is above the machine ceiling maxMemory 8g/ },
    { set: { cpus: 5 }, says: /cpus 5 is above the machine ceiling maxCpus 4/ },
    { set: { timeoutMinutes: 121 }, says: /timeoutMinutes 121 is above the machine ceiling maxTimeoutMinutes 120/ },
    { set: { memory: '3g' }, file: { maxMemory: '2048m' }, says: /memory 3g is above the machine ceiling maxMemory 2048m/ },
  ];
  for (const row of rows) {
    await t.test(JSON.stringify(row.set), async (t) => {
      const home = isolate(t);
      if (row.file) writeFileSync(join(home, 'config.json'), JSON.stringify(row.file));
      const repo = makeRepo(t, { athanor: { ...baseConfig, ...row.set } });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, row.says);
    });
  }
});

test('C24 the machine file sets limits under the repo, is read from ATHANOR_HOME, and a bad one exits 125', async (t) => {
  const badRows = [
    { content: '{ not json', says: /config\.json is not valid JSON/ },
    { content: JSON.stringify({ maxruns: 3 }), says: /config\.json.*unknown key "maxruns"/ },
    { content: JSON.stringify({ maxRuns: '3' }), says: /config\.json.*maxRuns must be a positive whole number/ },
    { content: JSON.stringify({ pruneDays: 1.5 }), says: /config\.json.*pruneDays must be a positive whole number/ },
    { content: JSON.stringify({ maxCpus: -1 }), says: /config\.json.*maxCpus must be a number greater than 0/ },
    { content: JSON.stringify([1]), says: /config\.json must hold one JSON object/ },
  ];
  for (const row of badRows) {
    await t.test(row.content, async (t) => {
      const home = isolate(t);
      writeFileSync(join(home, 'config.json'), row.content);
      const repo = makeRepo(t, { athanor: baseConfig });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, row.says);
    });
  }

  await t.test('a repo without limits takes the file; a repo with its own keeps them', async (t) => {
    const home = isolate(t);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: '3g', cpus: 3, timeoutMinutes: 45 }));
    const plain = makeRepo(t, { athanor: baseConfig });
    const a = callsOf((await runIn(t, plain)).calls, 'run')[0].args;
    assert.equal(a[a.indexOf('--memory') + 1], '3g');
    assert.equal(a[a.indexOf('--cpus') + 1], '3');
    assert.ok(a.includes('ATHANOR_GRACE_LIMIT=2760'), '45 minutes plus 60 seconds');

    const own = makeRepo(t, { athanor: { ...baseConfig, memory: '1g', cpus: 1.5 } });
    const b = callsOf((await runIn(t, own)).calls, 'run')[0].args;
    assert.equal(b[b.indexOf('--memory') + 1], '1g');
    assert.equal(b[b.indexOf('--cpus') + 1], '1.5');
  });

  await t.test('a missing state folder is created where ATHANOR_HOME points', async (t) => {
    const home = isolate(t);
    process.env.ATHANOR_HOME = join(home, 'nested', 'state');
    const repo = makeRepo(t, { athanor: baseConfig });
    const { result } = await runIn(t, repo);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.ok(existsSync(process.env.ATHANOR_HOME));
  });
  await t.test('maxRuns 3 in the file: three at once', async (t) => {
    const home = isolate(t);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxRuns: 3 }));
    const { results, progress } = await together(t, 3);
    assert.deepEqual(results.map((r) => r.slot).sort(), [1, 2, 3]);
    assert.equal(progress.some(waited), false);
  });
  await t.test('ATHANOR_MAX_RUNS=1 overrides maxRuns 3: the second waits', async (t) => {
    const home = isolate(t, { ATHANOR_MAX_RUNS: '1' });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxRuns: 3 }));
    const { results, progress } = await together(t, 2, { hangMs: 800 });
    assert.deepEqual(results.map((r) => r.slot), [1, 1]);
    assert.equal(progress.filter(waited).length, 1);
    assert.ok(results.some((r) => r.waitedMs >= 500));
  });
});
