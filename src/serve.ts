// athanor serve (issue 35, ADR 0034): a repo's dev server in a container, with
// the working tree mounted read-only and one port published on 127.0.0.1. It
// runs until it is aborted or the server exits. Like the rest of the core it
// never prints, exits or registers signal handlers (ADR 0003): it reports
// through callbacks and returns a result.
import { lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { AthanorError, EXIT } from './errors.js';
import { readMachineConfig, resolveServerConfig, resolveServerLimit } from './run-config.js';
import { repoRoot, makeScratch, clearStale, buildContext } from './git.js';
import { stateFolder, markUse, Interrupted, settleImage } from './image.js';
import type { ImageBuild } from './image.js';
import {
  prepareDocker, recheckDocker, readWorkdir, runWritableCheck, publishedAddress, clearServerContainer,
  removeServerContainer, readExit,
} from './docker.js';
import type { DockerCommand } from './docker.js';
import { tryServerLock } from './slots.js';
import type { ServerLock } from './slots.js';
import { start } from './proc.js';
import { markerFilter } from './container-run.js';
import type { Sink } from './container-run.js';
import { serveSettings, checkSettings, serverContainerName } from './serve-settings.js';
import { hasControl, showName } from './copy-out.js';

export type ServeOutcome = 'stopped' | 'exited' | 'memory' | 'error';

export interface ServeOptions {
  // The folder to serve from, inside the repo (default: the current folder).
  cwd?: string;
  // The server's name, from the repo configuration's servers.
  name: string;
  // The host port to publish on, instead of one Docker picks.
  port?: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  // Called once, when the port is published on 127.0.0.1.
  onServing?: (s: Serving) => void;
  // The server's stdout and stderr.
  stdout?: Sink | null;
  stderr?: Sink | null;
  /** @internal For tests (ADR 0003): the Docker command as an argument-array prefix. */
  docker?: DockerCommand;
  /** @internal For tests (ADR 0003): the name prefix for locks and containers. */
  prefix?: string;
  /** @internal For tests (ADR 0003): how long to wait for the published port, in milliseconds. */
  portWaitMs?: number;
  /** @internal For tests (ADR 0003): how often to ask for the published port, in milliseconds. */
  portPollMs?: number;
}

export interface Serving {
  server: string;
  url: string;
  port: number;
  lock: number;
}

export interface ServeResult {
  schema: 1;
  outcome: ServeOutcome;
  exitCode: number;
  // Only when the server started (the container printed athanor's start marker):
  // the ended line leaves it out on a failure before that.
  ranMs?: number;
  message?: string;
  server?: string;
  image?: { tag: string; built: boolean };
  lock?: number;
  url?: string;
  port?: number;
}

const PORT_WAIT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stopped(partial: ServeResult): ServeResult {
  return { ...partial, outcome: 'stopped', exitCode: EXIT.interrupted };
}

// Run the named server until it is stopped or ends. athanor's own failures
// come back as outcome "error", exit 125.
export async function serve(options: ServeOptions): Promise<ServeResult> {
  const partial: ServeResult = { schema: 1, outcome: 'error', exitCode: EXIT.setup };
  try {
    return await serveInner(options, partial);
  } catch (error) {
    if (error instanceof Interrupted) return stopped(partial);
    if (error instanceof AthanorError) return { ...partial, outcome: 'error', exitCode: EXIT.setup, message: error.message };
    throw error;
  }
}

// What the host's path to a writable folder is, and whether it is a folder and
// not a link, on the way or at the end.
function hostFolderProblem(root: string, path: string): 'missing' | 'link' | 'file' | null {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return 'missing';
    }
    if (stat.isSymbolicLink()) return 'link';
    if (!stat.isDirectory()) return 'file';
  }
  return null;
}

