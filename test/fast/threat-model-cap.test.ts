// The threat model is capped at 3,000 words so that a session reads all of it
// (claim X3, from the spec on issue 96). Words are whitespace-separated pieces
// of the whole file, the mermaid blocks included. Raising the cap is a spec
// change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const threatModel = join(root, 'docs', 'threat-model.md');
const CAP = 3000;

function countWords(file: string): number {
  return readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).length;
}

test('X3: docs/threat-model.md is at most 3,000 words', () => {
  const words = countWords(threatModel);
  assert.ok(words <= CAP, `docs/threat-model.md has ${words} words; the cap is ${CAP}. Cut it back; raising the cap needs a spec change.`);
});

test('X3: a threat model padded past the cap is reported over', (t) => {
  const padded = join(tempDir(t), 'threat-model.md');
  writeFileSync(padded, `${readFileSync(threatModel, 'utf8')}\n${'word '.repeat(CAP)}\n`);
  assert.ok(countWords(padded) > CAP, 'the counter must see a padded copy as over the cap');
});
