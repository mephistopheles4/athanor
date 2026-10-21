// Configuration, paths, ceilings and environment values: each bad case exits
// 125 with a plain message, before any Docker call. One top-level test per
// acceptance claim, with its cases as rows.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import type { RunOptions, RunResult } from '#dist/index.js';
import type { Call } from '../helpers.ts';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, tempDir, callsOf, cli, together, waited } from '../helpers.ts';

async function runIn(t: TestContext, repo: string, extra: RunOptions = {}) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });
  return { result, calls: docker.calls() };
}

function assertSetupError(result: RunResult, calls: Call[], pattern: RegExp) {
  assert.equal(result.outcome, 'error', JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  assert.match(result.message!, pattern);
  assert.equal(callsOf(calls, 'build').length + callsOf(calls, 'run').length, 0, 'no build or run');
}

test('C18 bad configuration and bad command lines exit 125 naming the problem; -- overrides the named command', async (t) => {
  const configRows = [
    { name: 'missing key', athanor: undefined, says: /no repo configuration.*athanor\.json.*"athanor" key in package\.json/is },
    { name: 'unknown command name', athanor: baseConfig, runName: 'lint', says: /no command named "lint".*Its commands are: test/s },
    { name: 'a name that is a built-in object member', athanor: baseConfig, runName: 'constructor', says: /no command named "constructor".*Its commands are: test/s },
    { name: 'string command', athanor: { ...baseConfig, commands: { test: 'npm test' } }, says: /commands\.test must be an array of strings, such as \["npm", "test"\]/ },
    { name: 'array with a number', athanor: { ...baseConfig, commands: { test: ['node', 3] } }, says: /commands\.test must be an array of strings, such as \["npm", "test"\]/ },
    { name: 'empty array', athanor: { ...baseConfig, commands: { test: [] } }, says: /commands\.test must be an array of strings, such as \["npm", "test"\]/ },
    { name: 'no dockerfile', athanor: { commands: baseConfig.commands }, says: /"dockerfile" is required.*the repo-relative path of the Dockerfile/ },
    { name: 'unknown key', athanor: { ...baseConfig, image: 'x' }, says: /unknown key "image". Its keys are: dockerfile/ },
    { name: 'bad memory', athanor: { ...baseConfig, memory: '2gb' }, says: /memory must be digits followed by m or g, such as 512m or 2g/ },
    { name: 'bad cpus', athanor: { ...baseConfig, cpus: 0 }, says: /cpus must be a number greater than 0/ },
    { name: 'bad timeout', athanor: { ...baseConfig, timeoutMinutes: '5' }, says: /timeoutMinutes must be a number greater than 0/ },
    { name: 'inputs not a list', athanor: { ...baseConfig, inputs: 'a' }, says: /inputs must be a list of repo-relative paths, such as \["package-lock\.json"\]/ },
    { name: 'no commits yet', athanor: baseConfig, commit: false, says: /no commits yet.*Make a first commit, then run again/s },
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
    { args: [], says: /No subcommand given. The subcommands are: run, status, prune/ },
    { args: ['frobnicate'], says: /unknown subcommand "frobnicate".*run, status, prune/s },
    { args: ['run', '--bogus'], says: /unknown flag "--bogus" for athanor run. Its flags are: --json, --untracked/ },
    { args: ['status', '--untracked'], says: /unknown flag "--untracked" for athanor status. Its flags are: --json./ },
    { args: ['prune', '--days', '0'], says: /--days must be a positive whole number of days, such as --days 30/ },
    { args: ['prune', '--days', 'x'], says: /--days must be a positive whole number of days, such as --days 30/ },
    { args: ['prune', '--days', '1.5'], says: /--days must be a positive whole number of days, such as --days 30/ },
    { args: ['prune', '--days'], says: /--days must be a positive whole number of days, such as --days 30/ },
    { args: ['run', 'a', 'b'], says: /one command name.*put it after --/s },
    { args: ['run', '--'], says: /nothing after --. Give the command to run after it/ },
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

  await t.test('a sibling folder whose name starts with the repo name is outside', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: baseConfig });
    const sibling = repo + 'x';
    mkdirSync(sibling);
    t.after(() => rmSync(sibling, { recursive: true, force: true }));
    writeFileSync(join(sibling, 'Dockerfile'), 'FROM alpine\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ athanor: { ...baseConfig, dockerfile: join(sibling, 'Dockerfile') } }));
    const { result, calls } = await runIn(t, repo);
    assertSetupError(result, calls, /dockerfile.*outside the repo/);
    assert.equal(calls.length, 0);
  });
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
    { content: '{"constructor": 1}', says: /config\.json.*unknown key "constructor"/ },
    { content: '{"__proto__": {}}', says: /config\.json.*unknown key "__proto__"/ },
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
    assert.ok(results.some((r) => r.waitedMs! >= 500));
  });
});

