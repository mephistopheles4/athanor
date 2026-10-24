// Copy-out (issue 46, ADR 0023): the files a named command declares in
// `outputs` come out of the stopped container into a new folder on the host.
// The container chose every name and byte, so all of it is checked here: names
// are read as text and never resolved, only regular files and folders are
// written, every create is exclusive, and size, entry count and time are
// capped. On any refusal what this copy made is removed from a list. The core
// uses this module and it never prints (ADR 0003).
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AthanorError } from './errors.js';
import { start } from './proc.js';
import { firstLine } from './docker.js';
import type { DockerCommand } from './docker.js';

export const DEFAULT_MAX_OUTPUT_MEGABYTES = 1024;
export const MAX_ENTRIES = 100_000;
export const COPY_TIME_MS = 10 * 60 * 1000;
// The most a PAX or GNU header's own data may hold.
const MAX_META_BYTES = 1024 * 1024;
const BLOCK = 512;

// A copy that failed: the reason, in plain words, for the core to wrap.
export class CopyError extends Error {}
// An interrupt that arrived during the copy.
export class CopyInterrupted extends Error {}

// ---- Names -----------------------------------------------------------------

const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
  'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³',
]);

// Why a path segment is refused, or null when it is fine. These rules hold on
// every platform, so a report made on Linux opens on Windows.
export function badSegment(segment: string): string | null {
  if (segment === '') return 'it has an empty part';
  if (segment === '.' || segment === '..') return 'it has a "." or ".." part';
  // Both folds, so a letter that folds to i (the dotless i) does not get past.
  if (segment.toLowerCase() === '.git' || segment.toUpperCase() === '.GIT') return 'it names a .git folder or file';
  if (segment.includes('\\')) return 'it holds a backslash';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(segment)) return 'it holds a control character';
  if (/\p{Cf}/u.test(segment)) return 'it holds an invisible formatting character';
  if (/[<>:"|?*]/.test(segment)) return 'it holds a character Windows does not allow in a name';
  if (/[. ]$/.test(segment)) return 'it ends in a dot or a space';
  const base = segment.split('.')[0]!.replace(/ +$/, '').toUpperCase();
  if (DEVICE_NAMES.has(base)) return 'it is a Windows device name';
  return null;
}

// A name as the messages show it: control and format characters escaped,
// nothing stripped.
export function showName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

// The `outputs` list of a command: each entry a relative path whose segments
// pass the segment rules, and no entry equal to, under, or differing only in
// case from another. Returns the problem, or null.
export function checkOutputs(outputs: unknown): string | null {
  if (!Array.isArray(outputs)) return 'must be a list of paths inside the work folder, such as ["reports/mutation"]';
  const seen: string[] = [];
  for (const entry of outputs) {
    if (typeof entry !== 'string' || entry === '') return 'must hold non-empty strings';
    if (entry.startsWith('/')) return `has "${showName(entry)}", which is absolute; give a path relative to the work folder`;
    if (/^[a-zA-Z]:/.test(entry)) return `has "${showName(entry)}", which starts with a drive; give a path relative to the work folder`;
    if (entry.includes('\\')) return `has "${showName(entry)}", which holds a backslash; separate folders with /`;
    for (const segment of entry.split('/')) {
      const bad = badSegment(segment);
      if (bad) return `has "${showName(entry)}", which is not allowed: ${bad}`;
    }
    const key = entry.toLowerCase();
    for (const other of seen) {
      if (key === other || key.startsWith(other + '/') || other.startsWith(key + '/')) {
        return `has "${showName(entry)}" next to another entry that is the same, inside it or differs only in case`;
      }
    }
    seen.push(key);
  }
  return null;
}

// ---- The --output folder -----------------------------------------------------

export interface OutputTarget {
  // The folder as the caller wrote it, for every message.
  asTyped: string;
  // The parent as resolved at the start, and its real path recorded then.
  parent: string;
  realParent: string;
  // The new folder's name inside the parent.
  name: string;
}

// The early checks on --output. Throws an AthanorError (exit 125) before any
// Docker call, and creates nothing.
export function checkOutputTarget(dir: string, cwd: string): OutputTarget {
  const full = resolve(cwd, dir);
  try {
    lstatSync(full);
    throw new AthanorError(`--output ${dir} already exists. Give a folder that does not exist yet; athanor never copies into an existing one.`);
  } catch (error) {
    if (error instanceof AthanorError) throw error;
    // Missing is what is wanted. Any other failure means the place cannot be used.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AthanorError(`--output ${dir} could not be checked. Give a folder that does not exist yet, in a folder you can write to.`);
    }
  }
  const parent = dirname(full);
  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
    if (!lstatSync(realParent).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new AthanorError(`The folder that should hold --output ${dir} does not exist. Make it first, then run again.`);
  }
  if (realParent.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
    throw new AthanorError(`--output ${dir} is inside a .git folder. Give a folder somewhere else.`);
  }
  return { asTyped: dir, parent, realParent, name: basename(full) };
}

