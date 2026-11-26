// OS lock probe: the Windows named pipe (spec S4, claim C33) and, on macOS,
// the loopback port (spec on ATH-7, S2). On Linux it probes the abstract
// socket. It decides whether athanor may ship that lock.
//
//   node scripts/probe-pipe.mjs                    automated run (criteria 1-3, and 6 on macOS), prints a JSON record
//   node scripts/probe-pipe.mjs hold               terminal A: hold the lock until killed
//   node scripts/probe-pipe.mjs check              terminal B: criteria 1, 2 and 4 against that holder
//   node scripts/probe-pipe.mjs --remote <host>    also try the lock by that host name (criterion 5)
//
// Criteria: (1) a second listen on a held lock fails; (2) the holder answers a
// connection with its JSON line; (3) after the holder is hard-killed
// (taskkill /F, or kill -9), a new listen succeeds within 2 seconds; (4) the
// same holds between two separate terminals; (5) a connection from another
// machine is refused, or the record says it was not tried; (6) on macOS,
// whether a listen on 127.0.0.1 succeeds while another process listens on the
// same port at 0.0.0.0, and at [::]. 6 is recorded, not required.
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
// The port athanor's lockPort gives run slot 1 of the prefix `name`, worked out
// here so the probe runs before anything is built.
const portFor = (name) => 20000 + (createHash('sha256').update(`${name}-slot-1`).digest().readUInt32BE(0) % 27000);
const addressFor = (name) => {
  if (isMac) return { host: '127.0.0.1', port: portFor(name) };
  return isWindows ? `\\\\.\\pipe\\${name}` : `\0${name}`;
};
const killHint = (pid) => (isWindows ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`);
const holderLine = () =>
  JSON.stringify({ slot: 1, pid: process.pid, started: Date.now(), repo: 'probe', limit: 2 }) + '\n';

function listen(address) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(holderLine());
    });
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(address, () => resolve({ ok: true, server }));
  });
}

function ask(address, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.code ?? 'error' });
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(data.trim());
        resolve({ ok: Number.isInteger(parsed.pid), reply: parsed });
      } catch {
        resolve({ ok: false, reason: 'not one JSON line' });
      }
    });
  });
}

function kill(pid) {
  const result = isWindows
    ? spawnSync('taskkill', ['/F', '/PID', String(pid)], { shell: false })
    : spawnSync('kill', ['-9', String(pid)], { shell: false });
  return result.status === 0;
}

async function waitForListen(address, withinMs) {
  const start = Date.now();
  while (Date.now() - start <= withinMs) {
    const attempt = await listen(address);
    if (attempt.ok) {
      attempt.server.close();
      return { ok: true, afterMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, afterMs: Date.now() - start };
}

function startHolder(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hold', name], {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: false,
    });
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
    child.once('exit', () => reject(new Error('The holder exited before it held the lock. Read its message above, then run the probe again.')));
  });
}

async function hold(name) {
  const address = addressFor(name);
  const attempt = await listen(address);
  if (!attempt.ok) {
    console.error(`Could not listen on the lock (${attempt.code}). If another process holds it, stop that process, then run the probe again.`);
    process.exit(1);
  }
  console.log('holding');
  const what = isMac ? `127.0.0.1:${address.port}` : `pipe ${name}`;
  console.error(`Holding ${what} as pid ${process.pid}. Leave this terminal open; hard-kill it with: ${killHint(process.pid)}`);
  setInterval(() => {}, 1 << 30);
}

async function check(name) {
  const address = addressFor(name);
  const second = await listen(address);
  if (second.ok) second.server.close();
  const answer = await ask(address);
  const record = {
    secondListenFails: !second.ok,
    holderAnswersJson: answer.ok,
    note: `Now hard-kill the holder (${killHint('<its pid>')}), then run this check again: it must show secondListenFails false within 2 seconds.`,
  };
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.secondListenFails && record.holderAnswersJson ? 0 : 1);
}

async function remote(host, name) {
  const target = isMac ? { host, port: portFor(name) } : `\\\\${host}\\pipe\\${name}`;
  const holder = await startHolder(name);
  const result = await ask(target, 3000);
  kill(holder.pid);
  return result.ok ? { refused: false } : { refused: true, reason: result.reason };
}

// The other process of criterion 6: it listens on the port at `host`, and says
// "holding", or the error code its listen failed with.
async function listenAt(host, port) {
  const attempt = await listen({ host, port: Number(port) });
  console.log(attempt.ok ? 'holding' : attempt.code);
  if (attempt.ok) setInterval(() => {}, 1 << 30);
}

// Criterion 6: while another process listens on the port at `host`, try the
// same port on 127.0.0.1.
async function besideListener(host, port) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'listen-at', host, String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  const gone = new Promise((resolve) => child.once('close', resolve));
  const said = await new Promise((resolve) => {
    child.once('error', (error) => resolve(error.code ?? 'error'));
    child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    child.once('close', () => resolve('exited'));
  });
  if (said !== 'holding') {
    await gone;
    return `not tried (${said})`;
  }
  const attempt = await listen({ host: '127.0.0.1', port });
  if (attempt.ok) attempt.server.close();
  child.kill('SIGKILL');
  await gone;
  return attempt.ok ? 'the listen on 127.0.0.1 succeeds' : `the listen on 127.0.0.1 fails (${attempt.code})`;
}

async function automated(remoteHost) {
  const name = `athanor-probe-${randomBytes(6).toString('hex')}`;
  const address = addressFor(name);
  const record = { schema: 1, platform: process.platform, node: process.version };
  if (isMac) record.port = address.port;

  const holder = await startHolder(name);
  const second = await listen(address);
  if (second.ok) second.server.close();
  record.secondListenFails = !second.ok;
  const answer = await ask(address);
  record.holderAnswersJson = answer.ok;
  record.hardKillReleasesWithin2s = false;

  record.killed = kill(holder.pid);
  const after = await waitForListen(address, 2000);
  record.hardKillReleasesWithin2s = after.ok;
  record.releaseAfterMs = after.afterMs;

  if (isMac) {
    record.besideListenerOn0000 = await besideListener('0.0.0.0', address.port);
    record.besideListenerOnColons = await besideListener('::', address.port);
  }

  record.twoTerminals = 'not tried by this run; see the two-terminal steps below';
  if (remoteHost) {
    const r = await remote(remoteHost, name);
    record.otherMachine = r.refused ? `refused (${r.reason})` : 'ANSWERED: the lock is reachable by that host name';
  } else {
    record.otherMachine = 'not tried';
  }
  const pass = record.secondListenFails && record.holderAnswersJson && record.hardKillReleasesWithin2s && record.killed;
  record.automatedPass = pass;
  console.log(JSON.stringify(record, null, 2));
  process.exit(pass ? 0 : 1);
}

const [, , mode, arg, port] = process.argv;
if (mode === 'hold') await hold(arg ?? 'athanor-probe-terminals');
else if (mode === 'check') await check(arg ?? 'athanor-probe-terminals');
else if (mode === 'listen-at') await listenAt(arg, port);
else if (mode === '--remote') await automated(arg);
else await automated();
