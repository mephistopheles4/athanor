// The server container settings (issue 35, ADR 0034): the one place that says
// what reaches a server's container. It gets the working tree read-only, one
// anonymous volume per writable folder, a bridge network, and one port
// published on 127.0.0.1. It keeps run's controls (ADR 0016): every capability
// dropped and six added back, no-new-privileges, the limits, and the ten proxy
// names set empty with `-e NAME=`. It gets no other -e, no -v and no
// --privileged. The arguments live only here, and nothing is put into the boot
// script. A second, short-lived container (checkSettings) checks the writable
// folders in the image; src/container-settings.ts makes run's arguments.
import type { Limits } from './run-config.js';
import { KEPT_CAPABILITIES, PROXY_NAMES } from './container-settings.js';

// The server's boot script, fixed text joined with \n so no checkout's line
// endings can reach sh -c. The first line keeps the container's stdin on
// descriptor 3, because a non-interactive shell gives a background list
// /dev/null as its stdin. The background line ends the server when that stdin
// ends, which happens when the caller's docker process dies. The server runs
// with /dev/null as stdin and no descriptor 3. The marker line is the same text
// as run's MARKER. The kill words are `kill -TERM -1`, not `kill -s TERM -1`:
// dash (Debian and Ubuntu images) reads `-s TERM -1` as an option and refuses.
export const SERVE_BOOT = [
  'exec 3<&0',
  '( cat <&3 >/dev/null; kill -TERM -1; sleep 5; kill -KILL -1 ) &',
  'echo athanor-boot-ok >&2',
  'exec "$@" </dev/null 3<&-',
].join('\n');

export type ServerLimits = Pick<Limits, 'memory' | 'cpus' | 'processes'>;

export interface ServerRequest {
  prefix: string;
  // The server lock, which names the container.
  lock: number;
  tag: string;
  argv: string[];
  // The container port, and the host port when the caller chose one.
  port: number;
  hostPort?: number;
  // The repo root as the engine's machine spells it (the engine is on this machine), and the image's WORKDIR.
  root: string;
  workdir: string;
  // Repo-relative writable folders, in configured order.
  writable: string[];
  limits: ServerLimits;
}

export interface ServerContainer {
  name: string;
  args: string[];
}

const limitArgs = (l: ServerLimits): string[] => [
  '--memory', l.memory, '--memory-swap', l.memory,
  ...(l.cpus !== undefined ? ['--cpus', String(l.cpus)] : []), '--pids-limit', String(l.processes),
];

const controlArgs = (): string[] => [
  '--security-opt', 'no-new-privileges',
  '--cap-drop', 'ALL', ...KEPT_CAPABILITIES.flatMap((c) => ['--cap-add', c]),
  ...PROXY_NAMES.flatMap((n) => ['-e', `${n}=`]),
];

export function serverContainerName(prefix: string, lock: number): string {
  return `${prefix}-server-${lock}`;
}

// The container's fixed name and the arguments after the Docker command.
export function serveSettings(r: ServerRequest): ServerContainer {
  const name = serverContainerName(r.prefix, r.lock);
  const args = [
    'run', '-i', '--init', '--pull', 'never', '--log-driver', 'none',
    '--name', name, '--label', `athanor.server=${r.lock}`, '--network', 'bridge',
    '-p', r.hostPort === undefined ? `127.0.0.1::${r.port}` : `127.0.0.1:${r.hostPort}:${r.port}`,
    '--mount', `type=bind,src=${r.root},dst=${r.workdir},readonly`,
    ...r.writable.flatMap((p) => ['--mount', `type=volume,dst=${r.workdir}/${p}`]),
    '-w', r.workdir,
    ...limitArgs(r.limits),
    ...controlArgs(),
    r.tag, 'sh', '-c', SERVE_BOOT, 'athanor', ...r.argv,
  ];
  return { name, args };
}

// The short-lived container that asks the image whether each writable folder
// exists and can be written by the image's own user. No mount, no network.
export const CHECK_SCRIPT = 'for p; do { [ -d "$p" ] && [ -w "$p" ]; } || echo "$p"; done';

export function checkSettings(r: { prefix: string; hex: string; tag: string; workdir: string; writable: string[]; limits: ServerLimits }): ServerContainer {
  const name = `${r.prefix}-server-check-${r.hex}`;
  const args = [
    'run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--log-driver', 'none',
    '--name', name, '--entrypoint', 'sh',
    ...limitArgs(r.limits),
    ...controlArgs(),
    r.tag, '-c', CHECK_SCRIPT, 'athanor', ...r.writable.map((p) => `${r.workdir}/${p}`),
  ];
  return { name, args };
}
