// Snapshots and build contexts, made without writing the repo (ADR 0006, 0007).
// Every git call in a run uses a copy of the index and a per-run object folder
// whose alternates file names the repo's own object store.
import { copyFileSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { call, start } from './proc.js';
import type { Started } from './proc.js';
import { AthanorError } from './errors.js';

type Env = NodeJS.ProcessEnv;

// A run's scratch folder and the git environments that use it.
export interface Scratch {
  dir: string;
  // An env with a fresh copy of the real index (or an empty index).
  env(fromRealIndex?: boolean): Env;
  objectsEnv: Env;
  archiveEnv: Env;
  // An empty file, for the archive's global config and attributes file.
  emptyFile: string;
  remove(): void;
}

export interface Snapshot {
  // A commit, or a tree when the snapshot holds untracked files.
  id: string;
  untracked: boolean;
  untrackedLeftOut: number;
}

export interface BuildContext {
  commit: string;
  tree: string;
  tag: string;
  hash: string;
}

// What a tar stream carries (ADR 0006).
export type TarOf = 'build context' | 'snapshot';

// v2: the archive step carries the tree as committed (ADR 0020), so an image
// built from a v1 stream, which host settings could change, is not reused.
const TAG_FORMAT = 'athanor-image-v2';
const STALE_MS = 24 * 60 * 60 * 1000;
// Line endings pinned for every archive athanor makes (C32).
const ARCHIVE_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
// File modes pinned for each archive: the build context's, so every machine
// builds the image from the same modes (ADR 0006); the snapshot's at git's
// default, so a host umask changes none (ADR 0020).
const BUILD_ARCHIVE_CONFIG = ['-c', 'tar.umask=0022'];
const SNAPSHOT_ARCHIVE_CONFIG = ['-c', 'tar.umask=0002'];

// The environment for the archive step (ADR 0020): the inherited one with
// every GIT_* variable removed (on Windows in any case, since Windows matches
// variable names without regard to case), no global or system config and no
// system attributes.
function cleanGitEnv(emptyFile: string): Env {
  const gitVariable = process.platform === 'win32' ? /^git_/i : /^GIT_/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !gitVariable.test(name)));
  return { ...env, GIT_CONFIG_GLOBAL: emptyFile, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' };
}

async function git(args: string[], { cwd, env, what }: { cwd: string; env?: Env; what: string }): Promise<string> {
  const r = await call(['git', ...args], { cwd, env });
  if (r.code !== 0) {
    throw new AthanorError(`git could not ${what}: ${firstLine(r.stderr) || `exit ${r.code}`}.`);
  }
  return r.stdout;
}

