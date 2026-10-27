// Snapshots and build contexts, made without writing the repo (ADR 0006, 0007).
// Every git call in a run uses a copy of the index and a per-run object folder
// whose alternates file names the repo's own object store.
import { copyFileSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { call, start } from './proc.js';
import type { Started } from './proc.js';
import { AthanorError } from './errors.js';
import { showName } from './copy-out.js';

type Env = NodeJS.ProcessEnv;

// A run's scratch folder and the git environments that use it.
export interface Scratch {
  dir: string;
  // An env with a fresh copy of the real index (or an empty index).
  env(fromRealIndex?: boolean): Env;
  objectsEnv: Env;
  archiveEnv: Env;
  // The environment for every git call that resolves or carries a base (ADR
  // 0032): the archive step's clean one, with replace refs and grafts off, no
  // lazy fetch, and the run's object folder, so the snapshot's own objects are
  // found. It sets no GIT_DIR: git finds the repo's refs from its root.
  baseEnv: Env;
  // An empty file, for the archive's global config and attributes file.
  emptyFile: string;
  // The repo's object format, sha1 or sha256.
  format: string;
  remove(): void;
}

export interface Snapshot {
  // A commit, or a tree when the snapshot holds untracked files.
  id: string;
  untracked: boolean;
  untrackedLeftOut: number;
  // How the id was made: a `stash create` commit (whose first parent is HEAD),
  // HEAD itself on a clean tree, or a tree with --untracked. A base reads HEAD's
  // id from it (ADR 0032).
  from: 'stash' | 'head' | 'tree';
}

// A base that can be carried (ADR 0032): its full ref name, its tip, the HEAD
// commit the snapshot sits on, every merge base, and the one git names.
export interface ResolvedBase {
  ref: string;
  tip: string;
  head: string;
  mergeBases: string[];
  mergeBase: string;
}

// The folder the four files that carry a base ride in, at the top of the
// snapshot's tar: pack, shallow, refs and tree, the names the base boot
// script reads.
const BASE_FOLDER = '.athanor-base';
// The branch the snapshot sits on inside the container, when a base is carried.
const BASE_BRANCH = 'refs/heads/athanor';

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

const firstLine = (text: unknown): string => String(text).trim().split('\n')[0]?.trim() ?? '';

// A git call fed `input` on stdin, which the run's abort signal ends.
async function gitFed(args: string[], { cwd, env, input, what, signal }: { cwd: string; env: Env; input: string; what: string; signal?: AbortSignal }): Promise<string> {
  const started = start(['git', ...args], { cwd, env, stdin: 'pipe' });
  const kill = () => { started.child.kill(); };
  if (signal?.aborted) kill();
  signal?.addEventListener('abort', kill, { once: true });
  // git may stop reading early, on an error; its exit code says what happened.
  started.child.stdin?.on('error', () => {});
  started.child.stdin?.end(input);
  const r = await started.done;
  signal?.removeEventListener('abort', kill);
  if (r.code !== 0) {
    throw new AthanorError(`git could not ${what}: ${firstLine(r.stderr) || `exit ${r.code}`}. Check that the disk has room and that git fsck finds the repo sound, then run again.`);
  }
  return r.stdout;
}

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
    baseEnv: {
      ...clean, GIT_OBJECT_DIRECTORY: objects, GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: emptyFile, GIT_NO_LAZY_FETCH: '1',
    },
    emptyFile,
    format,
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
    return { id: tree, untracked: true, untrackedLeftOut: 0, from: 'tree' };
  }
  const env = scratch.env(true);
  // `stash create` refuses an index copy holding an intent-to-add entry (git add -N);
  // `add -u` turns each into a real entry at its working-tree content (issue 46, M8).
  await git(['add', '-u', '--', '.'], { cwd: root, env, what: 'read files added with git add -N' });
  const stash = (await git(['stash', 'create'], { cwd: root, env, what: 'make a snapshot of the tracked changes' })).trim();
  const id = stash || (await git(['rev-parse', 'HEAD'], { cwd: root, what: 'read HEAD' })).trim();
  return { id, untracked: false, untrackedLeftOut: untrackedCount, from: stash ? 'stash' : 'head' };
}

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CARRIED_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'];

