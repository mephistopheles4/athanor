// Copy-out (issue 46, spec M10 to M15 and M17): outputs declared by a command
// come out of the stopped container into a new --output folder, and every name
// and byte the container chose is checked. The fake Docker serves a tar per
// output; the tars are built in this file. Each test is named by the claim it backs.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '#dist/index.js';
import type { RunOptions } from '#dist/index.js';
import { parseArgs } from '#dist/cli.js';
import type { Call } from '../helpers.ts';
import { makeRepo, isolate, fake, uniquePrefix, callsOf, collector, gitState, tempDir, withCommands } from '../helpers.ts';
import { buildTar } from '../tar.ts';
import type { TarSpec } from '../tar.ts';

const mutation = (outputs: unknown) => ({ test: ['true'], mutation: { argv: ['npx', 'stryker', 'run'], outputs } });
const served = (tar: Buffer, extra: Record<string, unknown> = {}) => ({ tar: tar.toString('base64'), ...extra });
const idOfSlot = (prefix: string): string => createHash('sha256').update(`${prefix}-slot-1`).digest('hex');

interface Scene {
  repo: string;
  parent: string;
  dir: string;
  prefix: string;
  home: string;
  docker: ReturnType<typeof fake>;
}

// A repo with a command that declares outputs, a fresh parent for --output, and a fake Docker.
function scene(t: TestContext, { outputs = ['out'], cp = {}, plan = {}, machine }: { outputs?: unknown; cp?: Record<string, unknown>; plan?: Record<string, unknown>; machine?: Record<string, unknown> } = {}): Scene {
  const home = isolate(t);
  if (machine) writeFileSync(join(home, 'config.json'), JSON.stringify(machine));
  const repo = makeRepo(t, { athanor: withCommands(mutation(outputs)) });
  const parent = tempDir(t, 'athanor-parent-');
  return { repo, parent, dir: join(parent, 'report-1'), prefix: uniquePrefix(), home, docker: fake(t, { run: plan, cp }) };
}

async function copy(s: Scene, extra: RunOptions = {}) {
  const lines: string[] = [];
  const result = await run({ cwd: s.repo, docker: s.docker.docker, prefix: s.prefix, name: 'mutation', output: s.dir, onProgress: (l) => lines.push(l), ...extra });
  return { result, lines, calls: s.docker.calls() };
}

// Every file and folder under a folder, by relative path, with file content.
function tree(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    out[path.slice(root.length + 1).replaceAll('\\', '/')] = e.isFile() ? readFileSync(path).toString('latin1') : null;
  }
  return out;
}

const hasDockerCalls = (calls: Call[]): boolean => calls.length > 0;

test('M10 a bad outputs entry exits 125 before any Docker call', async (t) => {
  const rows: { name: string; outputs: unknown }[] = [
    { name: 'not an array', outputs: 'reports' },
    { name: 'empty string', outputs: [''] },
    { name: 'absolute', outputs: ['/abs'] },
    { name: 'drive form', outputs: ['C:x'] },
    { name: 'backslash', outputs: ['a\\b'] },
    { name: 'parent part', outputs: ['../x'] },
    { name: 'dot part', outputs: ['a/./b'] },
    { name: 'empty part', outputs: ['a//b'] },
    { name: '.git', outputs: ['.git'] },
    { name: '.GIT', outputs: ['.GIT'] },
    { name: 'inside .git', outputs: ['x/.git/y'] },
    { name: 'colon', outputs: ['a:b/x'] },
    { name: 'device name', outputs: ['CON/x'] },
    { name: 'trailing dot', outputs: ['x./y'] },
    { name: 'control character', outputs: ['a\u0001b'] },
    { name: 'right-to-left override', outputs: ['a‮b'] },
    { name: 'two equal', outputs: ['a', 'a'] },
    { name: 'one under another', outputs: ['a', 'a/b'] },
    { name: 'one around another', outputs: ['a/b', 'a'] },
    { name: 'differ only in case', outputs: ['A', 'a'] },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const s = scene(t, { outputs: row.outputs });
      const { result, calls } = await copy(s);
      assert.equal(result.outcome, 'error', JSON.stringify(result));
      assert.equal(result.exitCode, 125);
      assert.match(result.message!, /commands\.mutation\.outputs/);
      assert.equal(hasDockerCalls(calls), false, 'no Docker call');
    });
  }
});