async function serveInner(options: ServeOptions, partial: ServeResult): Promise<ServeResult> {
  const {
    cwd = process.cwd(), name, signal, onProgress = () => {}, onServing, stdout = null, stderr = null,
    docker = ['docker'], prefix = 'athanor',
  } = options;
  const env = process.env;
  partial.server = name;
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new AthanorError('--port must be a whole number from 1 to 65535, such as --port 5000.');
  }

  const home = stateFolder();
  clearStale(home);
  const machine = readMachineConfig(home);
  const { limit } = resolveServerLimit(machine);
  const root = await repoRoot(cwd);
  const config = resolveServerConfig(root, machine, name);

  const { notices, driver, checked } = await prepareDocker(docker, env, config.docker, { localOnly: true });
  for (const notice of notices) onProgress(notice);
  const pinned = checked.env;
  const buildOptions = driver === 'docker-container' ? ['--load'] : [];

  const scratch = await makeScratch(home, root);
  let lock: ServerLock | null = null;
  let containerName: string | undefined;
  let removeContainer = false;
  try {
    // The image: found or built as run builds it (ADR 0006).
    const ctx = await buildContext(root, scratch, config.build);
    const image: ImageBuild = { docker, env: pinned, root, scratch, ctx, dockerfile: config.build.dockerfileInContext, buildOptions, stderr, signal };
    partial.image = { tag: ctx.tag, built: false };
    if (await settleImage(image, () => onProgress(`building the test image ${ctx.tag} from ${config.dockerfileAsSet}.`))) {
      partial.image.built = true;
    }
    markUse(home, ctx.hash);
    if (signal?.aborted) return stopped(partial);

    // The mount folder: the image's WORKDIR.
    const rawWorkdir = await readWorkdir(docker, ctx.tag, pinned);
    if (rawWorkdir === null || rawWorkdir === '' || !rawWorkdir.startsWith('/') || /^\/+$/.test(rawWorkdir)) {
      throw new AthanorError(`The image's WORKDIR is ${rawWorkdir === null ? 'not readable' : `"${showName(rawWorkdir)}"`}, and athanor serve mounts your working tree there. Set WORKDIR in the Dockerfile to the folder where it installs the repo's dependencies, an absolute folder other than /.`);
    }
    const workdir = rawWorkdir.replace(/\/+$/, '');

    // Each writable folder: a real folder on the host, athanor never makes one (ADR 0033).
    const missing: string[] = [];
    for (const path of config.writable) {
      const problem = hostFolderProblem(root, path);
      if (problem === 'link') {
        throw new AthanorError(`The writable folder "${showName(path)}" is a link, which athanor does not follow. Replace it with a real folder, or remove it from servers.${showName(name)}.writable.`);
      }
      if (problem === 'file') {
        throw new AthanorError(`The writable folder "${showName(path)}" is a file, not a folder. Rename or remove the file, make the folder, or remove it from servers.${showName(name)}.writable.`);
      }
      if (problem === 'missing') missing.push(path);
    }
    if (missing.length > 0) {
      throw new AthanorError(`The writable folder${missing.length === 1 ? '' : 's'} ${missing.map((p) => `"${showName(p)}"`).join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in the repo, and athanor never writes your working tree. Make ${missing.length === 1 ? 'it' : 'them'} first, such as mkdir -p ${missing.map(showName).join(' ')}, then run again.`);
    }

    // And in the image, a folder its own user can write: a volume on a folder
    // the image lacks starts owned by root.
    if (config.writable.length > 0) {
      const check = checkSettings({
        prefix, hex: randomBytes(6).toString('hex'), tag: ctx.tag, workdir, writable: config.writable, limits: config.limits,
      });
      const bad = await runWritableCheck(docker, check.args, pinned);
      const unwritable = config.writable.filter((p) => bad.includes(`${workdir}/${p}`));
      if (unwritable.length > 0) {
        throw new AthanorError(`The image has no folder its user can write at ${unwritable.map((p) => `${workdir}/${showName(p)}`).join(', ')}, and a volume there would belong to root. In the Dockerfile, after USER and WORKDIR, add RUN mkdir -p ${unwritable.map(showName).join(' ')} (or COPY --chown); if an earlier line made the folder as root, move that line after USER or chown it. Then run again.`);
      }
    }
    if (signal?.aborted) return stopped(partial);

    // The --mount syntax cannot carry these characters.
    const unsafe = (text: string): boolean => /[,"]/.test(text) || hasControl(text);
    if (unsafe(root)) throw new AthanorError('The repo folder\'s path holds a comma, a double quote or a control character, which the mount cannot carry. Move the repo to a path without one, then run again.');
    if (unsafe(workdir)) throw new AthanorError('The image\'s WORKDIR holds a comma, a double quote or a control character, which the mount cannot carry. Change WORKDIR in the Dockerfile, then run again.');

    // A server lock, and the sweep of the containers whose callers were killed.
    lock = await takeLock({ prefix, limit, docker, env: pinned, info: { pid: process.pid, started: Date.now(), repo: basename(root), name } });
    if (!lock) {
      throw new AthanorError(`all ${limit} servers are in use. athanor status shows them; stop one, or raise maxServers in the machine configuration (${machine.file}).`);
    }
    partial.lock = lock.server;
    containerName = serverContainerName(prefix, lock.server);
    await recheckDocker(docker, checked);
    await clearServerContainer(docker, containerName, pinned);
    if (signal?.aborted) return stopped(partial);

    const container = serveSettings({
      prefix, lock: lock.server, tag: ctx.tag, argv: config.argv, port: config.port,
      ...(options.port !== undefined ? { hostPort: options.port } : {}),
      root, workdir, writable: config.writable, limits: config.limits,
    });
    return await runServer({
      docker, env: pinned, container, containerPort: config.port, name, lock, signal, stdout, stderr, onServing,
      portWaitMs: options.portWaitMs ?? PORT_WAIT_MS, portPollMs: options.portPollMs ?? 500,
      started: () => { removeContainer = true; },
    }, partial);
  } finally {
    if (removeContainer && containerName !== undefined) await removeServerContainer(docker, containerName, pinned);
    if (lock) await lock.release();
    scratch.remove();
  }
}

