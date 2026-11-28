// The Node lines agree (docs/spec/0002-node-26-beside-the-floor.md, S5, claim
// NV4). package.json names the lowest line athanor supports, the floor, and
// the types package, ci.yml, release.yml and the test image must match it.
// The ci job, the one check a merge requires, must keep the shape that makes it
// fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PATHS = {
  packageJson: 'package.json',
  ci: '.github/workflows/ci.yml',
  release: '.github/workflows/release.yml',
  dockerfile: 'test/container/Dockerfile',
};
type Files = Record<keyof typeof PATHS, string>;

// The jobs ci may leave out of needs: they do not block a merge (spec, Q1).
const NOT_NEEDED = ['ci-macos', 'ci-windows'];
// The jobs that run athanor on every pull request and push, the system each one
// runs on, and whether it runs a newer line beside the floor (spec, S4).
const LEGS = [
  { name: 'suite', runner: 'ubuntu-', newer: true },
  { name: 'ci-macos', runner: 'macos-', newer: false },
  { name: 'ci-windows', runner: 'windows-', newer: false },
];
const FROM_MATRIX = '${{ matrix.node }}';

// A workflow line that means something: no blank, no comment, and nothing
// inside a block scalar such as run: |, whose text is not YAML.
type Line = { depth: number; key?: string; value: string; item: boolean; text: string };
type Job = { name: string; lines: Line[] };

