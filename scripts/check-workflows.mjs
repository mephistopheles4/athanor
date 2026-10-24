// The workflow check (spec on issue 6, S6): every actions/checkout step sets
// persist-credentials: false in its with: block, every actions/setup-node step
// sets package-manager-cache: false there with no cache or registry-url input,
// no step uses a cache action, and no line names an npm token or reads a
// secret. Action names and input keys match in any case.
// It reads each .yml and .yaml file by lines and step blocks, with no YAML
// package, so it sees only the named actions written in block style, and it
// refuses a step, or a with: on those actions, written in flow style. It
// guards against mistakes, not against someone set on getting round it.
//   node scripts/check-workflows.mjs [folder]   (default: .github/workflows)
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const folder = process.argv[2] ?? join(root, '.github', 'workflows');

const indent = (line) => line.match(/^ */)[0].length;
const meaningful = (line) => line.trim() !== '' && !line.trim().startsWith('#');
// The value of a key on its line, without quotes or a trailing comment.
const value = (line, key) => line.match(new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*['"]?([^'"\\s#]*)`, 'i'))?.[1]?.toLowerCase();
// The text of a line that sits inside ${{ }} expressions, given whether an
// expression is still open from the line before; an expression may run on
// over several lines. Returns the inside text and whether one stays open.
function insideExpressions(line, open) {
  let inside = '';
  let rest = line;
  for (;;) {
    if (open) {
      const end = rest.indexOf('}}');
      if (end < 0) return { inside: inside + rest, open: true };
      inside += rest.slice(0, end) + ' ';
      rest = rest.slice(end + 2);
      open = false;
    }
    const start = rest.indexOf('${{');
    if (start < 0) return { inside, open: false };
    rest = rest.slice(start + 3);
    open = true;
  }
}
// The secrets context named anywhere inside an expression, in any case and
// any form (by name, by index, whole, or filtered with .*).
const namesSecrets = (inside) => /\bsecrets\b/i.test(inside);

// The lines of the step that holds line i: from its "- " line to the next
// line at or left of that dash.
function stepAround(lines, i) {
  let start = i;
  while (start >= 0 && !(/^\s*-\s/.test(lines[start]) && indent(lines[start]) < indent(lines[i]) + (/^\s*-\s/.test(lines[i]) ? 1 : 0))) start--;
  if (start < 0) start = i;
  const dash = indent(lines[start]);
  let end = start + 1;
  while (end < lines.length && !(meaningful(lines[end]) && indent(lines[end]) <= dash)) end++;
  return { start, end };
}

const problems = [];
let files = 0;
for (const name of readdirSync(folder).filter((n) => /\.ya?ml$/.test(n)).sort()) {
  files++;
  const path = join(folder, name);
  const shown = relative(process.cwd(), path);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const report = (i, why) => problems.push(`${shown}:${i + 1}: ${why}`);
  let open = false;

  lines.forEach((line, i) => {
    const expr = insideExpressions(line, open);
    open = expr.open;
    const persist = value(line, 'persist-credentials');
    if (persist !== undefined && persist !== 'false') report(i, 'persist-credentials must be false, so the job\'s token is not left in the clone.');
    if (/NODE_AUTH_TOKEN|_authToken/.test(line)) report(i, 'an npm token is named here. Remove it: releases publish through the trusted publisher, and no npm token is kept anywhere.');
    // The secrets context read in an expression, or passed on to a called workflow.
    if (namesSecrets(expr.inside) || /^\s*secrets\s*:/i.test(line)) report(i, 'a secret is read here. Remove it: no workflow in this repo holds a secret.');
    if (/^\s*-\s*\{/.test(line)) {
      report(i, 'this step is in flow style, which this check can\'t read. Write it in block style, one key per line.');
      return;
    }

    const uses = value(line, 'uses')?.toLowerCase();
    if (uses === undefined) return;
    if (/^actions\/cache(\/restore|\/save)?@/.test(uses)) {
      report(i, `${uses.split('@')[0]} must not be used: no workflow restores or saves an Actions cache.`);
      return;
    }
    const checkout = uses.startsWith('actions/checkout@');
    const setupNode = uses.startsWith('actions/setup-node@');
    if (!checkout && !setupNode) return;
    const action = checkout ? 'actions/checkout' : 'actions/setup-node';
    const { start, end } = stepAround(lines, i);
    const step = lines.slice(start, end).map((text, k) => ({ text, at: start + k }));
    const withLine = step.find((l) => /^\s*(?:-\s+)?with:/.test(l.text));
    if (withLine && /^\s*(?:-\s+)?with:\s*\{/.test(withLine.text)) {
      report(withLine.at, `${action}'s with: is in flow style, which this check can't read. Write it in block style, one input per line.`);
      return;
    }
    // The action's inputs: the lines indented under its with: line, and no other.
    const inputs = [];
    if (withLine) {
      const under = indent(withLine.text);
      for (const l of step.filter((s) => s.at > withLine.at)) {
        if (meaningful(l.text) && indent(l.text) <= under) break;
        inputs.push(l);
      }
    }
    if (checkout && !inputs.some((l) => value(l.text, 'persist-credentials') !== undefined)) {
      report(i, 'actions/checkout must set persist-credentials: false in its with: block, so the job\'s token is not left in the clone.');
    }
    if (setupNode) {
      if (!inputs.some((l) => value(l.text, 'package-manager-cache') === 'false')) {
        report(i, 'actions/setup-node must set package-manager-cache: false in its with: block, so no Actions cache is restored.');
      }
      for (const l of inputs) {
        if (value(l.text, 'cache') !== undefined) report(l.at, 'actions/setup-node must not set cache: no workflow restores an Actions cache.');
        if (value(l.text, 'registry-url') !== undefined) report(l.at, 'actions/setup-node must not set registry-url, which writes an .npmrc that reads an npm token.');
      }
    }
  });
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} workflow rule${problems.length === 1 ? '' : 's'} broken.`);
  process.exit(1);
}
console.log(`${files} workflow file${files === 1 ? '' : 's'} checked; every rule kept.`);
