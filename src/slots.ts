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

// A lock is a run slot, or a server lock (issue 35): the same OS lock under a
// different name, so a server never holds a run slot.
export type Kind = 'slot' | 'server';

export function lockPath(prefix: string, slot: number, kind: Kind = 'slot'): string {
  const name = `${prefix}-${kind}-${slot}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Try to hold one lock. Resolves to a net.Server, or null when it is held. The
// answer is built when someone asks, from `info` as it is then, so a holder can
// add to it once it knows more (a server's port).
function tryHold(prefix: string, slot: number, info: Record<string, unknown>, kind: Kind = 'slot'): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(JSON.stringify({ [kind]: slot, ...info }) + '\n');
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(null);
      else reject(error);
    });
    server.listen(lockPath(prefix, slot, kind), () => resolve(server));
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

// A server lock held, with the answer its holder gives (issue 35). `update`
// adds fields to the answer, such as the port once it is known.
export type ServerLock = { server: number; update: (extra: Record<string, unknown>) => void; release: () => Promise<void> };

export type ServerInfo = HolderInfo & { name: string };

// Try to hold server lock n, once, without waiting. Null when it is held.
export async function tryServerLock(prefix: string, n: number, limit: number, info: ServerInfo): Promise<ServerLock | null> {
  const answer: Record<string, unknown> = { ...info, limit };
  const server = await tryHold(prefix, n, answer, 'server');
  if (!server) return null;
  server.unref();
  return {
    server: n,
    update: (extra) => { Object.assign(answer, extra); },
    release: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const isHolderAnswer = (v: any): v is HolderAnswer =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Number.isInteger(v.slot) && Number.isInteger(v.pid) && Number.isFinite(new Date(v.started).getTime()) && typeof v.started === 'number' &&
  // No control characters, so an answer cannot draw on the terminal that shows it.
  typeof v.repo === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(v.repo) && Number.isInteger(v.limit);

// Ask slot n's holder. Resolves to { held: false }, { held: true }, or
// { held: true, answer } when it answered with one well-formed JSON line.
export function ask(prefix: string, slot: number, timeoutMs = 1000): Promise<Asked> {
  return askLock(prefix, slot, 'slot', isHolderAnswer, timeoutMs);
}

export type ServerAnswer = HolderInfo & { server: number; limit: number; name: string; port?: number };
export type AskedServer = { held: false } | { held: true; answer?: ServerAnswer };

// No control characters, so an answer cannot draw on the terminal that shows it.
const plain = (v: unknown): boolean => typeof v === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(v);

const isServerAnswer = (v: any): v is ServerAnswer =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Number.isInteger(v.server) && Number.isInteger(v.pid) && typeof v.started === 'number' && Number.isFinite(new Date(v.started).getTime()) &&
  plain(v.repo) && plain(v.name) && Number.isInteger(v.limit) &&
  (v.port === undefined || (Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535));

// Ask server lock n's holder, as ask does for a slot.
export function askServer(prefix: string, n: number, timeoutMs = 1000): Promise<AskedServer> {
  return askLock(prefix, n, 'server', isServerAnswer, timeoutMs);
}

function askLock<A>(prefix: string, slot: number, kind: Kind, valid: (v: unknown) => v is A, timeoutMs: number): Promise<{ held: false } | { held: true; answer?: A }> {
  return new Promise((resolve) => {
    const socket = net.connect(lockPath(prefix, slot, kind));
    let data = '';
    let connected = false;
    const done = (value: { held: false } | { held: true; answer?: A }) => { clearTimeout(timer); socket.destroy(); resolve(value); };
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
      done(valid(answer) ? { held: true, answer } : { held: true });
    });
  });
}
