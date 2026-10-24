// One runner, named tiers: node test/run.mjs <fast|docker> [file filter] [--host-fallback=<reason>]
// fast   — a fake Docker and real git in temporary repos.
// docker — real Docker with the Alpine fixture in test/fixture.
// Each run clears dist/ and builds it first (scripts/build.mjs), so run one at
// a time per worktree. A failed build ends the run as a failure.
// --host-fallback=<reason> (fast only) names why this fast run is on the host
// and not in athanor (ADR 0024); the runner prints it and runs as usual.
// The last line is "result: <tier> pass" or "result: <tier> fail".
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tiers = { fast: join(here, 'fast'), docker: join(here, 'docker') };
const FLAG = '--host-fallback';
// The reason can reach a posted record, so it is plain words only, and a bad
// one is refused without being echoed.
const PLAIN_REASON = /^[A-Za-z0-9 .,:;'()-]{1,80}$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith(FLAG));
const [tier, filter, ...stray] = args.filter((a) => !a.startsWith(FLAG));
if (!tiers[tier]) fail(`usage: node test/run.mjs <${Object.keys(tiers).join('|')}> [filter] [${FLAG}=<reason>]`);
if (flags.length > 0) {
  const [flag] = flags;
  if (!flag.startsWith(`${FLAG}=`)) fail(`${FLAG} takes its reason after =, as ${FLAG}='<reason>'.`);
  const reason = flag.slice(FLAG.length + 1).trim();
  if (reason === '') fail(`${FLAG} needs a reason: say in plain words why this run is on the host.`);
  if (!PLAIN_REASON.test(reason) || reason.split(' ').some((w) => w.length > 24)) {
    fail(`${FLAG} takes a short reason in plain words: at most 80 letters, digits, spaces and basic punctuation, no word over 24. Leave out paths, tokens and pasted errors.`);
  }
  if (stray.length > 0) fail(`quote the ${FLAG} reason: it reached the runner as more than one argument.`);
  if (tier !== 'fast') fail(`${FLAG} is for the fast tier only; the docker tier runs on the host anyway.`);
  console.log(`host fallback: ${reason}`);
}
const built = spawnSync(process.execPath, [join(here, '..', 'scripts', 'build.mjs')], { stdio: 'inherit', shell: false });
if (built.status !== 0) {
  console.log(`result: ${tier} fail`);
  process.exit(1);
}
const files = readdirSync(tiers[tier])
  .filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)))
  .sort()
  .map((f) => join(tiers[tier], f));
if (files.length === 0) {
  console.error(`no ${tier} test file matches "${filter}"`);
  console.log(`result: ${tier} fail`);
  process.exit(2);
}
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', shell: false });
child.on('exit', (code) => {
  console.log(`result: ${tier} ${code === 0 ? 'pass' : 'fail'}`);
  process.exit(code ?? 1);
});
