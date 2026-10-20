// athanor's core API: run, status and prune (ADR 0003). It never prints,
// exits or registers signal handlers: it reports progress through onProgress,
// stops on an AbortSignal, and returns a result.
import { mkdirSync, existsSync, utimesSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { AthanorError, EXIT } from './errors.mjs';
import { readMachineConfig, readRepoConfig, resolveRunLimit, resolveLimits, DEFAULTS } from './config.mjs';
import { insideRepo, isUnder } from './paths.mjs';
import { repoRoot, makeScratch, clearStale, snapshot, buildContext, ARCHIVE_CONFIG } from './git.mjs';
import { prepareDocker, imageExists, clearSlotContainer, removeContainer, readExit, listSlotContainers, listAthanorImages, removeImage } from './docker.mjs';
import { acquire, ask } from './slots.mjs';
import { start } from './proc.mjs';

export { AthanorError };

const MARKER = 'athanor-boot-ok';
const TAG_PATTERN = /^athanor:([0-9a-f]{32})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// The boot script, joined with \n so no checkout's line endings can reach sh -c.
export const BOOT = [
  'set -e',
  'mkdir -p "$HOME/work"; cd "$HOME/work"',
  'tar -xm',
  'if command -v git >/dev/null 2>&1; then',
  '  git init -q; git add -A',
  '  git -c user.name=athanor -c user.email=athanor@localhost commit -qm athanor',
  'fi',
  '( sleep "$ATHANOR_GRACE_LIMIT"; kill -s KILL -1 ) &',
  `echo ${MARKER} >&2`,
  'exec "$@"',
].join('\n');

function stateFolder() {
  const home = process.env.ATHANOR_HOME !== undefined && process.env.ATHANOR_HOME !== ''
    ? process.env.ATHANOR_HOME
    : join(homedir(), '.athanor');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'linux') chmodSync(home, 0o700);
  return home;
}

function markUse(home, hash) {
  const dir = join(home, 'images');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hash);
  const now = new Date();
  if (existsSync(file)) utimesSync(file, now, now);
  else writeFileSync(file, '');
}

// An interrupt that arrived while a step other than the container was running.
class Interrupted extends Error {}

function errorResult(message, partial = {}) {
  return { schema: 1, outcome: 'error', exitCode: EXIT.setup, ...partial, message };
}

// Run the named command (or `command`) in a fresh container. Returns the run
// result; athanor's own failures come back as outcome "error", exit 125.
export async function run(options = {}) {
  const partial = {};
  try {
    return await runInner(options, partial);
  } catch (error) {
    if (error instanceof Interrupted) return interruptedResult(partial);
    if (error instanceof AthanorError) return errorResult(error.message, partial);
    throw error;
  }
}

