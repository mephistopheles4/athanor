#!/usr/bin/env node
// Source: the-pact 2b1eaaae2b605d1a22320161239d3fb57e4b6832
// Writes each long doc's table of contents from its headings (PACT-78).
//
//   node <this file>           write every covered doc whose table is missing or stale
//   node <this file> --check   write nothing; list each doc that is off, exit 1 if any
//
// A doc is covered when it is a tracked Markdown file of over maxUncoveredLines
// lines (100 by default), its table not counted, and outside the exclude list
// (EXCLUDED by default, below). Its table sits between the TOC_OPEN and
// TOC_CLOSE lines, just before its first H2, and links each H2 and H3 by
// GitHub's anchor. In the pact, gate/tests/toc.test.mjs fails while a table is
// missing or stale, and the word budgets count a doc without it (stripToc).
//
// The script is portable (PACT-84, spec 0004): another repo vendors this file
// unchanged, and its own toc.config.json, beside the file, sets the threshold
// and the exclusions. A copy carries a Source line at line 2, naming the pact
// commit it came from, and then refuses to run without a config. The defaults
// are the pact's own.
//
// Importing this module reads no file and starts no process. Run as a script,
// it finds the repo root with git, from the folder the script sits in, and
// lists the tracked files from there.
//
// Node 24, ESM, node: built-ins only.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOC_OPEN = '<!-- toc -->';
export const TOC_CLOSE = '<!-- /toc -->';
/** A doc is covered once it has more lines than this, its table not counted. */
export const MAX_UNCOVERED_LINES = 100;

/**
 * Paths left out, repo-relative with forward slashes: a prefix ends in '/'.
 * The logs and ADRs (the issue's own exclusions), test fixtures, which must
 * stay byte for byte, and what sessions load whole: the rules file with its
 * rendered cloud copy, AGENTS.md (CLAUDE.md imports it), the agents and the
 * commands. And README.md, written for people. Anthropic's guidance asks for a
 * table in reference files a model may read only in part (ADR 0168).
 */
export const EXCLUDED = Object.freeze(['docs/log/', 'docs/adr/', 'gate/tests/fixtures/', 'claude/CLAUDE.md', 'cloud-sessions/CLAUDE.cloud.md', 'claude/agents/', 'claude/commands/', 'AGENTS.md', 'README.md']);

/** What a config holds when a key is left out: this repo's own values. */
export const DEFAULTS = Object.freeze({ maxUncoveredLines: MAX_UNCOVERED_LINES, exclude: EXCLUDED });

/** The config file's name, kept in the folder that holds the script. */
export const CONFIG_FILE = 'toc.config.json';

/** The line a vendored copy carries at line 2: the pact commit it came from. */
export const SOURCE_LINE = /^\/\/ Source: the-pact [0-9a-f]{7,40}$/;

/** A config that can't be used: the message is the one line the script prints. */
export class ConfigError extends Error {}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The text's own line ending: CRLF when its first line ends in one. */
const eolOf = text => (/^[^\n]*\r\n/.test(text) ? '\r\n' : '\n');

/** The text's lines, without their line endings. */
const linesOf = text => text.split(/\r?\n/);

/** For each line, whether it sits in a fenced code block, its opening and closing fences included. */
function fenced(lines) {
  let fence = null;
  return lines.map(line => {
    const f = line.match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      return true;
    }
    if (f) fence = f[1];
    return Boolean(f);
  });
}

/** Where the table sits, its markers whole lines outside code fences: the open and close line indexes, or null when there is none. */
function tocSpan(lines) {
  const inFence = fenced(lines);
  const open = lines.findIndex((l, i) => l === TOC_OPEN && !inFence[i]);
  if (open < 0) return null;
  const close = lines.findIndex((l, i) => i > open && l === TOC_CLOSE && !inFence[i]);
  if (close < 0) throw new Error(`${TOC_OPEN} with no ${TOC_CLOSE}`);
  return { open, close };
}

