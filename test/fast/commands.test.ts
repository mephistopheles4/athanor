// Named commands (issue 46, spec M1 to M7): the object form, per-command
// limits and ceilings, and arguments after --. Each bad case exits 125 with a
// plain message, before any Docker call. One top-level test per claim.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import type { RunOptions, RunResult } from '#dist/index.js';
import { parseArgs } from '#dist/cli.js';
import type { Call } from '../helpers.ts';
import { makeRepo, isolate, fake, uniquePrefix, baseConfig, callsOf } from '../helpers.ts';

async function runIn(t: TestContext, repo: string, extra: RunOptions = {}) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });
  return { result, calls: docker.calls() };
}

function assertSetupError(result: RunResult, calls: Call[], pattern: RegExp) {
  assert.equal(result.outcome, 'error', JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  assert.match(result.message!, pattern);
  assert.equal(calls.length, 0, 'no Docker call at all');
}

const withCommands = (commands: unknown, extra: Record<string, unknown> = {}) => ({ ...baseConfig, ...extra, commands });
const flag = (args: string[], name: string): string => args[args.indexOf(name) + 1] as string;

test('M1 a command in object form runs its argv, and the array form is unchanged', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: withCommands({ test: ['node', 'test/run.mjs'], mutation: { argv: ['npx', 'stryker', 'run'] } }) });
  const mutation = await runIn(t, repo, { name: 'mutation' });
  assert.equal(mutation.result.outcome, 'pass', JSON.stringify(mutation.result));
  assert.deepEqual(callsOf(mutation.calls, 'run')[0].args.slice(-3), ['npx', 'stryker', 'run']);
  const plain = await runIn(t, repo);
  assert.deepEqual(callsOf(plain.calls, 'run')[0].args.slice(-2), ['node', 'test/run.mjs']);
});

test('M2 a bad command object exits 125 naming commands.<name>.<key> and the place', async (t) => {
  const rows = [
    { name: 'argv missing', command: {}, key: 'argv' },
    { name: 'argv empty', command: { argv: [] }, key: 'argv' },
    { name: 'argv a string', command: { argv: 'npm test' }, key: 'argv' },
    { name: 'argv with a non-string', command: { argv: ['npm', 3] }, key: 'argv' },
    { name: 'args not a boolean', command: { argv: ['x'], args: 'yes' }, key: 'args' },
    { name: 'memory 2x', command: { argv: ['x'], memory: '2x' }, key: 'memory' },
    { name: 'cpus 0', command: { argv: ['x'], cpus: 0 }, key: 'cpus' },
    { name: 'timeoutMinutes -1', command: { argv: ['x'], timeoutMinutes: -1 }, key: 'timeoutMinutes' },
    { name: 'an unknown key', command: { argv: ['x'], shell: true }, key: 'shell', lists: /keys are: argv, args, outputs, memory, cpus, timeoutMinutes/ },
  ];
  for (const place of ['athanor.json', 'package.json']) {
    for (const row of rows) {
      await t.test(`${row.name}, in ${place}`, async (t) => {
        isolate(t);
        const commands = { test: ['true'], mutation: row.command };
        const repo = place === 'package.json'
          ? makeRepo(t, { athanor: withCommands(commands) })
          : makeRepo(t, { files: { 'athanor.json': JSON.stringify(withCommands(commands)) } });
        // The run is the default command, but every command gets the shape checks.
        const { result, calls } = await runIn(t, repo);
        assertSetupError(result, calls, new RegExp(`commands\\.mutation\\.${row.key}`));
        assert.match(result.message!, place === 'package.json' ? /"athanor" key in package\.json/ : /athanor\.json/);
        if (row.lists) assert.match(result.message!, row.lists);
      });
    }
  }
});

test('M3 each limit takes the command, then the repo, then the machine file, then the default', async (t) => {
  const home = isolate(t);
  const repo = makeRepo(t, {
    athanor: withCommands(
      { test: ['true'], mutation: { argv: ['npx', 'stryker'], timeoutMinutes: 90, cpus: 4, memory: '4g' }, partial: { argv: ['true'], cpus: 3 } },
      { timeoutMinutes: 30, cpus: 2, memory: '2g' },
    ),
  });
  const mutation = callsOf((await runIn(t, repo, { name: 'mutation' })).calls, 'run')[0].args;
  assert.equal(flag(mutation, '--cpus'), '4');
  assert.equal(flag(mutation, '--memory'), '4g');
  assert.equal(flag(mutation, '--memory-swap'), '4g');
  assert.ok(mutation.includes(`ATHANOR_GRACE_LIMIT=${90 * 60 + 60}`), '90 minutes plus the grace');

  const other = callsOf((await runIn(t, repo)).calls, 'run')[0].args;
  assert.equal(flag(other, '--cpus'), '2');
  assert.equal(flag(other, '--memory'), '2g');
  assert.ok(other.includes(`ATHANOR_GRACE_LIMIT=${30 * 60 + 60}`));

  // A command that sets only cpus takes the other two from the repo's top level.
  const partial = callsOf((await runIn(t, repo, { name: 'partial' })).calls, 'run')[0].args;
  assert.equal(flag(partial, '--cpus'), '3');
  assert.equal(flag(partial, '--memory'), '2g');
  assert.ok(partial.includes(`ATHANOR_GRACE_LIMIT=${30 * 60 + 60}`));

  // With no top level, the machine file, then the defaults.
  const bare = makeRepo(t, { athanor: withCommands({ test: ['true'], partial: { argv: ['true'], cpus: 3 } }) });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ memory: '3g' }));
  const fromMachine = callsOf((await runIn(t, bare, { name: 'partial' })).calls, 'run')[0].args;
  assert.equal(flag(fromMachine, '--cpus'), '3');
  assert.equal(flag(fromMachine, '--memory'), '3g');
  assert.ok(fromMachine.includes(`ATHANOR_GRACE_LIMIT=${30 * 60 + 60}`), 'the default of 30 minutes');
});

