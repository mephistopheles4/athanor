// Run slots, held by the OS lock the probe selected (ADR 0004): a named pipe
// on Windows, an abstract socket on Linux. The OS frees it when the holder's
// process ends, even after a hard kill.
import net from 'node:net';

export function lockPath(prefix, slot) {
  const name = `${prefix}-slot-${slot}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

// Try to hold one slot. Resolves to a net.Server, or null when it is held.
function tryHold(prefix, slot, info) {
  return new Promise((resolve, reject) => {
    const line = JSON.stringify({ slot, ...info }) + '\n';
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(line);
    });
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(null);
      else reject(error);
    });
    server.listen(lockPath(prefix, slot), () => resolve(server));
  });
}

// Wait for one of slots 1..limit. Resolves to { slot, release } or null if aborted.
export async function acquire({ prefix, limit, info, signal, onWait }) {
  let told = false;
  while (!signal?.aborted) {
    for (let slot = 1; slot <= limit; slot++) {
      const server = await tryHold(prefix, slot, { ...info, limit });
      if (server) {
        server.unref();
        return { slot, release: () => new Promise((r) => server.close(() => r())) };
      }
    }
    if (!told) {
      onWait?.();
      told = true;
    }
    await sleep(1000, signal);
  }
  return null;
}

const isHolderAnswer = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Number.isInteger(v.slot) && Number.isInteger(v.pid) && typeof v.started === 'number' &&
  typeof v.repo === 'string' && Number.isInteger(v.limit);

// Ask slot n's holder. Resolves to { held: false }, { held: true }, or
// { held: true, answer } when it answered with one well-formed JSON line.
export function ask(prefix, slot, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect(lockPath(prefix, slot));
    let data = '';
    let connected = false;
    const done = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done({ held: connected }), timeoutMs);
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) done({ held: true });
    });
    socket.on('error', () => done({ held: connected }));
    socket.on('end', () => {
      const lines = data.split('\n').filter((l) => l !== '');
      let answer;
      if (lines.length === 1) {
        try {
          answer = JSON.parse(lines[0]);
        } catch {
          answer = undefined;
        }
      }
      done(isHolderAnswer(answer) ? { held: true, answer } : { held: true });
    });
  });
}