test('T8 a configuration message names the file the bad value came from, in its present text', async (t) => {
  const ceiling = (value: string, max: string, where: string) => `memory ${value} is above the machine ceiling maxMemory ${max}. Lower it in ${where}, or raise maxMemory in the machine configuration.`;
  const rows = [
    { name: 'a repo value', athanor: { ...baseConfig, memory: '9g' }, says: () => ceiling('9g', '8g', 'the "athanor" key in package.json') },
    { name: 'a machine file value', file: { memory: '9g' }, says: (home: string) => ceiling('9g', '8g', `the machine configuration file ${join(home, 'config.json')}`) },
    { name: 'the default value', file: { maxMemory: '1g' }, says: () => ceiling('2g', '1g', 'the "athanor" key in package.json') },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const home = isolate(t);
      if (row.file) writeFileSync(join(home, 'config.json'), JSON.stringify(row.file));
      const repo = makeRepo(t, { athanor: row.athanor ?? baseConfig });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, /above the machine ceiling/);
      assert.equal(result.message, row.says(home));
    });
  }
});

test('T9 a key only the machine may set is refused in the repo configuration, and a repo key in the machine file', async (t) => {
  const repoKeys = 'dockerfile, context, inputs, commands, memory, cpus, timeoutMinutes';
  const machineKeys = 'memory, cpus, timeoutMinutes, maxRuns, pruneDays, maxMemory, maxCpus, maxTimeoutMinutes, allowPlainTcp';
  const machineOnly = { maxRuns: 3, pruneDays: 7, maxMemory: '4g', maxCpus: 2, maxTimeoutMinutes: 60, allowPlainTcp: true };
  for (const [key, value] of Object.entries(machineOnly)) {
    await t.test(`${key} in the repo`, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: { ...baseConfig, [key]: value } });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, /unknown key/);
      assert.equal(result.message, `The "athanor" key in package.json has an unknown key "${key}". Its keys are: ${repoKeys}.`);
    });
  }
  const repoOnly = { dockerfile: 'Dockerfile', context: '.', inputs: [], commands: { test: ['true'] } };
  for (const [key, value] of Object.entries(repoOnly)) {
    await t.test(`${key} in the machine file`, async (t) => {
      const home = isolate(t);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ [key]: value }));
      const repo = makeRepo(t, { athanor: baseConfig });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, /unknown key/);
      assert.equal(result.message, `The machine configuration file ${join(home, 'config.json')} has an unknown key "${key}". Its keys are: ${machineKeys}.`);
    });
  }
});

// The athanor.json tests (issue 7): a repo whose configuration is in
// athanor.json, in both places, or in neither.
const MARKER = 'SECRET-MARKER-7f3a';
const bothFiles = /athanor\.json.*package\.json|package\.json.*athanor\.json/s;
const asJson = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
function assertNoLeak(message: string, repo: string, ...texts: string[]) {
  assert.ok(!message.includes(repo), 'the message holds the repo path');
  for (const x of texts) assert.ok(!message.includes(x), `the message holds ${x}`);
}

test('J1 a run configured in athanor.json makes the same Docker calls as the same object under the key', async (t) => {
  isolate(t);
  const config = { ...baseConfig, memory: '1g', cpus: 1.5, timeoutMinutes: 10, inputs: ['a.lock'] };
  const files = { 'a.lock': 'x\n' };
  const byFile = makeRepo(t, { packageJson: false, files: { ...files, 'athanor.json': asJson(config) } });
  const byKey = makeRepo(t, { athanor: config, files });
  const prefix = uniquePrefix();
  const shape = async (repo: string) => {
    const docker = fake(t);
    const result = await run({ cwd: repo, docker: docker.docker, prefix });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    // The image tag hashes the snapshot, which differs by the configuration file.
    const calls = docker.calls().filter((c) => c.args[0] === 'build' || c.args[0] === 'run');
    return calls.map((c) => c.args.map((a) => a.replace(/athanor:[0-9a-f]{32}/, 'athanor:TAG')));
  };
  const a = await shape(byFile);
  assert.equal(a.length, 2);
  assert.deepEqual(a, await shape(byKey));
});

test('J2 the key alone still works, and its messages name package.json', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: baseConfig });
  const { result } = await runIn(t, repo);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const bad = makeRepo(t, { athanor: { ...baseConfig, image: 'x' } });
  const { result: r2, calls } = await runIn(t, bad);
  assertSetupError(r2, calls, /The "athanor" key in package\.json has an unknown key "image"/);
});

test('J3 athanor.json next to a package.json with no athanor key is read', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { files: { 'athanor.json': asJson({ ...baseConfig, commands: { test: ['echo', 'from-json'] } }) } });
  const { result, calls } = await runIn(t, repo);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.deepEqual(callsOf(calls, 'run')[0].args.slice(-2), ['echo', 'from-json']);
});

