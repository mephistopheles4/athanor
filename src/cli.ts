// The thin CLI: parses arguments, prints, handles signals, returns the exit code.
// The core (index.ts) does the work and never prints or exits.
import { readFileSync } from 'node:fs';
import { run, status, prune, serve } from './index.js';
import type { RunResult, StatusResult, PruneResult, ServeResult, Serving } from './index.js';
import type { DockerCommand } from './docker.js';
import { AthanorError, EXIT } from './errors.js';

type Command = 'run' | 'status' | 'prune' | 'serve';

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
  // The base to carry into the snapshot (ADR 0032).
  base?: string;
  dryRun?: boolean;
  days?: number;
  // The host port athanor serve publishes on (default: one Docker picks).
  port?: number;
}

type Parsed = { command: 'version' | Command; options: CliOptions };

interface ErrorResult {
  schema: 1;
  outcome: 'error';
  exitCode: number;
  message: string;
}

const SUBCOMMANDS = 'The subcommands are: run, status, prune, serve. Use athanor --version for the version.';

function version(): string {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

// Returns { command, options } or throws AthanorError.
export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === undefined) throw new AthanorError(`No subcommand given. ${SUBCOMMANDS}`);
  if (command === '--version' && rest.length === 0) return { command: 'version', options: { json: false } };
  if (command !== 'run' && command !== 'status' && command !== 'prune' && command !== 'serve') {
    throw new AthanorError(`unknown subcommand "${command}". ${SUBCOMMANDS}`);
  }
  const allowed: string[] = {
    run: ['--json', '--untracked', '--output', '--base'],
    status: ['--json'],
    prune: ['--json', '--dry-run', '--days'],
    serve: ['--json', '--port'],
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
      else if (arg === '--base') {
        const value = rest[++i];
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new AthanorError('--base needs the name of the branch to compare with right after it, such as --base origin/main.');
        }
        options.base = value;
      }
      else if (arg === '--port') {
        const value = rest[++i];
        if (value === undefined || !/^[1-9][0-9]*$/.test(value) || Number(value) > 65535) {
          throw new AthanorError('--port must be a whole number from 1 to 65535, such as --port 5000.');
        }
        options.port = Number(value);
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
    if (command !== 'run' && command !== 'serve') throw new AthanorError(`athanor ${command} takes no names, but got "${arg}".`);
    names.push(arg);
  }
  if (command === 'serve') {
    if (names.length !== 1) {
      throw new AthanorError(names.length === 0
        ? 'athanor serve needs the name of one server from the repo configuration, such as athanor serve dev.'
        : `athanor serve takes one server name, but got ${names.length}: ${names.join(', ')}.`);
    }
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
    if (argv.includes('--json')) writeJson(argv[0] === 'serve' ? serveEnded({ outcome: 'error', exitCode: EXIT.setup, message: error.message }) : errorResult(error.message));
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
    if (command === 'serve') return await serveProcess(options);
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
      ...(options.base !== undefined ? { base: options.base } : {}),
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

// The signals that stop a run or a server.
function stopSignals(): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  return signals;
}

async function serveProcess(options: CliOptions): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  const signals = stopSignals();
  for (const s of signals) process.on(s, onSignal);
  try {
    return await serveCommand(options, {
      line: writeJson, say, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
    });
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}

/** @internal What athanor serve writes and reads, so a test can stand in for the process (ADR 0003). */
export interface ServeIo {
  line(object: unknown): void;
  say(line: string): void;
  stdout: { write(chunk: Buffer | string): unknown };
  stderr: { write(chunk: Buffer | string): unknown };
  signal: AbortSignal;
  docker?: DockerCommand;
  prefix?: string;
  portWaitMs?: number;
  portPollMs?: number;
  cwd?: string;
}

