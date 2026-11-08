// The test image and the state folder, shared by run and serve: find the image
// or build it from the committed build context (ADR 0006).
import { mkdirSync, existsSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AthanorError } from './errors.js';
import { tarStream } from './git.js';
import type { Scratch, BuildContext } from './git.js';
import { imageExists } from './docker.js';
import type { DockerCommand } from './docker.js';
import { start, feed } from './proc.js';
import type { Sink } from './container-run.js';

export function stateFolder(): string {
  const home = process.env.ATHANOR_HOME !== undefined && process.env.ATHANOR_HOME !== ''
    ? process.env.ATHANOR_HOME
    : join(homedir(), '.athanor');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'linux') chmodSync(home, 0o700);
  return home;
}

export function markUse(home: string, hash: string): void {
  const dir = join(home, 'images');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hash);
  const now = new Date();
  if (existsSync(file)) utimesSync(file, now, now);
  else writeFileSync(file, '');
}

// An interrupt that arrived while a step other than the container was running.
export class Interrupted extends Error {}

// What building the run's image needs.
export interface ImageBuild {
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
export async function settleImage(b: ImageBuild, onBuild: () => void): Promise<boolean> {
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
