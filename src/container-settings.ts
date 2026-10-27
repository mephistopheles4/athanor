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
import { AthanorError } from './errors.js';

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

// The boot script, in three parts: unpack the snapshot, commit it with git,
// then start the timer, print the work line and the marker, and run the test.
const UNPACK = [
  'set -e',
  'mkdir -p "$HOME/work"; cd "$HOME/work"',
  'tar -xm',
];
const COMMIT = [
  'if command -v git >/dev/null 2>&1; then',
  '  git init -q; git add -A',
  '  git -c user.name=athanor -c user.email=athanor@localhost commit -qm athanor',
  'fi',
];
const START = [
  '( sleep "$ATHANOR_GRACE_LIMIT"; kill -s KILL -1 ) &',
  `echo "${WORK_PREFIX}$(pwd)" >&2`,
  `echo ${MARKER} >&2`,
  'exec "$@"',
];

// The boot script, joined with \n so no checkout's line endings can reach sh -c.
export const BOOT = [...UNPACK, ...COMMIT, ...START].join('\n');

// With a carried base (ADR 0032), the commit part becomes this: check the
// four files athanor added, put the history into a fresh repo with the
// repo's object format, read the index from the snapshot's own tree, and
// commit it on top of the host's HEAD only when it differs. Any failure ends
// the boot before the marker; its exit code is not read, since a missing
// marker makes the run an error. `init` is the one line that differs by format.
const baseCommit = (init: string): string[] => [
  'fail() { echo "athanor: $1" >&2; exit 3; }',
  'command -v git >/dev/null 2>&1 || fail "the image has no git, which a run with a base needs. Add git to the image, or run without a base."',
  'b=.athanor-base',
  '{ [ -d "$b" ] && [ ! -L "$b" ]; } || fail "the snapshot has no base folder that athanor made. Run again; if it repeats, check the Docker engine."',
  'n=0; for f in "$b"/* "$b"/.[!.]* "$b"/..?*; do if [ -e "$f" ] || [ -L "$f" ]; then n=$((n+1)); fi; done',
  '[ "$n" = 4 ] || fail "the base folder holds something athanor did not put there. Run again; if it repeats, check the Docker engine."',
  'for f in pack shallow refs tree; do { [ -f "$b/$f" ] && [ ! -L "$b/$f" ]; } || fail "the base folder holds something athanor did not put there. Run again; if it repeats, check the Docker engine."; done',
  'rm -rf "$HOME/.athanor-base"; mv "$b" "$HOME/.athanor-base"; b="$HOME/.athanor-base"',
  init,
  'git index-pack --stdin < "$b/pack" >/dev/null',
  'if [ -s "$b/shallow" ]; then cp "$b/shallow" .git/shallow; fi',
  'git update-ref --stdin < "$b/refs"',
  'git symbolic-ref HEAD refs/heads/athanor',
  'read -r t < "$b/tree"; git read-tree "$t"',
  'git update-index -q --refresh >/dev/null || true',
  'rm -rf "$b"',
  'git diff --cached --quiet HEAD || git -c user.name=athanor -c user.email=athanor@localhost commit -qm athanor',
];

// The base boot scripts, one per object format, fixed text with nothing put
// into it. A git older than 2.29 does not know --object-format and makes sha1.
export const BOOT_BASE_SHA1 = [...UNPACK, ...baseCommit('git init -q --object-format=sha1 2>/dev/null || git init -q'), ...START].join('\n');
export const BOOT_BASE_SHA256 = [...UNPACK, ...baseCommit('git init -q --object-format=sha256'), ...START].join('\n');

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
  // The repo's object format when a base is carried, which picks the base boot script.
  baseFormat?: string;
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
    r.tag, 'sh', '-c', bootFor(r.baseFormat), 'athanor', ...r.command,
  ];
  return { name, args };
}

// The boot script: BOOT, or with a base the fixed script for its format, by
// an exact match.
function bootFor(format: string | undefined): string {
  if (format === undefined) return BOOT;
  if (format === 'sha1') return BOOT_BASE_SHA1;
  if (format === 'sha256') return BOOT_BASE_SHA256;
  throw new AthanorError(`This repo's git object format is "${format}", which a run with a base cannot carry. Run without a base.`);
}