// The first line of git's output, with control characters escaped.
const firstLine = (text: unknown): string => (String(text).trim().split('\n')[0]?.trim() ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// The top of the work tree, after checking there is a commit and no conflict.
export async function repoRoot(cwd: string): Promise<string> {
  const top = await call(['git', 'rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) {
    throw new AthanorError('This folder is not inside a git repository. Run athanor from inside the repo you want to test.');
  }
  const root = resolve(top.stdout.trim());
  const head = await call(['git', 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: root });
  if (head.code !== 0) {
    throw new AthanorError('This repo has no commits yet, so there is nothing to snapshot. Make a first commit, then run again.');
  }
  const unmerged = await call(['git', 'ls-files', '-u'], { cwd: root });
  if (unmerged.stdout.trim() !== '') {
    throw new AthanorError('This repo has unmerged paths from a merge or rebase in progress. Resolve them, then run again.');
  }
  return root;
}

// A per-run scratch folder in the state folder: an object folder whose
// alternates name the repo's store, and room for index copies.
export async function makeScratch(home: string, root: string): Promise<Scratch> {
  const runs = join(home, 'runs');
  mkdirSync(runs, { recursive: true });
  const dir = join(runs, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const objects = join(dir, 'objects');
  mkdirSync(join(objects, 'info'), { recursive: true });
  const repoObjects = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, what: 'find the object store' })).trim();
  writeFileSync(join(objects, 'info', 'alternates'), resolve(repoObjects) + '\n');
  const realIndex = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: root, what: 'find the index' })).trim();
  // A git folder of athanor's own for every archive, made with no template in
  // the clean environment, so its config holds only what init writes. Its
  // info/attributes, which outranks the tree's .gitattributes, unsets
  // export-ignore, export-subst and filter, so the archive holds exactly the
  // tree and runs no content filter. The tree's text, eol, ident and
  // working-tree-encoding attributes still apply (ADR 0020).
  const emptyFile = join(dir, 'empty');
  writeFileSync(emptyFile, '');
  const clean = cleanGitEnv(emptyFile);
  const archiveDir = join(dir, 'archive.git');
  // The same object format as the repo (sha1 or sha256), or it cannot read its objects.
  const format = (await git(['rev-parse', '--show-object-format'], { cwd: root, what: 'read the object format' })).trim();
  await git(['init', '--bare', '-q', '--template=', `--object-format=${format}`, archiveDir], { cwd: dir, env: clean, what: 'make a folder for archives' });
  mkdirSync(join(archiveDir, 'info'), { recursive: true });
  writeFileSync(join(archiveDir, 'info', 'attributes'), '* -export-ignore -export-subst -filter\n');
  let copies = 0;
  return {
    dir,
    // An env with a fresh copy of the real index (or an empty index).
    env(fromRealIndex = true): Env {
      const index = join(dir, `index-${++copies}`);
      if (fromRealIndex && existsSync(realIndex)) copyFileSync(realIndex, index);
      return { ...process.env, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects, GIT_LITERAL_PATHSPECS: '1' };
    },
    objectsEnv: { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_LITERAL_PATHSPECS: '1' },
    archiveEnv: { ...clean, GIT_DIR: archiveDir, GIT_OBJECT_DIRECTORY: objects, GIT_LITERAL_PATHSPECS: '1' },
    emptyFile,
    remove(): void {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

// Delete per-run folders a hard-killed run left behind.
export function clearStale(home: string): void {
  const runs = join(home, 'runs');
  if (!existsSync(runs)) return;
  const now = Date.now();
  for (const name of readdirSync(runs)) {
    const path = join(runs, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run may be clearing it at the same time.
    }
  }
}

// The work as git sees it.
export async function snapshot(root: string, scratch: Scratch, { untracked }: { untracked: boolean }): Promise<Snapshot> {
  const countEnv = scratch.env(true);
  const others = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, env: countEnv, what: 'count untracked files' });
  const untrackedCount = others.split('\0').filter(Boolean).length;
  if (untracked) {
    const env = scratch.env(false);
    await git(['read-tree', 'HEAD'], { cwd: root, env, what: 'read HEAD into a temporary index' });
    await git(['add', '-A', '--', '.'], { cwd: root, env, what: 'add the work tree to a temporary index' });
    const tree = (await git(['write-tree'], { cwd: root, env, what: 'write the snapshot tree' })).trim();
    return { id: tree, untracked: true, untrackedLeftOut: 0 };
  }
  const env = scratch.env(true);
  // `stash create` refuses an index copy holding an intent-to-add entry (git add -N);
  // `add -u` turns each into a real entry at its working-tree content (issue 46, M8).
  await git(['add', '-u', '--', '.'], { cwd: root, env, what: 'read files added with git add -N' });
  const stash =(await git(['stash', 'create'], { cwd: root, env, what: 'make a snapshot of the tracked changes' })).trim();
  const id = stash || (await git(['rev-parse', 'HEAD'], { cwd: root, what: 'read HEAD' })).trim();
  return { id, untracked: false, untrackedLeftOut: untrackedCount };
}

