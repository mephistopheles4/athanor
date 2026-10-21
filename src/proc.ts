// Child processes, always from an argument array with shell: false (ADR 0002).
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

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

// Start argv[0] with argv.slice(1).
export function start(argv: string[], { cwd, env, stdin = 'ignore', capture = true, onStdout, onStderr }: StartOptions = {}): Started {
  // stdout and stderr are always piped, so neither is null; Node's types
  // cannot tell that while stdin is either.
  const child = spawn(argv[0], argv.slice(1), {
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

// Run argv to the end and return how it ended.
export function call(argv: string[], options: StartOptions & { input?: string } = {}): Promise<Ended> {
  const { child, done } = start(argv, options);
  if (options.input !== undefined) child.stdin?.end(options.input);
  return done;
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