test('M4 a command over a machine ceiling exits 125 naming commands.<name>.<key>; another command still runs', async (t) => {
  const rows = [
    { key: 'timeoutMinutes', value: 90, ceiling: { maxTimeoutMinutes: 60 }, says: /commands\.mutation\.timeoutMinutes 90 is above the machine ceiling maxTimeoutMinutes 60/ },
    { key: 'cpus', value: 4, ceiling: { maxCpus: 2 }, says: /commands\.mutation\.cpus 4 is above the machine ceiling maxCpus 2/ },
    { key: 'memory', value: '6g', ceiling: { maxMemory: '4g' }, says: /commands\.mutation\.memory 6g is above the machine ceiling maxMemory 4g/ },
  ];
  for (const row of rows) {
    await t.test(row.key, async (t) => {
      const home = isolate(t);
      writeFileSync(join(home, 'config.json'), JSON.stringify(row.ceiling));
      const repo = makeRepo(t, { athanor: withCommands({ test: ['true'], mutation: { argv: ['x'], [row.key]: row.value } }) });
      const over = await runIn(t, repo, { name: 'mutation' });
      assertSetupError(over.result, over.calls, row.says);
      assert.match(over.result.message!, /athanor\.json|"athanor" key in package\.json/);
      const fine = await runIn(t, repo);
      assert.equal(fine.result.outcome, 'pass', JSON.stringify(fine.result));
    });
  }
});

const mutationRepo = (t: TestContext, args: boolean | undefined) =>
  makeRepo(t, { athanor: withCommands({ test: ['node', 'test/run.mjs'], mutation: { argv: ['npx', 'stryker', 'run'], ...(args === undefined ? {} : { args }) } }) });

test('M5 with args set, everything after -- is a literal argument', async (t) => {
  isolate(t);
  const repo = mutationRepo(t, true);
  const words = ['src/a.ts', 'two words', ';', '$(x)', '--json'];
  const parsed = parseArgs(['run', 'mutation', '--', ...words]);
  assert.equal(parsed.options.json, false, '--json after -- is an argument');
  assert.equal(parsed.options.name, 'mutation');
  assert.deepEqual(parsed.options.args, words);
  assert.equal(parsed.options.command, undefined);
  const { result, calls } = await runIn(t, repo, { name: parsed.options.name, args: parsed.options.args });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.deepEqual(callsOf(calls, 'run')[0].args.slice(-8), ['npx', 'stryker', 'run', ...words]);
});

test('M6 without args set, arguments are refused with the two ways out; the other forms are unchanged', async (t) => {
  isolate(t);
  const plainRepo = mutationRepo(t, undefined);
  const refused = parseArgs(['run', 'mutation', '--', 'x']);
  const first = await runIn(t, plainRepo, { name: refused.options.name, args: refused.options.args });
  assertSetupError(first.result, first.calls, /"args": true.*athanor\.json|"args": true.*"athanor" key in package\.json/s);
  assert.match(first.result.message!, /after -- with no name/);

  const whole = parseArgs(['run', '--', 'node', 'x']);
  assert.equal(whole.options.name, undefined);
  assert.deepEqual(whole.options.command, ['node', 'x']);
  const ran = await runIn(t, plainRepo, { command: whole.options.command });
  assert.deepEqual(callsOf(ran.calls, 'run')[0].args.slice(-2), ['node', 'x']);

  assert.throws(() => parseArgs(['run', 'mutation', '--']), /nothing after --. Give the command to run after it/);

  // Two names: without the opt-in, the two ways out; with it, the -- form.
  const strayOptions = { name: 'mutation', extraNames: ['src/a.ts'] };
  const two = await runIn(t, plainRepo, strayOptions);
  assertSetupError(two.result, two.calls, /"args": true/);
  assert.match(two.result.message!, /after -- with no name/, 'both ways out');
  const optedIn = mutationRepo(t, true);
  const named = await runIn(t, optedIn, strayOptions);
  assertSetupError(named.result, named.calls, /athanor run mutation -- src\/a\.ts/);
  assert.deepEqual(parseArgs(['run', 'mutation', 'src/a.ts']).options.extraNames, ['src/a.ts']);
});

test('M7 the core takes args with a name, with none, and refuses them with a command', async (t) => {
  isolate(t);
  const repo = makeRepo(t, { athanor: withCommands({ test: { argv: ['node', 'test/run.mjs'], args: true }, mutation: { argv: ['npx', 'stryker', 'run'], args: true } }) });
  const named = await runIn(t, repo, { name: 'mutation', args: ['--mutate', 'src/a.ts'] });
  assert.deepEqual(callsOf(named.calls, 'run')[0].args.slice(-5), ['npx', 'stryker', 'run', '--mutate', 'src/a.ts']);
  const unnamed = await runIn(t, repo, { args: ['one'] });
  assert.deepEqual(callsOf(unnamed.calls, 'run')[0].args.slice(-3), ['node', 'test/run.mjs', 'one'], "test's own rule");
  const both = await runIn(t, repo, { command: ['echo'], args: ['x'] });
  assertSetupError(both.result, both.calls, /Arguments go with a command name/);
});