// The base, resolved and checked on the host before a slot is taken (ADR
// 0032). `label` names the base as a message shows it, with where it was set.
// Every refusal is a plain message that says what to do; git's exit code is
// never the test of an answer, only its output.
export async function resolveBase(
  root: string,
  scratch: Scratch,
  snap: Snapshot,
  { name, fromKey, label }: { name: string; fromKey: boolean; label: string },
): Promise<ResolvedBase> {
  const env = scratch.baseEnv;
  // git resolves HEAD and its kin (FETCH_HEAD, ORIG_HEAD, @) to the branch they
  // point at, so they are refused by name before git sees them.
  if (name === '@' || /^[A-Z_]+$/.test(name)) {
    const inFull = name === '@' || name.endsWith('HEAD') ? '' : `, or a branch or tag in full, such as refs/heads/${name}`;
    throw new AthanorError(`${label} names a pseudo ref such as HEAD, not a branch, a remote-tracking branch or a tag. Name one of those, such as origin/main${inFull}.`);
  }
  const resolved = await call(['git', '-c', 'core.warnAmbiguousRefs=true', 'rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options', name], { cwd: root, env });
  const lines = resolved.stdout.split('\n').filter(Boolean);
  const ref = lines.length === 1 ? (lines[0] as string) : '';
  if (ref === '') {
    if (/ambiguous/.test(resolved.stderr)) {
      throw new AthanorError(`${label} is ambiguous: more than one ref has that name. Name it in full, such as refs/remotes/origin/main.`);
    }
    throw new AthanorError(`${label} names nothing athanor can carry. If it is a remote-tracking branch, fetch it, or name a ref that exists.`);
  }
  // git follows a symbolic ref, such as a remote's HEAD, to a name the check
  // above never saw; that name must hold no control or format character either.
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]|\p{Cf}/u.test(ref)) {
    throw new AthanorError(`${label} resolves to ${showName(ref)}, a name with a control or invisible formatting character. Name the branch you mean directly.`);
  }
  if (!CARRIED_PREFIXES.some((p) => ref.startsWith(p))) {
    throw new AthanorError(`${label} resolves to ${ref}, which is not a branch, a remote-tracking branch or a tag. Name one of those, such as origin/main.`);
  }
  if (fromKey && ref.startsWith('refs/heads/')) {
    throw new AthanorError(`${label} names the local branch ${ref}, but a command's base may name only a remote-tracking branch or a tag. Name one, such as origin/main, or pass a local branch with --base.`);
  }
  if (ref === BASE_BRANCH || ref.startsWith(`${BASE_BRANCH}/`)) {
    throw new AthanorError(`${label} resolves to ${ref}, which is reserved for the snapshot's own branch in the container. Name another ref.`);
  }
  const tip = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd: root, env, what: `read the commit ${ref} points at` })).trim();

  const shallow = (await git(['rev-parse', '--is-shallow-repository'], { cwd: root, env, what: 'check whether the repo is shallow' })).trim();
  if (shallow !== 'false') {
    throw new AthanorError(`This repo is a shallow clone, so the history a base needs may be cut short. Run git fetch --unshallow, then run again.`);
  }
  // A partial clone lacks some of the history's files, and git would fetch them
  // from its remote; on git below 2.45 this refusal is the only guard.
  const partial = await call(['git', 'config', '--get', 'extensions.partialClone'], { cwd: root, env });
  const promisors = await call(['git', 'config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'], { cwd: root, env });
  if (promisors.code !== 0 && promisors.code !== 1) {
    throw new AthanorError(`git could not read this repo's remote settings: ${firstLine(promisors.stderr) || `exit ${promisors.code}`}. Fix the repo's git config, then run again.`);
  }
  const promised = promisors.stdout.split('\n').some((l) => / true$/.test(l));
  if (partial.stdout.trim() !== '' || promised) {
    throw new AthanorError('This repo is a partial clone, so some of the history a base needs may be missing, and git would fetch it. Fetch the missing objects (git fetch --refetch), or use a full clone, then run again.');
  }

  const head = snap.from === 'stash'
    ? (await git(['rev-parse', '--verify', `${snap.id}^1`], { cwd: root, env, what: 'read the commit the snapshot sits on' })).trim()
    : snap.from === 'head'
      ? snap.id
      : (await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, env, what: 'read HEAD' })).trim();

  const all = await call(['git', 'merge-base', '--all', tip, head], { cwd: root, env });
  const mergeBases = all.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (mergeBases.length === 0 || !mergeBases.every((id) => HEX.test(id))) {
    if (all.code === 1 || (all.code === 0 && mergeBases.length === 0)) {
      throw new AthanorError(`${label} has no merge base with this branch: their histories are unrelated. Name a base this branch was made from.`);
    }
    throw new AthanorError(`git could not find the merge base of ${label} and HEAD: ${firstLine(all.stderr) || `exit ${all.code}`}. Check that git fsck finds the repo sound, then run again.`);
  }
  const mergeBase = (await git(['merge-base', tip, head], { cwd: root, env, what: 'find the merge base' })).trim();

  const held = await git(['ls-tree', '--name-only', snap.id, '--', BASE_FOLDER], { cwd: root, env, what: `check the snapshot for ${BASE_FOLDER}` });
  if (held.trim() !== '') {
    throw new AthanorError(`The snapshot holds a path named ${BASE_FOLDER}, which athanor keeps for carrying the base. Rename it, then run again.`);
  }
  return { ref, tip, head, mergeBases, mergeBase };
}