test('M11 a bad --output exits 125 before any Docker call and creates nothing', async (t) => {
  assert.throws(() => parseArgs(['run', 'mutation', '--output']), /--output needs a folder/);
  assert.equal(parseArgs(['run', 'mutation', '--output', 'x']).options.output, 'x');

  const rows: { name: string; says: RegExp; make?: (s: Scene) => RunOptions; machine?: Record<string, unknown> }[] = [
    { name: 'a command with no outputs', says: /no outputs/, make: () => ({ name: 'test' }) },
    { name: 'the -- form', says: /no outputs/, make: () => ({ name: undefined, command: ['echo', 'hi'] }) },
    { name: 'an existing file', says: /already exists/, make: (s) => { writeFileSync(s.dir, 'x'); return {}; } },
    { name: 'an existing folder', says: /already exists/, make: (s) => { mkdirSync(s.dir); return {}; } },
    { name: 'a missing parent', says: /does not exist/, make: (s) => ({ output: join(s.parent, 'nope', 'x') }) },
    { name: 'a new folder named .git', says: /\.git/, make: (s) => ({ output: join(s.parent, '.git') }) },
    { name: 'a new folder named .GIT', says: /\.git/i, make: (s) => ({ output: join(s.parent, '.GIT') }) },
    ...(process.platform === 'win32' ? [] : [{ name: 'a parent others can change', says: /group or other write bit.*chmod go-w/s, make: (s: Scene) => { chmodSync(s.parent, 0o777); return {}; } }]),
    { name: 'a parent inside .git', says: /inside a \.git folder/, make: (s) => { mkdirSync(join(s.parent, '.GIT')); return { output: join(s.parent, '.GIT', 'x') }; } },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const s = scene(t);
      const extra = row.make?.(s) ?? {};
      const before = readdirSync(s.parent).sort();
      const { result, calls } = await copy(s, extra);
      assert.equal(result.outcome, 'error', JSON.stringify(result));
      assert.equal(result.exitCode, 125);
      assert.match(result.message!, row.says);
      assert.equal(hasDockerCalls(calls), false, 'no Docker call');
      assert.deepEqual(readdirSync(s.parent).sort(), before, 'nothing was created');
    });
  }

  await t.test('a dangling link', async (t) => {
    const s = scene(t);
    try {
      symlinkSync(join(s.parent, 'nowhere'), s.dir);
    } catch {
      t.skip('this machine does not let the test make a link');
      return;
    }
    const { result, calls } = await copy(s);
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /already exists/);
    assert.equal(hasDockerCalls(calls), false);
  });

  await t.test('maxOutputMegabytes is a machine key only, and a bad value exits 125', async (t) => {
    const s = scene(t);
    writeFileSync(join(s.repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, athanor: withCommands(mutation(['out']), { maxOutputMegabytes: 5 }) }));
    const unknown = await copy(s);
    assert.match(unknown.result.message!, /unknown key "maxOutputMegabytes"/);
    const bad = scene(t, { machine: { maxOutputMegabytes: 0 } });
    const { result, calls } = await copy(bad);
    assert.equal(result.exitCode, 125, JSON.stringify(result));
    assert.match(result.message!, /maxOutputMegabytes must be a positive whole number/);
    assert.equal(hasDockerCalls(calls), false);
  });
});

