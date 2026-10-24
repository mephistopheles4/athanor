// The pack check (spec on issue 6, S6), shared by CI's pack step and the
// release workflow: a packed tarball may hold only bin/*.mjs, the compiled
// JavaScript and declarations directly under dist/, the README, the LICENSE
// and package.json, and must hold dist/index.d.ts. A directory entry fails
// like any other entry not on the list; npm's tarballs hold none.
//   node scripts/check-pack.mjs <tarball>
// It lists the entries with tar, run in the tarball's folder with its bare
// name, because GNU tar on Windows reads "C:" in a path as a remote host.
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

const allowed = /^package\/(bin\/[^/]+\.mjs|dist\/[^/]+\.(m?js|d\.m?ts)|README\.md|LICENSE|package\.json)$/;
const required = 'package/dist/index.d.ts';

const [arg] = process.argv.slice(2);
if (!arg) {
  console.error('usage: node scripts/check-pack.mjs <tarball>');
  process.exit(2);
}
const tarball = resolve(arg);
const listed = spawnSync('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball), encoding: 'utf8', shell: false });
if (listed.error || listed.status !== 0) {
  console.error(`Could not list ${arg} with tar: ${listed.error?.message ?? listed.stderr.trim()}. Check that the file is a gzipped tarball and that tar is on the PATH.`);
  process.exit(1);
}
const entries = listed.stdout.split(/\r?\n/).filter((line) => line !== '');
const unexpected = entries.filter((entry) => !allowed.test(entry));
let failed = false;
if (unexpected.length > 0) {
  console.error(`The package holds files that must not ship: ${unexpected.join(', ')}. Only bin/*.mjs, the .js, .mjs, .d.ts and .d.mts files directly under dist/, README.md, LICENSE and package.json may ship. Check the files list in package.json and what the build wrote to dist/.`);
  failed = true;
}
if (!entries.includes(required)) {
  console.error(`The package has no ${required}. Build dist/ with node scripts/build.mjs before packing.`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`${arg}: ${entries.length} entries, all allowed.`);