// The last JSON line of a serve, which every end writes, a failure before the
// server included. It is never run's error object.
function serveEnded(result: Pick<ServeResult, 'outcome' | 'exitCode' | 'ranMs' | 'message'>): unknown {
  return {
    schema: 1, event: 'ended', outcome: result.outcome, exitCode: result.exitCode,
    ...(result.ranMs !== undefined ? { ranMs: result.ranMs } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/** @internal Exported for tests (ADR 0003). */
export async function serveCommand(options: CliOptions, io: ServeIo): Promise<number> {
  const onServing = (s: Serving): void => {
    io.say(`serving ${s.server} at ${s.url} (stop with Ctrl-C).`);
    if (options.json) io.line({ schema: 1, event: 'serving', server: s.server, url: s.url, port: s.port, lock: s.lock });
  };
  const result = await serve({
    cwd: io.cwd ?? process.cwd(),
    name: options.name as string,
    ...(options.port !== undefined ? { port: options.port } : {}),
    signal: io.signal,
    onProgress: io.say,
    onServing,
    stdout: options.json ? io.stderr : io.stdout,
    stderr: io.stderr,
    ...(io.docker !== undefined ? { docker: io.docker } : {}),
    ...(io.prefix !== undefined ? { prefix: io.prefix } : {}),
    ...(io.portWaitMs !== undefined ? { portWaitMs: io.portWaitMs } : {}),
    ...(io.portPollMs !== undefined ? { portPollMs: io.portPollMs } : {}),
  });
  if (options.json) io.line(serveEnded(result));
  io.say(serveLine(result));
  return result.exitCode;
}

/** @internal The line printed when a server ends, exported for tests (ADR 0030). */
export function serveLine(result: ServeResult): string {
  switch (result.outcome) {
    case 'stopped': return `the server was stopped and cleaned up (exit ${result.exitCode}).`;
    case 'exited': return `the server ended on its own (exit ${result.exitCode}).`;
    case 'memory': return `the memory limit ended the server (exit ${result.exitCode}). Raise memory in the repo configuration, or use less.`;
    default: return `athanor could not serve (exit ${result.exitCode}): ${result.message}`;
  }
}

/** @internal The line printed for a run's result, exported for tests (ADR 0030). */
export function resultLine(result: RunResult): string {
  // The test ran and exited, but its outputs could not be copied: the message says both.
  if (result.testExitCode !== undefined) return `${result.message?.replace(/\.$/, '')} (exit ${result.exitCode}).`;
  switch (result.outcome) {
    case 'pass': return 'the test command passed (exit 0).';
    case 'fail': return `the test command failed with exit ${result.exitCode}.`;
    case 'timeout': return `the time limit ended the run (exit ${result.exitCode}). Raise timeoutMinutes, or find what hangs.`;
    case 'memory':
      if (result.containerExitCode !== undefined && result.containerExitCode !== EXIT.memory) {
        return `the test exited ${result.containerExitCode}, but the memory limit killed a process in the container during the run (exit ${result.exitCode}). The test's result may be incomplete. Raise memory in the repo configuration, or use less.`;
      }
      return `the memory limit ended the run (exit ${result.exitCode}). Raise memory in the repo configuration, or use less.`;
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
  say(`server limit ${result.serverLimit} (from ${result.serverLimitSource}).`);
  for (const s of result.servers) {
    if (s.pid !== undefined) say(`server ${s.server}: ${s.name} held by pid ${s.pid} for ${s.repo}${s.port !== undefined ? `, on port ${s.port}` : ''}, since ${Number.isFinite(new Date(s.started as number).getTime()) ? new Date(s.started as number).toISOString() : 'an unknown time'} (as the holder reports).`);
    else if (s.held) say(`server ${s.server}: held.`);
  }
  for (const c of result.serverContainers) say(`server container ${c.name} on lock ${c.server}${c.orphan ? ', an orphan: its lock is free. docker rm -f -v ' + c.name + ' removes it, or the next athanor serve does' : ''}.`);
}

function printPrune(result: PruneResult): void {
  const verb = result.dryRun ? 'would remove' : 'removed';
  say(`${verb} ${result.removed.length} image${result.removed.length === 1 ? '' : 's'}${result.removed.length ? ': ' + result.removed.join(', ') : ''}; kept ${result.kept.length}.`);
}
