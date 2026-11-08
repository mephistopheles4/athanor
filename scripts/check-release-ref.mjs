// The release ref check (spec on issue 88, S1 and S3): the ref a release run
// starts on is a tag, the tag's name is "v" plus the version in package.json,
// and that version is X.Y.Z (dist-tag latest) or X.Y.Z-rc.N (dist-tag next).
// It takes its two inputs as arguments only: it reads no environment variable,
// starts no process and prints no environment. It prints the version and its
// dist-tag when all holds, and otherwise a plain message on stderr and a
// non-zero exit (1 for a refusal, 2 for a wrong call).
//   node scripts/check-release-ref.mjs --ref <ref> --package <path to package.json>
import { readFileSync } from 'node:fs';

// X, Y, Z and N are whole numbers without leading zeros, and N is at least 1.
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$/;
const FORMS = 'X.Y.Z (a stable release, dist-tag latest) or X.Y.Z-rc.N (a release candidate, dist-tag next), with whole numbers, no leading zeros and N at least 1';

function refuse(message) {
  console.error(message);
  process.exit(1);
}

// The inputs are shown quoted, so a control character or a newline can't
// shape the log.
const shown = (text) => JSON.stringify(typeof text === 'string' ? text.slice(0, 80) : text) ?? 'undefined';

const args = process.argv.slice(2);
const given = new Map();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if ((key !== '--ref' && key !== '--package') || given.has(key) || i + 1 >= args.length) {
    console.error('usage: node scripts/check-release-ref.mjs --ref <ref> --package <path to package.json>');
    process.exit(2);
  }
  given.set(key, args[i + 1]);
}
if (!given.has('--ref') || !given.has('--package')) {
  console.error('usage: node scripts/check-release-ref.mjs --ref <ref> --package <path to package.json>');
  process.exit(2);
}
const ref = given.get('--ref');
const packagePath = given.get('--package');

const PREFIX = 'refs/tags/v';
if (!ref.startsWith(PREFIX)) {
  refuse(`The release starts only on a tag named v plus the version, such as refs/tags/v1.2.3. This run is on ${shown(ref)}, which is not a tag of that form. Push the tag, or bump the version and tag anew.`);
}

let version;
try {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  version = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest.version : undefined;
} catch {
  refuse(`Could not read a version from ${shown(packagePath)}. The release needs a package.json that holds valid JSON with a version.`);
}
if (typeof version !== 'string' || !VERSION.test(version)) {
  refuse(`The version in package.json, ${shown(version)}, is not a release version. A release version is ${FORMS}. Fix the version in package.json, merge it, and tag anew.`);
}

const tag = ref.slice('refs/tags/'.length);
if (tag !== `v${version}`) {
  refuse(`The tag is ${shown(tag)}, but package.json's version is ${shown(version)}, so the tag must be ${shown(`v${version}`)}. The tag stays: bump the version in package.json, merge it, and tag the new version.`);
}
console.log(`version ${version}, dist-tag ${version.includes('-') ? 'next' : 'latest'}`);
