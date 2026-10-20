// Calls to the Docker CLI. `docker` is the command as an argument-array
// prefix (default ['docker']); tests stand a fake in its place.
import { call } from './proc.mjs';
import { AthanorError } from './errors.mjs';

// The Docker command as an argument-array prefix, such as ['docker'].
export type DockerCommand = string[];

interface Endpoint {
  host: string;
  tlsVerified: boolean;
  // The setting that chose the endpoint, as messages name it.
  setting: string;
}

interface DockerContext {
  Name?: string;
  Endpoints?: { docker?: { Host?: string; SkipTLSVerify?: boolean } };
  TLSMaterial?: { docker?: string[] };
}

const firstLine = (text: unknown): string => String(text).trim().split('\n')[0]?.trim() ?? '';
const noSuch = (text: string): boolean => /no such (container|object|image)/i.test(text);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// The engine endpoint Docker will use, and whether its TLS is verified:
// DOCKER_HOST when set, else the active context (which honours DOCKER_CONTEXT).
async function engineEndpoint(docker: DockerCommand, env: NodeJS.ProcessEnv): Promise<Endpoint> {
  if (env.DOCKER_HOST !== undefined && env.DOCKER_HOST !== '') {
    const verify = env.DOCKER_TLS_VERIFY !== undefined && env.DOCKER_TLS_VERIFY !== '';
    return { host: env.DOCKER_HOST, tlsVerified: verify, setting: `DOCKER_HOST ("${env.DOCKER_HOST}")` };
  }
  const r = await call([...docker, 'context', 'inspect']);
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
    ? `DOCKER_CONTEXT ("${env.DOCKER_CONTEXT}")`
    : `the active Docker context ("${context?.Name ?? 'unknown'}")`;
  return { host: endpoint.Host ?? '', tlsVerified: material.includes('ca.pem') && endpoint.SkipTLSVerify !== true, setting };
}

// A tcp endpoint without TLS verification sends the snapshot, the build
// context and the test output in clear (ADR 0013). Loopback stays on the machine.
function isPlainRemoteTcp({ host, tlsVerified }: Endpoint): boolean {
  const match = host.match(/^(tcp|http):\/\/(\[[^\]]+\]|[^:/]+)/i);
  if (!match || tlsVerified) return false;
  return !LOOPBACK.has(match[2].toLowerCase());
}

// athanor uses Docker as the user has it configured, local or remote (ADR 0012),
// but refuses a plain tcp endpoint unless the machine configuration allows it
// (ADR 0013). It checks that the engine answers, and reads the builder's driver
// so a docker-container builder can be told to load its image into the engine.
export async function prepareDocker(
  docker: DockerCommand,
  env: NodeJS.ProcessEnv = process.env,
  { allowPlainTcp = false, machineFile = 'config.json' }: { allowPlainTcp?: boolean; machineFile?: string } = {},
): Promise<{ driver: string | null }> {
  const endpoint = await engineEndpoint(docker, env);
  if (!allowPlainTcp && isPlainRemoteTcp(endpoint)) {
    throw new AthanorError(`${endpoint.setting} is a plain tcp endpoint without TLS verification, so the snapshot, the build context and the test output would cross the network unencrypted. Use ssh://, tcp with TLS verification (DOCKER_TLS_VERIFY=1), or a local engine. On a network you trust, you can allow it with "allowPlainTcp": true in the machine configuration (${machineFile}).`);
  }
  const version = await call([...docker, 'version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker version failed (${firstLine(version.stderr) || `exit ${version.code}`}). Start Docker, then run again.`);
  }
  const builder = await call([...docker, 'buildx', 'inspect']);
  // [ \t] so an empty value never reads on into the next line.
  const driver = builder.code === 0 ? builder.stdout.match(/^Driver:[ \t]*(\S*)/m)?.[1] || null : null;
  return { driver };
}

export async function imageExists(docker: DockerCommand, tag: string): Promise<boolean> {
  const r = await call([...docker, 'image', 'inspect', tag]);
  return r.code === 0;
}

// Remove slot n's leftover container, if it is athanor's (C10, C26).
export async function clearSlotContainer(docker: DockerCommand, name: string): Promise<void> {
  const r = await call([...docker, 'container', 'inspect', '--format', '{{json .Config.Labels}}', name]);
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
  const rm = await call([...docker, 'rm', '-f', name]);
  if (rm.code !== 0 && !noSuch(rm.stderr)) {
    throw new AthanorError(`athanor could not remove the old container ${name}: ${firstLine(rm.stderr)}. Remove it yourself, then run again.`);
  }
}

export async function removeContainer(docker: DockerCommand, name: string): Promise<void> {
  await call([...docker, 'rm', '-f', name]);
}

// { exitCode, oom } or null when the read fails.
export async function readExit(docker: DockerCommand, name: string): Promise<{ exitCode: number; oom: boolean } | null> {
  const r = await call([...docker, 'inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}', name]);
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
