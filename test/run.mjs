// One runner, named tiers: node test/run.mjs <fast|docker> [file filter]
// fast   — a fake Docker and real git in temporary repos.
// docker — real Docker with the Alpine fixture in test/fixture.
// Each run clears dist/ and builds it first (scripts/build.mjs), so run one at
// a time per worktree. A failed build ends the run as a failure.
// The last line is "result: <tier> pass" or "result: <tier> fail".
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tiers = { fast: join(here, 'fast'), docker: join(here, 'docker') };
const [tier, filter] = process.argv.slice(2);
if (!tiers[tier]) {
  console.error(`usage: node test/run.mjs <${Object.keys(tiers).join('|')}> [filter]`);
  process.exit(2);
}
const built = spawnSync(process.execPath, [join(here, '..', 'scripts', 'build.mjs')], { stdio: 'inherit', shell: false });
if (built.status !== 0) {
  console.log(`result: ${tier} fail`);
  process.exit(1);
}
const files = readdirSync(tiers[tier])
  .filter((f) => f.endsWith('.test.mjs') && (!filter || f.includes(filter)))
  .sort()
  .map((f) => join(tiers[tier], f));
if (files.length === 0) {
  console.error(`no ${tier} test file matches "${filter}"`);
  console.log(`result: ${tier} fail`);
  process.exit(2);
}
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', shell: false });
child.on('exit', (code) => {
  console.log(`result: ${tier} ${code === 0 ? 'pass' : 'fail'}`);
  process.exit(code ?? 1);
});