// The build context: tracked files under `context` at their working-tree
// state, plus each input at its repo-relative path under the context root.
export async function buildContext(
  root: string,
  scratch: Scratch,
  { context, inputs, dockerfileInContext }: { context: string; inputs: string[]; dockerfileInContext: string },
): Promise<BuildContext> {
  const env = scratch.env(true);
  const contextPath = context === '.' ? '.' : context;
  await git(['add', '-u', '--', contextPath], { cwd: root, env, what: 'read the context folder' });
  const writeArgs = context === '.' ? ['write-tree'] : ['write-tree', `--prefix=${context}/`];
  const contextTree = await call(['git', ...writeArgs], { cwd: root, env });
  if (contextTree.code !== 0) {
    throw new AthanorError(`The context folder "${context}" has no tracked files. Add the files the image build needs to git.`);
  }
  let tree = contextTree.stdout.trim();
  if (inputs.length > 0) {
    const inputEnv = scratch.env(false);
    const indexEnv = scratch.env(true);
    await git(['read-tree', tree], { cwd: root, env: inputEnv, what: 'read the context tree' });
    for (const input of inputs) {
      // Only files git tracks reach the build: never an ignored or untracked one.
      // -z, so a name git would quote (such as one with an accent) comes back as written.
      const entries = (await git(['ls-files', '-s', '-z', '--', input], { cwd: root, env: indexEnv, what: `check the inputs file "${input}"` }))
        .split('\0').filter(Boolean);
      if (entries.length === 0) {
        throw new AthanorError(`The inputs file "${input}" is not tracked by git, so athanor will not send it to the build. Add it to git, or remove it from inputs.`);
      }
      // One entry for exactly this path; anything else means a folder.
      const tracked = entries[0];
      if (entries.length > 1 || tracked.slice(tracked.indexOf('\t') + 1) !== input) {
        throw new AthanorError(`The inputs entry "${input}" is a folder. List each file the build needs in inputs.`);
      }
      const taken = await git(['ls-files', '--', input], { cwd: root, env: inputEnv, what: 'check an input' });
      if (taken.trim() !== '') {
        throw new AthanorError(`The inputs file "${input}" would land on "${input}" in the build context, where a file under context already is. Rename one of them.`);
      }
      const blob = (await git(['hash-object', '-w', `--path=${input}`, '--', input], { cwd: root, env: inputEnv, what: `read the inputs file "${input}"` })).trim();
      // The mode git records; Windows reports no executable bits.
      const mode = tracked.split(' ')[0];
      await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${input}`], { cwd: root, env: inputEnv, what: `add the inputs file "${input}"` });
    }
    tree = (await git(['write-tree'], { cwd: root, env: inputEnv, what: 'write the build context tree' })).trim();
  }
  const listed = await git(['ls-tree', '--name-only', tree, '--', dockerfileInContext], { cwd: root, env: scratch.objectsEnv, what: 'find the Dockerfile' });
  if (listed.trim() === '') {
    throw new AthanorError(`The Dockerfile "${dockerfileInContext}" is not tracked by git under the context folder. Add it to git, then run again.`);
  }
  const fixed = {
    ...scratch.objectsEnv,
    GIT_AUTHOR_NAME: 'athanor',
    GIT_AUTHOR_EMAIL: 'athanor@localhost',
    GIT_AUTHOR_DATE: '@0 +0000',
    GIT_COMMITTER_NAME: 'athanor',
    GIT_COMMITTER_EMAIL: 'athanor@localhost',
    GIT_COMMITTER_DATE: '@0 +0000',
  };
  const commit = (await git(['commit-tree', tree, '-m', 'athanor build context'], { cwd: root, env: fixed, what: 'wrap the build context' })).trim();
  const hash = createHash('sha256').update(`${TAG_FORMAT}\n${tree}`).digest('hex');
  return { commit, tree, tag: `athanor:${hash.slice(0, 32)}`, hash: hash.slice(0, 32) };
}

// A tar stream of a commit or tree, for a Docker child's stdin. It comes from
// athanor's own git folder in the clean environment, so it holds exactly the
// tree, with the archive settings pinned here; the attributes file is pinned
// empty, as git reads its default one even with no global config. Returns the
// git child; its stdout is the stream.
export function tarStream(root: string, scratch: Scratch, id: string, of: TarOf): Started {
  const pinned = [
    ...ARCHIVE_CONFIG,
    '-c', `core.attributesFile=${scratch.emptyFile}`,
    ...(of === 'build context' ? BUILD_ARCHIVE_CONFIG : SNAPSHOT_ARCHIVE_CONFIG),
  ];
  return start(['git', ...pinned, 'archive', '--format=tar', id], { cwd: root, env: scratch.archiveEnv, capture: false });
}