test('J4 athanor.json and an athanor key in package.json exit 125 naming both files', async (t) => {
  const rows = [
    { name: 'a valid key', athanor: baseConfig, json: asJson(baseConfig) },
    { name: 'a key set to null', athanor: null, json: asJson(baseConfig) },
    { name: 'a valid key and an athanor.json that is not valid JSON', athanor: baseConfig, json: '{ not json' },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { athanor: row.athanor, files: { 'athanor.json': row.json } });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, bothFiles);
      assert.match(result.message!, /keep one/i);
      assert.equal(calls.length, 0, 'no Docker call at all');
    });
  }
});

test('J5 athanor.json with a package.json that is not valid JSON exits 125 naming package.json', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { files: { 'athanor.json': asJson(baseConfig), 'package.json': `{ ${MARKER}` } });
  const { result, calls } = await runIn(t, repo);
  assertSetupError(result, calls, /package\.json.*not valid JSON/s);
  assertNoLeak(result.message!, repo, MARKER);
  assert.equal(calls.length, 0, 'no Docker call at all');
});

test('J6 athanor.json gets the key checks, and both files must be regular files inside the repo', async (t) => {
  const outside = tempDir(t, 'athanor-outside-');
  writeFileSync(join(outside, 'other.json'), JSON.stringify({ outsideKeyName: 1 }));
  const rows: { name: string; json?: string; dir?: boolean; link?: string; says: RegExp; absent?: string[] }[] = [
    { name: 'invalid JSON', json: `{ ${MARKER}`, says: /athanor\.json.*not valid JSON/s, absent: [MARKER] },
    { name: 'not an object', json: '[1]', says: /athanor\.json must hold one JSON object/ },
    { name: 'an unknown key', json: asJson({ ...baseConfig, image: 'x' }), says: /athanor\.json has an unknown key "image". Its keys are: dockerfile/ },
    { name: 'a string command', json: asJson({ ...baseConfig, commands: { test: 'npm test' } }), says: /athanor\.json.*commands\.test must be an array of strings/s },
    { name: 'a bad type', json: asJson({ ...baseConfig, cpus: 0 }), says: /athanor\.json.*cpus must be a number greater than 0/s },
    { name: 'no dockerfile', json: asJson({ commands: baseConfig.commands }), says: /"dockerfile" is required in athanor\.json/ },
    { name: 'a folder named athanor.json', dir: true, says: /athanor\.json at the repo root could not be read/ },
    { name: 'a link named athanor.json to a file outside', link: 'athanor.json', says: /athanor\.json at the repo root could not be read/, absent: ['outsideKeyName'] },
    { name: 'a link named package.json to a file outside', link: 'package.json', json: asJson(baseConfig), says: /package\.json at the repo root could not be read/, absent: ['outsideKeyName'] },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const plain = row.json !== undefined && row.link === undefined;
      const repo = makeRepo(t, { packageJson: row.link !== 'package.json', files: plain ? { 'athanor.json': row.json! } : {} });
      if (row.dir) mkdirSync(join(repo, 'athanor.json'));
      if (row.link === 'package.json') writeFileSync(join(repo, 'athanor.json'), row.json!);
      if (row.link) symlinkSync(join(outside, 'other.json'), join(repo, row.link), 'file');
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, row.says);
      assertNoLeak(result.message!, repo, ...(row.absent ?? []));
      assert.equal(calls.length, 0, 'no Docker call at all');
    });
  }

  await t.test('a link to /dev/zero exits 125 promptly', { skip: process.platform === 'win32' ? 'no /dev/zero' : false }, async (t) => {
    isolate(t);
    const repo = makeRepo(t);
    symlinkSync('/dev/zero', join(repo, 'athanor.json'));
    const { result, calls } = await runIn(t, repo);
    assertSetupError(result, calls, /athanor\.json at the repo root could not be read/);
  });
});

test('J7 each machine-only key in athanor.json exits 125 as an unknown key naming athanor.json', async (t) => {
  const machineOnly = { maxRuns: 3, pruneDays: 7, maxMemory: '4g', maxCpus: 2, maxTimeoutMinutes: 60, allowPlainTcp: true };
  for (const [key, value] of Object.entries(machineOnly)) {
    await t.test(key, async (t) => {
      isolate(t);
      const repo = makeRepo(t, { packageJson: false, files: { 'athanor.json': asJson({ ...baseConfig, [key]: value }) } });
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, /unknown key/);
      assert.equal(result.message, `athanor.json has an unknown key "${key}". Its keys are: dockerfile, context, inputs, commands, memory, cpus, timeoutMinutes.`);
    });
  }
});

test('J8 with no repo configuration the message names both forms', async (t) => {
  const rows = [
    { name: 'no package.json', opts: { packageJson: false } },
    { name: 'a package.json with no athanor key', opts: {} },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      isolate(t);
      const repo = makeRepo(t, row.opts);
      const { result, calls } = await runIn(t, repo);
      assertSetupError(result, calls, bothFiles);
      assert.match(result.message!, /athanor\.json at the repo root.*"athanor" key in package\.json/s);
    });
  }
});
