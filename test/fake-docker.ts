// A fake Docker CLI for the fast tier. The core is given
// [process.execPath, --disable-warning=ExperimentalWarning, this file, <scenario dir>] as its Docker command.
// It appends every argument array to <dir>/calls.jsonl and plays back what
// <dir>/scenario.json says. Images and containers live as one file each under
// <dir>/images and <dir>/containers, so concurrent fakes don't race.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { TarEntry } from './helpers.ts';

const [dir, ...args] = process.argv.slice(2) as [string, ...string[]];
// The scenario file is JSON written by the test; its keys are read as they come.
const scenario: Record<string, any> = existsSync(join(dir, 'scenario.json')) ? JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) : {};
const imagesDir = join(dir, 'images');
const containersDir = join(dir, 'containers');
mkdirSync(imagesDir, { recursive: true });
mkdirSync(containersDir, { recursive: true });

const record = (extra: Record<string, unknown> = {}): void => appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, ...extra }) + '\n');
const fileFor = (base: string, name: string | undefined): string => join(base, encodeURIComponent(String(name)) + '.json');
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// A small tar reader: returns [{ name, type, content }] for regular files and folders.
function readTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (match) longName = match[1] as string;
      continue;
    }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    entries.push({ name, type, mode: field(100, 8).trim(), content: type === '0' ? body.toString('base64') : undefined });
  }
  return entries;
}

function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// The `run` options athanor uses. Any other option is a typo in the container's
// options, so the fake refuses it. The image is the first argument after them.
const RUN_FLAGS = new Set(['-i', '--init']);
const RUN_VALUED = new Set([
  '--pull', '--log-driver', '--name', '--label', '--network', '--memory', '--memory-swap',
  '--cpus', '--pids-limit', '--security-opt', '-e',
]);

function parseRun(runArgs: string[]): { error: string } | { options: Map<string, string>; image: string } {
  const options = new Map<string, string>();
  let i = 0;
  for (; i < runArgs.length && (runArgs[i] as string).startsWith('-'); i++) {
    const name = runArgs[i] as string;
    if (RUN_FLAGS.has(name)) continue;
    if (!RUN_VALUED.has(name)) return { error: `fake docker: unknown run option ${name}` };
    if (i + 1 >= runArgs.length || (runArgs[i + 1] as string).startsWith('-')) return { error: `fake docker: run option ${name} needs a value` };
    options.set(name, runArgs[++i] as string);
  }
  if (i >= runArgs.length) return { error: 'fake docker: run has no image' };
  return { options, image: runArgs[i] as string };
}

