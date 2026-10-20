// Run slots, held by the OS lock the probe selected (ADR 0004): a named pipe
// on Windows, an abstract socket on Linux. The OS frees it when the holder's
// process ends, even after a hard kill.
import net from 'node:net';

// What a holder tells whoever asks; `slot` and `limit` are added when it holds.
export type HolderInfo = { pid: number; started: number; repo: string; [key: string]: unknown };

export type HolderAnswer = HolderInfo & { slot: number; limit: number };

export type Slot = { slot: number; release: () => Promise<void> };

// Slot n's state: not held, held with no usable answer, or held with one.
export type Asked = { held: false } | { held: true; answer?: HolderAnswer };

export function lockPath(prefix: string, slot: number): string {
  const name = `${prefix}-slot-${slot}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Try to hold one slot. Resolves to a net.Server, or null when it is held.
function tryHold(prefix: string, slot: number, info: Record<string, unknown>): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const line = JSON.stringify({ slot, ...info }) + '\n';
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(line);
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(null);
      else reject(error);
    });
    server.listen(lockPath(prefix, slot), () => resolve(server));
  });
}

// Wait for one of slots 1..limit. Resolves to { slot, release } or null if aborted.
export async function acquire({ prefix, limit, info, signal, onWait }: {
  prefix: string;
  limit: number;
  info: HolderInfo;
  signal?: AbortSignal;
  onWait?: () => void;
}): Promise<Slot | null> {
  let told = false;
  while (!signal?.aborted) {
    for (let slot = 1; slot <= limit; slot++) {
      const server = await tryHold(prefix, slot, { ...info, limit });
      if (server) {
        server.unref();
        return { slot, release: () => new Promise<void>((r) => server.close(() => r())) };
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

const isHolderAnswer = (v: any): v is HolderAnswer =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Number.isInteger(v.slot) && Number.isInteger(v.pid) && Number.isFinite(new Date(v.started).getTime()) && typeof v.started === 'number' &&
  // No control characters, so an answer cannot draw on the terminal that shows it.
  typeof v.repo === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(v.repo) && Number.isInteger(v.limit);

// Ask slot n's holder. Resolves to { held: false }, { held: true }, or
// { held: true, answer } when it answered with one well-formed JSON line.
export function ask(prefix: string, slot: number, timeoutMs = 1000): Promise<Asked> {
  return new Promise((resolve) => {
    const socket = net.connect(lockPath(prefix, slot));
    let data = '';
    let connected = false;
    const done = (value: Asked) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done({ held: connected }), timeoutMs);
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) done({ held: true });
    });
    socket.on('error', () => done({ held: connected }));
    socket.on('end', () => {
      const lines = data.split('\n').filter((l) => l !== '');
      let answer: unknown;
      if (lines.length === 1) {
        try {
          answer = JSON.parse(lines[0]!);
        } catch {
          answer = undefined;
        }
      }
      done(isHolderAnswer(answer) ? { held: true, answer } : { held: true });
    });
  });
}
