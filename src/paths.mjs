// Configured paths must resolve, after symlinks, to a place inside the repo
// root. Both sides use the same realpath and are compared segment by segment,
// ignoring case on Windows.
import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep, relative } from 'node:path';
import { AthanorError } from './errors.mjs';

const segments = (p) => {
  const parts = p.split(sep).filter((s) => s !== '');
  return process.platform === 'win32' ? parts.map((s) => s.toLowerCase()) : parts;
};

function isInside(root, path) {
  const r = segments(root);
  const p = segments(path);
  return p.length >= r.length && r.every((s, i) => s === p[i]);
}

// Returns the path relative to the repo root, with forward slashes ('.' for the root).
export function insideRepo(root, value, key) {
  const realRoot = realpathSync.native(root);
  const target = resolve(realRoot, value);
  if (!isInside(realRoot, target)) {
    throw new AthanorError(`${key} "${value}" is outside the repo. Every configured path must stay inside the repo root.`);
  }
  if (!existsSync(target)) {
    throw new AthanorError(`${key} "${value}" does not exist in the repo. Fix the path in the "athanor" key.`);
  }
  const real = realpathSync.native(target);
  if (!isInside(realRoot, real)) {
    throw new AthanorError(`${key} "${value}" is outside the repo: it leads through a link to a place outside the repo root.`);
  }
  const rel = relative(realRoot, target).split(sep).join('/');
  return rel === '' ? '.' : rel;
}

// True when child (repo-relative, forward slashes) is the folder itself or under it.
export function isUnder(folder, child) {
  if (folder === '.') return true;
  return child === folder || child.startsWith(folder + '/');
}
