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

// The pin athanor sets, and two values it must pass through unchanged (ADR 0021).
const pinned = {
  context: process.env.DOCKER_CONTEXT,
  builder: process.env.BUILDX_BUILDER,
  tlsVerify: process.env.DOCKER_TLS_VERIFY,
  hasPath: Object.keys(process.env).some((k) => k.toUpperCase() === 'PATH'),
};
const record = (extra: Record<string, unknown> = {}): void => appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, env: pinned, ...extra }) + '\n');
// How many earlier calls had these first two arguments, so a scenario can
// answer differently after the first check (a context edited while a run waits).
function seen(a: string, b: string, named: boolean): number {
  const log = join(dir, 'calls.jsonl');
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).args as string[])
    .filter((c) => c[0] === a && c[1] === b && (c.length > 2) === named).length;
}
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
// A repeated option (`-e`, `--cap-add`) keeps only its last value in the parsed
// options; a check on one reads the raw arguments.
const RUN_VALUED = new Set([
  '--pull', '--log-driver', '--name', '--label', '--network', '--memory', '--memory-swap',
  '--cpus', '--pids-limit', '--security-opt', '--cap-drop', '--cap-add', '-e',
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
      console.error(scenario.engineDownText ?? 'Cannot connect to the Docker daemon. Is the docker daemon running?');
      return 1;
    }
    console.log('29.8.2');
    return 0;
  }
  if (a === 'context' && b === 'inspect') {
    // The name, when given, comes after "--".
    const named = args[2] === '--' ? args[3] : args[2];
    const earlier = seen(a, b, named !== undefined);
    record();
    if (named !== undefined && scenario.contexts?.[named] === null) {
      console.error(`context "${named}" does not exist`);
      return 1;
    }
    // A context is a host, or { host, tls } for one with TLS material.
    // As real Docker does: with DOCKER_HOST set, the "default" context is DOCKER_HOST.
    const fromHost = named === 'default' && scenario.contexts?.default === undefined && process.env.DOCKER_HOST ? process.env.DOCKER_HOST : undefined;
    const entry = fromHost ?? (named !== undefined && scenario.contexts?.[named] !== undefined
      ? scenario.contexts[named]
      : earlier > 0 && scenario.contextHostLater !== undefined ? scenario.contextHostLater : scenario.contextHost ?? 'unix:///var/run/docker.sock');
    const host = typeof entry === 'string' ? entry : entry.host;
    // A name with no entry of its own is the default context, TLS material included.
    const tls = typeof entry === 'string' ? (scenario.contexts?.[named ?? ''] === undefined ? scenario.contextTls : undefined) : entry.tls;
    console.log(JSON.stringify([{
      Name: named ?? 'fake',
      Endpoints: { docker: { Host: host, SkipTLSVerify: scenario.contextSkipTls === true } },
      TLSMaterial: tls ?? {},
    }]));
    return 0;
  }
  if (a === 'buildx' && b === 'version') {
    record();
    if (scenario.buildx === 'missing') {
      console.error("docker: 'buildx' is not a docker command.");
      return 1;
    }
    console.log('github.com/docker/buildx v0.29.1 fake');
    return 0;
  }
  if (a === 'buildx' && b === 'inspect') {
    const earlier = seen(a, b, false);
    record();
    if (scenario.engineDown) {
      console.error('ERROR: Cannot connect to the Docker daemon. Is the docker daemon running?');
      return 1;
    }
    if (scenario.buildxFails) {
      console.error(scenario.buildxFailText ?? 'ERROR: no builder found');
      return 1;
    }
    const driver = scenario.builderDriver ?? 'docker';
    // A node is an endpoint, or { endpoint, options, after } with its driver
    // options line and raw lines printed after its status, as buildx prints labels.
    const listed = earlier > 0 && scenario.builderNodesLater !== undefined
      ? scenario.builderNodesLater
      : scenario.builderNodes ?? scenario.builderEndpoints ?? [scenario.builderEndpoint ?? 'default'];
    // The shape of real `docker buildx inspect` output, one block per node.
    const nodes = listed.map((n: any, i: number) => {
      const node = typeof n === 'string' ? { endpoint: n } : n;
      const endpoint = node.endpoint === undefined ? '' : `Endpoint:         ${node.endpoint}\n`;
      const options = node.options === undefined ? '' : `Driver Options:   ${node.options}\n`;
      const repeat = node.repeatEndpoint ? `Endpoint:         ${node.repeatEndpoint}\n` : '';
      return `Name:             fake${i}\n${endpoint}${options}Status:           running\n${repeat}${node.after ?? ''}`;
    }).join('\n');
    const error = scenario.builderHeaderError ? `Error:         ${scenario.builderHeaderError}\n` : '';
    console.log(`Name:          ${scenario.builderName ?? 'fake'}\nDriver:        ${driver}\nLast Activity: 2026-10-19 20:31:02 +0000 UTC\n${error}\nNodes:\n${nodes}`);
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
    // When the run began, before the snapshot is read, so a test can time a run from here.
    const at = Date.now();
    const input = await readStdin();
    record({ at, tar: readTar(input) });
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