test('M12 a copy lands the files with their bytes, by the container ID, between the exit read and the removal', async (t) => {
  const longPax = `out/sub/${'p'.repeat(120)}.txt`;
  const longGnu = `out/sub/${'g'.repeat(110)}.txt`;
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);
  const out = buildTar([
    { name: 'out/', type: '5' },
    { name: 'out/a.txt', content: 'alpha\n' },
    { name: 'out/sub/', type: '5' },
    { name: 'out/sub/deep.txt', content: 'deep' },
    { name: longPax, pax: { path: longPax }, content: 'pax' },
    { name: longGnu, gnuLong: true, content: 'gnu' },
    { name: 'file.txt', prefix: 'out/sub/prefixdir', content: 'prefix' },
    { name: 'out/bin.dat', content: binary },
    { name: 'out/nofolder/x.txt', content: 'x' },
    { name: 'out/later/f.txt', content: 'f' },
    { name: 'out/later/', type: '5' },
  ]);
  const reports = buildTar([{ name: 'mutation/report.json', content: '{"a":1}' }]);
  const s = scene(t, { outputs: ['out', 'reports/mutation', 'absent'], cp: { out: served(out), 'reports/mutation': served(reports) } });
  const { result, lines, calls } = await copy(s);
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  const files = tree(s.dir);
  assert.equal(files['out/a.txt'], 'alpha\n');
  assert.equal(files['out/sub/deep.txt'], 'deep');
  assert.equal(files[longPax], 'pax');
  assert.equal(files[longGnu], 'gnu');
  assert.equal(files['out/sub/prefixdir/file.txt'], 'prefix');
  assert.deepEqual(Buffer.from(files['out/bin.dat']!, 'latin1'), binary, 'bytes that are not UTF-8 arrive as they were');
  assert.equal(files['out/nofolder/x.txt'], 'x');
  assert.equal(files['out/later/f.txt'], 'f');
  assert.equal(files['reports/mutation/report.json'], '{"a":1}');
  if (process.platform !== 'win32') assert.equal(statSync(s.dir).mode & 0o777, 0o700);
  const bytes = 6 + 4 + 3 + 3 + 6 + binary.length + 1 + 1 + 7;
  assert.deepEqual(result.outputs, { dir: s.dir, files: 9, bytes, skipped: 0, missing: ['absent'] });
  assert.equal(lines.filter((l) => /copied 9 files/.test(l) && l.includes(s.dir)).length, 1, lines.join('\n'));

  // The calls: each cp names the container by the ID, at the work folder, between the exit read and the rm.
  const id = idOfSlot(s.prefix);
  const at = (pick: (c: Call) => boolean) => calls.map((c, i) => (pick(c) ? i : -1)).filter((i) => i >= 0);
  const inspect = at((c) => c.args[0] === 'inspect' && !c.finished)[0]!;
  const cps = at((c) => c.args[0] === 'cp' && !c.finished);
  const removal = at((c) => c.args[0] === 'rm' && c.args.at(-1) === id).at(-1)!;
  assert.deepEqual(cps.map((i) => calls[i]!.args), [`out`, `reports/mutation`, `absent`].map((o) => ['cp', `${id}:/root/work/${o}`, '-']));
  assert.ok(cps.every((i) => i > inspect && i < removal), 'every cp is after the exit read and before the rm');
  const context = callsOf(calls, 'run')[0]!.env!.context;
  assert.ok(context !== undefined);
  assert.ok(cps.every((i) => calls[i]!.env!.context === context), 'every cp has the run\'s pinned Docker context');
  assert.equal(callsOf(calls, 'rm').some((c) => c.args.at(-1) === `${s.prefix}-slot-1`), false, 'on the copy path the container is removed by ID only');
  assert.deepEqual(readdirSync(join(s.docker.dir, 'containers')), [], 'the container is gone');
});

test('M12 a relative --output resolves against the run\'s cwd and no message holds the resolved parent', async (t) => {
  const out = buildTar([{ name: 'out/a.txt', content: 'a' }]);
  const s = scene(t, { cp: { out: served(out) } });
  const { result, lines } = await copy(s, { output: 'rel-report' });
  assert.equal(result.outcome, 'pass', JSON.stringify(result));
  assert.equal(result.outputs!.dir, 'rel-report');
  assert.equal(readFileSync(join(s.repo, 'rel-report', 'out', 'a.txt'), 'utf8'), 'a');
  assert.ok(lines.every((l) => !l.includes(s.repo)), lines.join('\n'));
});

test('M12 after a failing test the files land and exitCode is the test\'s own', async (t) => {
  const s = scene(t, { cp: { out: served(buildTar([{ name: 'out/a.txt', content: 'a' }])) }, plan: { exitCode: 3 } });
  const { result } = await copy(s);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.exitCode, 3);
  assert.equal(result.outputs!.files, 1);
  assert.equal(readFileSync(join(s.dir, 'out', 'a.txt'), 'utf8'), 'a');
});

const MEGABYTE = 1024 * 1024;

