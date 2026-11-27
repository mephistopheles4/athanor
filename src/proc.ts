// Child processes, always from an argument array with shell: false (ADR 0002).
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { AthanorError } from './errors.js';

export interface StartOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: 'ignore' | 'pipe';
  // Keep stdout and stderr for the result (default true).
  capture?: boolean;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

// How a child ended. code is null when it could not start; stdout and stderr
// are empty unless captured.
export interface Ended {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

// A started child, and the promise of its end. stdin is null unless piped.
export interface Started {
  child: ChildProcessByStdio<Writable | null, Readable, Readable>;
  done: Promise<Ended>;
}

/** @internal For tests (ADR 0003, ATH-14): a program that runs in this process. */
export type TestProgram = (argv: string[], io: {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string | Uint8Array, done?: () => void): unknown };
  stderr: { write(chunk: string | Uint8Array, done?: () => void): unknown };
  signal: AbortSignal;
}) => Promise<number>;

/** @internal For tests (ADR 0003, ATH-14): argv[0] names that start a TestProgram in this process instead of a child. */
export const testPrograms = new Map<string, TestProgram>();

// A stand-in child for a TestProgram: the streams, exit state, events and
// kill() the core uses on a real one. A kill ends it as a signal would.
function programChild(program: TestProgram, args: string[], env: NodeJS.ProcessEnv, stdin: 'ignore' | 'pipe'): Started['child'] {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // The caller's end of stdin, and what the program reads: ended when the
  // caller ends or destroys its end, as a closed pipe ends a child's input.
  const input = new PassThrough();
  const writer = stdin === 'pipe' ? new PassThrough() : null;
  if (writer === null) input.end();
  else {
    // A write after the program ended fails, as on a closed pipe; the caller's own handlers see it.
    writer.on('error', () => {});
    writer.on('data', (chunk) => input.write(chunk));
    writer.once('end', () => input.end());
    writer.once('close', () => input.end());
  }
  const stop = new AbortController();
  let ended = false;
  const guarded = (out: PassThrough) => ({
    write: (chunk: string | Uint8Array, done?: () => void): boolean => {
      if (ended) { done?.(); return false; }
      return out.write(chunk, () => done?.());
    },
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (ended) return;
    ended = true;
    Object.assign(child, { exitCode: code, signalCode: signal });
    writer?.destroy();
    input.destroy();
    stdout.end();
    stderr.end();
    child.emit('exit', code, signal);
    let open = 2;
    const closed = () => { if (--open === 0) child.emit('close', code, signal); };
    stdout.once('end', closed);
    stderr.once('end', closed);
    stdout.resume();
    stderr.resume();
  };
  Object.assign(child, {
    stdin: writer, stdout, stderr, exitCode: null, signalCode: null,
    kill: (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
      if (ended) return false;
      stop.abort();
      finish(null, signal);
      return true;
    },
  });
  setImmediate(() => {
    program(args, { env, stdin: input, stdout: guarded(stdout), stderr: guarded(stderr), signal: stop.signal })
      .then((code) => finish(code, null), (error: unknown) => { stderr.write(String(error)); finish(1, null); });
  });
  return child as unknown as Started['child'];
}

// Start argv[0] with argv.slice(1). A program PATH does not hold ends in
// `done`'s error; only `call` turns that into the plain message.
export function start(argv: string[], { cwd, env, stdin = 'ignore', capture = true, onStdout, onStderr }: StartOptions = {}): Started {
  // stdout and stderr are always piped, so neither is null; Node's types
  // cannot tell that while stdin is either.
  const program = testPrograms.get(argv[0]);
  const child = program !== undefined ? programChild(program, argv.slice(1), env ?? process.env, stdin) : spawn(argv[0], argv.slice(1), {
    cwd,
    env: env ?? process.env,
    stdio: [stdin, 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  }) as Started['child'];
  // Keep the raw chunks and decode each stream once at the end, so a
  // multibyte character split across chunks is not garbled.
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
  child.stdout.on('data', (chunk: Buffer) => {
    if (capture) stdout.push(chunk);
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (capture) stderr.push(chunk);
    onStderr?.(chunk);
  });
  const done = new Promise<Ended>((resolve) => {
    child.once('error', (error) => resolve({ code: null, stdout: text(stdout), stderr: text(stderr) + String(error.message), error }));
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : null), stdout: text(stdout), stderr: text(stderr) }));
  });
  return { child, done };
}

// Run argv to the end and return how it ended. A program named without a
// folder that PATH does not hold ends in a plain message. A missing working
// folder fails to spawn the same way, and is left to the caller.
export async function call(argv: string[], options: StartOptions & { input?: string } = {}): Promise<Ended> {
  const { child, done } = start(argv, options);
  if (options.input !== undefined) child.stdin?.end(options.input);
  const ended = await done;
  const missing = (ended.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  if (missing && !/[\\/]/.test(argv[0]) && existsSync(options.cwd ?? '.')) {
    throw new AthanorError(`${argv[0]} was not found on PATH. Install it, or add its folder to PATH, then run again.`);
  }
  return ended;
}

// Pipe a tar stream from one child (git) into another (Docker). If the
// consumer stops reading (it exits, or its input closes), end the archive too,
// so it fails rather than blocks.
export function feed(archive: Started, consumer: Started): void {
  const out = archive.child.stdout;
  const into = consumer.child.stdin;
  if (into === null) throw new Error('feed: the consumer was started without a stdin pipe.');
  out.pipe(into);
  const stopArchive = () => {
    out.unpipe(into);
    out.destroy();
    if (archive.child.exitCode === null) archive.child.kill();
  };
  into.on('error', stopArchive);
  consumer.child.once('exit', stopArchive);
}
