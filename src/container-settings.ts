// The container settings: the one place that says what reaches the container
// (ADR 0005). The container gets the snapshot on stdin and ATHANOR_GRACE_LIMIT,
// and nothing else from the host: --network none, no-new-privileges, no -v,
// --mount or --privileged, and no other -e. A change here is security-sensitive.
import type { Limits } from './run-config.js';

// The line the boot script prints on stderr just before the test command.
export const MARKER = 'athanor-boot-ok';

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

export interface ContainerRequest {
  // The resolved limits, and the time limit with the grace the in-container
  // timer adds to it, in seconds.
  limits: Limits;
  timeLimitSeconds: number;
  graceSeconds: number;
  // The name prefix and the slot, which name the container.
  prefix: string;
  slot: number;
  tag: string;
  command: string[];
}

// The container's fixed name, and the arguments after the Docker command for
// `docker run` that give it that name. They come together, so the name the
// run stops the container by is always the one it started it with.
export interface Container {
  name: string;
  args: string[];
}

// The options, the image, the boot script and the test command.
export function containerSettings(r: ContainerRequest): Container {
  const name = `${r.prefix}-slot-${r.slot}`;
  const graceLimit = Math.ceil(r.timeLimitSeconds + r.graceSeconds);
  const args = [
    'run', '-i', '--init', '--pull', 'never', '--log-driver', 'none',
    '--name', name, '--label', `athanor.slot=${r.slot}`,
    '--network', 'none',
    '--memory', r.limits.memory, '--memory-swap', r.limits.memory,
    '--cpus', String(r.limits.cpus), '--pids-limit', '1024',
    '--security-opt', 'no-new-privileges',
    '-e', `ATHANOR_GRACE_LIMIT=${graceLimit}`,
    r.tag, 'sh', '-c', BOOT, 'athanor', ...r.command,
  ];
  return { name, args };
}
