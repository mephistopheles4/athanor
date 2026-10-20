// The source check (spec S5, ADR 0002): fails when a child process is started
// with a shell, or when exec, execSync, or execFile with a shell appears.
// It reads every JavaScript and TypeScript file tsc can compile (.js, .mjs,
// .cjs, .jsx, .ts, .mts, .cts, .tsx), never the compiled dist/.
// Each file is checked as a whole, so a match split across lines still counts.
//   node scripts/check-source.mjs [dir...]   (default: bin, src, scripts)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['bin', 'src', 'scripts'].map((d) => join(root, d));

const rules = [
  { pattern: /\bshell\s*:\s*(?!false\b)[^\s,}]/g, why: 'a child process started with a shell' },
  { pattern: /(\.\s*shell|\[\s*['"`]shell['"`]\s*\])\s*=(?!=)\s*(?!false\b)/g, why: 'a shell option set by assignment' },
  { pattern: /\bexec(Sync)?\s*\(/g, why: 'exec or execSync, which run a command string through a shell' },
  { pattern: /\bexec(Sync)?\b\s*[,}]/g, why: 'exec or execSync imported' },
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.[cm]?[jt]sx?$/i.test(name) && path !== self) yield path;
  }
}

let failures = 0;
for (const dir of dirs) {
  for (const file of files(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        failures++;
        const line = text.slice(0, match.index).split('\n').length;
        console.error(`${relative(process.cwd(), file)}:${line}: ${rule.why}: ${match[0].replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
}
if (failures) {
  console.error(`source check: ${failures} shell use${failures === 1 ? '' : 's'} found. Start child processes from an argument array with shell: false.`);
  process.exit(1);
}
console.log('source check: no shell use found.');
