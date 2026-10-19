// The source check (spec S5, ADR 0002): fails when a child process is started
// with a shell, or when exec, execSync, or execFile with a shell appears.
//   node scripts/check-source.mjs [dir...]   (default: bin, src, scripts)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);
const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['bin', 'src', 'scripts'].map((d) => join(root, d));

const rules = [
  { pattern: /\bshell\s*:\s*(?!false\b)[^\s,}]/, why: 'a child process started with a shell' },
  { pattern: /\bexec(Sync)?\s*\(/, why: 'exec or execSync, which run a command string through a shell' },
  { pattern: /\bexec(Sync)?\b\s*[,}]/, why: 'exec or execSync imported' },
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(mjs|cjs|js)$/.test(name) && path !== self) yield path;
  }
}

let failures = 0;
for (const dir of dirs) {
  for (const file of files(dir)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          failures++;
          console.error(`${relative(process.cwd(), file)}:${i + 1}: ${rule.why}: ${line.trim()}`);
        }
      }
    });
  }
}
if (failures) {
  console.error(`source check: ${failures} shell use${failures === 1 ? '' : 's'} found. Start child processes from an argument array with shell: false.`);
  process.exit(1);
}
console.log('source check: no shell use found.');