test('M13 a hostile tar ends with exit 125, and everything this copy made is gone', async (t) => {
  const one = (name: string, extra: Partial<TarSpec> = {}): Buffer => buildTar([{ name, ...extra }]);
  // Only the header of an x record that claims more data than a header may hold.
  const bigHeader = buildTar([{ name: 'PaxHeader/x', type: 'x', declaredSize: MEGABYTE + 1 }], { end: false }).subarray(0, 512);
  const rows: { name: string; tar: Buffer; says: RegExp; late?: boolean; machine?: Record<string, unknown>; extra?: RunOptions }[] = [
    // Each of these starts with the output's own name, so only the segment rules can refuse it.
    { name: 'parent part', tar: one('out/../x'), says: /out\/\.\.\/x/ },
    { name: 'backslash', tar: one('out/a\\b'), says: /out\/a\\b/ },
    { name: 'a part that climbs out', tar: one('out/a/../../x'), says: /out\/a\/\.\.\/\.\.\/x/ },
    { name: 'empty part', tar: one('out//x'), says: /out\/\/x/ },
    { name: 'a newline in the name', tar: one('out/a\nb'), says: /out\/a\\u\{a\}b/ },
    { name: 'a first part that is not the output', tar: one('other/x'), says: /other\/x.*not inside the output "out"/ },
    { name: '.git folder', tar: one('out/.git/config'), says: /out\/\.git\/config/ },
    { name: '.GIT folder deeper', tar: one('out/sub/.GIT/HEAD'), says: /\.GIT/ },
    { name: '.git as a regular file', tar: one('out/.git'), says: /out\/\.git/ },
    // git treats a folder holding HEAD with objects or refs as a bare repository, in whatever order the files come.
    { name: 'a bare repository layout, HEAD first', tar: buildTar([{ name: 'out/HEAD', content: 'ref: refs/heads/main\n' }, { name: 'out/objects/x' }]), says: /bare git repository/ },
    { name: 'a bare repository layout, HEAD last', tar: buildTar([{ name: 'out/refs/x' }, { name: 'out/HEAD' }]), says: /bare git repository/ },
    // git also finds a repository's objects and refs through a commondir file, in another folder.
    { name: 'a bare repository layout through a commondir file', tar: buildTar([{ name: 'out/a/HEAD' }, { name: 'out/a/commondir' }, { name: 'out/b/objects/x' }]), says: /bare git repository/ },
    { name: 'CONIN$', tar: one('out/CONIN$'), says: /out\/CONIN\$/ },
    { name: 'CONOUT$ with an extension', tar: one('out/conout$.txt'), says: /conout\$\.txt/ },
    { name: 'a line separator', tar: one('out/a\u2028b'), says: /out\/a\\u\{2028\}b/ },
    { name: 'a bare repository layout in a nested folder', tar: buildTar([{ name: 'out/sub/objects/', type: '5' }, { name: 'out/sub/HEAD' }]), says: /bare git repository/ },
    { name: 'a dotless i', tar: one('out/.gıt/config'), says: /\.gıt/ },
    { name: 'CON.txt', tar: one('out/CON.txt'), says: /CON\.txt/ },
    { name: 'nul', tar: one('out/nul'), says: /out\/nul/ },
    { name: 'COM with a superscript', tar: one('out/COM¹.txt'), says: /COM¹/ },
    { name: 'a device name with spaces before its extension', tar: one('out/nul  .txt'), says: /nul {2}\.txt/ },
    { name: 'a colon', tar: one('out/a:b'), says: /a:b/ },
    { name: 'a trailing dot', tar: one('out/x.'), says: /out\/x\./ },
    { name: 'a trailing space', tar: one('out/x '), says: /out\/x /s },
    { name: 'a right-to-left override', tar: one('out/a‮b'), says: /out\/a\\u\{202e\}b/ },
    // firstLine would strip "me@" after a space, so the name must be shown in full.
    { name: 'an at sign and a prefix before a refused name', tar: one('out/x me@host:y'), says: /out\/x me@host:y/ },
    { name: 'names that differ only in case', tar: buildTar([{ name: 'out/a' }, { name: 'out/A' }]), says: /differs only in case/ },
    { name: 'a PAX path holding ..', tar: one('out/x', { pax: { path: 'out/../../x' } }), says: /out\/\.\.\/\.\.\/x/ },
    { name: 'a PAX record with the wrong length', tar: one('out/x', { pax: ['99 path=out/y\n'] }), says: /PAX record/ },
    { name: 'a size that is not a number', tar: one('out/x', { sizeField: 'zzzzzzzzzzz\0' }), says: /size.*not a number/ },
    { name: 'a PAX size that is not a number', tar: one('out/x', { pax: { size: 'zz' } }), says: /size.*not a number/ },
    { name: 'a PAX size over the size limit', tar: one('out/x', { pax: { size: String(5 * MEGABYTE) } }), says: /size limit/, machine: { maxOutputMegabytes: 1 } },
    { name: 'a header that declares more than the size limit, before any of it arrives', tar: buildTar([{ name: 'out/big', declaredSize: 2 * MEGABYTE }], { end: false }).subarray(0, 512), says: /size limit/, machine: { maxOutputMegabytes: 1 } },
    { name: 'an x header over 1 MiB', tar: bigHeader, says: /too large/ },
    { name: 'a bad checksum', tar: one('out/x', { badChecksum: true }), says: /bad checksum/ },
    { name: 'an unknown header type', tar: one('out/x', { type: 'S' }), says: /kind athanor does not copy/ },
    { name: 'a truncated stream', tar: buildTar([{ name: 'out/x', content: 'abcdef' }], { end: false }).subarray(0, 512 + 3), says: /ended early/, late: true },
    { name: 'a file over the size limit', tar: one('out/big', { content: Buffer.alloc(MEGABYTE + MEGABYTE / 2, 1) }), says: /size limit/, machine: { maxOutputMegabytes: 1 } },
    { name: 'files that together pass the size limit', tar: buildTar([1, 2, 3].map((n) => ({ name: `out/f${n}`, content: Buffer.alloc(400 * 1024, n) }))), says: /size limit/, machine: { maxOutputMegabytes: 1 } },
    { name: 'more entries than the limit, written files', tar: buildTar(Array.from({ length: 5 }, (_, n) => ({ name: `out/f${n}` }))), says: /more entries/, extra: { maxOutputEntries: 3 } },
    // The folders athanor makes for one deep name count against the same cap.
    { name: 'one file entry whose path makes more folders than the entry limit', tar: one(`out/${'d/'.repeat(10)}f`), says: /more entries/, extra: { maxOutputEntries: 5 } },
    { name: 'a path longer than a path can be', tar: one('out/x', { pax: { path: `out/${'d/'.repeat(2100)}f` } }), says: /too long/ },
    { name: 'more entries than the limit, links alone', tar: buildTar(Array.from({ length: 5 }, (_, n) => ({ name: `out/l${n}`, type: '2' }))), says: /more entries/, extra: { maxOutputEntries: 3 } },
    { name: 'more entries than the limit, metadata alone', tar: buildTar(Array.from({ length: 5 }, () => ({ name: 'pax', type: 'g' }))), says: /more entries/, extra: { maxOutputEntries: 3 } },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const s = scene(t, { machine: row.machine, cp: { out: served(row.tar, { lingerMs: 5000 }) } });
      mkdirSync(join(s.parent, 'sentinel'));
      writeFileSync(join(s.parent, 'sentinel', 'keep.txt'), 'keep');
      const before = gitState(s.repo);
      const { result, calls } = await copy(s, row.extra);
      assert.equal(result.outcome, 'error', JSON.stringify(result));
      assert.equal(result.exitCode, 125);
      assert.equal(result.testExitCode, 0);
      assert.match(result.message!, row.says);
      assert.match(result.message!, /test exited 0/);
      assert.equal(existsSync(s.dir), false, 'everything this copy made is gone');
      assert.deepEqual(tree(s.parent), { sentinel: null, 'sentinel/keep.txt': 'keep' });
      assert.deepEqual(gitState(s.repo), before, 'the repo is unchanged');
      if (!row.late) assert.equal(calls.some((c) => c.finished), false, 'cp was stopped before it finished');
      assert.equal(result.outputs, undefined);
    });
  }
});

