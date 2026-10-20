// Calls to the Docker CLI. `docker` is the command as an argument-array
// prefix (default ['docker']); tests stand a fake in its place.
import { call } from './proc.mjs';
import { AthanorError } from './errors.mjs';

const firstLine = (text) => String(text).trim().split('\n')[0]?.trim() ?? '';
const noSuch = (text) => /no such (container|object|image)/i.test(text);

// athanor uses Docker as the user has it configured, local or remote (ADR 0012).
// It checks only that the engine answers, and reads the builder's driver so a
// docker-container builder can be told to load its image into the engine.
export async function prepareDocker(docker) {
  const version = await call([...docker, 'version', '--format', '{{.Server.Version}}']);
  if (version.code !== 0) {
    throw new AthanorError(`Docker is not reachable: docker version failed (${firstLine(version.stderr) || `exit ${version.code}`}). Start Docker, then run again.`);
  }
  const builder = await call([...docker, 'buildx', 'inspect']);
  // [ \t] so an empty value never reads on into the next line.
  const driver = builder.code === 0 ? builder.stdout.match(/^Driver:[ \t]*(\S*)/m)?.[1] || null : null;
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
