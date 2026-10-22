// The build (spec on issue 8, ADR 0017): clears dist/, then compiles src/ to
// it with tsc. The test runner calls it before every tier, and every pack runs
// it first as an explicit step, so no test or package uses a stale build. The compiler is started as Node itself with shell: false,
// because a .cmd file on Windows needs a shell (ADR 0002). The compiler and
// Node's types are taken from this repo's node_modules, whichever project root
// it builds.
//   node scripts/build.mjs [project root]   (default: this repo)
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? here);
const tsc = join(here, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tsc)) {
  console.error('build: the TypeScript compiler is not installed. Run npm ci --ignore-scripts at the repo root, then run again.');
  process.exit(1);
}
try {
  rmSync(join(root, 'dist'), { recursive: true, force: true, maxRetries: 5 });
} catch (err) {
  console.error(`build: could not clear dist/ (${err.code ?? err.message}). Close whatever holds a file in it, then run again.`);
  process.exit(1);
}
const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json'), '--typeRoots', join(here, 'node_modules', '@types')], { cwd: root, stdio: 'inherit', shell: false });
if (r.error) {
  console.error(`build: the compiler could not start (${r.error.code ?? r.error.message}). Run npm ci --ignore-scripts at the repo root, then run again.`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error('build: the compile failed. Fix the errors above, then run again.');
  process.exit(1);
}
