// athanor's core API: run, status and prune (ADR 0003). It never prints,
// exits or registers signal handlers: it reports progress through onProgress,
// stops on an AbortSignal, and returns a result.
import { mkdirSync, existsSync, utimesSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { AthanorError, EXIT } from './errors.js';
import { readMachineConfig, resolveRunLimit, resolveRunConfig, DEFAULTS } from './run-config.js';
import { repoRoot, makeScratch, clearStale, snapshot, buildContext, tarStream } from './git.js';
import type { Scratch, BuildContext } from './git.js';
import { prepareDocker, recheckDocker, imageExists, clearSlotContainer, listSlotContainers, listAthanorImages, removeImage } from './docker.js';
import type { DockerCommand } from './docker.js';
import { acquire, ask } from './slots.js';
import type { Slot } from './slots.js';
import { start, feed } from './proc.js';
import { containerSettings } from './container-settings.js';
import { runContainer } from './container-run.js';
import type { Outcome, Sink } from './container-run.js';

export { AthanorError };
export { BOOT } from './container-settings.js';
export type { Outcome, Sink };

const TAG_PATTERN = /^athanor:([0-9a-f]{32})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunOptions {
  // The folder to run in, inside the repo to test (default: the current folder).
  cwd?: string;
  // A command name from the repo configuration's commands, or `command` to give one.
  name?: string;
  command?: string[];
  untracked?: boolean;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  stdout?: Sink | null;
  stderr?: Sink | null;
  /** @internal For tests (ADR 0003): the Docker command as an argument-array prefix. */
  docker?: DockerCommand;
  /** @internal For tests (ADR 0003): the name prefix for pipes and containers. */
  prefix?: string;
  /** @internal For tests (ADR 0003): the time limit, in seconds. */
  timeLimitSeconds?: number;
  /** @internal For tests (ADR 0003): the grace the in-container timer adds, in seconds. */
  graceSeconds?: number;
}

export interface RunResult {
  schema: 1;
  outcome: Outcome;
  exitCode: number;
  image?: { tag: string; built: boolean };
  snapshot?: { id: string; untracked: boolean };
  untrackedLeftOut?: number;
  waitedMs?: number;
  slot?: number;
  ranMs?: number;
  message?: string;
}

// What a run has learned so far, for a result that ends it early.
type SoFar = Omit<RunResult, 'schema' | 'outcome' | 'exitCode'>;

// Every status option is for tests, so the shipped declarations give status()
// no options at all: an empty options type would accept any key.
/** @internal */
export interface StatusOptions {
  /** For tests (ADR 0003): the Docker command as an argument-array prefix. */
  docker?: DockerCommand;
  /** For tests (ADR 0003): the name prefix for pipes and containers. */
  prefix?: string;
}

export interface SlotStatus {
  slot: number;
  // As the holder reports them.
  pid?: number;
  started?: number;
  repo?: string;
  limit?: number;
  held?: true;
}

export interface StatusResult {
  schema: 1;
  limit: number;
  limitSource: 'environment' | 'file' | 'default';
  slots: SlotStatus[];
  containers: { name: string; slot: number; orphan: boolean }[];
}

export interface PruneOptions {
  dryRun?: boolean;
  days?: number;
  /** @internal For tests (ADR 0003): the Docker command as an argument-array prefix. */
  docker?: DockerCommand;
}

export interface PruneResult {
  schema: 1;
  dryRun: boolean;
  removed: string[];
  kept: string[];
}

function stateFolder(): string {
  const home = process.env.ATHANOR_HOME !== undefined && process.env.ATHANOR_HOME !== ''
    ? process.env.ATHANOR_HOME
    : join(homedir(), '.athanor');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'linux') chmodSync(home, 0o700);
  return home;
}

function markUse(home: string, hash: string): void {
  const dir = join(home, 'images');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hash);
  const now = new Date();
  if (existsSync(file)) utimesSync(file, now, now);
  else writeFileSync(file, '');
}

// An interrupt that arrived while a step other than the container was running.
class Interrupted extends Error {}

function errorResult(message: string, partial: SoFar = {}): RunResult {
  return { schema: 1, outcome: 'error', exitCode: EXIT.setup, ...partial, message };
}

function interruptedResult(partial: SoFar): RunResult {
  return { schema: 1, outcome: 'interrupted', exitCode: EXIT.interrupted, ...partial };
}

// Run the named command (or `command`) in a fresh container. Returns the run
// result; athanor's own failures come back as outcome "error", exit 125.
export async function run(options: RunOptions = {}): Promise<RunResult> {
  const partial: SoFar = {};
  try {
    return await runInner(options, partial);
  } catch (error) {
    if (error instanceof Interrupted) return interruptedResult(partial);
    if (error instanceof AthanorError) return errorResult(error.message, partial);
    throw error;
  }
}

