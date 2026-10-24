// Shared test helpers. Every test gets its own state folder and name prefix,
// so no test touches a live machine's slots, configuration or image marks.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { run } from '#dist/index.js';
import type { RunResult } from '#dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const bin = join(here, '..', 'bin', 'athanor.mjs');
export const fakeDocker = join(here, 'fake-docker.ts');

export function tempDir(t?: TestContext, label = 'athanor-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), label)));
  t?.after?.(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

export function uniquePrefix(): string {
  return `athanor-t${randomBytes(4).toString('hex')}`;
}

// Run the CLI as a child process. Returns { code, stdout, stderr }.
export interface CliResult { code: number | null; stdout: string; stderr: string }

export function cli(args: string[], { cwd, env = {}, input }: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A repo with one commit holding the given files, a package.json (unless
// packageJson is false), and the athanor key in it when athanor is set.
export interface RepoOptions {
  files?: Record<string, string>;
  athanor?: unknown;
  commit?: boolean;
  packageExtra?: Record<string, unknown>;
  objectFormat?: string;
  // false writes no package.json, for a repo whose configuration is in athanor.json.
  packageJson?: boolean;
}

export function makeRepo(t: TestContext, { files = {}, athanor, commit = true, packageExtra = {}, objectFormat, packageJson = true }: RepoOptions = {}): string {
  const dir = tempDir(t, 'athanor-repo-');
  git(dir, ['init', '-q', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@localhost']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  const pkg: Record<string, unknown> = { name: 'fixture', private: true, ...packageExtra };
  if (athanor !== undefined) pkg.athanor = athanor;
  const all = {
    ...(packageJson ? { 'package.json': JSON.stringify(pkg, null, 2) + '\n' } : {}),
    'test/Dockerfile': 'FROM alpine:3.20\n',
    ...files,
  };
  writeFiles(dir, all);
  if (commit) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'initial']);
  }
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

const ISOLATED_ENV = ['ATHANOR_HOME', 'ATHANOR_MAX_RUNS', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'BUILDX_BUILDER', 'ATHANOR_ALLOW_REMOTE_DOCKER'];

// Give a test its own state folder and clear every environment value athanor
// reads; restore them afterwards. Returns the state folder.
export function isolate(t: TestContext, env: Record<string, string> = {}): string {
  const saved = Object.fromEntries(ISOLATED_ENV.map((k) => [k, process.env[k]]));
  for (const k of ISOLATED_ENV) delete process.env[k];
  const home = tempDir(t, 'athanor-home-');
  Object.assign(process.env, { ATHANOR_HOME: home, ...env });
  t.after(() => {
    for (const k of ISOLATED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  return home;
}

// A fake Docker with its own scenario folder. calls() returns the recorded
// argument arrays (and tar listings), oldest first.
export interface Call { args: string[]; at?: number; finished?: boolean; tar?: TarEntry[]; env?: { context?: string; builder?: string; tlsVerify?: string; hasPath: boolean } }
export interface TarEntry { name: string; type: string; mode: string; content: string | undefined }

export type Fake = ReturnType<typeof fake>;

export function fake(t: TestContext, scenario: Record<string, unknown> = {}) {
  const dir = tempDir(t, 'athanor-fake-');
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  return {
    dir,
    // Node prints an ExperimentalWarning when it runs a .ts file, and tests check the fake's stderr, so the flag turns it off.
    docker: [process.execPath, '--disable-warning=ExperimentalWarning', fakeDocker, dir],
    setScenario: (s: Record<string, unknown>) => writeFileSync(join(dir, 'scenario.json'), JSON.stringify(s)),
    addContainer: (name: string, labels: Record<string, string>, image = 'athanor:old') => {
      mkdirSync(join(dir, 'containers'), { recursive: true });
      writeFileSync(join(dir, 'containers', encodeURIComponent(name) + '.json'), JSON.stringify({ name, labels, image, running: true }));
    },
    addImage: (tag: string) => {
      mkdirSync(join(dir, 'images'), { recursive: true });
      writeFileSync(join(dir, 'images', encodeURIComponent(tag) + '.json'), JSON.stringify({ tag }));
    },
    calls: (): Call[] => {
      try {
        return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

export const callsOf = (calls: Call[], verb: string): Call[] => calls.filter((c) => c.args[0] === verb);

// A stream stand-in that keeps what is written to it.
export function collector() {
  const parts: Buffer[] = [];
  return { write: (c: string | Uint8Array): boolean => { parts.push(Buffer.from(c)); return true; }, text: () => Buffer.concat(parts).toString('utf8') };
}

// A file's bytes from a recorded tar listing, or undefined.
export function tarFile(entries: TarEntry[], name: string): string | undefined {
  const entry = entries.find((e) => e.name === name && e.type === '0');
  return entry ? Buffer.from(entry.content!, 'base64').toString('utf8') : undefined;
}

export const tarNames = (entries: TarEntry[]): string[] => entries.filter((e) => e.type === '0').map((e) => e.name).sort();

// Everything a run must leave as it was: stash list, index entries, status,
// refs, the index file's bytes and time, and the object count.
export function gitState(repo: string) {
  const indexPath = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const index = existsSync(indexPath) ? statSync(indexPath) : null;
  return {
    stash: git(repo, ['stash', 'list']),
    stage: git(repo, ['ls-files', '--stage']),
    status: git(repo, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']),
    refs: git(repo, ['show-ref']),
    indexBytes: index ? readFileSync(indexPath).toString('base64') : null,
    indexTime: index ? index.mtimeMs : null,
    objects: git(repo, ['count-objects', '-v']),
  };
}

export const baseConfig = {
  dockerfile: 'test/Dockerfile',
  commands: { test: ['node', 'test/run.mjs'] },
};

// Start `count` hanging runs together; resolve with their results and the
// progress lines each printed.
export async function together(t: TestContext, count: number, { hangMs = 1500, prefix = uniquePrefix() }: { hangMs?: number; prefix?: string } = {}): Promise<{ results: RunResult[]; progress: string[][]; docker: ReturnType<typeof fake> }> {
  const repo = makeRepo(t, { athanor: baseConfig });
  const docker = fake(t, { run: { hangMs } });
  const progress: string[][] = Array.from({ length: count }, () => []);
  const results = await Promise.all(progress.map((lines) =>
    run({ cwd: repo, docker: docker.docker, prefix, onProgress: (l) => lines.push(l) })));
  return { results, progress, docker };
}

export const waited = (lines: string[]): boolean => lines.some((l) => /waiting for a free run slot/.test(l));
