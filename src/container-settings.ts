// The container settings: the one place that says what reaches the container
// (ADR 0016). The container gets the snapshot on stdin and ATHANOR_GRACE_LIMIT,
// and nothing else from the host: --network none, no-new-privileges, no -v,
// --mount or --privileged, and no other -e. It drops every Linux capability
// (--cap-drop ALL) and adds back six with --cap-add: an allow-list, so a
// capability a later Docker adds to its defaults does not reach the container.
// The one exception to the environment rule is the ten proxy names, each set
// empty with `-e NAME=`: the Docker CLI fills them from its client
// configuration, and a proxy setting can hold a password. The empty value
// stops that; the bare `-e NAME` would copy the host's value in, so it is
// never used. A change here is security-sensitive.
import type { Limits } from './run-config.js';

// The line the boot script prints on stderr just before the test command.
export const MARKER = 'athanor-boot-ok';

// The line before it that names the work folder, for copy-out (ADR 0023). The
// run strips it with the marker; a line like it after the marker is test output.
export const WORK_PREFIX = 'athanor-work ';

// The six capabilities a test keeps (ADR 0016): five that a root-run test can
// plausibly need, and KILL, which the in-container time limit needs to end a
// test that switched to another user.
export const KEPT_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETUID', 'SETGID'];

// The names the Docker CLI fills from the five proxy settings it reads today.
// The list is fixed (ADR 0016, accepted risk 11 in the threat model).
export const PROXY_NAMES = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'FTP_PROXY', 'ftp_proxy',
  'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy',
];

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
  `echo "${WORK_PREFIX}$(pwd)" >&2`,
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
    ...(r.limits.cpus !== undefined ? ['--cpus', String(r.limits.cpus)] : []), '--pids-limit', String(r.limits.processes),
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL', ...KEPT_CAPABILITIES.flatMap((c) => ['--cap-add', c]),
    '-e', `ATHANOR_GRACE_LIMIT=${graceLimit}`,
    ...PROXY_NAMES.flatMap((n) => ['-e', `${n}=`]),
    r.tag, 'sh', '-c', BOOT, 'athanor', ...r.command,
  ];
  return { name, args };
}