async function runInner(options, partial) {
  const {
    cwd = process.cwd(),
    name,
    command: override,
    untracked = false,
    signal,
    onProgress = () => {},
    stdout = null,
    stderr = null,
    docker = ['docker'],
    prefix = 'athanor',
  } = options;
  const env = process.env;

  const home = stateFolder();
  clearStale(home);
  const machine = readMachineConfig(home);
  const { limit } = resolveRunLimit(env, machine);
  const root = await repoRoot(cwd);
  const config = readRepoConfig(root);

  const dockerfile = insideRepo(root, config.dockerfile, 'dockerfile');
  const context = config.context !== undefined
    ? insideRepo(root, config.context, 'context')
    : (dockerfile.includes('/') ? dockerfile.slice(0, dockerfile.lastIndexOf('/')) : '.');
  const inputs = (config.inputs ?? []).map((p) => insideRepo(root, p, 'inputs'));
  if (!isUnder(context, dockerfile)) {
    throw new AthanorError(`The Dockerfile "${config.dockerfile}" is outside the context folder "${context}". Move it into the context, or widen the context.`);
  }
  const dockerfileInContext = context === '.' ? dockerfile : dockerfile.slice(context.length + 1);
  const limits = resolveLimits(config, machine);
  const commandName = name ?? 'test';
  // Own keys only, so a name such as "constructor" is not found on the prototype.
  const command = override ?? (Object.hasOwn(config.commands, commandName) ? config.commands[commandName] : undefined);
  if (command === undefined) {
    throw new AthanorError(`There is no command named "${commandName}" in the "athanor" key. Its commands are: ${Object.keys(config.commands).join(', ')}.`);
  }
  const timeLimitSeconds = options.timeLimitSeconds ?? limits.timeoutMinutes * 60;
  const graceSeconds = options.graceSeconds ?? 60;

  const { driver } = await prepareDocker(docker);
  // A docker-container builder keeps its result in the build cache unless told to load it.
  const buildOptions = driver === 'docker-container' ? ['--load'] : [];

  const scratch = await makeScratch(home, root);
  let slot = null;
  try {
    // The image: found, or built before waiting for a slot (T1).
    const ctx = await buildContext(root, scratch, { context, inputs, dockerfileInContext });
    partial.image = { tag: ctx.tag, built: false };
    if (!(await imageExists(docker, ctx.tag))) {
      onProgress(`building the test image ${ctx.tag} from ${config.dockerfile}.`);
      await build(docker, root, scratch, ctx, dockerfileInContext, buildOptions, stderr, signal);
      partial.image.built = true;
    }
    markUse(home, ctx.hash);

    const snap = await snapshot(root, scratch, { untracked });
    partial.snapshot = { id: snap.id, untracked: snap.untracked };
    partial.untrackedLeftOut = snap.untrackedLeftOut;
    if (snap.untrackedLeftOut > 0) {
      onProgress(`left out ${snap.untrackedLeftOut} untracked file${snap.untrackedLeftOut === 1 ? '' : 's'}. Add them to git, or run with --untracked to include them.`);
    }
    if (signal?.aborted) return interruptedResult(partial);

    const waitStart = Date.now();
    slot = await acquire({
      prefix,
      limit,
      signal,
      info: { pid: process.pid, started: Date.now(), repo: basename(root) },
      onWait: () => onProgress(`waiting for a free run slot: all ${limit} are in use. athanor status shows who holds them.`),
    });
    partial.waitedMs = Date.now() - waitStart;
    if (!slot) return interruptedResult(partial);
    partial.slot = slot.slot;
    await warnOnOtherLimits(prefix, slot.slot, limit, onProgress);

    // A prune may have removed the tag while this run waited.
    if (!(await imageExists(docker, ctx.tag))) {
      onProgress(`the test image ${ctx.tag} is no longer in Docker (a prune may have removed it while this run waited); building it again.`);
      await build(docker, root, scratch, ctx, dockerfileInContext, buildOptions, stderr, signal);
      partial.image.built = true;
    }
    const containerName = `${prefix}-slot-${slot.slot}`;
    await clearSlotContainer(docker, containerName);
    if (signal?.aborted) return interruptedResult(partial);

    const ran = await runContainer({
      docker, root, scratch, snapshotId: snap.id, containerName, slot: slot.slot, tag: ctx.tag,
      limits, command, timeLimitSeconds, graceSeconds, stdout, stderr, signal,
    });
    markUse(home, ctx.hash);
    return { schema: 1, ...partial, ...ran };
  } finally {
    if (slot) await slot.release();
    scratch.remove();
  }
}

function interruptedResult(partial) {
  return { schema: 1, outcome: 'interrupted', exitCode: EXIT.interrupted, ...partial };
}

async function warnOnOtherLimits(prefix, slot, limit, onProgress) {
  const checks = [];
  for (let n = 1; n <= limit + 1; n++) if (n !== slot) checks.push(ask(prefix, n).then((r) => ({ n, ...r })));
  const answers = await Promise.all(checks);
  const above = answers.find((a) => a.n === limit + 1 && a.held);
  const differs = answers.find((a) => a.answer && a.answer.limit !== limit);
  if (above || differs) {
    onProgress(`warning: another caller uses a different run limit (this run uses ${limit}${differs ? `, a holder reports ${differs.answer.limit}` : `, but slot ${limit + 1} is held`}). Set the same ATHANOR_MAX_RUNS or maxRuns for every caller.`);
  }
}

