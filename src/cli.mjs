// The thin CLI: parses arguments, prints, handles signals, returns the exit code.
// The core (index.ts) does the work and never prints or exits.
import { readFileSync } from 'node:fs';
import { run, status, prune } from './index.js';
import { AthanorError, EXIT } from './errors.js';

const SUBCOMMANDS = 'The subcommands are: run, status, prune. Use athanor --version for the version.';

function version() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// Returns { command, options } or throws AthanorError.
export function parseArgs(argv) {
  if (argv.length === 0) throw new AthanorError(`No subcommand given. ${SUBCOMMANDS}`);
  const [command, ...rest] = argv;
  if (command === '--version' && rest.length === 0) return { command: 'version', options: {} };
  if (!['run', 'status', 'prune'].includes(command)) {
    throw new AthanorError(`unknown subcommand "${command}". ${SUBCOMMANDS}`);
  }
  const allowed = {
    run: ['--json', '--untracked'],
    status: ['--json'],
    prune: ['--json', '--dry-run', '--days'],
  }[command];
  const options = { json: false };
  const names = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (command === 'run' && arg === '--') {
      const after = rest.slice(i + 1);
      if (after.length === 0) throw new AthanorError('There is nothing after --. Give the command to run after it, or leave -- out.');
      options.command = after;
      break;
    }
    if (arg.startsWith('-')) {
      if (!allowed.includes(arg)) {
        throw new AthanorError(`unknown flag "${arg}" for athanor ${command}. Its flags are: ${allowed.join(', ')}.`);
      }
      if (arg === '--json') options.json = true;
      else if (arg === '--untracked') options.untracked = true;
      else if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--days') {
        const value = rest[++i];
        if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
          throw new AthanorError('--days must be a positive whole number of days, such as --days 30.');
        }
        options.days = Number(value);
      }
      continue;
    }
    if (command !== 'run') throw new AthanorError(`athanor ${command} takes no names, but got "${arg}".`);
    names.push(arg);
  }
  if (names.length > 1) {
    throw new AthanorError(`athanor run takes one command name, but got ${names.length}: ${names.join(', ')}. To run a command of your own, put it after --.`);
  }
  if (names.length === 1) options.name = names[0];
  return { command, options };
}

function errorResult(message) {
  return { schema: 1, outcome: 'error', exitCode: EXIT.setup, message };
}

function writeJson(object) {
  process.stdout.write(JSON.stringify(object) + '\n');
}

function say(line) {
  process.stderr.write(`athanor: ${line}\n`);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof AthanorError)) throw error;
    say(error.message);
    if (argv.includes('--json')) writeJson(errorResult(error.message));
    return EXIT.setup;
  }
  const { command, options } = parsed;
  if (command === 'version') {
    process.stdout.write(version() + '\n');
    return 0;
  }
  const onProgress = (line) => say(line);
  try {
    if (command === 'run') return await runCommand(options, onProgress);
    const result = command === 'status'
      ? await status({ onProgress })
      : await prune({ days: options.days, dryRun: options.dryRun, onProgress });
    if (options.json) writeJson(result);
    else printSummary(command, result);
    return 0;
  } catch (error) {
    if (!(error instanceof AthanorError)) throw error;
    say(error.message);
    if (options.json) writeJson(errorResult(error.message));
    return EXIT.setup;
  }
}

async function runCommand(options, onProgress) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].filter((s) => s !== 'SIGBREAK' || process.platform === 'win32');
  for (const s of signals) process.on(s, onSignal);
  try {
    const result = await run({
      cwd: process.cwd(),
      name: options.name,
      command: options.command,
      untracked: options.untracked === true,
      json: options.json,
      signal: controller.signal,
      onProgress,
      stdout: options.json ? process.stderr : process.stdout,
      stderr: process.stderr,
    });
    if (options.json) writeJson(result);
    else say(resultLine(result));
    return result.exitCode;
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}

function resultLine(result) {
  switch (result.outcome) {
    case 'pass': return 'the test command passed (exit 0).';
    case 'fail': return `the test command failed with exit ${result.exitCode}.`;
    case 'timeout': return `the time limit ended the run (exit ${result.exitCode}). Raise timeoutMinutes, or find what hangs.`;
    case 'memory': return `the memory limit ended the run (exit ${result.exitCode}). Raise memory in the athanor key, or use less.`;
    case 'interrupted': return `the run was interrupted and cleaned up (exit ${result.exitCode}).`;
    default: return `athanor could not run the test (exit ${result.exitCode}): ${result.message}`;
  }
}

function printSummary(command, result) {
  if (command === 'status') {
    say(`run limit ${result.limit} (from ${result.limitSource}).`);
    for (const s of result.slots) {
      say(s.pid === undefined
        ? `slot ${s.slot}: free.`
        : `slot ${s.slot}: held by pid ${s.pid} for ${s.repo}, since ${Number.isFinite(new Date(s.started).getTime()) ? new Date(s.started).toISOString() : 'an unknown time'}, limit ${s.limit} (as the holder reports).`);
    }
    for (const c of result.containers) say(`container ${c.name} on slot ${c.slot}${c.orphan ? ', an orphan: its slot is free' : ''}.`);
    if (result.containers.length === 0) say('no athanor containers.');
  } else {
    const verb = result.dryRun ? 'would remove' : 'removed';
    say(`${verb} ${result.removed.length} image${result.removed.length === 1 ? '' : 's'}${result.removed.length ? ': ' + result.removed.join(', ') : ''}; kept ${result.kept.length}.`);
  }
}
