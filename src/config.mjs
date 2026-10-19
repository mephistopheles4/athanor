// The repo's athanor key, the machine configuration, and the limits a run uses.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AthanorError } from './errors.mjs';

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

const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isMemory = (v) => typeof v === 'string' && /^[0-9]*[1-9][0-9]*[mg]$/.test(v);

const TYPES = {
  memory: [isMemory, 'must be digits followed by m or g, such as 512m or 2g'],
  cpus: [isPositiveNumber, 'must be a number greater than 0'],
  timeoutMinutes: [isPositiveNumber, 'must be a number greater than 0'],
  maxRuns: [isPositiveInteger, 'must be a positive whole number'],
  pruneDays: [isPositiveInteger, 'must be a positive whole number'],
  maxMemory: [isMemory, 'must be digits followed by m or g, such as 8g'],
  maxCpus: [isPositiveNumber, 'must be a number greater than 0'],
  maxTimeoutMinutes: [isPositiveNumber, 'must be a number greater than 0'],
};

export function memoryBytes(value) {
  const n = Number(value.slice(0, -1));
  return n * (value.endsWith('g') ? 1024 ** 3 : 1024 ** 2);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The optional config.json in the state folder. Missing means {}.
export function readMachineConfig(home) {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return {};
  const where = `The machine configuration file ${file}`;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AthanorError(`${where} is not valid JSON. Fix it, or delete it to use the defaults.`);
  }
  if (!isObject(parsed)) throw new AthanorError(`${where} must hold one JSON object.`);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in TYPES)) {
      throw new AthanorError(`${where} has an unknown key "${key}". Its keys are: ${Object.keys(TYPES).join(', ')}.`);
    }
    const [ok, rule] = TYPES[key];
    if (!ok(value)) throw new AthanorError(`${where}: ${key} ${rule}.`);
  }
  return parsed;
}

// The run limit and where it came from: environment, file or default.
export function resolveRunLimit(env, machine) {
  if (env.ATHANOR_MAX_RUNS !== undefined) {
    const raw = env.ATHANOR_MAX_RUNS;
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new AthanorError(`ATHANOR_MAX_RUNS is "${raw}", but it must be a positive whole number, such as 2. Fix or unset it.`);
    }
    return { limit: Number(raw), source: 'environment' };
  }
  if (machine.maxRuns !== undefined) return { limit: machine.maxRuns, source: 'file' };
  return { limit: DEFAULTS.maxRuns, source: 'default' };
}

const REPO_KEYS = ['dockerfile', 'context', 'inputs', 'commands', 'memory', 'cpus', 'timeoutMinutes'];

// The athanor key in the package.json at the repo root, validated.
export function readRepoConfig(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) {
    throw new AthanorError('There is no package.json at the repo root. Add one with an "athanor" key, as the README shows.');
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AthanorError('package.json at the repo root is not valid JSON. Fix it, then run again.');
  }
  const config = pkg?.athanor;
  if (config === undefined) {
    throw new AthanorError('There is no "athanor" key in package.json at the repo root. Add one with at least "dockerfile" and "commands", as the README shows.');
  }
  if (!isObject(config)) throw new AthanorError('The "athanor" key in package.json must be an object.');
  for (const key of Object.keys(config)) {
    if (!REPO_KEYS.includes(key)) {
      throw new AthanorError(`The "athanor" key in package.json has an unknown key "${key}". Its keys are: ${REPO_KEYS.join(', ')}.`);
    }
  }
  if (typeof config.dockerfile !== 'string' || config.dockerfile === '') {
    throw new AthanorError('"dockerfile" is required in the "athanor" key: the repo-relative path of the Dockerfile.');
  }
  if (config.context !== undefined && (typeof config.context !== 'string' || config.context === '')) {
    throw new AthanorError('In the "athanor" key, context must be a repo-relative path string.');
  }
  if (config.inputs !== undefined && (!Array.isArray(config.inputs) || !config.inputs.every((p) => typeof p === 'string' && p !== ''))) {
    throw new AthanorError('In the "athanor" key, inputs must be a list of repo-relative paths, such as ["package-lock.json"].');
  }
  if (!isObject(config.commands) || Object.keys(config.commands).length === 0) {
    throw new AthanorError('In the "athanor" key, commands must map names to argument arrays, such as { "test": ["npm", "test"] }.');
  }
  for (const [name, argv] of Object.entries(config.commands)) {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new AthanorError(`commands.${name} must be an array of strings, such as ["npm", "test"]. A single string is not allowed, because athanor never uses a shell.`);
    }
  }
  for (const key of ['memory', 'cpus', 'timeoutMinutes']) {
    if (config[key] !== undefined && !TYPES[key][0](config[key])) {
      throw new AthanorError(`In the "athanor" key, ${key} ${TYPES[key][1]}.`);
    }
  }
  return config;
}

// Per-run limits: the repo, then the machine file, then the defaults, each
// held to the machine's ceilings.
export function resolveLimits(repo, machine) {
  const pick = (key) => repo[key] ?? machine[key] ?? DEFAULTS[key];
  const limits = { memory: pick('memory'), cpus: pick('cpus'), timeoutMinutes: pick('timeoutMinutes') };
  const ceilings = {
    maxMemory: machine.maxMemory ?? DEFAULTS.maxMemory,
    maxCpus: machine.maxCpus ?? DEFAULTS.maxCpus,
    maxTimeoutMinutes: machine.maxTimeoutMinutes ?? DEFAULTS.maxTimeoutMinutes,
  };
  const over = (key, ceilingKey, above) => {
    if (above) {
      throw new AthanorError(`${key} ${limits[key]} is above the machine ceiling ${ceilingKey} ${ceilings[ceilingKey]}. Lower it in the "athanor" key, or raise ${ceilingKey} in the machine configuration.`);
    }
  };
  over('memory', 'maxMemory', memoryBytes(limits.memory) > memoryBytes(ceilings.maxMemory));
  over('cpus', 'maxCpus', limits.cpus > ceilings.maxCpus);
  over('timeoutMinutes', 'maxTimeoutMinutes', limits.timeoutMinutes > ceilings.maxTimeoutMinutes);
  return limits;
}
