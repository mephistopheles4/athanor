// Calls to the Docker CLI. `docker` is the command as an argument-array
// prefix (default ['docker']); tests stand a fake in its place.
import { call } from './proc.mjs';
import { AthanorError } from './errors.mjs';

const firstLine = (text) => String(text).trim().split('\n')[0]?.trim() ?? '';
const isLocalEndpoint = (host) => /^(npipe|unix):\/\//i.test(host ?? '');
const noSuch = (text) => /no such (container|object|image)/i.test(text);

async function contextHost(docker, name) {
  const args = name ? ['context', 'inspect', name] : ['context', 'inspect'];
  const r = await call([...docker, ...args]);
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker context inspect failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  try {
    return JSON.parse(r.stdout)[0].Endpoints.docker.Host;
  } catch {
    throw new AthanorError('Docker is not reachable: docker context inspect gave output athanor cannot read. Check your Docker install.');
  }
}

// Refuse a remote engine, a remote context or a remote or cloud builder (ADR 0008).
export async function checkLocal(docker, env) {
  if (env.DOCKER_HOST !== undefined && !isLocalEndpoint(env.DOCKER_HOST)) {
    throw new AthanorError(`DOCKER_HOST is "${env.DOCKER_HOST}", which is not a local pipe or socket. athanor only uses a local Docker engine: unset DOCKER_HOST, or set it to an npipe:// or unix:// address.`);
  }
  const host = await contextHost(docker);
  if (!isLocalEndpoint(host)) {
    const setting = env.DOCKER_CONTEXT !== undefined ? `DOCKER_CONTEXT ("${env.DOCKER_CONTEXT}")` : 'the active Docker context';
    throw new AthanorError(`${setting} points at "${host}", which is not a local engine. athanor only uses a local Docker engine: switch to a local context.`);
  }
  const setting = env.BUILDX_BUILDER !== undefined ? `BUILDX_BUILDER ("${env.BUILDX_BUILDER}")` : 'the active buildx builder';
  const builder = await call([...docker, 'buildx', 'inspect']);
  if (builder.code !== 0) {
    // No buildx: the classic builder runs in the local engine.
    if (/is not a docker command|unknown command/i.test(builder.stderr)) return { driver: null };
    if (env.BUILDX_BUILDER !== undefined) {
      throw new AthanorError(`${setting} could not be read (${firstLine(builder.stderr) || `exit ${builder.code}`}), so athanor cannot confirm the builder is local. Name a builder that exists, or unset BUILDX_BUILDER.`);
    }
    throw new AthanorError(`Docker is not reachable: docker buildx inspect failed (${firstLine(builder.stderr) || `exit ${builder.code}`}). Start Docker, then run again.`);
  }
  // [ \t] so an empty value never reads on into the next line.
  const driver = builder.stdout.match(/^Driver:[ \t]*(\S*)/m)?.[1] ?? '';
  const endpoints = [...builder.stdout.matchAll(/^Endpoint:[ \t]*(\S*)/gm)].map((m) => m[1]);
  if (driver === '' || /^Error:/m.test(builder.stdout)) {
    if (env.BUILDX_BUILDER !== undefined) {
      throw new AthanorError(`${setting} shows no builder driver: its builder is unreachable or does not exist, so athanor cannot confirm it is local. Name a local builder, or unset BUILDX_BUILDER.`);
    }
    throw new AthanorError('Docker is not reachable: docker buildx inspect shows no builder driver, so athanor cannot confirm the builder is local. Start Docker, then run again.');
  }
  const notLocal = (detail) =>
    new AthanorError(`${setting} ${detail}, which is not a local builder. athanor only builds locally: use the docker driver, or docker-container, on a local engine.`);
  if (driver !== 'docker' && driver !== 'docker-container') throw notLocal(`uses the "${driver}" driver`);
  if (endpoints.length === 0) throw notLocal('lists no node endpoint');
  // Every node must be local: a pipe or socket, or a context whose engine is one.
  for (const endpoint of endpoints) {
    if (isLocalEndpoint(endpoint)) continue;
    if (endpoint !== '' && !endpoint.includes('://') && isLocalEndpoint(await contextHost(docker, endpoint).catch(() => ''))) continue;
    throw notLocal(`has a node at "${endpoint}"`);
  }
  return { driver };
}

export async function imageExists(docker, tag) {
  const r = await call([...docker, 'image', 'inspect', tag]);
  return r.code === 0;
}

// Remove slot n's leftover container, if it is athanor's (C10, C26).
export async function clearSlotContainer(docker, name) {
  const r = await call([...docker, 'container', 'inspect', '--format', '{{json .Config.Labels}}', name]);
  if (r.code !== 0) {
    if (noSuch(r.stderr)) return;
    throw new AthanorError(`athanor could not check for an old container named ${name}: ${firstLine(r.stderr)}.`);
  }
  let labels = {};
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

export async function removeContainer(docker, name) {
  await call([...docker, 'rm', '-f', name]);
}

// { exitCode, oom } or null when the read fails.
export async function readExit(docker, name) {
  const r = await call([...docker, 'inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}', name]);
  if (r.code !== 0) return null;
  const [code, oom] = r.stdout.trim().split(/\s+/);
  const exitCode = Number(code);
  if (!Number.isInteger(exitCode)) return null;
  return { exitCode, oom: oom === 'true' };
}

// Every container with an athanor slot label: [{ name, slot, image }].
export async function listSlotContainers(docker) {
  const r = await call([...docker, 'ps', '-a', '--filter', 'label=athanor.slot', '--format', '{{.Names}}\t{{.Label "athanor.slot"}}\t{{.Image}}']);
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker ps failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name, slot, image] = line.split('\t');
    return { name, slot: Number(slot), image };
  });
}

export async function listAthanorImages(docker) {
  const r = await call([...docker, 'images', '--format', '{{.Repository}}:{{.Tag}}', 'athanor']);
  if (r.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker images failed (${firstLine(r.stderr) || `exit ${r.code}`}). Start Docker, then run again.`);
  }
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function removeImage(docker, tag) {
  const r = await call([...docker, 'rmi', tag]);
  return r.code === 0;
}
