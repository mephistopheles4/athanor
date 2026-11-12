// The word budget of the agent-facing docs (spec on issue 97, claim Y5). A doc
// that grows past its budget fails here, and a doc in the set with no budget
// fails too, so a new one has to be given a number on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Words, as `wc -w` counts them: runs of non-space characters.
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length;
}

const BUDGETS: Record<string, number> = {
  'AGENTS.md': 1650,
  'GLOSSARY.md': 1200,
  'docs/releasing.md': 6520,
  'docs/agents/issue-tracker.md': 640,
  'docs/agents/triage-labels.md': 410,
};

// One problem per doc that is over its budget, and one per doc with none.
function problems(docs: Record<string, string>, budgets: Record<string, number>): string[] {
  const found: string[] = [];
  for (const [name, text] of Object.entries(docs)) {
    const budget = budgets[name];
    if (budget === undefined) {
      found.push(`${name} has no word budget: add one to BUDGETS in test/fast/docs.test.ts.`);
      continue;
    }
    const words = countWords(text);
    if (words > budget) found.push(`${name} is ${words} words, over its budget of ${budget}: cut history and duplicates, and never cut or shorten an instruction in force to fit. If the doc needs the words for one, raise its number in BUDGETS and say why in the pull request.`);
  }
  return found;
}

function agentDocs(): Record<string, string> {
  const names = ['AGENTS.md', 'GLOSSARY.md', 'docs/releasing.md'];
  for (const f of readdirSync(join(root, 'docs', 'agents')).sort()) if (f.endsWith('.md')) names.push(`docs/agents/${f}`);
  return Object.fromEntries(names.map((n) => [n, readFileSync(join(root, n), 'utf8')]));
}

test('Y5 every agent-facing doc is within its word budget', () => {
  assert.deepEqual(problems(agentDocs(), BUDGETS), []);
});

test('Y5 a doc over its budget, and a doc with no budget, are each refused', () => {
  // Eleven words, split by a space, line breaks, a tab and a run of spaces, and ended by a line break as a file is.
  const text = 'one two\nthree\tfour  five\nsix\n\nseven eight\tnine\r\nten  eleven\n';
  const over = problems({ 'a.md': text }, { 'a.md': 10 });
  assert.equal(over.length, 1);
  assert.match(over[0], /a\.md is 11 words, over its budget of 10/);
  assert.deepEqual(problems({ 'a.md': text }, { 'a.md': 11 }), [], 'a doc at its budget passes');
  const none = problems({ 'b.md': 'word' }, { 'a.md': 10 });
  assert.equal(none.length, 1);
  assert.match(none[0], /b\.md has no word budget/);
});

test('Y5 every doc in the budget table exists in the set the test reads', () => {
  assert.deepEqual(Object.keys(BUDGETS).filter((n) => !(n in agentDocs())), []);
});