// A line-based read of a workflow's jobs, with no YAML package (ADR 0001). It
// reads block style alone: a layout it cannot read is a problem, never a pass.
function readJobs(text: string, unreadable: (line: string) => void): Job[] {
  const jobs: Job[] = [];
  let inJobs = false;
  let block = -1; // the column of the key that opened a block scalar
  for (const raw of text.split(/\r?\n/)) {
    const spaces = raw.length - raw.trimStart().length;
    if (block >= 0 && (raw.trim() === '' || spaces > block)) continue;
    block = -1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (spaces === 0) {
      inJobs = /^jobs:\s*(#.*)?$/.test(raw);
      continue;
    }
    if (!inJobs) continue;
    if (spaces === 2) {
      const header = raw.match(/^  ([A-Za-z0-9_-]+):\s*(#.*)?$/);
      if (header) jobs.push({ name: header[1], lines: [] });
      else unreadable(raw);
      continue;
    }
    const job = jobs.at(-1);
    const item = /^\s*- /.test(raw);
    const body = raw.trimStart().replace(/^- +/, '').replace(/(^|\s+)#.*$/, '').trimEnd();
    const pair = body.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    const value = pair ? (pair[2] ?? '') : body;
    // A quoted or merge key, a flow mapping, an anchor or an alias.
    if (!job || spaces < 4 || (!pair && !(item && !body.includes(':'))) || /^[{&*]/.test(value)) {
      unreadable(raw);
      continue;
    }
    const line = { depth: raw.length - raw.trimStart().replace(/^- +/, '').length, key: pair?.[1], value, item, text: raw };
    job.lines.push(line);
    if (/^[|>][+-]?\d*$/.test(value)) block = line.depth;
  }
  if (jobs.length === 0) unreadable('no job under jobs:');
  return jobs;
}

// The job's own keys, those at its shallowest depth.
const jobKeys = (job: Job) => job.lines.filter((l) => l.depth === 4);
const unquoted = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');

// The job's steps, each the lines from one "- " under steps: to the next.
function steps(job: Job): Line[][] {
  const out: Line[][] = [];
  let inSteps = false;
  let dash = -1;
  for (const line of job.lines) {
    if (line.depth === 4 && !line.item) {
      inSteps = line.key === 'steps';
    } else if (inSteps) {
      if (line.item && (dash < 0 || line.depth === dash)) {
        dash = line.depth;
        out.push([line]);
      } else out.at(-1)?.push(line);
    }
  }
  return out;
}

const uses = (step: Line[], action: string) => step.some((l) => l.key === 'uses' && unquoted(l.value).toLowerCase().startsWith(`${action}@`));
const nodeVersions = (lines: Line[]) => lines.filter((l) => l.key === 'node-version').map((l) => unquoted(l.value));

// The job's strategy.matrix.node list: null when the job has no matrix, and
// undefined when its matrix is not a plain node: [...] list and nothing else.
function matrix(job: Job): string[] | null | undefined {
  const at = job.lines.findIndex((l) => l.key === 'matrix');
  if (at < 0) return job.lines.some((l) => l.key === 'strategy' && l.value !== '') ? undefined : null;
  const head = job.lines[at];
  const under: Line[] = [];
  for (const line of job.lines.slice(at + 1)) {
    if (line.depth <= head.depth) break;
    under.push(line);
  }
  if (head.value !== '' || under.length !== 1 || under[0].key !== 'node') return undefined;
  const list = under[0].value.match(/^\[(.*)\]$/)?.[1].split(',').map((v) => unquoted(v.trim()));
  return list?.every((v) => /^\d+$/.test(v)) ? list : undefined;
}

// The names in a job's needs:, as a flow list, a single name or a block list.
function needs(job: Job): string[] {
  const at = job.lines.findIndex((l) => l.depth === 4 && l.key === 'needs');
  if (at < 0) return [];
  const { value } = job.lines[at];
  if (value !== '') return value.replace(/^\[(.*)\]$/, '$1').split(',').map((v) => unquoted(v.trim()));
  const names: string[] = [];
  for (const line of job.lines.slice(at + 1)) {
    if (!line.item) break;
    names.push(unquoted(line.value));
  }
  return names;
}

// One problem per disagreement, each naming the file and what to change.
function nodeLineProblems(files: Files): string[] {
  const found: string[] = [];
  const say = (file: keyof Files, why: string) => found.push(`${PATHS[file]}: ${why}`);

  const manifest = JSON.parse(files.packageJson);
  const floor = String(manifest.engines?.node).match(/^>=(\d+)$/)?.[1];
  if (floor === undefined) {
    say('packageJson', `engines.node is ${manifest.engines?.node}: write it as >= and one major number.`);
    return found;
  }
  const types = String(manifest.devDependencies?.['@types/node']);
  if (types.match(/^[\^~]?(\d+)\./)?.[1] !== floor) say('packageJson', `@types/node is ${types}: keep it on major ${floor}, the lowest line engines.node names.`);

  const read = (file: 'ci' | 'release') => readJobs(files[file], (line) => say(file, `cannot read "${line.trim()}": write the workflow's jobs in plain block style.`));
  const ci = read('ci');
  for (const job of ci) {
    const both = LEGS.some((leg) => leg.newer && leg.name === job.name);
    const want = both ? FROM_MATRIX : `'${floor}'`;
    const list = matrix(job);
    if (list === undefined) say('ci', `cannot read the matrix of job ${job.name}: write it as strategy:, matrix:, node: [...] with no other key.`);
    else if (both && !(list?.length === 2 && list[0] === floor && Number(list[1]) > Number(floor))) say('ci', `job ${job.name} must run two lines: give it the matrix node: ['${floor}', a newer line].`);
    else if (!both && list) say('ci', `job ${job.name} has a node matrix: it runs ${floor} alone, so remove the matrix and write '${floor}'.`);
    for (const version of nodeVersions(job.lines)) {
      if (version !== (both ? FROM_MATRIX : floor)) say('ci', `job ${job.name} has node-version ${version}: write ${want}.`);
    }
    if (steps(job).some((s) => uses(s, 'actions/setup-node') && nodeVersions(s).length !== 1)) say('ci', `a setup-node step of job ${job.name} names no node-version: give it ${want}.`);
  }
  for (const leg of LEGS) {
    const job = ci.find((j) => j.name === leg.name);
    if (!job) {
      say('ci', `there is no job ${leg.name}: keep it, so its system stays tested.`);
      continue;
    }
    if (!unquoted(jobKeys(job).find((l) => l.key === 'runs-on')?.value ?? '').startsWith(leg.runner)) say('ci', `job ${leg.name} must run on a ${leg.runner} runner.`);
    if (!steps(job).some((s) => uses(s, 'actions/setup-node'))) say('ci', `job ${leg.name} has no setup-node step: add one, so it does not run the runner's own Node.`);
  }

  const release = read('release');
  const pin = new RegExp(`^${floor}\\.\\d+\\.\\d+$`);
  for (const job of release) {
    const versions = nodeVersions(job.lines);
    for (const version of versions) if (!pin.test(version)) say('release', `job ${job.name} has node-version ${version}: pin an exact ${floor}.y.z release.`);
    if (steps(job).some((s) => uses(s, 'actions/setup-node') && nodeVersions(s).length !== 1)) say('release', `a setup-node step of job ${job.name} names no node-version: pin an exact ${floor}.y.z release.`);
  }
  if (release.every((job) => nodeVersions(job.lines).length === 0)) say('release', `no node-version is named: pin an exact ${floor}.y.z release.`);

  const froms = files.dockerfile.split(/\r?\n/).filter((l) => /^\s*FROM\s/i.test(l));
  if (froms.length === 0 || !froms.every((l) => l.startsWith(`FROM node:${floor}-`))) say('dockerfile', `write the FROM line as FROM node:${floor}- and the variant.`);

  const gate = ci.find((job) => job.name === 'ci');
  if (!gate) {
    say('ci', 'there is no job ci: the ruleset requires that check, so keep the aggregator under that name.');
    return found;
  }
  if (jobKeys(gate).find((l) => l.key === 'if')?.value !== 'always()') say('ci', 'the ci job must have if: always(), or a failed job skips it and a skipped required check passes.');
  const needed = needs(gate);
  for (const job of ci) {
    if (job !== gate && !NOT_NEEDED.includes(job.name) && !needed.includes(job.name)) say('ci', `the ci job's needs: leaves out ${job.name}: add it, so a merge waits for it.`);
  }
  for (const action of ['actions/checkout', 'actions/setup-node']) {
    if (steps(gate).some((s) => uses(s, action))) say('ci', `the ci job uses ${action}: remove the step, the aggregator only reads results.`);
  }
  if (gate.lines.some((l) => l.key === 'permissions')) say('ci', 'the ci job sets permissions: remove the key, it needs none of its own.');
  for (const job of ci) {
    if (needed.includes(job.name) && job.lines.some((l) => l.key === 'continue-on-error')) say('ci', `job ${job.name} sets continue-on-error, which lets a failure reach ci as success: remove it.`);
  }
  return found;
}

const real = Object.fromEntries(Object.entries(PATHS).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')])) as Files;

// A copy of the real files with one of them changed. A change that finds
// nothing to change fails, so no case passes on an unchanged copy.
function changed(file: keyof Files, from: RegExp, to: string): Files {
  const text = real[file].replace(from, to);
  assert.notEqual(text, real[file], `${PATHS[file]} holds nothing that matches ${from}`);
  return { ...real, [file]: text };
}

// The copy is refused, and every problem names the changed file and says why.
function refused(file: keyof Files, copy: Files, why: RegExp): void {
  const found = nodeLineProblems(copy);
  assert.notDeepEqual(found, [], 'the changed copy passed');
  for (const problem of found) {
    assert.ok(problem.startsWith(`${PATHS[file]}: `), problem);
    assert.match(problem, why);
  }
}

const MATRIX = /node: \['24', '26'\]/;
const AGGREGATOR_STEPS = /(  ci:\n    name: ci\n[\s\S]*?    steps:\n)/;

test('NV4 the real files agree', () => {
  assert.deepEqual(nodeLineProblems(real), []);
});

test('NV4 a types major, a matrix, a literal, a release pin or a test image off the floor is refused', () => {
  refused('packageJson', changed('packageJson', /("@types\/node": ")\d+/, '$199'), /@types\/node/);
  refused('ci', changed('ci', MATRIX, "node: ['25', '26']"), /matrix/);
  refused('ci', changed('ci', MATRIX, "node: ['24', '22']"), /matrix/);
  refused('ci', changed('ci', /node-version: '24'/, "node-version: '99'"), /node-version/);
  refused('release', changed('release', /node-version: '\d+\.\d+\.\d+'/, "node-version: '99.0.0'"), /node-version/);
  refused('release', changed('release', /node-version: '\d+\.\d+\.\d+'/, "node-version: '24'"), /node-version/);
  refused('dockerfile', changed('dockerfile', /FROM node:\d+-/, 'FROM node:99-'), /FROM/);
});

test('NV4 a leg that runs other lines, or on another system, is refused', () => {
  // Linux loses the newer line: the list, the whole matrix, or the step that reads it.
  refused('ci', changed('ci', MATRIX, "node: ['24']"), /two lines/);
  const alone = changed('ci', /\n    strategy:\n      fail-fast: false\n      matrix:\n        node: \['24', '26'\]/, '');
  refused('ci', { ...alone, ci: alone.ci.replace('node-version: ${{ matrix.node }}', "node-version: '24'") }, /matrix/);
  refused('ci', changed('ci', /node-version: \$\{\{ matrix\.node \}\}/, "node-version: '24'"), /matrix/);
  // Another system takes the newer line, in a matrix or in place of the floor.
  refused('ci', changed('ci', /\n  ci-macos:\n/, "$&    strategy:\n      matrix:\n        node: ['24', '26']\n"), /matrix/);
  refused('ci', changed('ci', /(\n  ci-windows:\n[\s\S]*?node-version: )'24'/, "$1'26'"), /node-version/);
  refused('ci', changed('ci', /runs-on: macos-\d+/, 'runs-on: ubuntu-24.04'), /macos- runner/);
  refused('ci', changed('ci', /\n  ci-windows:\n[\s\S]*?(?=\n  ci:\n)/, ''), /no job ci-windows/);
  refused('ci', changed('ci', /(\n  ci-macos:\n[\s\S]*?)\n      - uses: actions\/setup-node@[^\n]*\n        with:\n          node-version: '24'\n          package-manager-cache: false/, '$1'), /no setup-node step/);
});

test('NV4 a setup-node step that names neither the matrix nor a literal is refused', () => {
  refused('ci', changed('ci', /node-version: \$\{\{ matrix\.node \}\}/, 'node-version-file: .nvmrc'), /setup-node/);
  refused('ci', changed('ci', /node-version: \$\{\{ matrix\.node \}\}/, 'node-version: ${{ env.NODE }}'), /node-version/);
  // The workflows job has no matrix, so naming one there names no line.
  refused('ci', changed('ci', /node-version: '24'/, 'node-version: ${{ matrix.node }}'), /matrix/);
});

test('NV4 an aggregator without if: always(), or without a job in needs:, is refused', () => {
  refused('ci', changed('ci', /\n    if: always\(\)/, ''), /if: always\(\)/);
  refused('ci', changed('ci', /if: always\(\)\n/, 'if: ${{ !cancelled() }}\n'), /if: always\(\)/);
  // On a step it holds nothing: the job itself would still be skipped.
  refused('ci', changed('ci', /\n    if: always\(\)([\s\S]*?\n      - name: Every job it needs passed)/, '$1\n        if: always()'), /if: always\(\)/);
  refused('ci', changed('ci', /needs: \[workflows, suite\]/, 'needs: [workflows]'), /suite/);
  refused('ci', changed('ci', /needs: \[workflows, suite\]/, 'needs: [suite]'), /workflows/);
  refused('ci', changed('ci', /\njobs:\n/, '\njobs:\n  extra:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node --version\n'), /extra/);
  refused('ci', changed('ci', /\n  ci:\n    name: ci\n/, '\n  gate:\n    name: ci\n'), /no job ci/);
});

test('NV4 a checkout, a setup-node or a permissions: key on the aggregator is refused', () => {
  refused('ci', changed('ci', AGGREGATOR_STEPS, '$1      - uses: actions/checkout@0123456789012345678901234567890123456789\n'), /actions\/checkout/);
  refused('ci', changed('ci', AGGREGATOR_STEPS, "$1      - uses: actions/setup-node@0123456789012345678901234567890123456789\n        with:\n          node-version: '24'\n"), /actions\/setup-node/);
  refused('ci', changed('ci', /if: always\(\)\n/, 'if: always()\n    permissions:\n      contents: write\n'), /permissions/);
});

test('NV4 continue-on-error on a job ci needs, or on one of its steps, is refused', () => {
  refused('ci', changed('ci', /\n    name: suite [^\n]*/, '$&\n    continue-on-error: true'), /continue-on-error/);
  refused('ci', changed('ci', /\n  workflows:\n/, '$&    continue-on-error: ${{ true }}\n'), /continue-on-error/);
  refused('ci', changed('ci', /\n        run: node scripts\/check-workflows\.mjs/, '\n        continue-on-error: true$&'), /continue-on-error/);
});

test('NV4 a layout the check cannot read is refused, never passed', () => {
  refused('packageJson', changed('packageJson', /">=24"/, '">=24.1"'), /engines/);
  refused('ci', changed('ci', MATRIX, "$&\n        exclude:\n          - node: '26'"), /read/);
  refused('ci', changed('ci', /\n    if: always\(\)/, '$&\n    "continue-on-error": true'), /read/);
  refused('ci', changed('ci', /if: always\(\)\n/, '$&    strategy: { fail-fast: false }\n'), /read/);
  refused('ci', changed('ci', /if: always\(\)\n/, '$&    env: *shared\n'), /read/);
  refused('release', changed('release', /node-version: '\d+\.\d+\.\d+'/, 'node-version-file: .nvmrc'), /setup-node/);
  refused('release', changed('release', /\n      - uses: actions\/setup-node@[^\n]*\n        with:\n          node-version: [^\n]*\n          package-manager-cache: false/g, ''), /no node-version is named/);
});