// The work folder the boot script named. Exactly one line must have come before
// the marker, an absolute path with no control or format character.
export function workFolder(lines: string[]): string {
  if (lines.length !== 1) {
    throw new CopyError(`the container named its work folder ${lines.length} times instead of once, so athanor does not know where to copy from.`);
  }
  const work = lines[0]!;
  if (!work.startsWith('/') || /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(work)) {
    throw new CopyError('the container named a work folder that is not an absolute path, so athanor does not know where to copy from.');
  }
  return work;
}

// ---- The copy --------------------------------------------------------------

export interface CopyRequest {
  docker: DockerCommand;
  env?: NodeJS.ProcessEnv;
  // The stopped container's ID, and its work folder.
  id: string;
  work: string;
  outputs: string[];
  target: OutputTarget;
  maxBytes: number;
  maxEntries: number;
  timeMs: number;
  // Skip the files Windows acts on when it shows a folder (accepted risk 28).
  skipActOnView: boolean;
  signal?: AbortSignal;
  onProgress: (line: string) => void;
}

export interface Copied {
  files: number;
  bytes: number;
  skipped: number;
  missing: string[];
}

const ACT_ON_VIEW = /(^desktop\.ini$)|(\.(lnk|url|scf|library-ms|searchConnector-ms|theme|themepack)$)/i;
const MISSING = /no such container:path|could not find the file/i;
const RETRY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Made { path: string; kind: 'file' | 'dir' }

// Copy every output into the new folder. Resolves with the counts; throws a
// CopyError or CopyInterrupted after removing what it made.
export async function copyOut(req: CopyRequest): Promise<Copied> {
  const job = new Job(req);
  try {
    return await job.run();
  } catch (error) {
    const left = await job.cleanup();
    if (error instanceof CopyError && left.length > 0) {
      throw new CopyError(`${error.message} athanor could not remove: ${left.join(', ')}. Remove ${req.target.asTyped} yourself.`);
    }
    throw error;
  }
}

class Job {
  private made: Made[] = [];
  // Every folder and file written, by exact name, and by lower-case name for the case check.
  private kinds = new Map<string, 'file' | 'dir'>();
  private folded = new Map<string, string>();
  private counts: Copied = { files: 0, bytes: 0, skipped: 0, missing: [] };
  private req: CopyRequest;
  private root: string;

  constructor(req: CopyRequest) {
    this.req = req;
    this.root = join(req.target.realParent, req.target.name);
  }