// Take one of the server locks 1..limit, and remove the leftover container of
// every other lock it can take (S2 point 6). A lock it cannot take is left
// alone. When every lock is held, it tries once more after a second, since
// another serve's sweep may hold one for a moment. Null when none is free.
async function takeLock(o: {
  prefix: string; limit: number; docker: DockerCommand; env: NodeJS.ProcessEnv;
  info: { pid: number; started: number; repo: string; name: string };
}): Promise<ServerLock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let mine: ServerLock | null = null;
    const others: ServerLock[] = [];
    for (let n = 1; n <= o.limit; n++) {
      const held = await tryServerLock(o.prefix, n, o.limit, o.info);
      if (!held) continue;
      if (!mine) mine = held;
      else others.push(held);
    }
    try {
      for (const other of others) await clearServerContainer(o.docker, serverContainerName(o.prefix, other.server), o.env);
    } catch (error) {
      await mine?.release();
      throw error;
    } finally {
      for (const other of others) await other.release();
    }
    if (mine) return mine;
    if (attempt === 0) await sleep(1000);
  }
  return null;
}

interface RunServer {
  docker: DockerCommand;
  env: NodeJS.ProcessEnv;
  container: { name: string; args: string[] };
  containerPort: number;
  name: string;
  lock: ServerLock;
  signal?: AbortSignal;
  stdout: Sink | null;
  stderr: Sink | null;
  onServing?: (s: Serving) => void;
  portWaitMs: number;
  portPollMs: number;
  // Called as `docker run` starts, so the container is removed on every path after.
  started: () => void;
}

async function runServer(o: RunServer, partial: ServeResult): Promise<ServeResult> {
  const write = (stream: Sink | null) => (c: Buffer | string) => { stream?.write(c); };
  const filter = markerFilter(write(o.stderr));
  const began = Date.now();
  o.started();
  // The container's stdin is a pipe that is kept open and never written: it ends
  // only when athanor's own process ends (on Linux the boot script's stdin line
  // then ends the server; on Windows the next serve's sweep removes it, ADR 0034),
  // or when a signal arrives. Run's default of no stdin would end it at once.
  const proc = start([...o.docker, ...o.container.args], {
    env: o.env, stdin: 'pipe', capture: false, onStdout: write(o.stdout), onStderr: (c) => filter.push(c),
  });
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    // A signal can come before Docker has made the container, when the remove
    // below finds nothing. Ending the container's stdin ends the server (the boot
    // script's stdin line) once the container does start, and the remove in
    // `serveInner`'s `finally` then takes the container away.
    proc.child.stdin?.destroy();
    void removeServerContainer(o.docker, o.container.name, o.env);
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let exited: { code: number | null } | null = null;
  void proc.done.then((ended) => { exited = ended; });

  try {
    // Ready: the marker has come, then Docker reports the published port.
    let markerAt: number | null = null;
    let address: string | null = null;
    while (!aborted && exited === null) {
      if (filter.seen && markerAt === null) markerAt = Date.now();
      if (markerAt !== null) {
        address = await publishedAddress(o.docker, o.container.name, o.containerPort, o.env);
        if (address !== null) break;
        if (Date.now() - markerAt >= o.portWaitMs) {
          throw new AthanorError('Docker did not report the published port within 30 seconds. Check that Docker is running, then run again.');
        }
      }
      await sleep(o.portPollMs);
    }
    if (address !== null && !aborted && exited === null) {
      const match = address.match(/^127\.0\.0\.1:(\d+)$/);
      if (!match) {
        throw new AthanorError(`Docker published the server's port on ${address.replace(/[^\x20-\x7e]/g, '?')}, not on 127.0.0.1, so athanor stopped it. Check your Docker engine's settings.`);
      }
      const port = Number(match[1]);
      const url = `http://127.0.0.1:${port}/`;
      o.lock.update({ port });
      Object.assign(partial, { url, port });
      o.onServing?.({ server: o.name, url, port, lock: o.lock.server });
    }

    const ended = await proc.done;
    filter.flush();
    const ranMs = Date.now() - began;
    // A signal wins over the server's own exit.
    if (aborted) return stopped(filter.seen ? { ...partial, ranMs } : partial);
    if (!filter.seen) {
      const why = ended.code === 125
        ? 'docker run failed before the server started. Its message is above.'
        : 'the container did not print athanor\'s start marker. The image breaks athanor\'s image contract: it needs sh, and an ENTRYPOINT must run the arguments it is given.';
      return { ...partial, outcome: 'error', exitCode: EXIT.setup, message: `The server never started: ${why}` };
    }
    const state = await readExit(o.docker, o.container.name, o.env);
    if (state?.oom) return { ...partial, outcome: 'memory', exitCode: EXIT.memory, ranMs };
    return { ...partial, outcome: 'exited', exitCode: ended.code ?? state?.exitCode ?? EXIT.setup, ranMs };
  } catch (error) {
    if (error instanceof AthanorError) {
      await removeServerContainer(o.docker, o.container.name, o.env);
      return { ...partial, outcome: 'error', exitCode: EXIT.setup, ranMs: Date.now() - began, message: error.message };
    }
    throw error;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    proc.child.stdin?.destroy();
  }
}
