// The thin CLI: parses arguments, prints, handles signals, returns the exit code.
// The core (index.ts) does the work and never prints or exits.
import { readFileSync } from 'node:fs';
import { run, status, prune } from './index.js';
import type { RunResult, StatusResult, PruneResult } from './index.js';
import { AthanorError, EXIT } from './errors.js';

type Command = 'run' | 'status' | 'prune';

interface CliOptions {
  json: boolean;
  name?: string;
  command?: string[];
  // Arguments for the named command, from after --.
  args?: string[];
  // Words after the name given without --, passed on so the core can say how to give them.
  extraNames?: string[];
  untracked?: boolean;
  output?: string;
  dryRun?: boolean;
  days?: number;
}

type Parsed = { command: 'version' | Command; options: CliOptions };

interface ErrorResult {
  schema: 1;
  outcome: 'error';
  exitCode: number;
  message: string;
}

const SUBCOMMANDS = 'The subcommands are: run, status, prune. Use athanor --version for the version.';

function version(): string {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// Returns { command, options } or throws AthanorError.
export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === undefined) throw new AthanorError(`No subcommand given. ${SUBCOMMANDS}`);
  if (command === '--version' && rest.length === 0) return { command: 'version', options: { json: false } };
  if (command !== 'run' && command !== 'status' && command !== 'prune') {
    throw new AthanorError(`unknown subcommand "${command}". ${SUBCOMMANDS}`);
  }
  const allowed: string[] = {
    run: ['--json', '--untracked', '--output'],
    status: ['--json'],
    prune: ['--json', '--dry-run', '--days'],
  }[command];
  const options: CliOptions = { json: false };
  const names: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (command === 'run' && arg === '--') {
      const after = rest.slice(i + 1);
      if (after.length === 0) throw new AthanorError('There is nothing after --. Give the command to run after it, or leave -- out.');
      // With no name before it, -- starts a whole command; after a name, the words are its arguments.
      if (names.length === 0) options.command = after;
      else options.args = after;
      break;
    }
    if (arg.startsWith('-')) {
      if (!allowed.includes(arg)) {
        throw new AthanorError(`unknown flag "${arg}" for athanor ${command}. Its flags are: ${allowed.join(', ')}.`);
      }
      if (arg === '--json') options.json = true;
      else if (arg === '--untracked') options.untracked = true;
      else if (arg === '--dry-run') options.dryRun = true;
      else if (arg === '--output') {
        const value = rest[++i];
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new AthanorError('--output needs a folder to copy into, which must not exist yet. Put a folder name right after it, for example one under your user profile.');
        }
        options.output = value;
      }
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
  if (names.length >= 1) options.name = names[0] as string;
  if (names.length > 1) options.extraNames = names.slice(1);
  return { command, options };
}

function errorResult(message: string): ErrorResult {
  return { schema: 1, outcome: 'error', exitCode: EXIT.setup, message };
}

function writeJson(object: unknown): void {
  process.stdout.write(JSON.stringify(object) + '\n');
}

function say(line: string): void {
  process.stderr.write(`athanor: ${line}\n`);
}

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
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
  const onProgress = (line: string): void => say(line);
  try {
    if (command === 'run') return await runCommand(options, onProgress);
    if (command === 'status') {
      const result = await status();
      if (options.json) writeJson(result);
      else printStatus(result);
    } else {
      const result = await prune({ days: options.days, dryRun: options.dryRun });
      if (options.json) writeJson(result);
      else printPrune(result);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof AthanorError)) throw error;
    say(error.message);
    if (options.json) writeJson(errorResult(error.message));
    return EXIT.setup;
  }
}

async function runCommand(options: CliOptions, onProgress: (line: string) => void): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const s of signals) process.on(s, onSignal);
  try {
    const result = await run({
      cwd: process.cwd(),
      name: options.name,
      command: options.command,
      args: options.args,
      extraNames: options.extraNames,
      output: options.output,
      untracked: options.untracked === true,
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

function resultLine(result: RunResult): string {
  // The test ran and exited, but its outputs could not be copied: the message says both.
  if (result.testExitCode !== undefined) return `${result.message?.replace(/\.$/, '')} (exit ${result.exitCode}).`;
  switch (result.outcome) {
    case 'pass': return 'the test command passed (exit 0).';
    case 'fail': return `the test command failed with exit ${result.exitCode}.`;
    case 'timeout': return `the time limit ended the run (exit ${result.exitCode}). Raise timeoutMinutes, or find what hangs.`;
    case 'memory': return `the memory limit ended the run (exit ${result.exitCode}). Raise memory in the repo configuration, or use less.`;
    case 'interrupted': return `the run was interrupted and cleaned up (exit ${result.exitCode}).`;
    default: return `athanor could not run the test (exit ${result.exitCode}): ${result.message}`;
  }
}

function printStatus(result: StatusResult): void {
  say(`run limit ${result.limit} (from ${result.limitSource}).`);
  for (const s of result.slots) {
    say(s.pid === undefined
      ? `slot ${s.slot}: free.`
      : `slot ${s.slot}: held by pid ${s.pid} for ${s.repo}, since ${Number.isFinite(new Date(s.started as number).getTime()) ? new Date(s.started as number).toISOString() : 'an unknown time'}, limit ${s.limit} (as the holder reports).`);
  }
  for (const c of result.containers) say(`container ${c.name} on slot ${c.slot}${c.orphan ? ', an orphan: its slot is free' : ''}.`);
  if (result.containers.length === 0) say('no athanor containers.');
}

function printPrune(result: PruneResult): void {
  const verb = result.dryRun ? 'would remove' : 'removed';
  say(`${verb} ${result.removed.length} image${result.removed.length === 1 ? '' : 's'}${result.removed.length ? ': ' + result.removed.join(', ') : ''}; kept ${result.kept.length}.`);
}
