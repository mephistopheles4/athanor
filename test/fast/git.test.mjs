// git owns the tar stream of a commit (spec on issue 8, candidate 3). The
// behaviour of the stream is checked through run() by C28, C32 and the file
// mode tests; this checks where its pinned settings live.
// One top-level test per acceptance claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolate } from '../helpers.mjs';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

test('T11 git keeps its archive settings private, and the core gets the tar stream of a commit from git', async (t) => {
  isolate(t);
  const git = await import('../../dist/git.js');
  assert.equal('ARCHIVE_CONFIG' in git, false, 'git does not export its archive settings');
  for (const [name, value] of Object.entries(git)) {
    if (typeof value === 'function') continue;
    assert.equal(String(JSON.stringify(value)).includes('core.eol'), false, `the export ${name} carries no archive setting`);
  }
  assert.equal(typeof git.tarStream, 'function');
  // Only the compiled git module starts git archive or names its settings.
  const startsArchive = /['"`](archive|core\.eol=lf|tar\.umask=0022)['"`]/;
  const compiled = readdirSync(dist).filter((f) => /\.m?js$/.test(f));
  assert.ok(compiled.includes('git.js'));
  for (const file of compiled) {
    const text = readFileSync(join(dist, file), 'utf8');
    assert.equal(startsArchive.test(text), file === 'git.js', `${file} ${file === 'git.js' ? 'starts' : 'does not start'} git archive`);
  }
});
