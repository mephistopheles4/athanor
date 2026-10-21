// Configured paths must resolve, after symlinks, to a place inside the repo
// root. Both sides use the same realpath and are compared segment by segment,
// ignoring case on Windows.
import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep, relative } from 'node:path';
import { AthanorError } from './errors.js';

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

// True when child (repo-relative, forward slashes) is the folder itself or under it.
export function isUnder(folder: string, child: string): boolean {
  if (folder === '.') return true;
  return child === folder || child.startsWith(folder + '/');
}
