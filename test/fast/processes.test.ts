// The process limit (issue 54, spec N2 to N5): processes and its machine
// ceiling maxProcesses. Each bad case exits 125 with a plain message, before
// any Docker call. One top-level test per claim, with its cases as rows.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import type { RunOptions, RunResult } from '#dist/index.js';
import type { Call } from '../helpers.ts';
import { makeRepo, isolate, fake, uniquePrefix, callsOf, withCommands } from '../helpers.ts';

async function runIn(t: TestContext, repo: string, extra: RunOptions = {}) {
  const docker = fake(t);
  const result = await run({ cwd: repo, docker: docker.docker, prefix: uniquePrefix(), ...extra });
  return { result, calls: docker.calls() };
}

function assertSetupError(result: RunResult, calls: Call[]) {
  assert.equal(result.outcome, 'error', JSON.stringify(result));
  assert.equal(result.exitCode, 125);
  assert.equal(calls.length, 0, 'no Docker call at all');
}

const pidsLimit = (calls: Call[]): string => {
  const args = callsOf(calls, 'run')[0].args;
  return args[args.indexOf('--pids-limit') + 1] as string;
};

const machine = (home: string, values: Record<string, unknown>) => writeFileSync(join(home, 'config.json'), JSON.stringify(values));

test('N2 the process limit takes the command, then the repo, then the machine file, then the smaller of 1024 and maxProcesses', async (t) => {
  const rows = [
    { name: 'a raised ceiling alone leaves the default', top: undefined, machine: { maxProcesses: 4096 }, run: {}, want: '1024' },
    { name: 'a lowered ceiling lowers the default', top: undefined, machine: { maxProcesses: 512 }, run: {}, want: '512' },
    { name: 'the machine file', top: undefined, machine: { processes: 512 }, run: {}, want: '512' },
    { name: 'the repo over the machine file', top: 768, machine: { processes: 512 }, run: {}, want: '768' },
    { name: 'the command over the repo', top: 768, machine: { processes: 512, maxProcesses: 4096 }, run: { name: 'mutation' }, want: '2048' },
    { name: 'another command takes the repo', top: 768, machine: { processes: 512, maxProcesses: 4096 }, run: {}, want: '768' },
    { name: 'the -- form takes the repo', top: 768, machine: { maxProcesses: 4096 }, run: { command: ['true'] }, want: '768' },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const home = isolate(t);
      machine(home, row.machine);
      const repo = makeRepo(t, {
        athanor: withCommands({ test: ['true'], mutation: { argv: ['x'], processes: 2048 } }, row.top === undefined ? {} : { processes: row.top }),
      });
      const { result, calls } = await runIn(t, repo, row.run);
      assert.equal(result.outcome, 'pass', JSON.stringify(result));
      assert.equal(pidsLimit(calls), row.want);
    });
  }
});

test('N3 a process limit above maxProcesses exits 125 naming the key, the ceiling and the place; another command still runs', async (t) => {
  const rows = [
    {
      name: "a command's own value over the default ceiling",
      athanor: withCommands({ test: ['true'], mutation: { argv: ['x'], processes: 2048 } }), machine: {}, run: { name: 'mutation' },
      says: () => 'commands.mutation.processes 2048 is above the machine ceiling maxProcesses 1024. Lower it in the "athanor" key in package.json, or raise maxProcesses in the machine configuration.',
    },
    {
      name: "the repo's value over a set ceiling",
      athanor: withCommands({ test: ['true'] }, { processes: 2048 }), machine: { maxProcesses: 1500 }, run: {},
      says: () => 'processes 2048 is above the machine ceiling maxProcesses 1500. Lower it in the "athanor" key in package.json, or raise maxProcesses in the machine configuration.',
    },
    {
      name: "the machine file's value over the default ceiling",
      athanor: withCommands({ test: ['true'] }), machine: { processes: 2048 }, run: {},
      says: (home: string) => `processes 2048 is above the machine ceiling maxProcesses 1024. Lower it in the machine configuration file ${join(home, 'config.json')}, or raise maxProcesses in the machine configuration.`,
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const home = isolate(t);
      machine(home, row.machine);
      const repo = makeRepo(t, { athanor: row.athanor });
      const { result, calls } = await runIn(t, repo, row.run);
      assertSetupError(result, calls);
      assert.equal(result.message, row.says(home));
    });
  }

  await t.test('a command not run does not stop another, and a value equal to the ceiling runs', async (t) => {
    const home = isolate(t);
    machine(home, { maxProcesses: 2048 });
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'], over: { argv: ['x'], processes: 4096 }, equal: { argv: ['x'], processes: 2048 } }) });
    const other = await runIn(t, repo);
    assert.equal(other.result.outcome, 'pass', JSON.stringify(other.result));
    const equal = await runIn(t, repo, { name: 'equal' });
    assert.equal(equal.result.outcome, 'pass', JSON.stringify(equal.result));
    assert.equal(pidsLimit(equal.calls), '2048');
  });
});

test('N4 processes and maxProcesses must be whole numbers from 16 to 4194304, in every place', async (t) => {
  const bad: unknown[] = [0, -1, 15, 1.5, 4194305, 1e21, '1024', true, null];
  const rule = 'must be a whole number from 16 to 4194304';
  const places = [
    { name: 'the repo', key: 'processes', set: (_home: string, v: unknown) => withCommands({ test: ['true'] }, { processes: v }), says: /^In the "athanor" key in package\.json, processes must be/ },
    { name: 'a command', key: 'commands.mutation.processes', set: (_home: string, v: unknown) => withCommands({ test: ['true'], mutation: { argv: ['x'], processes: v } }), says: /^In the "athanor" key in package\.json, commands\.mutation\.processes must be/ },
    { name: 'the machine processes', key: 'processes', set: (home: string, v: unknown) => { machine(home, { processes: v }); return withCommands({ test: ['true'] }); }, says: /^The machine configuration file .*config\.json: processes must be/ },
    { name: 'the machine maxProcesses', key: 'maxProcesses', set: (home: string, v: unknown) => { machine(home, { maxProcesses: v }); return withCommands({ test: ['true'] }); }, says: /^The machine configuration file .*config\.json: maxProcesses must be/ },
  ];
  for (const place of places) {
    for (const value of bad) {
      await t.test(`${place.name}: ${JSON.stringify(value)}`, async (t) => {
        const home = isolate(t);
        const repo = makeRepo(t, { athanor: place.set(home, value) });
        const { result, calls } = await runIn(t, repo);
        assertSetupError(result, calls);
        assert.match(result.message!, place.says);
        assert.ok(result.message!.includes(`${place.key} ${rule}`), result.message);
      });
    }
  }

  await t.test('16 passes the check', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }, { processes: 16 }) });
    const { result, calls } = await runIn(t, repo);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.equal(pidsLimit(calls), '16');
  });

  await t.test('4194304 passes the check', async (t) => {
    const home = isolate(t);
    machine(home, { maxProcesses: 4194304 });
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }, { processes: 4194304 }) });
    const { result, calls } = await runIn(t, repo);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.equal(pidsLimit(calls), '4194304');
  });

  await t.test('maxProcesses in the repo is an unknown key', async (t) => {
    isolate(t);
    const repo = makeRepo(t, { athanor: withCommands({ test: ['true'] }, { maxProcesses: 4096 }) });
    const { result, calls } = await runIn(t, repo);
    assertSetupError(result, calls);
    assert.match(result.message!, /has an unknown key "maxProcesses"/);
  });
});