test('M13 the caps hold across several outputs, and the test\'s own exit is reported', async (t) => {
  const big = (name: string) => served(buildTar([{ name: `${name}/f`, content: Buffer.alloc(700 * 1024, 1) }]));
  await t.test('size', async (t) => {
    const s = scene(t, { outputs: ['one', 'two'], cp: { one: big('one'), two: big('two') }, machine: { maxOutputMegabytes: 1 }, plan: { exitCode: 3 } });
    const { result } = await copy(s);
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.match(result.message!, /size limit/);
    assert.equal(result.testExitCode, 3);
    assert.match(result.message!, /test exited 3/);
    assert.equal(existsSync(s.dir), false);
  });
  await t.test('a missing output still counts what it sent against the size cap', async (t) => {
    // An end block and padding, then the missing-path text: nothing in it, but 700 KB read.
    const empty = { tar: Buffer.alloc(700 * 1024).toString('base64'), fails: 'Error response from daemon: Could not find the file /x in container y' };
    const s = scene(t, { outputs: ['one', 'two', 'three'], cp: { one: empty, two: empty, three: served(buildTar([{ name: 'three/a' }])) }, machine: { maxOutputMegabytes: 1 } });
    const { result } = await copy(s);
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.match(result.message!, /size limit/);
  });
  await t.test('entries', async (t) => {
    const small = (name: string) => served(buildTar([{ name: `${name}/a` }, { name: `${name}/b` }]));
    const s = scene(t, { outputs: ['one', 'two'], cp: { one: small('one'), two: small('two') } });
    const { result } = await copy(s, { maxOutputEntries: 3 });
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.match(result.message!, /more entries/);
    assert.equal(existsSync(s.dir), false);
  });
});