// Pipe git archive into a Docker child. If the child stops reading (it exits,
// or its input closes), end the archive too, so it fails rather than blocks.
function feed(archive, consumer) {
  const out = archive.child.stdout;
  out.pipe(consumer.child.stdin);
  const stopArchive = () => {
    out.unpipe(consumer.child.stdin);
    out.destroy();
    if (archive.child.exitCode === null) archive.child.kill();
  };
  consumer.child.stdin.on('error', stopArchive);
  consumer.child.once('exit', stopArchive);
}

async function build(docker, root, scratch, ctx, dockerfileInContext, buildOptions, stderr, signal) {
  const archive = start(['git', ...ARCHIVE_CONFIG, '-c', 'tar.umask=0022', 'archive', '--format=tar', ctx.commit], {
    cwd: root, env: scratch.archiveEnv, capture: false,
  });
  const builder = start([...docker, 'build', ...buildOptions, '-t', ctx.tag, '-f', dockerfileInContext, '-'], {
    stdin: 'pipe', capture: true, onStderr: (c) => stderr?.write(c), onStdout: (c) => stderr?.write(c),
  });
  feed(archive, builder);
  // On an interrupt, stop waiting once docker has exited: a buildx plugin it
  // started can hold the output open until the build ends (S4 leaves the build
  // to Docker).
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => {
      builder.child.kill();
      archive.child.kill();
      if (builder.child.exitCode !== null || builder.child.signalCode !== null) resolve();
      else builder.child.once('exit', () => resolve());
    };
  });
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const settled = await Promise.race([Promise.all([archive.done, builder.done]), aborted.then(() => null)]);
  signal?.removeEventListener('abort', onAbort);
  if (signal?.aborted || settled === null) {
    builder.child.stdout.destroy();
    builder.child.stderr.destroy();
    throw new Interrupted();
  }
  const [a, b] = settled;
  if (a.code !== 0) throw new AthanorError(`git archive of the build context failed (exit ${a.code}).`);
  if (b.code !== 0) {
    throw new AthanorError(`The image build failed (docker build exit ${b.code}). Its output is above; fix the Dockerfile or the context, then run again.`);
  }
  if (!(await imageExists(docker, ctx.tag))) {
    throw new AthanorError(`The image build finished, but the image ${ctx.tag} is not in Docker. Check that the buildx builder loads its images into the local engine.`);
  }
}

// Strips the boot marker from the container's stderr and notes that it came.
function markerFilter(write) {
  let seen = false;
  let pending = '';
  return {
    get seen() { return seen; },
    push(chunk) {
      if (seen) { write(chunk); return; }
      pending += chunk.toString('utf8');
      let i;
      while (!seen && (i = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, i + 1);
        pending = pending.slice(i + 1);
        if (line.replace(/\r?\n$/, '') === MARKER) seen = true;
        else write(line);
      }
      if (seen && pending) { write(pending); pending = ''; }
    },
    flush() { if (pending) write(pending); pending = ''; },
  };
}