async function main() {
  const [a, b] = args;
  if (a === 'version') {
    record();
    if (scenario.engineDown) {
      console.error('Cannot connect to the Docker daemon. Is the docker daemon running?');
      return 1;
    }
    console.log('29.8.2');
    return 0;
  }
  if (a === 'context' && b === 'inspect') {
    record();
    const named = args[2];
    const host = named && scenario.contexts?.[named] !== undefined
      ? scenario.contexts[named]
      : scenario.contextHost ?? 'unix:///var/run/docker.sock';
    console.log(JSON.stringify([{
      Name: named ?? 'fake',
      Endpoints: { docker: { Host: host, SkipTLSVerify: scenario.contextSkipTls === true } },
      TLSMaterial: scenario.contextTls ?? {},
    }]));
    return 0;
  }
  if (a === 'buildx' && b === 'inspect') {
    record();
    if (scenario.buildxFails) {
      console.error('ERROR: no builder found');
      return 1;
    }
    if (scenario.buildx === 'missing') {
      console.error("docker: 'buildx' is not a docker command.");
      return 1;
    }
    const driver = scenario.builderDriver ?? 'docker';
    const endpoints = scenario.builderEndpoints ?? [scenario.builderEndpoint ?? 'default'];
    // The shape of real `docker buildx inspect` output, one block per node.
    const nodes = endpoints.map((e: string, i: number) => `Name:             fake${i}\nEndpoint:         ${e}\nStatus:           running\n`).join('\n');
    console.log(`Name:          fake\nDriver:        ${driver}\nLast Activity: 2026-10-19 20:31:02 +0000 UTC\n\nNodes:\n${nodes}`);
    return 0;
  }
  if (a === 'image' && b === 'inspect') {
    record();
    if (existsSync(fileFor(imagesDir, args[2]))) { console.log('[{}]'); return 0; }
    console.error(`Error response from daemon: No such image: ${args[2]}`);
    return 1;
  }
  if (a === 'build') {
    const input = await readStdin();
    const entries = readTar(input);
    record({ tar: entries });
    if (scenario.buildGrandchild) {
      // Like the buildx plugin: a child that keeps this process's output open.
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], shell: false });
    }
    if (scenario.buildHangMs) await sleep(scenario.buildHangMs);
    if (scenario.buildFails) { console.error('ERROR: failed to solve: process did not complete successfully'); return 1; }
    if (scenario.loadRequired && !args.includes('--load')) {
      console.error('WARNING: No output specified with docker-container driver. Build result will only remain in the build cache.');
      return 0;
    }
    writeFileSync(fileFor(imagesDir, option('-t')), JSON.stringify({ tag: option('-t') }));
    console.error('#1 building fake image');
    return 0;
  }
  if (a === 'container' && b === 'inspect') {
    record();
    const path = fileFor(containersDir, args.at(-1));
    if (!existsSync(path)) { console.error(`Error response from daemon: No such container: ${args.at(-1)}`); return 1; }
    console.log(JSON.stringify(readJson(path).labels ?? {}));
    return 0;
  }
  if (a === 'rm') {
    record();
    const path = fileFor(containersDir, args.at(-1));
    if (scenario.rmFails) { console.error('Error response from daemon: cannot remove container: permission denied'); return 1; }
    if (!existsSync(path)) { console.error(`Error response from daemon: No such container: ${args.at(-1)}`); return 1; }
    rmSync(path, { force: true });
    console.log(args.at(-1));
    return 0;
  }
  if (a === 'inspect') {
    record();
    const path = fileFor(containersDir, args.at(-1));
    if (scenario.inspectFails || !existsSync(path)) { console.error(`Error: No such object: ${args.at(-1)}`); return 1; }
    const state = readJson(path);
    console.log(`${state.exitCode ?? 0} ${state.oom ? 'true' : 'false'}`);
    return 0;
  }
  if (a === 'ps') {
    record();
    for (const f of readdirSync(containersDir)) {
      const c = readJson(join(containersDir, f));
      if (c.labels?.['athanor.slot'] !== undefined) console.log(`${c.name}\t${c.labels['athanor.slot']}\t${c.image}`);
    }
    return 0;
  }
  if (a === 'images') {
    record();
    for (const f of readdirSync(imagesDir)) console.log(readJson(join(imagesDir, f)).tag);
    return 0;
  }
  if (a === 'rmi') {
    record();
    rmSync(fileFor(imagesDir, args.at(-1)), { force: true });
    console.log(`Untagged: ${args.at(-1)}`);
    return 0;
  }
  if (a === 'run') {
    const parsed = parseRun(args.slice(1));
    if ('error' in parsed) {
      record();
      console.error(parsed.error);
      return 125;
    }
    const { image } = parsed;
    const name = parsed.options.get('--name');
    const labelArg = parsed.options.get('--label');
    const labels = labelArg ? { [labelArg.split('=')[0]]: labelArg.split('=')[1] } : {};
    const path = fileFor(containersDir, name);
    const plan = { exitCode: 0, marker: true, ...(scenario.run ?? {}) };
    if (plan.runFails) {
      record();
      console.error('docker: Error response from daemon: Conflict.');
      return 125;
    }
    writeFileSync(path, JSON.stringify({ name, labels, image, running: true }));
    if (plan.skipStdin) {
      // Exit without reading the snapshot, closing the pipe under git archive.
      record();
      if (plan.marker) process.stderr.write('athanor-boot-ok\n');
      finish(path, plan.exitCode, false);
      process.exit(plan.exitCode);
    }
    const input = await readStdin();
    record({ tar: readTar(input) });
    if (plan.tarFails) { console.error('tar: short read'); finish(path, 2, false); return 2; }
    if (plan.marker) process.stderr.write('athanor-boot-ok\n');
    if (plan.stdout) process.stdout.write(plan.stdout);
    if (plan.stderr) process.stderr.write(plan.stderr);
    if (plan.hangMs) {
      const until = Date.now() + plan.hangMs;
      while (Date.now() < until) {
        if (!existsSync(path)) return 137; // removed with rm -f
        await sleep(25);
      }
    }
    if (!existsSync(path)) return 137;
    finish(path, plan.exitCode, plan.oom === true);
    return plan.exitCode;
  }
  record();
  console.error(`fake docker: unhandled ${args.join(' ')}`);
  return 1;
}

function finish(path: string, exitCode: number, oom: boolean): void {
  const state = readJson(path);
  writeFileSync(path, JSON.stringify({ ...state, running: false, exitCode, oom }));
}

process.exitCode = await main();
