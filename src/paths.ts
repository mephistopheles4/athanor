// Configured paths must resolve, after symlinks, to a place inside the repo
// root, or inside the configuration folder (ADR 0039). Both sides use the same
// realpath and are compared segment by segment, ignoring case on Windows.
import { realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, relative, isAbsolute } from 'node:path';
import { AthanorError } from './errors.js';
import { showName } from './copy-out.js';

const segments = (p: string): string[] => {
  const parts = p.split(sep).filter((s) => s !== '');
  return process.platform === 'win32' ? parts.map((s) => s.toLowerCase()) : parts;
};

function isInside(root: string, path: string): boolean {
  const r = segments(root);
  const p = segments(path);
  return p.length >= r.length && r.every((s, i) => s === p[i]);
}

// Returns the path relative to the repo root, with forward slashes ('.' for the root).
// `where` names the place the path was set, such as 'athanor.json' or 'the "athanor" key in package.json'.
export function insideRepo(root: string, value: string, key: string, where: string): string {
  const realRoot = realpathSync.native(root);
  const target = resolve(realRoot, value);
  if (!isInside(realRoot, target)) {
    throw new AthanorError(`${key} "${value}" in ${where} is outside the repo. Every configured path must stay inside the repo root.`);
  }
  if (!existsSync(target)) {
    throw new AthanorError(`${key} "${value}" does not exist in the repo. Fix the path in ${where}.`);
  }
  const real = realpathSync.native(target);
  if (!isInside(realRoot, real)) {
    throw new AthanorError(`${key} "${value}" in ${where} is outside the repo: it leads through a link to a place outside the repo root.`);
  }
  // From the real path, so Windows gives the folder's own spelling, as git has it.
  const rel = relative(realRoot, real).split(sep).join('/');
  return rel === '' ? '.' : rel;
}

// A name git keeps its own files under, which a build context never takes.
export const isGitEntry = (name: string): boolean => name.toLowerCase() === '.git';

// A path given relative to the configuration folder, as a path relative to it
// with forward slashes ('.' for the folder), checked to be there, to stay inside
// after links and junctions, to be of its kind, and to lie in no .git folder.
export function insideConfigFolder(folder: string, value: string, key: string, where: string, kind: 'file' | 'folder'): string {
  const named = `${key} "${showName(value)}"`;
  if (isAbsolute(value)) {
    throw new AthanorError(`${named} in ${where} must be a path relative to the configuration folder, not an absolute one. Fix it there.`);
  }
  const noGit = (path: string): void => {
    if (path.split(/[\\/]/).some(isGitEntry)) {
      throw new AthanorError(`${named} in ${where} goes through a .git entry, which athanor never sends to a build. Move the file out of .git.`);
    }
  };
  noGit(value);
  let realFolder: string;
  try {
    realFolder = realpathSync.native(folder);
  } catch {
    throw new AthanorError(`The configuration folder of ${where} could not be read. Make it a folder you can read, then run again.`);
  }
  const target = resolve(realFolder, value);
  if (!isInside(realFolder, target)) {
    throw new AthanorError(`${named} in ${where} is outside the configuration folder. Every { "config": ... } path must stay inside the folder that holds the configuration file.`);
  }
  if (!existsSync(target)) {
    throw new AthanorError(`${named} does not exist in the configuration folder. Fix the path in ${where}.`);
  }
  const real = realpathSync.native(target);
  if (!isInside(realFolder, real)) {
    throw new AthanorError(`${named} in ${where} is outside the configuration folder: it leads through a link to a place outside it.`);
  }
  const rel = relative(realFolder, real).split(sep).join('/');
  noGit(rel);
  const stat = statSync(real);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new AthanorError(`${named} in ${where} is not a ${kind === 'file' ? 'regular file' : 'folder'}. Name a ${kind === 'file' ? 'file' : 'folder'} there.`);
  }
  return rel === '' ? '.' : rel;
}

// True when child (repo-relative, forward slashes) is the folder itself or under it.
export function isUnder(folder: string, child: string): boolean {
  if (folder === '.') return true;
  return child === folder || child.startsWith(folder + '/');
}