  async run(): Promise<Copied> {
    const { req } = this;
    const deadline = Date.now() + req.timeMs;
    const parentNow = (() => { try { return realpathSync.native(req.target.parent); } catch { return null; } })();
    if (parentNow !== req.target.realParent) throw new CopyError('the folder that holds the output folder changed while the run was going.');
    try {
      mkdirSync(this.root, { mode: 0o700 });
    } catch {
      throw new CopyError(`${req.target.asTyped} could not be created.`);
    }
    this.made.push({ path: this.root, kind: 'dir' });
    if (!lstatSync(this.root).isDirectory()) throw new CopyError(`${req.target.asTyped} is not a folder after it was created.`);
    let rawBytes = 0;
    let entries = 0;
    for (const output of req.outputs) {
      const reader = new Reader(this, output, req.maxBytes - rawBytes, req.maxEntries - entries);
      const stderr: Buffer[] = [];
      let failure: unknown;
      let timedOut = false;
      let aborted = false;
      const child = start([...req.docker, 'cp', `${req.id}:${req.work}/${output}`, '-'], {
        env: req.env,
        capture: false,
        onStdout: (chunk) => {
          if (failure) return;
          try {
            reader.push(chunk);
          } catch (error) {
            failure = error;
            child.child.kill();
          }
        },
        onStderr: (chunk) => { if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk); },
      });
      const timer = setTimeout(() => { timedOut = true; child.child.kill(); }, Math.max(0, deadline - Date.now()));
      const onAbort = () => { aborted = true; child.child.kill(); };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const ended = await child.done;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      reader.close();
      if (aborted) throw new CopyInterrupted();
      if (failure) throw failure;
      if (timedOut) throw new CopyError('it took longer than the time limit for a copy.');
      const text = Buffer.concat(stderr).toString('utf8');
      if (ended.code !== 0) {
        if (MISSING.test(text) && reader.entries === 0) {
          this.counts.missing.push(output);
          req.onProgress(`the output "${showName(output)}" is not in the container, so nothing was copied for it.`);
          continue;
        }
        throw new CopyError(`docker cp of "${showName(output)}" failed: ${firstLine(text) || `exit ${ended.code}`}.`);
      }
      reader.finish();
      rawBytes += reader.bytes;
      entries += reader.entries;
    }
    return this.counts;
  }

  // ---- what the reader asks for

  private fold(segments: string[]): string {
    const exact = segments.join('/');
    const key = exact.toLowerCase();
    const earlier = this.folded.get(key);
    if (earlier !== undefined && earlier !== exact) {
      throw new CopyError(`"${showName(exact)}" differs only in case from "${showName(earlier)}", which was copied before it.`);
    }
    this.folded.set(key, exact);
    return exact;
  }

  // Make every missing folder on the way to segments (and the last one too when asked).
  private folders(segments: string[], includingLast: boolean): void {
    const count = includingLast ? segments.length : segments.length - 1;
    for (let i = 1; i <= count; i++) {
      const parts = segments.slice(0, i);
      const exact = this.fold(parts);
      const kind = this.kinds.get(exact);
      if (kind === 'dir') continue;
      if (kind === 'file') throw new CopyError(`"${showName(exact)}" is a file and also a folder.`);
      const path = join(this.root, ...parts);
      try {
        mkdirSync(path);
      } catch {
        throw new CopyError(`the folder "${showName(exact)}" could not be made.`);
      }
      this.made.push({ path, kind: 'dir' });
      this.kinds.set(exact, 'dir');
    }
  }

  // The path of an entry inside the output folder, as segments, or a CopyError.
  place(raw: string, output: string, isFolder: boolean): string[] {
    let name = raw;
    if (name.endsWith('/')) {
      if (!isFolder) throw new CopyError(`the entry "${showName(raw)}" is a file but its name ends in /.`);
      name = name.slice(0, -1);
    }
    const segments = name.split('/');
    for (const segment of segments) {
      const bad = badSegment(segment);
      if (bad) throw new CopyError(`the entry "${showName(raw)}" is not allowed: ${bad}.`);
    }
    const outputSegments = output.split('/');
    if (segments[0] !== outputSegments.at(-1)) {
      throw new CopyError(`the entry "${showName(raw)}" is not inside the output "${showName(output)}".`);
    }
    return [...outputSegments.slice(0, -1), ...segments];
  }

  folder(raw: string, output: string): void {
    this.folders(this.place(raw, output, true), true);
  }

  // Opens a file for the entry; returns null when the entry is skipped.
  file(raw: string, output: string): number | null {
    const segments = this.place(raw, output, false);
    if (this.req.skipActOnView && ACT_ON_VIEW.test(segments.at(-1)!)) {
      this.counts.skipped++;
      return null;
    }
    this.folders(segments, false);
    const exact = this.fold(segments);
    if (this.kinds.has(exact)) throw new CopyError(`the entry "${showName(exact)}" came twice.`);
    const path = join(this.root, ...segments);
    let fd: number;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666);
    } catch {
      throw new CopyError(`the file "${showName(exact)}" could not be created (it may already exist).`);
    }
    this.made.push({ path, kind: 'file' });
    this.kinds.set(exact, 'file');
    this.counts.files++;
    return fd;
  }

  wrote(bytes: number): void { this.counts.bytes += bytes; }
  skipped(): void { this.counts.skipped++; }

  // Remove what this copy made, deepest first, one non-recursive call each,
  // retrying a few times for a file a scanner briefly holds. Returns what is left.
  async cleanup(): Promise<string[]> {
    const left: string[] = [];
    for (const item of this.made.reverse()) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (item.kind === 'file') unlinkSync(item.path);
          else rmdirSync(item.path);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (code === 'ENOENT') break;
          if (RETRY.has(code) && attempt < 3) { await sleep(100); continue; }
          left.push(item.kind === 'dir' && item.path === this.root ? this.req.target.asTyped : showName(item.path.slice(this.root.length + 1)));
          break;
        }
      }
    }
    this.made = [];
    return left;
  }
}

