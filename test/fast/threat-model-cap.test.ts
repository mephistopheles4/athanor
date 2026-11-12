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

// The gate: null when the file is within the cap, else the message that fails the build.
function overCap(file: string): string | null {
  const words = readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).length;
  return words <= 3000 ? null : `${file} has ${words} words; the cap is 3000. Cut it back; raising the cap needs a spec change.`;
}

const filler = (count: number): string => Array.from({ length: count }, () => 'w').join(' ');

test('X3: docs/threat-model.md is at most 3,000 words', () => {
  assert.equal(overCap(threatModel), null);
});

test('X3: a copy padded past the cap is reported over, and 3,000 words exactly is not', (t) => {
  const dir = tempDir(t);
  const real = readFileSync(threatModel, 'utf8');
  const have = real.split(/\s+/).filter(Boolean).length;

  const atCap = join(dir, 'at-cap.md');
  writeFileSync(atCap, `${real}\n${filler(3000 - have)}\n`);
  assert.equal(overCap(atCap), null, 'exactly 3,000 words is within the cap');

  const padded = join(dir, 'padded.md');
  writeFileSync(padded, `${real}\n${filler(3001 - have)}\n`);
  assert.match(overCap(padded) ?? '', /has 3001 words/, 'one word past the cap is reported over');

  const inMermaid = join(dir, 'in-mermaid.md');
  writeFileSync(inMermaid, `\`\`\`mermaid\n${filler(3001)}\n\`\`\`\n`);
  assert.match(overCap(inMermaid) ?? '', /has 3003 words/, 'words inside a mermaid block count');
});