/** The text with its table, and the one blank line after it, taken out. */
export function stripToc(text) {
  const eol = eolOf(text);
  const lines = linesOf(text);
  const span = tocSpan(lines);
  if (!span) return text;
  const after = lines[span.close + 1] === '' && span.close + 1 < lines.length - 1 ? 2 : 1;
  lines.splice(span.open, span.close - span.open + after);
  return lines.join(eol);
}

/** Emphasis marks dropped from inline Markdown outside code spans. Inline HTML is left as written: no heading here uses it. */
const plainProse = s => s.replace(/\*+/g, '').replace(/(^|[^\p{L}\p{N}])_+(?=\S)|(?<=\S)_+(?=[^\p{L}\p{N}]|$)/gu, '$1');

/** Inline Markdown reduced to the text GitHub renders: links to their text, then a code span keeps its text as written and the rest goes through plainProse. */
const plain = s =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`+)([^`]*?)\1/)
    .map((part, i) => (i % 3 === 0 ? plainProse(part) : i % 3 === 2 ? part : ''))
    .join('');

/** GitHub's anchor for heading text, before the repeat suffix. */
export const slug = text =>
  plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');

/** Each heading outside code fences and outside the table: level, text and anchor, repeats suffixed as GitHub does. */
export function headings(text) {
  const lines = linesOf(text);
  const span = tocSpan(lines);
  const inFence = fenced(lines);
  const seen = new Map();
  const out = [];
  lines.forEach((line, i) => {
    if (inFence[i] || (span && i >= span.open && i <= span.close)) return;
    const h = line.match(HEADING);
    if (!h) return;
    // As github-slugger counts: a taken anchor gets the next free -n, and the anchor given is taken too.
    const base = slug(h[2]);
    let anchor = base;
    while (seen.has(anchor)) {
      seen.set(base, seen.get(base) + 1);
      anchor = `${base}-${seen.get(base)}`;
    }
    seen.set(anchor, 0);
    out.push({ level: h[1].length, text: h[2], anchor });
  });
  return out;
}

/** The table's lines for this text, markers included, or null when it has no H2. */
export function tocBlock(text) {
  const hs = headings(text).filter(h => h.level === 2 || h.level === 3);
  if (!hs.some(h => h.level === 2)) return null;
  const items = hs.map(h => `${h.level === 3 ? '  ' : ''}- [${h.text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')}](#${h.anchor})`);
  return [TOC_OPEN, '', ...items, '', TOC_CLOSE];
}