// ---- The tar reader ----------------------------------------------------------

// Reads one `docker cp` tar stream as it arrives. It throws a CopyError at the
// first thing it refuses; the caller then kills cp.
class Reader {
  entries = 0;
  bytes = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private state: 'header' | 'data' | 'pad' | 'done' = 'header';
  private remaining = 0;
  private pad = 0;
  // What the current entry's data does.
  private sink: 'file' | 'skip' | 'meta' = 'skip';
  private fd: number | null = null;
  private meta: { kind: string; chunks: Buffer[] } | null = null;
  // Set by x and L headers for the next entry.
  private next: { path?: string; size?: number } = {};

  private job: Job;
  private output: string;
  private maxBytes: number;
  private maxEntries: number;

  constructor(job: Job, output: string, maxBytes: number, maxEntries: number) {
    this.job = job;
    this.output = output;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new CopyError('the outputs are bigger than the size limit (maxOutputMegabytes in the machine configuration).');
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.state === 'done') { this.buffer = Buffer.alloc(0); return; }
      if (this.state === 'header') {
        if (this.buffer.length < BLOCK) return;
        const header = this.buffer.subarray(0, BLOCK);
        this.buffer = this.buffer.subarray(BLOCK);
        this.header(header);
      } else if (this.state === 'data') {
        if (this.remaining === 0) { this.endData(); continue; }
        if (this.buffer.length === 0) return;
        const take = Math.min(this.remaining, this.buffer.length);
        this.data(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.remaining -= take;
        if (this.remaining === 0) this.endData();
      } else {
        const take = Math.min(this.pad, this.buffer.length);
        this.buffer = this.buffer.subarray(take);
        this.pad -= take;
        if (this.pad > 0) return;
        this.state = 'header';
      }
    }
  }

  // The stream ended: it must have ended the way a tar does.
  finish(): void {
    if (this.state !== 'done') throw new CopyError('the stream from docker cp ended early.');
  }

  // Close anything left open after a stop.
  close(): void {
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* the cleanup list removes the file */ } this.fd = null; }
  }

  private fail(why: string): never { throw new CopyError(why); }

  private number(field: Buffer, what: string): number {
    if (((field[0] ?? 0) & 0x80) !== 0) {
      if (((field[0] ?? 0) & 0x40) !== 0) this.fail(`a ${what} in the stream is negative.`);
      let value = BigInt((field[0] ?? 0) & 0x3f);
      for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i] ?? 0);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) this.fail(`a ${what} in the stream is too large.`);
      return Number(value);
    }
    const text = field.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
    if (!/^[0-7]+$/.test(text)) this.fail(`a ${what} in the stream is not a number.`);
    return parseInt(text, 8);
  }

  private text(field: Buffer): string {
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
  }

  private header(block: Buffer): void {
    if (block.every((b) => b === 0)) { this.state = 'done'; return; }
    if (++this.entries > this.maxEntries) this.fail('the outputs hold more entries than the limit allows.');
    // The checksum: all bytes, with the checksum field read as spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (this.number(block.subarray(148, 156), 'checksum') !== sum) this.fail('a header in the stream has a bad checksum.');
    if (block.subarray(257, 262).toString('latin1') !== 'ustar') this.fail('a header in the stream is not in the ustar form.');
    const type = String.fromCharCode(block[156] ?? 0);
    let size = this.number(block.subarray(124, 136), 'size');
    const remainingCap = this.maxBytes - this.bytes;
    if (size > remainingCap) this.fail('the outputs are bigger than the size limit (maxOutputMegabytes in the machine configuration).');
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > MAX_META_BYTES) this.fail('a header record in the stream is too large.');
      this.meta = { kind: type, chunks: [] };
      this.begin('meta', size);
      return;
    }
    const prefix = this.text(block.subarray(345, 500));
    const own = this.text(block.subarray(0, 100));
    const name = this.next.path ?? (prefix ? `${prefix}/${own}` : own);
    if (this.next.size !== undefined) {
      if (this.next.size > remainingCap) this.fail('the outputs are bigger than the size limit (maxOutputMegabytes in the machine configuration).');
      size = this.next.size;
    }
    this.next = {};
    switch (type) {
      case '\0':
      case '0': {
        this.fd = this.job.file(name, this.output);
        this.begin(this.fd === null ? 'skip' : 'file', size);
        return;
      }
      case '5':
        this.job.folder(name, this.output);
        this.begin('skip', size);
        return;
      case '1': case '2': case '3': case '4': case '6':
        this.job.skipped();
        this.begin('skip', size);
        return;
      default:
        this.fail(`the stream holds an entry of a kind athanor does not copy (type ${showName(type)}).`);
    }
  }

  private begin(sink: 'file' | 'skip' | 'meta', size: number): void {
    this.sink = sink;
    this.remaining = size;
    this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
    this.state = 'data';
  }

  private data(part: Buffer): void {
    if (this.sink === 'meta') this.meta!.chunks.push(Buffer.from(part));
    else if (this.sink === 'file') {
      writeSync(this.fd!, part);
      this.job.wrote(part.length);
    }
  }

  private endData(): void {
    if (this.sink === 'file' && this.fd !== null) { closeSync(this.fd); this.fd = null; }
    if (this.sink === 'meta') this.endMeta();
    this.state = this.pad > 0 ? 'pad' : 'header';
  }

  private endMeta(): void {
    const { kind, chunks } = this.meta!;
    this.meta = null;
    const data = Buffer.concat(chunks);
    if (kind === 'L') this.next.path = this.text(data);
    else if (kind === 'x') this.pax(data);
  }

  // PAX records: "<length> <key>=<value>\n", the length counting the whole record.
  private pax(data: Buffer): void {
    let at = 0;
    while (at < data.length) {
      const space = data.indexOf(0x20, at);
      const digits = space === -1 ? '' : data.subarray(at, space).toString('latin1');
      if (!/^[1-9][0-9]{0,9}$/.test(digits)) this.fail('a PAX record in the stream is malformed.');
      const length = Number(digits);
      if (length <= space - at + 1 || at + length > data.length || data[at + length - 1] !== 0x0a) this.fail('a PAX record in the stream is malformed.');
      const body = data.subarray(space + 1, at + length - 1).toString('utf8');
      const eq = body.indexOf('=');
      if (eq === -1) this.fail('a PAX record in the stream is malformed.');
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (key === 'path') this.next.path = value;
      else if (key === 'size') {
        if (!/^[0-9]{1,15}$/.test(value)) this.fail('a PAX size in the stream is not a number.');
        this.next.size = Number(value);
      }
      at += length;
    }
  }
}