// The Run: settle the image, take a snapshot, wait for a slot, run the
// container, and return its outcome.
async function runInner(options: RunOptions, partial: SoFar): Promise<RunResult> {
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
  const config = resolveRunConfig(root, machine, { name, command: override });
  const { limits, command } = config;
  const timeLimitSeconds = options.timeLimitSeconds ?? config.timeLimitSeconds;
  const graceSeconds = options.graceSeconds ?? 60;

  const { driver, notices, checked } = await prepareDocker(docker, env, config.docker);
  for (const notice of notices) onProgress(notice);
  // Every Docker call from here on runs with the checked context and builder pinned.
  const pinned = checked.env;
  // A docker-container builder keeps its result in the build cache unless told to load it.
  const buildOptions = driver === 'docker-container' ? ['--load'] : [];

  const scratch = await makeScratch(home, root);
  let slot: Slot | null = null;
  try {
    // The image: found, or built before waiting for a slot (T1).
    const ctx = await buildContext(root, scratch, config.build);
    const image: ImageBuild = { docker, env: pinned, root, scratch, ctx, dockerfile: config.build.dockerfileInContext, buildOptions, stderr, signal };
    partial.image = { tag: ctx.tag, built: false };
    if (await settleImage(image, () => onProgress(`building the test image ${ctx.tag} from ${config.dockerfileAsSet}.`))) {
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
    // A context or builder edited in place while this run waited would change
    // where the pinned names lead.
    await recheckDocker(docker, checked);

    // A prune may have removed the tag while this run waited.
    if (await settleImage(image, () => onProgress(`the test image ${ctx.tag} is no longer in Docker (a prune may have removed it while this run waited); building it again.`))) {
      partial.image.built = true;
    }
    const container = containerSettings({ limits, timeLimitSeconds, graceSeconds, prefix, slot: slot.slot, tag: ctx.tag, command });
    await clearSlotContainer(docker, container.name, pinned);
    if (signal?.aborted) return interruptedResult(partial);

    const ran = await runContainer({
      docker, env: pinned, root, scratch, snapshotId: snap.id, container, timeLimitSeconds, stdout, stderr, signal,
    });
    markUse(home, ctx.hash);
    return { schema: 1, ...partial, ...ran };
  } finally {
    if (slot) await slot.release();
    scratch.remove();
  }
}

async function warnOnOtherLimits(prefix: string, slot: number, limit: number, onProgress: (line: string) => void): Promise<void> {
  const checks = [];
  for (let n = 1; n <= limit + 1; n++) if (n !== slot) checks.push(ask(prefix, n).then((r) => ({ n, ...r })));
  const answers = await Promise.all(checks);
  const above = answers.find((a) => a.n === limit + 1 && a.held);
  const differs = answers.map((a) => (a.held ? a.answer : undefined)).find((answer) => answer !== undefined && answer.limit !== limit);
  if (above || differs) {
    onProgress(`warning: another caller uses a different run limit (this run uses ${limit}${differs ? `, a holder reports ${differs.limit}` : `, but slot ${limit + 1} is held`}). Set the same ATHANOR_MAX_RUNS or maxRuns for every caller.`);
  }
}

// What building the run's image needs.
interface ImageBuild {
  docker: DockerCommand;
  // The run's environment with the checked Docker context and builder pinned.
  env: NodeJS.ProcessEnv;
  root: string;
  scratch: Scratch;
  ctx: BuildContext;
  // The Dockerfile's path inside the build context.
  dockerfile: string;
  buildOptions: string[];
  stderr: Sink | null;
  signal?: AbortSignal;
}

// Build the image unless Docker already has it; onBuild says so first.
// Returns whether it built.
async function settleImage(b: ImageBuild, onBuild: () => void): Promise<boolean> {
  if (await imageExists(b.docker, b.ctx.tag, b.env)) return false;
  onBuild();
  await build(b);
  return true;
}

async function build({ docker, env, root, scratch, ctx, dockerfile, buildOptions, stderr, signal }: ImageBuild): Promise<void> {
  const archive = tarStream(root, scratch, ctx.commit, 'build context');
  const builder = start([...docker, 'build', ...buildOptions, '-t', ctx.tag, '-f', dockerfile, '-'], {
    env, stdin: 'pipe', capture: true, onStderr: (c) => stderr?.write(c), onStdout: (c) => stderr?.write(c),
  });
  feed(archive, builder);
  // On an interrupt, stop waiting once docker has exited: a buildx plugin it
  // started can hold the output open until the build ends (S4 leaves the build
  // to Docker).
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
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
  if (!(await imageExists(docker, ctx.tag, env))) {
    throw new AthanorError(`The image build finished, but the image ${ctx.tag} is not in Docker. Check that the buildx builder loads its images into the local engine.`);
  }
}

// Who holds each slot, and which athanor containers exist. Starts nothing.
export function status(): Promise<StatusResult>;
/** @internal */
export function status(options: StatusOptions): Promise<StatusResult>;
export async function status(options: StatusOptions = {}): Promise<StatusResult> {
  const { docker = ['docker'], prefix = 'athanor' } = options;
  const home = stateFolder();
  const machine = readMachineConfig(home);
  const { limit, source } = resolveRunLimit(process.env, machine);
  const slots: SlotStatus[] = [];
  const held = new Set<number>();
  for (let n = 1; n <= limit; n++) {
    const r = await ask(prefix, n);
    if (r.held) held.add(n);
    const entry: SlotStatus = { slot: n };
    if (r.held && r.answer) Object.assign(entry, { pid: r.answer.pid, started: r.answer.started, repo: r.answer.repo, limit: r.answer.limit });
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
export async function prune(options: PruneOptions = {}): Promise<PruneResult> {
  const { docker = ['docker'], dryRun = false } = options;
  const home = stateFolder();
  clearStale(home);
  const machine = readMachineConfig(home);
  const days = options.days ?? machine.values.pruneDays ?? DEFAULTS.pruneDays;
  const inUse = new Set((await listSlotContainers(docker)).map((c) => c.image));
  const removed: string[] = [];
  const kept: string[] = [];
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