/** The text with its table written: replaced in place, or put before the first H2 with a blank line after. */
export function withToc(text) {
  const block = tocBlock(text);
  if (!block) return stripToc(text);
  const eol = eolOf(text);
  const lines = linesOf(text);
  const span = tocSpan(lines);
  if (span) {
    lines.splice(span.open, span.close - span.open + 1, ...block);
    return lines.join(eol);
  }
  const inFence = fenced(lines);
  const at = lines.findIndex((line, i) => !inFence[i] && /^ {0,3}##[ \t]/.test(line));
  lines.splice(at, 0, ...block, '');
  return lines.join(eol);
}

/** Lines in the text with its table taken out, counted as an editor numbers them. */
const lineCount = text => {
  const t = stripToc(text);
  const n = linesOf(t).length;
  return /\r?\n$/.test(t) ? n - 1 : n;
};

/** Whether an exclude entry names the path: a folder prefix ends in '/', an entry that starts with two stars and a slash names a file in any folder, the root included, and any other entry is one file. */
const excludes = (entry, path) => (entry.endsWith('/') ? path.startsWith(entry) : entry.startsWith('**/') ? path === entry.slice(3) || path.endsWith(entry.slice(2)) : path === entry);

/** Whether a tracked file gets a table: Markdown, over the config's maxUncoveredLines lines without its table, outside its exclude list. */
export function covered(path, text, config = DEFAULTS) {
  if (!path.endsWith('.md')) return false;
  if (config.exclude.some(e => excludes(e, path))) return false;
  return lineCount(text) > config.maxUncoveredLines;
}

/** The config from its file's text, its left-out keys at their defaults. Throws a ConfigError whose message is the line to print. */
export function parseConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE}: not valid JSON: ${e.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${CONFIG_FILE}: not an object`);
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULTS, key)) throw new ConfigError(`${CONFIG_FILE}: ${key}: unknown key`);
  const { maxUncoveredLines = DEFAULTS.maxUncoveredLines, exclude = DEFAULTS.exclude } = raw;
  if (!Number.isInteger(maxUncoveredLines) || maxUncoveredLines < 1) throw new ConfigError(`${CONFIG_FILE}: maxUncoveredLines: must be an integer of at least 1`);
  if (!Array.isArray(exclude) || exclude.some(e => typeof e !== 'string')) throw new ConfigError(`${CONFIG_FILE}: exclude: must be an array of strings`);
  return { maxUncoveredLines, exclude };
}

/** What is off in one file, or null: a covered file whose table is missing or stale, an uncovered one that holds a table, or an unclosed marker. */
function problem(path, text, config) {
  let has;
  try {
    has = tocSpan(linesOf(text)) !== null;
  } catch (e) {
    return `${path}: ${e.message}`;
  }
  if (!covered(path, text, config)) return has ? `${path}: holds a table of contents but is not covered` : null;
  if (withToc(text) === text) return null;
  return has ? `${path}: table of contents is stale` : `${path}: no table of contents`;
}

/** What is off across the files given, one line each. Each file is { path, text }. */
export function problems(files, config = DEFAULTS) {
  return files.map(({ path, text }) => problem(path, text, config)).filter(Boolean);
}

/** The tracked Markdown files under `repo`, read: { path, text }. */
export function trackedDocs(repo) {
  return execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: repo, encoding: 'utf8', env: gitEnv() })
    .split('\0')
    .filter(Boolean)
    .map(path => ({ path, text: readFileSync(join(repo, path), 'utf8') }));
}

/** The environment for a git call that finds its repo from the folder it runs in: the variables git exports to a hook, which name another repo or index, are left out. */
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX)$/i.test(k)));

/** The repo root git reports from `folder`, or null when git is missing or the folder is in no work tree. */
function repoRoot(folder) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: folder, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** The config beside the script: its file's, or the defaults when there is none and this is no vendored copy. Throws a ConfigError. */
function loadConfig(folder, script) {
  let text;
  try {
    text = readFileSync(join(folder, CONFIG_FILE), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new ConfigError(`${CONFIG_FILE}: not readable: ${e.code ?? e.message}`);
    if (SOURCE_LINE.test(linesOf(readFileSync(script, 'utf8'))[1] ?? '')) throw new ConfigError(`${CONFIG_FILE}: missing in a vendored copy`);
    return DEFAULTS;
  }
  return parseConfig(text);
}

function main(argv) {
  const script = fileURLToPath(import.meta.url);
  const folder = dirname(script);
  const repo = repoRoot(folder);
  if (!repo) {
    console.log('toc.mjs: not in a git work tree');
    return 2;
  }
  let config;
  try {
    config = loadConfig(folder, script);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.log(e.message);
    return 2;
  }
  const check = argv.includes('--check');
  const files = trackedDocs(repo);
  if (check) {
    const off = problems(files, config);
    for (const l of off) console.log(l);
    return off.length ? 1 : 0;
  }
  let code = 0;
  for (const { path, text } of files) {
    let next;
    try {
      next = covered(path, text, config) ? withToc(text) : stripToc(text);
    } catch (e) {
      console.log(`${path}: ${e.message}`);
      code = 1;
      continue;
    }
    if (next !== text) {
      writeFileSync(join(repo, path), next);
      console.log(`wrote ${path}`);
    }
  }
  return code;
}


/** True when this file is the script node was started with, compared by real path (macOS reaches /var through /private/var). */
const startedAsScript = () => {
  try {
    const self = fileURLToPath(import.meta.url);
    if (!process.argv[1]) return false;
    if (resolve(process.argv[1]) === self) return true;
    // Only a script of this file's name is looked up on disk, so an importer touches no file.
    return basename(process.argv[1]) === basename(self) && realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return false;
  }
};
if (startedAsScript()) process.exit(main(process.argv.slice(2)));