async function runContainer(o) {
  const graceLimit = Math.ceil(o.timeLimitSeconds + o.graceSeconds);
  const args = [
    'run', '-i', '--init', '--pull', 'never', '--log-driver', 'none',
    '--name', o.containerName, '--label', `athanor.slot=${o.slot}`,
    '--network', 'none',
    '--memory', o.limits.memory, '--memory-swap', o.limits.memory,
    '--cpus', String(o.limits.cpus), '--pids-limit', '1024',
    '--security-opt', 'no-new-privileges',
    '-e', `ATHANOR_GRACE_LIMIT=${graceLimit}`,
    o.tag, 'sh', '-c', BOOT, 'athanor', ...o.command,
  ];
  const write = (stream) => (c) => stream?.write(c);
  const filter = markerFilter(write(o.stderr));
  const started = Date.now();
  const archive = start(['git', ...ARCHIVE_CONFIG, 'archive', '--format=tar', o.snapshotId], {
    cwd: o.root, env: o.scratch.archiveEnv, capture: false,
  });
  const container = start([...o.docker, ...args], {
    stdin: 'pipe', capture: false, onStdout: write(o.stdout), onStderr: (c) => filter.push(c),
  });
  feed(archive, container);

  let timedOut = false;
  let interrupted = false;
  const stop = () => removeContainer(o.docker, o.containerName);
  const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeLimitSeconds * 1000);
  const onAbort = () => { interrupted = true; stop(); };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const [a, c] = await Promise.all([archive.done, container.done]);
  clearTimeout(timer);
  o.signal?.removeEventListener('abort', onAbort);
  filter.flush();
  const ranMs = Date.now() - started;
  const state = interrupted || timedOut ? null : await readExit(o.docker, o.containerName);
  await removeContainer(o.docker, o.containerName);

  const base = { ranMs };
  if (interrupted) return { ...base, outcome: 'interrupted', exitCode: EXIT.interrupted };
  if (timedOut) return { ...base, outcome: 'timeout', exitCode: EXIT.timeout };
  if (a.code !== 0) {
    return { ...base, outcome: 'error', exitCode: EXIT.setup, message: `git archive of the snapshot failed (exit ${a.code}), so the test did not run on the whole snapshot.` };
  }
  if (!filter.seen) {
    const why = c.code === 125
      ? 'docker run failed before the test started. Its message is above.'
      : 'the container did not print athanor\'s start marker. Either the snapshot could not be unpacked, or the image breaks athanor\'s image contract: it needs sh and tar, and an ENTRYPOINT must run the arguments it is given.';
    return { ...base, outcome: 'error', exitCode: EXIT.setup, message: `The test never started: ${why}` };
  }
  if (!state) {
    return { ...base, outcome: 'error', exitCode: EXIT.setup, message: 'athanor could not read how the container ended (docker inspect failed). Check that Docker is still running.' };
  }
  if (state.oom) return { ...base, outcome: 'memory', exitCode: EXIT.memory };
  return { ...base, outcome: state.exitCode === 0 ? 'pass' : 'fail', exitCode: state.exitCode };
}

// Who holds each slot, and which athanor containers exist. Starts nothing.
export async function status(options = {}) {
  const { docker = ['docker'], prefix = 'athanor' } = options;
  const home = stateFolder();
  const machine = readMachineConfig(home);
  const { limit, source } = resolveRunLimit(process.env, machine);
  const slots = [];
  const held = new Set();
  for (let n = 1; n <= limit; n++) {
    const r = await ask(prefix, n);
    if (r.held) held.add(n);
    const entry = { slot: n };
    if (r.answer) Object.assign(entry, { pid: r.answer.pid, started: r.answer.started, repo: r.answer.repo, limit: r.answer.limit });
    if (r.held) entry.held = true;
    slots.push(entry);
  }
  const names = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-slot-\\d+$`);
  const containers = (await listSlotContainers(docker))
    .filter((c) => names.test(c.name))
    .map((c) => ({ name: c.name, slot: c.slot, orphan: !held.has(c.slot) }));
  return { schema: 1, limit, limitSource: source, slots, containers };
}

// Remove athanor image tags whose last use is older than `days` days.
export async function prune(options = {}) {
  const { docker = ['docker'], dryRun = false } = options;
  const home = stateFolder();
  clearStale(home);
  const machine = readMachineConfig(home);
  const days = options.days ?? machine.pruneDays ?? DEFAULTS.pruneDays;
  const inUse = new Set((await listSlotContainers(docker)).map((c) => c.image));
  const removed = [];
  const kept = [];
  const now = Date.now();
  for (const tag of await listAthanorImages(docker)) {
    const match = tag.match(TAG_PATTERN);
    if (!match) continue;
    const mark = join(home, 'images', match[1]);
    if (!existsSync(mark)) {
      if (!dryRun) markUse(home, match[1]);
      kept.push(tag);
      continue;
    }
    if (inUse.has(tag) || now - statSync(mark).mtimeMs <= days * DAY_MS) {
      kept.push(tag);
      continue;
    }
    if (dryRun || (await removeImage(docker, tag))) removed.push(tag);
    else kept.push(tag);
  }
  return { schema: 1, dryRun, removed, kept };
}

