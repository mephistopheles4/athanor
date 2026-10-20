// The container run: start the container from its arguments, pipe the
// snapshot in, apply the interrupt and the time limit, find the boot marker,
// and return the outcome. What the container gets is decided by the container
// settings, not here.
import { EXIT } from './errors.js';
import { tarStream } from './git.js';
import type { Scratch } from './git.js';
import { readExit, removeContainer } from './docker.js';
import type { DockerCommand } from './docker.js';
import { start, feed } from './proc.js';
import { MARKER } from './container-settings.js';

export type Outcome = 'pass' | 'fail' | 'timeout' | 'memory' | 'interrupted' | 'error';

// Where the test command's output goes, such as process.stdout.
export interface Sink {
  write(chunk: Buffer | string): unknown;
}

export interface ContainerRun {
  docker: DockerCommand;
  root: string;
  scratch: Scratch;
  snapshotId: string;
  // The container's name, and the arguments that start it (from the container settings).
  name: string;
  args: string[];
  timeLimitSeconds: number;
  stdout: Sink | null;
  stderr: Sink | null;
  signal?: AbortSignal;
}

export interface Ran {
  ranMs: number;
  outcome: Outcome;
  exitCode: number;
  message?: string;
}

// Strips the boot marker from the container's stderr and notes that it came.
function markerFilter(write: (chunk: Buffer | string) => void) {
  let seen = false;
  let pending = '';
  return {
    get seen() { return seen; },
    push(chunk: Buffer): void {
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
    flush(): void { if (pending) write(pending); pending = ''; },
  };
}

export async function runContainer(o: ContainerRun): Promise<Ran> {
  const write = (stream: Sink | null) => (c: Buffer | string) => { stream?.write(c); };
  const filter = markerFilter(write(o.stderr));
  const started = Date.now();
  const archive = tarStream(o.root, o.scratch, o.snapshotId, 'snapshot');
  const container = start([...o.docker, ...o.args], {
    stdin: 'pipe', capture: false, onStdout: write(o.stdout), onStderr: (c) => filter.push(c),
  });
  feed(archive, container);

  let timedOut = false;
  let interrupted = false;
  const stop = () => removeContainer(o.docker, o.name);
  const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeLimitSeconds * 1000);
  const onAbort = () => { interrupted = true; stop(); };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const [a, c] = await Promise.all([archive.done, container.done]);
  clearTimeout(timer);
  o.signal?.removeEventListener('abort', onAbort);
  filter.flush();
  const ranMs = Date.now() - started;
  const state = interrupted || timedOut ? null : await readExit(o.docker, o.name);
  await removeContainer(o.docker, o.name);

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
