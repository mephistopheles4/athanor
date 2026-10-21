// The run configuration: everything a run needs from the repo configuration
// and the machine configuration, path-checked and ceiling-checked, with the
// source of each value, so every message names the file to fix.
import { readFileSync, existsSync, lstatSync, realpathSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { AthanorError } from './errors.js';
import { insideRepo, isUnder } from './paths.js';

export const DEFAULTS = Object.freeze({
  maxRuns: 2,
  memory: '2g',
  cpus: 2,
  timeoutMinutes: 30,
  pruneDays: 30,
  maxMemory: '8g',
  maxCpus: 4,
  maxTimeoutMinutes: 120,
});

// Where a value came from.
export type Source =
  | { kind: 'repo'; file: string; key?: string }
  | { kind: 'machine'; file: string }
  | { kind: 'default' };

interface Check {
  ok: (v: unknown) => boolean;
  rule: string;
}

const positiveInteger: Check = { ok: (v) => Number.isInteger(v) && (v as number) > 0, rule: 'must be a positive whole number' };
const positiveNumber: Check = { ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, rule: 'must be a number greater than 0' };
const memory = (example: string): Check => ({
  ok: (v) => typeof v === 'string' && /^[0-9]*[1-9][0-9]*[mg]$/.test(v),
  rule: `must be digits followed by m or g, such as ${example}`,
});

// The one table of configuration keys: which file may set each, and the check
// for its value. Messages list the keys in this order. The repo-only keys are
// checked by checkRepoValues. allowPlainTcp is machine-only, so a repo cannot
// open a plain tcp endpoint for itself (ADR 0013).
const KEYS = {
  dockerfile: { repo: true, machine: false },
  context: { repo: true, machine: false },
  inputs: { repo: true, machine: false },
  commands: { repo: true, machine: false },
  memory: { repo: true, machine: true, check: memory('512m or 2g') },
  cpus: { repo: true, machine: true, check: positiveNumber },
  timeoutMinutes: { repo: true, machine: true, check: positiveNumber },
  maxRuns: { repo: false, machine: true, check: positiveInteger },
  pruneDays: { repo: false, machine: true, check: positiveInteger },
  maxMemory: { repo: false, machine: true, check: memory('8g') },
  maxCpus: { repo: false, machine: true, check: positiveNumber },
  maxTimeoutMinutes: { repo: false, machine: true, check: positiveNumber },
  allowPlainTcp: { repo: false, machine: true, check: { ok: (v) => typeof v === 'boolean', rule: 'must be true or false' } },
} satisfies Record<string, KeyRule>;

interface KeyRule {
  repo: boolean;
  machine: boolean;
  check?: Check;
}

type Key = keyof typeof KEYS;
const RULES: Record<Key, KeyRule> = KEYS;
const keysFor = (file: 'repo' | 'machine'): Key[] => (Object.keys(RULES) as Key[]).filter((k) => RULES[k][file]);
const REPO_KEYS = keysFor('repo');
const MACHINE_KEYS = keysFor('machine');
const checkOf = (key: Key): Check | undefined => RULES[key].check;

export interface MachineValues {
  memory: string;
  cpus: number;
  timeoutMinutes: number;
  maxRuns: number;
  pruneDays: number;
  maxMemory: string;
  maxCpus: number;
  maxTimeoutMinutes: number;
  allowPlainTcp: boolean;
}

// The machine configuration: its file, which may not exist, and its checked values.
export interface MachineConfig {
  file: string;
  values: Partial<MachineValues>;
}

interface RepoValues {
  dockerfile: string;
  context?: string;
  inputs?: string[];
  commands: Record<string, string[]>;
  memory?: string;
  cpus?: number;
  timeoutMinutes?: number;
}

export interface Limits {
  memory: string;
  cpus: number;
  timeoutMinutes: number;
}

type LimitKey = keyof Limits;

export interface RunConfig {
  // Repo-relative paths with forward slashes, each checked to stay inside the repo.
  build: { dockerfile: string; context: string; inputs: string[]; dockerfileInContext: string };
  // The dockerfile as the configuration spells it, for progress messages.
  dockerfileAsSet: string;
  command: string[];
  limits: Limits;
  timeLimitSeconds: number;
  docker: { allowPlainTcp: boolean; machineFile: string };
  from: Record<LimitKey | 'allowPlainTcp', Source>;
}

export function memoryBytes(value: string): number {
  const n = Number(value.slice(0, -1));
  return n * (value.endsWith('g') ? 1024 ** 3 : 1024 ** 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The optional config.json in the state folder. Missing means no values.
export function readMachineConfig(home: string): MachineConfig {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return { file, values: {} };
  const where = `The machine configuration file ${file}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AthanorError(`${where} is not valid JSON. Fix it, or delete it to use the defaults.`);
  }
  if (!isObject(parsed)) throw new AthanorError(`${where} must hold one JSON object.`);
  for (const [key, value] of Object.entries(parsed)) {
    // A list lookup, so "constructor" or "__proto__" is not found on a prototype.
    if (!MACHINE_KEYS.includes(key as Key)) {
      throw new AthanorError(`${where} has an unknown key "${key}". Its keys are: ${MACHINE_KEYS.join(', ')}.`);
    }
    const check = checkOf(key as Key);
    if (check && !check.ok(value)) throw new AthanorError(`${where}: ${key} ${check.rule}.`);
  }
  return { file, values: parsed as Partial<MachineValues> };
}

// The run limit and where it came from: environment, file or default.
export function resolveRunLimit(env: NodeJS.ProcessEnv, machine: MachineConfig): { limit: number; source: 'environment' | 'file' | 'default' } {
  if (env.ATHANOR_MAX_RUNS !== undefined) {
    const raw = env.ATHANOR_MAX_RUNS;
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new AthanorError(`ATHANOR_MAX_RUNS is "${raw}", but it must be a positive whole number, such as 2. Fix or unset it.`);
    }
    return { limit: Number(raw), source: 'environment' };
  }
  if (machine.values.maxRuns !== undefined) return { limit: machine.values.maxRuns, source: 'file' };
  return { limit: DEFAULTS.maxRuns, source: 'default' };
}

// One configuration file at the repo root, as text. It must be a regular file
// whose real path is inside the repo, so a link out, a device or a pipe is
// never read. The real path is opened once, without following a link and
// without waiting on a pipe, and the open handle is checked to be the file
// that was checked, so a swap between the check and the read is refused.
// Whatever goes wrong, the message holds no file content, no system error text
// and no host path.
function readRootFile(root: string, file: string): string {
  let fd: number | undefined;
  try {
    const real = join(realpathSync.native(root), insideRepo(root, file, file, file));
    const before = lstatSync(real, { bigint: true });
    if (!before.isFile()) throw new Error('not a regular file');
    // O_NOFOLLOW and O_NONBLOCK are not defined on Windows, where they count as 0.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('not the file that was checked');
    return readFileSync(fd, 'utf8');
  } catch {
    throw new AthanorError(`${file} at the repo root could not be read. Make it a regular file inside the repo that you can read, then run again.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const PACKAGE_KEY = 'athanor';
const PACKAGE_PLACE = `the "${PACKAGE_KEY}" key in package.json`;
// The same words at the start of a sentence.
const PACKAGE_PLACE_LEAD = `The "${PACKAGE_KEY}" key in package.json`;

// The repo configuration, validated: athanor.json, or the athanor key in the
// package.json at the repo root, never both. `place` names where it was read,
// for every message that sends the user back to it.
function readRepoConfig(root: string): { source: Source & { kind: 'repo' }; values: RepoValues; place: string } {
  const hasJson = existsSync(join(root, 'athanor.json'));
  let pkg: unknown;
  if (existsSync(join(root, 'package.json'))) {
    const text = readRootFile(root, 'package.json');
    try {
      pkg = JSON.parse(text);
    } catch {
      throw new AthanorError(hasJson
        ? `package.json at the repo root is not valid JSON, so athanor cannot tell whether it also has an "${PACKAGE_KEY}" key next to athanor.json. Fix it, then run again.`
        : 'package.json at the repo root is not valid JSON. Fix it, then run again.');
    }
  }
  const hasKey = isObject(pkg) && Object.hasOwn(pkg, PACKAGE_KEY);
  if (hasJson && hasKey) {
    throw new AthanorError(`The repo has both athanor.json and ${PACKAGE_PLACE}. Keep one, and delete the other, then run again.`);
  }
  if (!hasJson && !hasKey) {
    throw new AthanorError(`There is no repo configuration. Add an athanor.json at the repo root, or an "${PACKAGE_KEY}" key in package.json, with at least "dockerfile" and "commands", as the README shows.`);
  }
  let config: unknown;
  let source: Source & { kind: 'repo' };
  let place: string;
  let lead: string;
  if (hasJson) {
    source = { kind: 'repo', file: 'athanor.json' };
    place = lead = 'athanor.json';
    const text = readRootFile(root, 'athanor.json');
    try {
      config = JSON.parse(text);
    } catch {
      throw new AthanorError('athanor.json at the repo root is not valid JSON. Fix it, then run again.');
    }
    if (!isObject(config)) throw new AthanorError('athanor.json must hold one JSON object, such as { "dockerfile": "test/Dockerfile", "commands": { "test": ["npm", "test"] } }. Fix it, then run again.');
  } else {
    source = { kind: 'repo', file: 'package.json', key: PACKAGE_KEY };
    place = PACKAGE_PLACE;
    lead = PACKAGE_PLACE_LEAD;
    config = (pkg as Record<string, unknown>)[PACKAGE_KEY];
    if (!isObject(config)) throw new AthanorError(`${lead} must be an object.`);
  }
  return { source, values: checkRepoValues(config, place, lead), place };
}

// The checks on the repo configuration object, whichever place it came from.
// `lead` is the place as it starts a sentence.
function checkRepoValues(config: Record<string, unknown>, place: string, lead: string): RepoValues {
  for (const k of Object.keys(config)) {
    if (!REPO_KEYS.includes(k as Key)) {
      throw new AthanorError(`${lead} has an unknown key "${k}". Its keys are: ${REPO_KEYS.join(', ')}.`);
    }
  }
  if (typeof config.dockerfile !== 'string' || config.dockerfile === '') {
    throw new AthanorError(`"dockerfile" is required in ${place}: the repo-relative path of the Dockerfile.`);
  }
  if (config.context !== undefined && (typeof config.context !== 'string' || config.context === '')) {
    throw new AthanorError(`In ${place}, context must be a repo-relative path string.`);
  }
  if (config.inputs !== undefined && (!Array.isArray(config.inputs) || !config.inputs.every((p) => typeof p === 'string' && p !== ''))) {
    throw new AthanorError(`In ${place}, inputs must be a list of repo-relative paths, such as ["package-lock.json"].`);
  }
  if (!isObject(config.commands) || Object.keys(config.commands).length === 0) {
    throw new AthanorError(`In ${place}, commands must map names to argument arrays, such as { "test": ["npm", "test"] }.`);
  }
  for (const [name, argv] of Object.entries(config.commands)) {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new AthanorError(`In ${place}, commands.${name} must be an array of strings, such as ["npm", "test"]. A single string is not allowed, because athanor never uses a shell.`);
    }
  }
  for (const k of REPO_KEYS) {
    const check = checkOf(k);
    if (check && config[k] !== undefined && !check.ok(config[k])) {
      throw new AthanorError(`In ${place}, ${k} ${check.rule}.`);
    }
  }
  return config as unknown as RepoValues;
}

// Everything a run needs. The machine configuration is read first, on its
// own, because the run limit comes from it before the repo is found.
export function resolveRunConfig(root: string, machine: MachineConfig, request: { name?: string; command?: string[] } = {}): RunConfig {
  const { source: repoSource, values: repo, place: where } = readRepoConfig(root);
  const machineSource: Source = { kind: 'machine', file: machine.file };
  // Where a message tells the user to change a value: the file it came from,
  // or the repo configuration for a default.
  const placeOf = (source: Source): string => (source.kind === 'machine' ? `the machine configuration file ${source.file}` : where);

  const dockerfile = insideRepo(root, repo.dockerfile, 'dockerfile', where);
  const context = repo.context !== undefined
    ? insideRepo(root, repo.context, 'context', where)
    : (dockerfile.includes('/') ? dockerfile.slice(0, dockerfile.lastIndexOf('/')) : '.');
  const inputs = (repo.inputs ?? []).map((p) => insideRepo(root, p, 'inputs', where));
  if (!isUnder(context, dockerfile)) {
    throw new AthanorError(`The Dockerfile "${repo.dockerfile}" is outside the context folder "${context}". Move it into the context, or widen the context in ${where}.`);
  }
  const dockerfileInContext = context === '.' ? dockerfile : dockerfile.slice(context.length + 1);

  // Per-run limits: the repo, then the machine file, then the defaults, each
  // held to the machine's ceilings.
  const pick = <K extends LimitKey>(key: K): { value: Limits[K]; source: Source } => {
    if (repo[key] !== undefined) return { value: repo[key] as Limits[K], source: repoSource };
    if (machine.values[key] !== undefined) return { value: machine.values[key] as Limits[K], source: machineSource };
    return { value: DEFAULTS[key] as Limits[K], source: { kind: 'default' } };
  };
  const picked = { memory: pick('memory'), cpus: pick('cpus'), timeoutMinutes: pick('timeoutMinutes') };
  const limits: Limits = { memory: picked.memory.value, cpus: picked.cpus.value, timeoutMinutes: picked.timeoutMinutes.value };
  const ceilings = {
    maxMemory: machine.values.maxMemory ?? DEFAULTS.maxMemory,
    maxCpus: machine.values.maxCpus ?? DEFAULTS.maxCpus,
    maxTimeoutMinutes: machine.values.maxTimeoutMinutes ?? DEFAULTS.maxTimeoutMinutes,
  };
  const over = (key: LimitKey, ceilingKey: keyof typeof ceilings, above: boolean): void => {
    if (above) {
      throw new AthanorError(`${key} ${limits[key]} is above the machine ceiling ${ceilingKey} ${ceilings[ceilingKey]}. Lower it in ${placeOf(picked[key].source)}, or raise ${ceilingKey} in the machine configuration.`);
    }
  };
  over('memory', 'maxMemory', memoryBytes(limits.memory) > memoryBytes(ceilings.maxMemory));
  over('cpus', 'maxCpus', limits.cpus > ceilings.maxCpus);
  over('timeoutMinutes', 'maxTimeoutMinutes', limits.timeoutMinutes > ceilings.maxTimeoutMinutes);

  const commandName = request.name ?? 'test';
  // Own keys only, so a name such as "constructor" is not found on the prototype.
  const command = request.command ?? (Object.hasOwn(repo.commands, commandName) ? repo.commands[commandName] : undefined);
  if (command === undefined) {
    throw new AthanorError(`There is no command named "${commandName}" in ${where}. Its commands are: ${Object.keys(repo.commands).join(', ')}.`);
  }

  return {
    build: { dockerfile, context, inputs, dockerfileInContext },
    dockerfileAsSet: repo.dockerfile,
    command,
    limits,
    timeLimitSeconds: limits.timeoutMinutes * 60,
    docker: { allowPlainTcp: machine.values.allowPlainTcp === true, machineFile: machine.file },
    from: {
      memory: picked.memory.source,
      cpus: picked.cpus.source,
      timeoutMinutes: picked.timeoutMinutes.source,
      allowPlainTcp: machine.values.allowPlainTcp !== undefined ? machineSource : { kind: 'default' },
    },
  };
}
