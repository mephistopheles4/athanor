// Calls to the Docker CLI. `docker` is the command as an argument-array
// prefix (default ['docker']); tests stand a fake in its place.
import { call } from './proc.js';
import { AthanorError } from './errors.js';

// The Docker command as an argument-array prefix, such as ['docker'].
export type DockerCommand = string[];

interface Endpoint {
  host: string;
  tlsVerified: boolean;
  // The setting that chose the endpoint, as messages name it, in the shown form.
  setting: string;
  // The context it came from, when DOCKER_HOST is not set.
  context?: string;
}

interface DockerContext {
  Name?: string;
  Endpoints?: { docker?: { Host?: string; SkipTLSVerify?: boolean } };
  TLSMaterial?: { docker?: string[] };
}

// The first line of Docker's output, as athanor quotes it. Besides the shown
// form, it drops the login the Docker CLI's ssh helper names in its own error
// text: "-l <user>", and "<user>@<host>" (but not "<image>@sha256:...").
const firstLine = (text: unknown): string => shown(
  (String(text).trim().split('\n')[0]?.trim() ?? '')
    .replace(/(^|\s)-l\s+\S+/g, '$1-l')
    .replace(/(^|[\s=[(])[\w.-]+@(?!sha\d+:)(?=[\w[])/g, '$1'),
);
const noSuch = (text: string): boolean => /no such (container|object|image)/i.test(text);

// Node's URL parser writes an IPv6 host with its brackets.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

const escaped = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// A line of text as athanor shows it: without the user-info part of any
// address in it, which can hold a user name and a password, and with control
// characters escaped (ADR 0021).
export function shown(text: string): string {
  const out = text.includes('://')
    // From after :// to the last @ before the first /, ? or #.
    ? text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1')
    : /^\S*@\S*$/.test(text) ? text.slice(text.lastIndexOf('@') + 1) : text;
  return escaped(out);
}

// One endpoint or setting value as athanor shows it. A user-info part that
// holds a character the URL rules end it at (/, ?, # or a space) is removed
// too: everything up to the value's last @.
export function shownValue(value: string): string {
  const first = shown(value);
  if (!first.includes('@')) return first;
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? '';
  return escaped(scheme + value.slice(value.lastIndexOf('@') + 1));
}

// Docker reads an endpoint with no "://" as a tcp host: "unix:/x" is tcp to a
// host named "unix", and "10.0.0.5:2375" is plain tcp. The checks read it the
// same way.
const asDockerReads = (host: string): string => (host === '' || host.includes('://') ? host : `tcp://${host}`);

const parse = (host: string): URL | null => {
  try {
    return new URL(host);
  } catch {
    return null;
  }
};

// Whether an endpoint is on this machine: a unix socket, a pipe on this machine
// in its one exact form, or tcp to loopback with no user-info. Anything else,
// ssh included, is not (ADR 0021).
export function isLocal(endpoint: string): boolean {
  const host = asDockerReads(endpoint);
  if (/^npipe:/i.test(host)) {
    // Read as raw text: the URL parser drops the "." that names this machine.
    const name = host.match(/^npipe:\/\/\/\/\.\/pipe\/([^/\\]+)$/i)?.[1];
    return name !== undefined && name !== '.' && name !== '..';
  }
  const url = parse(host);
  if (!url || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'unix:') return host.startsWith('unix://') && url.hostname === '' && url.pathname.length > 1;
  if (url.protocol === 'tcp:' || url.protocol === 'http:') return LOOPBACK.has(url.hostname.toLowerCase());
  return false;
}

// The engine endpoint Docker will use, and whether its TLS is verified:
// DOCKER_HOST when set, else the active context (which honours DOCKER_CONTEXT).
async function engineEndpoint(docker: DockerCommand, env: NodeJS.ProcessEnv): Promise<Endpoint> {
  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST !== '') {
    const verify = env.DOCKER_TLS_VERIFY !== undefined && env.DOCKER_TLS_VERIFY !== '';
    return { host: env.DOCKER_HOST, tlsVerified: verify, setting: `DOCKER_HOST ("${shownValue(env.DOCKER_HOST)}")` };
  }
  const r = await call([...docker, 'context', 'inspect'], { env });
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker context inspect failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  let context: DockerContext | undefined;
  try {
    context = JSON.parse(r.stdout)[0];
  } catch {
    throw new AthanorError('docker context inspect gave output athanor cannot read. Check your Docker install.');
  }
  const endpoint = context?.Endpoints?.docker ?? {};
  const material = context?.TLSMaterial?.docker ?? [];
  const setting = env.DOCKER_CONTEXT !== undefined && env.DOCKER_CONTEXT !== ''
    ? `DOCKER_CONTEXT ("${shownValue(env.DOCKER_CONTEXT)}")`
    : `the active Docker context ("${shownValue(context?.Name ?? 'unknown')}")`;
  return { host: endpoint.Host ?? '', tlsVerified: material.includes('ca.pem') && endpoint.SkipTLSVerify !== true, setting, context: context?.Name };
}

// A tcp endpoint without TLS verification sends the snapshot, the build
// context and the test output in clear (ADR 0013). Loopback stays on the machine.
function isPlainRemoteTcp({ host: endpoint, tlsVerified }: { host: string; tlsVerified: boolean }): boolean {
  const host = asDockerReads(endpoint);
  if (!/^(tcp|http):/i.test(host) || tlsVerified) return false;
  const url = parse(host);
  return !url || !LOOPBACK.has(url.hostname.toLowerCase());
}

// A builder node's transport counts as read only for a local endpoint, ssh, or
// tcp with TLS verified. Anything else, a buildx connection helper among them,
// counts as plain (ADR 0021).
function isPlainBuilderTarget(target: { host: string; tlsVerified: boolean }): boolean {
  const host = asDockerReads(target.host);
  if (isLocal(host) || /^ssh:\/\//i.test(host)) return false;
  if (/^(tcp|http):\/\//i.test(host)) return isPlainRemoteTcp(target);
  return true;
}

export interface DockerOptions {
  allowPlainTcp?: boolean;
  allowRemoteDocker?: boolean;
  machineFile?: string;
}

// What prepareDocker checked, for the check again once the run holds its slot.
export interface Checked {
  // The run's environment with the pin merged over it: every later Docker
  // call runs with it.
  env: NodeJS.ProcessEnv;
  engine: string;
  // Undefined when buildx is missing and the classic builder runs in the engine.
  builder?: string;
}

const engineSeen = (e: { host: string; tlsVerified: boolean }): string => JSON.stringify([e.host, e.tlsVerified]);

// athanor uses the Docker engine and builder on this machine, or on another
// one when the machine configuration allows it (ADR 0021), and never plain tcp
// unless the machine configuration allows that too (ADR 0013). It checks that
// the engine answers, and reads the builder's driver so a docker-container
// builder can be told to load its image into the engine. What it checked is
// pinned: every later Docker call gets the checked context and builder by name.
export async function prepareDocker(
  docker: DockerCommand,
  env: NodeJS.ProcessEnv = process.env,
  { allowPlainTcp = false, allowRemoteDocker = false, machineFile = 'config.json' }: DockerOptions = {},
): Promise<{ driver: string | null; notices: string[]; checked: Checked }> {
  const notices: string[] = [];
  const endpoint = await engineEndpoint(docker, env);
  if (!allowPlainTcp && isPlainRemoteTcp(endpoint)) {
    throw new AthanorError(`${endpoint.setting} is a plain tcp endpoint without TLS verification, so the snapshot, the build context and the test output would cross the network unencrypted. Use ssh://, tcp with TLS verification (DOCKER_TLS_VERIFY=1), or a local engine. On a network you trust, you can allow it with "allowPlainTcp": true in the machine configuration (${machineFile}).`);
  }
  const local = isLocal(endpoint.host);
  if (!allowRemoteDocker && !local) {
    throw new AthanorError(`${endpoint.setting} is a Docker engine at ${shownValue(endpoint.host) || 'an address athanor cannot read'}, which is not on this machine, so your build context and snapshot, uncommitted changes included, would go to that machine. Use a Docker engine on this machine, or set "allowRemoteDocker": true in the machine configuration (${machineFile}).`);
  }
  if (!local) {
    notices.push(`using a Docker engine on another machine, ${shownValue(endpoint.host)} (from ${endpoint.setting}): your build context and snapshot go there.`);
  }
  // Merged over the run's own environment, so DOCKER_HOST, its TLS settings
  // and PATH reach every call unchanged.
  const pinned: NodeJS.ProcessEnv = endpoint.context !== undefined ? { ...env, DOCKER_CONTEXT: endpoint.context } : { ...env };
  const version = await call([...docker, 'version', '--format', '{{.Server.Version}}'], { env: pinned });
  if (version.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker version failed (${firstLine(version.stderr) || `exit ${version.code}`}). Start Docker, then run again.`);
  }
  const builder = await checkBuilder(docker, pinned, { allowPlainTcp, allowRemoteDocker, machineFile }, endpoint);
  if (builder.notice) notices.push(builder.notice);
  if (builder.name !== undefined) pinned.BUILDX_BUILDER = builder.name;
  return { driver: builder.driver, notices, checked: { env: pinned, engine: engineSeen(endpoint), builder: builder.seen } };
}

// The engine and builder read again under the pin, once the run holds its
// slot: a context or builder edited in place while the run waited would change
// where the pinned names lead (ADR 0021).
export async function recheckDocker(docker: DockerCommand, checked: Checked): Promise<void> {
  const endpoint = await engineEndpoint(docker, checked.env);
  const builder = checked.builder === undefined ? undefined : (await resolveBuilder(docker, checked.env, endpoint)).seen;
  if (engineSeen(endpoint) !== checked.engine || builder !== checked.builder) {
    throw new AthanorError('The Docker engine or the buildx builder changed while the run waited for a slot, so athanor cannot be sure where the snapshot would go. Check your Docker context and builder, then run again.');
  }
}

interface BuilderNode {
  endpoint: string;
  cacert: boolean;
}

// `docker buildx inspect` read strictly, as buildx prints it: the builder's
// Name and Driver first, an Error line before Nodes when it could not load a
// node, then one block per node starting with its Name. A CA option counts
// only from the Driver Options line straight after that node's Endpoint, since
// later lines (labels) carry text the daemon chose. Null when athanor cannot
// read it.
function readBuilder(stdout: string): { name: string; driver: string; nodes: BuilderNode[] } | null {
  const lines = stdout.split(/\r?\n/);
  const name = (lines[0] ?? '').match(/^Name:[ \t]*(\S+)[ \t]*$/)?.[1];
  const driver = (lines[1] ?? '').match(/^Driver:[ \t]*(\S+)[ \t]*$/)?.[1];
  if (!name || !driver) return null;
  const start = lines.indexOf('Nodes:');
  if (lines.slice(0, start === -1 ? lines.length : start).some((l) => l.startsWith('Error:'))) return null;
  if (start === -1) return { name, driver, nodes: [] };
  const nodes: BuilderNode[] = [];
  let keys: Set<string> | null = null;
  let node: { endpoint?: string; cacert: boolean } | null = null;
  const close = (): boolean => {
    if (node?.endpoint !== undefined && node.endpoint !== '') nodes.push({ endpoint: node.endpoint, cacert: node.cacert });
    return true;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const key = line.match(/^(Name|Endpoint|Driver Options):/)?.[1];
    if (key === 'Name') {
      close();
      keys = new Set(['Name']);
      node = { cacert: false };
      continue;
    }
    if (!keys || !node) {
      if (line.trim() !== '') return null;
      continue;
    }
    if (key === undefined) continue;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = line.slice(key.length + 1).trim();
    if (key === 'Endpoint') node.endpoint = value;
    else if (/^Endpoint:/.test(lines[i - 1] ?? '')) node.cacert = /(^|[\s,])cacert=/.test(value);
  }
  close();
  return { name, driver, nodes };
}

// Docker's context-name pattern; anything else is never passed to `context inspect`.
const CONTEXT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]+$/;

async function namedContext(docker: DockerCommand, env: NodeJS.ProcessEnv, name: string): Promise<{ host: string; tlsVerified: boolean } | null> {
  const r = await call([...docker, 'context', 'inspect', '--', name], { env });
  if (r.code !== 0) return null;
  try {
    const context: DockerContext | undefined = JSON.parse(r.stdout)[0];
    const host = context?.Endpoints?.docker?.Host ?? '';
    if (host === '') return null;
    const material = context?.TLSMaterial?.docker ?? [];
    return { host, tlsVerified: material.includes('ca.pem') && context?.Endpoints?.docker?.SkipTLSVerify !== true };
  } catch {
    return null;
  }
}

type Target = { host: string; tlsVerified: boolean } | null;

// Whether a builder is the engine's own: the docker builder buildx makes for
// the engine's context, whose node is that context, or "default" when the
// engine came from DOCKER_HOST (as buildx names it then).
const isEnginesOwn = (read: { driver: string; nodes: BuilderNode[] }, engine: Endpoint): boolean =>
  read.driver === 'docker' && read.nodes.length === 1 && read.nodes[0]?.endpoint === (engine.context ?? 'default');

// The builder as `buildx inspect` shows it, each node's endpoint resolved to
// where it leads (null when athanor cannot tell), and all of it as one string
// to compare on the check again. The engine's own builder leads to the engine
// as already checked, TLS setting included.
async function resolveBuilder(docker: DockerCommand, env: NodeJS.ProcessEnv, engine: Endpoint) {
  const inspect = await call([...docker, 'buildx', 'inspect'], { env });
  const read = inspect.code === 0 ? readBuilder(inspect.stdout) : null;
  const targets: Target[] = [];
  const own = read !== null && isEnginesOwn(read, engine);
  for (const node of read?.nodes ?? []) {
    if (own) targets.push({ host: engine.host, tlsVerified: engine.tlsVerified });
    else if (node.endpoint.includes('://')) targets.push({ host: node.endpoint, tlsVerified: node.cacert });
    else targets.push(CONTEXT_NAME.test(node.endpoint) ? await namedContext(docker, env, node.endpoint) : null);
  }
  const seen = JSON.stringify(read ? [read.name, read.driver, read.nodes, targets] : null);
  return { inspect, read, targets, own, seen };
}

// The buildx builder gets the build context, so it is held to the engine's
// rules: on this machine unless allowRemoteDocker, and never in clear unless
// allowPlainTcp. A builder whose transport athanor could not read counts as
// in clear (ADR 0021).
async function checkBuilder(
  docker: DockerCommand,
  env: NodeJS.ProcessEnv,
  { allowPlainTcp, allowRemoteDocker, machineFile }: Required<DockerOptions>,
  engine: Endpoint,
): Promise<{ driver: string | null; name?: string; notice?: string; seen?: string }> {
  // Asking buildx for its version contacts nothing; without buildx the classic
  // builder runs in the engine, which is already checked.
  const present = await call([...docker, 'buildx', 'version'], { env });
  if (present.code !== 0) return { driver: null };
  const setting = env.BUILDX_BUILDER !== undefined && env.BUILDX_BUILDER !== ''
    ? `BUILDX_BUILDER ("${shownValue(env.BUILDX_BUILDER)}")`
    : 'the active buildx builder';
  const optIn = `"allowRemoteDocker": true in the machine configuration (${machineFile})`;
  const { inspect, read, targets, own, seen } = await resolveBuilder(docker, env, engine);
  if (!read) {
    const why = inspect.code !== 0 ? `docker buildx inspect failed (${firstLine(inspect.stderr) || `exit ${inspect.code}`})` : 'docker buildx inspect gave output athanor cannot read';
    if (!allowRemoteDocker || !allowPlainTcp) {
      throw new AthanorError(`${setting} could not be inspected: ${why}. athanor cannot tell where your build context would go, or whether it would be encrypted. Install or repair buildx, or set both "allowRemoteDocker": true and "allowPlainTcp": true in the machine configuration (${machineFile}).`);
    }
    // No name was read: the pin keeps BUILDX_BUILDER when it is set, and
    // otherwise the run is unpinned for the builder and says so.
    const name = env.BUILDX_BUILDER || undefined;
    return {
      driver: null,
      name,
      notice: `using a buildx builder athanor could not inspect (from ${setting}): your build context may go to another machine${name === undefined ? ', and athanor cannot pin it for this run' : ''}.`,
      seen,
    };
  }

  const known = ['docker', 'docker-container', 'remote'].includes(read.driver);
  let away: string | null = known && read.nodes.length > 0 ? null : read.nodes[0]?.endpoint ?? 'no endpoint athanor could read';
  let plain = !known || read.nodes.length === 0;
  for (const [i, node] of (known ? read.nodes : []).entries()) {
    const target = targets[i];
    if (!target) {
      away ??= node.endpoint;
      plain = true;
      continue;
    }
    if (!isLocal(target.host)) away ??= node.endpoint;
    // The engine's own builder is the engine, already held to the engine's rule.
    if (own ? isPlainRemoteTcp(target) : isPlainBuilderTarget(target)) plain = true;
  }
  // Plain tcp first, as for the engine.
  if (plain && !allowPlainTcp) {
    throw new AthanorError(`${setting} (driver ${shownValue(read.driver)}) is reached over plain tcp without TLS verification, or by a way athanor cannot read, so your build context could cross the network unencrypted. Use a builder on this machine, over ssh or tcp with TLS verification, or on a network you trust set "allowPlainTcp": true in the machine configuration (${machineFile}).`);
  }
  if (away !== null && !allowRemoteDocker) {
    throw new AthanorError(`${setting} (driver ${shownValue(read.driver)}) builds at ${shownValue(away)}, which is not on this machine, so your build context would go there. Switch to a builder on this machine (for example docker buildx use default), or set ${optIn}.`);
  }
  // The engine notice already names the engine's own docker builder.
  const notice = away !== null && !own
    ? `using a buildx builder on another machine, ${shownValue(read.name)} (${shownValue(read.driver)}, ${shownValue(away)}): your build context goes there.`
    : undefined;
  return { driver: read.driver, name: read.name, notice, seen };
}

// The env arguments below are a run's pinned environment (Checked.env); status
// and prune pass none and use Docker as configured.
export async function imageExists(docker: DockerCommand, tag: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await call([...docker, 'image', 'inspect', tag], { env });
  return r.code === 0;
}

// Remove slot n's leftover container, if it is athanor's (C10, C26).
export async function clearSlotContainer(docker: DockerCommand, name: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const r = await call([...docker, 'container', 'inspect', '--format', '{{json .Config.Labels}}', name], { env });
  if (r.code !== 0) {
    if (noSuch(r.stderr)) return;
    throw new AthanorError(`athanor could not check for an old container named ${name}: ${firstLine(r.stderr)}.`);
  }
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(r.stdout) ?? {};
  } catch {
    labels = {};
  }
  if (labels['athanor.slot'] === undefined) {
    throw new AthanorError(`A container named ${name} exists without athanor's label, so athanor leaves it alone and cannot use this slot. Rename or remove that container yourself.`);
  }
  const rm = await call([...docker, 'rm', '-f', name], { env });
  if (rm.code !== 0 && !noSuch(rm.stderr)) {
    throw new AthanorError(`athanor could not remove the old container ${name}: ${firstLine(rm.stderr)}. Remove it yourself, then run again.`);
  }
}

export async function removeContainer(docker: DockerCommand, name: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await call([...docker, 'rm', '-f', name], { env });
}

// { exitCode, oom } or null when the read fails.
export async function readExit(docker: DockerCommand, name: string, env?: NodeJS.ProcessEnv): Promise<{ exitCode: number; oom: boolean } | null> {
  const r = await call([...docker, 'inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}', name], { env });
  if (r.code !== 0) return null;
  const [code, oom] = r.stdout.trim().split(/\s+/);
  const exitCode = Number(code);
  if (!Number.isInteger(exitCode)) return null;
  return { exitCode, oom: oom === 'true' };
}

// Every container with an athanor slot label: [{ name, slot, image }].
export async function listSlotContainers(docker: DockerCommand): Promise<{ name: string; slot: number; image: string }[]> {
  const r = await call([...docker, 'ps', '-a', '--filter', 'label=athanor.slot', '--format', '{{.Names}}\t{{.Label "athanor.slot"}}\t{{.Image}}']);
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker ps failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  return r.stdout.split('\n').map((l: string) => l.trim()).filter(Boolean).map((line: string) => {
    const [name, slot, image] = line.split('\t');
    return { name, slot: Number(slot), image };
  });
}

export async function listAthanorImages(docker: DockerCommand): Promise<string[]> {
  const r = await call([...docker, 'images', '--format', '{{.Repository}}:{{.Tag}}', 'athanor']);
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker images failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  return r.stdout.split('\n').map((l: string) => l.trim()).filter(Boolean);
}

export async function removeImage(docker: DockerCommand, tag: string): Promise<boolean> {
  const r = await call([...docker, 'rmi', tag]);
  return r.code === 0;
}
