// Child processes, always from an argument array with shell: false (ADR 0002).
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
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

const windows = process.platform === 'win32';

// Whether a path is absolute from the root of a drive or share. On Windows,
// "\x" hangs off whichever drive is current, so it does not count.
function absolute(path: string): boolean {
  return windows ? /^([a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(path) : path.startsWith('/');
}

// The same folder, whatever its trailing separator, and on Windows its case.
function sameFolder(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return windows ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isProgram(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The full path of a program named without a folder, found in PATH's absolute
// entries only (ADR 0020): never in the working folder or a relative entry,
// which Windows would otherwise search first. On Windows the name is tried as
// given, then with .com, then with .exe; never .cmd or .bat, which need a shell.
export function findProgram(name: string, { path = process.env.PATH ?? '', cwd = process.cwd() }: { path?: string; cwd?: string } = {}): string {
  const endings = windows ? ['', '.com', '.exe'] : [''];
  for (const raw of path.split(delimiter)) {
    const entry = windows ? raw.replace(/^"(.*)"$/, '$1') : raw;
    const folder = resolve(cwd, entry);
    if (!absolute(entry) || sameFolder(folder, cwd)) continue;
    for (const ending of endings) {
      const file = join(folder, name + ending);
      if (isProgram(file)) return file;
    }
  }
  throw new AthanorError(`${name} was not found on PATH. Install it, or add its folder to PATH, then run again.`);
}

// Each name is looked up once per process, so every later start of it runs
// the same file.
const found = new Map<string, string>();

function hasFolder(program: string): boolean {
  return windows ? /[\\/]|^[a-z]:/i.test(program) : program.includes('/');
}

function programPath(program: string): string {
  if (hasFolder(program)) return program;
  let file = found.get(program);
  if (file === undefined) {
    file = findProgram(program);
    found.set(program, file);
  }
  return file;
}

// Start argv[0] with argv.slice(1). A name without a folder starts by the full
// path findProgram gives; a path passes through unchanged.
export function start(argv: string[], { cwd, env, stdin = 'ignore', capture = true, onStdout, onStderr }: StartOptions = {}): Started {
  const program = programPath(argv[0]);
  // stdout and stderr are always piped, so neither is null; Node's types
  // cannot tell that while stdin is either.
  const child = spawn(program, argv.slice(1), {
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