test('M14 links, devices, FIFOs and act-on-view files are skipped and counted', async (t) => {
  const viewed = ['out/a.lnk', 'out/b.scf', 'out/c.library-ms', 'out/d.searchConnector-ms', 'out/e.theme', 'out/f.themepack'];
  const tar = buildTar([
    { name: 'out/', type: '5' },
    { name: 'out/real.txt', content: 'real' },
    { name: 'out/desktop.ini', content: '[x]' },
    { name: 'out/x.URL', content: '[InternetShortcut]' },
    ...viewed.map((name) => ({ name, content: 'x' })),
    { name: 'out/link', type: '2' },
    { name: 'out/hard', type: '1' },
    { name: 'out/dev', type: '3' },
    { name: 'out/fifo', type: '6' },
  ]);
  // The files Windows acts on when it shows a folder are skipped on every engine, local or not.
  for (const machine of [undefined, { allowRemoteDocker: true }]) {
    const s = scene(t, { cp: { out: served(tar) }, machine });
    const { result } = await copy(s);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.deepEqual(Object.keys(tree(s.dir)).sort(), ['out', 'out/real.txt']);
    assert.equal(result.outputs!.files, 1);
    assert.equal(result.outputs!.skipped, 12, 'four links, devices and FIFOs, and the eight act-on-view files');
  }
});