// The four files that carry a resolved base (ADR 0032), written into the run's
// scratch folder once the slot is held: a pack of every commit from the merge
// bases onward on both sides, with every tree and file each reaches (the ones
// a merge base shares with later commits included, which is why the objects
// are listed commit by commit and never with a negative revision), plus the
// snapshot's own tree; the carried commits whose parents were not carried; the
// two refs to set; and the snapshot's tree id. Returns their paths, in the
// order the stream adds them. `folder` is for tests (ADR 0003).
export async function packBase(
  root: string,
  scratch: Scratch,
  snap: Snapshot,
  base: ResolvedBase,
  { folder, signal }: { folder?: string; signal?: AbortSignal } = {},
): Promise<string[]> {
  const env = scratch.baseEnv;
  const dir = folder ?? join(scratch.dir, 'base');
  if (folder === undefined) onDisk(() => mkdirSync(dir));
  const later = (await git(['rev-list', base.tip, base.head, '--not', ...base.mergeBases], { cwd: root, env, what: 'list the commits from the merge base onward' }))
    .split('\n').filter(Boolean);
  const carried = [...new Set([...later, ...base.mergeBases])];
  const kept = new Set(carried);
  const withParents = await gitFed(['rev-list', '--no-walk=unsorted', '--parents', '--stdin'], { cwd: root, env, input: carried.join('\n') + '\n', what: 'read the carried commits\' parents', signal });
  const shallow = withParents.split('\n').filter(Boolean).map((l) => l.split(' '))
    .filter(([, ...parents]) => parents.some((p) => !kept.has(p))).map(([id]) => id as string);
  const tree = (await git(['rev-parse', '--verify', `${snap.id}^{tree}`], { cwd: root, env, what: 'read the snapshot\'s tree' })).trim();
  const objects = await gitFed(['rev-list', '--objects', '--no-object-names', '--no-walk=unsorted', '--stdin'], { cwd: root, env, input: [...carried, tree].join('\n') + '\n', what: 'list the objects of the base\'s history', signal });
  // One pack, whatever size limit the repo's config sets.
  const hashes = (await gitFed(['-c', 'pack.packSizeLimit=0', 'pack-objects', '-q', join(dir, 'base')], { cwd: root, env, input: objects, what: 'build the pack of the base\'s history', signal }))
    .split('\n').filter(Boolean);
  if (hashes.length !== 1 || !HEX.test(hashes[0] as string)) {
    throw new AthanorError('git did not build one pack of the base\'s history, as athanor asked. Check the repo\'s pack settings, then run again.');
  }
  const files = { pack: join(dir, 'pack'), shallow: join(dir, 'shallow'), refs: join(dir, 'refs'), tree: join(dir, 'tree') };
  onDisk(() => {
    renameSync(join(dir, `base-${hashes[0]}.pack`), files.pack);
    for (const name of readdirSync(dir)) if (name.startsWith('base-')) rmSync(join(dir, name), { force: true });
    writeFileSync(files.shallow, shallow.map((id) => `${id}\n`).join(''));
    writeFileSync(files.refs, `update ${base.ref} ${base.tip}\nupdate ${BASE_BRANCH} ${base.head}\n`);
    writeFileSync(files.tree, `${tree}\n`);
  });
  return [files.pack, files.shallow, files.refs, files.tree];
}

// A file step of the base's pack, whose failure (a full disk, say) is a plain
// message naming the error's code, never a path, which holds the account name.
function onDisk(step: () => void): void {
  try {
    step();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'an unknown error';
    throw new AthanorError(`athanor could not write the base's pack in its state folder (${code}). If the disk is full, free some space; then run again.`);
  }
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
// empty, as git reads its default one even with no global config. A carried
// base's four files ride after the tree, in their own folder (ADR 0032).
// Returns the git child; its stdout is the stream.
export function tarStream(root: string, scratch: Scratch, id: string, of: TarOf, added: string[] = []): Started {
  const pinned = [
    ...ARCHIVE_CONFIG,
    '-c', `core.attributesFile=${scratch.emptyFile}`,
    ...(of === 'build context' ? BUILD_ARCHIVE_CONFIG : SNAPSHOT_ARCHIVE_CONFIG),
  ];
  const carry = added.length > 0 ? [`--prefix=${BASE_FOLDER}/`, ...added.map((f) => `--add-file=${f}`), '--prefix='] : [];
  return start(['git', ...pinned, 'archive', '--format=tar', ...carry, id], { cwd: root, env: scratch.archiveEnv, capture: false });
}
