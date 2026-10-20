// Snapshots and build contexts, made without writing the repo (ADR 0006, 0007).
// Every git call in a run uses a copy of the index and a per-run object folder
// whose alternates file names the repo's own object store.
import { copyFileSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { call } from './proc.mjs';
import { AthanorError } from './errors.mjs';

const TAG_FORMAT = 'athanor-image-v1';
const STALE_MS = 24 * 60 * 60 * 1000;
// Line endings pinned for every archive athanor makes (C32).
export const ARCHIVE_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

async function git(args, { cwd, env, what }) {
  const r = await call(['git', ...args], { cwd, env });
  if (r.code !== 0) {
    throw new AthanorError(`git could not ${what}: ${firstLine(r.stderr) || `exit ${r.code}`}.`);
  }
  return r.stdout;
}

const firstLine = (text) => String(text).trim().split('\n')[0]?.trim() ?? '';

// The top of the work tree, after checking there is a commit and no conflict.
export async function repoRoot(cwd) {
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
export async function makeScratch(home, root) {
  const runs = join(home, 'runs');
  mkdirSync(runs, { recursive: true });
  const dir = join(runs, `${process.pid}-${randomBytes(6).toString('hex')}`);
  const objects = join(dir, 'objects');
  mkdirSync(join(objects, 'info'), { recursive: true });
  const repoObjects = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, what: 'find the object store' })).trim();
  writeFileSync(join(objects, 'info', 'alternates'), resolve(repoObjects) + '\n');
  const realIndex = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: root, what: 'find the index' })).trim();
  // A git folder of athanor's own for every archive: its info/attributes,
  // which outranks the tree's .gitattributes, unsets export-ignore and
  // export-subst, so the archive holds exactly the tree. The tree's eol
  // attributes still apply.
  const archiveDir = join(dir, 'archive.git');
  await git(['init', '--bare', '-q', archiveDir], { cwd: dir, what: 'make a folder for archives' });
  mkdirSync(join(archiveDir, 'info'), { recursive: true });
  writeFileSync(join(archiveDir, 'info', 'attributes'), '* -export-ignore -export-subst\n');
  let copies = 0;
  return {
    dir,
    // An env with a fresh copy of the real index (or an empty index).
    env(fromRealIndex = true) {
      const index = join(dir, `index-${++copies}`);
      if (fromRealIndex && existsSync(realIndex)) copyFileSync(realIndex, index);
      return { ...process.env, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects };
    },
    objectsEnv: { ...process.env, GIT_OBJECT_DIRECTORY: objects },
    archiveEnv: { ...process.env, GIT_DIR: archiveDir, GIT_OBJECT_DIRECTORY: objects },
    remove() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

// Delete per-run folders a hard-killed run left behind.
export function clearStale(home) {
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

// The work as git sees it. Returns { id, untracked, untrackedLeftOut }.
export async function snapshot(root, scratch, { untracked }) {
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
  const stash = (await git(['stash', 'create'], { cwd: root, env, what: 'make a snapshot of the tracked changes' })).trim();
  const id = stash || (await git(['rev-parse', 'HEAD'], { cwd: root, what: 'read HEAD' })).trim();
  return { id, untracked: false, untrackedLeftOut: untrackedCount };
}

// The build context: tracked files under `context` at their working-tree
// state, plus each input at its repo-relative path under the context root.
// Returns { commit, tree, tag }.
export async function buildContext(root, scratch, { context, inputs, dockerfileInContext }) {
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
      const tracked = (await git(['ls-files', '-s', '--', input], { cwd: root, env: indexEnv, what: `check the inputs file "${input}"` })).trim();
      if (tracked === '') {
        throw new AthanorError(`The inputs file "${input}" is not tracked by git, so athanor will not send it to the build. Add it to git, or remove it from inputs.`);
      }
      if (tracked.includes('\n')) {
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