test('M15 nothing is copied unless the test ran and exited; a hanging cp, the time bound and an ssh login', async (t) => {
  const tar = served(buildTar([{ name: 'out/a.txt', content: 'a' }]));
  const rows: { name: string; plan: Record<string, unknown>; extra?: RunOptions; outcome: string }[] = [
    { name: 'timeout', plan: { hangMs: 5000 }, extra: { timeLimitSeconds: 1 }, outcome: 'timeout' },
    { name: 'memory', plan: { oom: true, exitCode: 137 }, outcome: 'memory' },
    { name: 'error', plan: { tarFails: true }, outcome: 'error' },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const s = scene(t, { cp: { out: tar }, plan: row.plan });
      const { result, calls } = await copy(s, row.extra);
      assert.equal(result.outcome, row.outcome, JSON.stringify(result));
      assert.equal(callsOf(calls, 'cp').length, 0);
      assert.equal(existsSync(s.dir), false);
      assert.equal(result.outputs, undefined);
      assert.equal(result.testExitCode, undefined, 'the run ended before a copy was tried');
    });
  }

  const waitFor = async (s: Scene, verb: string): Promise<void> => {
    for (let i = 0; i < 200 && callsOf(s.docker.calls(), verb).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  };

  await t.test('interrupted while the test runs', async (t) => {
    const s = scene(t, { cp: { out: tar }, plan: { hangMs: 10000 } });
    const controller = new AbortController();
    const pending = copy(s, { signal: controller.signal });
    await waitFor(s, 'run');
    controller.abort();
    const { result, calls } = await pending;
    assert.equal(result.outcome, 'interrupted', JSON.stringify(result));
    assert.equal(callsOf(calls, 'cp').length, 0);
    assert.equal(existsSync(s.dir), false);
  });

  await t.test('an abort during a hanging cp ends the run interrupted, with the folder gone and the container removed', async (t) => {
    const s = scene(t, { cp: { out: { hang: true } } });
    const controller = new AbortController();
    const pending = copy(s, { signal: controller.signal });
    await waitFor(s, 'cp');
    controller.abort();
    const { result, calls } = await pending;
    assert.equal(result.outcome, 'interrupted', JSON.stringify(result));
    assert.equal(existsSync(s.dir), false);
    assert.ok(callsOf(calls, 'rm').some((c) => c.args.at(-1) === idOfSlot(s.prefix)));
    assert.deepEqual(readdirSync(join(s.docker.dir, 'containers')), []);
  });

  await t.test('the time bound ends a hanging cp as an error', async (t) => {
    const s = scene(t, { cp: { out: { hang: true } } });
    const { result, calls } = await copy(s, { copyTimeMs: 400 });
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.equal(result.exitCode, 125);
    assert.match(result.message!, /took longer/);
    assert.equal(existsSync(s.dir), false);
    assert.ok(callsOf(calls, 'rm').some((c) => c.args.at(-1) === idOfSlot(s.prefix)));
  });

  await t.test('the time bound runs from the copy\'s start, not from each output', async (t) => {
    const first = served(buildTar([{ name: 'one/a' }]), { lingerMs: 1000 });
    // The same run with a second output that is simply missing: the cost of everything but the wait.
    const baseline = scene(t, { outputs: ['one', 'two'], cp: { one: first } });
    const base = Date.now();
    assert.equal((await copy(baseline, { copyTimeMs: 1500 })).result.outcome, 'pass');
    const baseMs = Date.now() - base;
    // The second output hangs. From the copy's start the bound ends it 500 ms after the first output; a fresh bound would end it 1500 ms after.
    const s = scene(t, { outputs: ['one', 'two'], cp: { one: first, two: { hang: true } } });
    const started = Date.now();
    const { result } = await copy(s, { copyTimeMs: 1500 });
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.match(result.message!, /took longer/);
    assert.ok(Date.now() - started - baseMs < 1000, 'the second output did not get a fresh 1500 ms');
  });

  await t.test('a cp failing with an ssh login in its text gives a message without the login', async (t) => {
    const s = scene(t, { cp: { out: { fails: 'error: ssh -l mallory me@example.com docker system dial-stdio: connection refused' } } });
    const { result } = await copy(s);
    assert.equal(result.outcome, 'error', JSON.stringify(result));
    assert.doesNotMatch(result.message!, /mallory|me@/);
    assert.equal(existsSync(s.dir), false);
  });
});

test('M17 the work line never reaches the caller, and a run that copies needs exactly one valid line', async (t) => {
  const tar = served(buildTar([{ name: 'out/a.txt', content: 'a' }]));
  await t.test('the line is stripped, and one after the marker is test output that changes nothing', async (t) => {
    const s = scene(t, { cp: { out: tar }, plan: { stderr: 'athanor-work /etc\n' } });
    const stderr = collector();
    const { result, calls } = await copy(s, { stderr });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.ok(!stderr.text().includes('athanor-work /root/work'), 'the boot script\'s line is stripped');
    assert.ok(stderr.text().includes('athanor-work /etc'), 'a line after the marker is test output');
    assert.equal(callsOf(calls, 'cp')[0]!.args[1], `${idOfSlot(s.prefix)}:/root/work/out`);
  });

  await t.test('without --output the line is stripped too', async (t) => {
    const s = scene(t);
    const stderr = collector();
    const { result } = await copy(s, { stderr, output: undefined });
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
    assert.ok(!stderr.text().includes('athanor-work'));
  });

  const rows = [
    { name: 'no work line', work: [] },
    { name: 'two work lines', work: ['/a', '/b'] },
    { name: 'one invalid work line', work: ['rel'] },
    { name: 'a work line with a control character', work: ['/a\u0001b'] },
    { name: 'a work line with a format character', work: ['/a‮b'] },
  ];
  for (const row of rows) {
    await t.test(row.name, async (t) => {
      const s = scene(t, { cp: { out: tar }, plan: { work: row.work } });
      const stderr = collector();
      const { result, calls } = await copy(s, { stderr });
      assert.equal(result.outcome, 'error', JSON.stringify(result));
      assert.equal(result.exitCode, 125);
      assert.equal(result.testExitCode, 0);
      assert.equal(callsOf(calls, 'cp').length, 0, 'no cp');
      assert.equal(existsSync(s.dir), false, 'no folder');
      assert.ok(!stderr.text().includes('athanor-work'));
    });
  }
});
