// Windows named-pipe lock probe (spec S4, claim C33).
// Decides whether the build ships the OS lock (named pipe) or the folder lock.
//
//   node scripts/probe-pipe.mjs                    automated run (criteria 1-3), prints a JSON record
//   node scripts/probe-pipe.mjs hold               terminal A: hold the pipe until killed
//   node scripts/probe-pipe.mjs check              terminal B: criteria 1, 2 and 4 against that holder
//   node scripts/probe-pipe.mjs --remote <host>    also try the pipe from another machine (criterion 5)
//
// Criteria: (1) a second listen on a held pipe fails; (2) the holder answers a
// connection with its JSON line; (3) after the holder is hard-killed
// (taskkill /F), a new listen succeeds within 2 seconds; (4) the same holds
// between two separate terminals; (5) a connection from another machine is
// refused, or the record says it was not tried.
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const pipeFor = (name) => (isWindows ? `\\\\.\\pipe\\${name}` : `\0${name}`);
const holderLine = () =>
  JSON.stringify({ slot: 1, pid: process.pid, started: Date.now(), repo: 'probe', limit: 2 }) + '\n';

function listen(path) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end(holderLine()));
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(path, () => resolve({ ok: true, server }));
  });
}

function ask(path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(path);
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

async function waitForListen(path, withinMs) {
  const start = Date.now();
  while (Date.now() - start <= withinMs) {
    const attempt = await listen(path);
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
    child.once('exit', () => reject(new Error('holder exited before it held the pipe')));
  });
}

async function hold(name) {
  const path = pipeFor(name);
  const attempt = await listen(path);
  if (!attempt.ok) {
    console.error(`could not listen on the pipe: ${attempt.code}`);
    process.exit(1);
  }
  console.log('holding');
  console.error(`Holding pipe ${name} as pid ${process.pid}. Leave this terminal open; hard-kill it with: taskkill /F /PID ${process.pid}`);
  setInterval(() => {}, 1 << 30);
}

async function check(name) {
  const path = pipeFor(name);
  const second = await listen(path);
  if (second.ok) second.server.close();
  const answer = await ask(path);
  const record = {
    secondListenFails: !second.ok,
    holderAnswersJson: answer.ok,
    note: 'Now hard-kill the holder (taskkill /F /PID <its pid>), then run this check again: it must show secondListenFails false within 2 seconds.',
  };
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.secondListenFails && record.holderAnswersJson ? 0 : 1);
}

async function remote(host, name) {
  const target = `\\\\${host}\\pipe\\${name}`;
  const holder = await startHolder(name);
  const result = await ask(target, 3000);
  kill(holder.pid);
  return result.ok ? { refused: false } : { refused: true, reason: result.reason };
}

async function automated(remoteHost) {
  const name = `athanor-probe-${randomBytes(6).toString('hex')}`;
  const path = pipeFor(name);
  const record = { schema: 1, platform: process.platform, node: process.version };

  const holder = await startHolder(name);
  const second = await listen(path);
  if (second.ok) second.server.close();
  record.secondListenFails = !second.ok;
  const answer = await ask(path);
  record.holderAnswersJson = answer.ok;
  record.hardKillReleasesWithin2s = false;

  record.killed = kill(holder.pid);
  const after = await waitForListen(path, 2000);
  record.hardKillReleasesWithin2s = after.ok;
  record.releaseAfterMs = after.afterMs;

  record.twoTerminals = 'not tried by this run; see the two-terminal steps below';
  if (remoteHost) {
    const r = await remote(remoteHost, name);
    record.otherMachine = r.refused ? `refused (${r.reason})` : 'ANSWERED: the pipe is reachable from another machine';
  } else {
    record.otherMachine = 'not tried';
  }
  const pass = record.secondListenFails && record.holderAnswersJson && record.hardKillReleasesWithin2s && record.killed;
  record.automatedPass = pass;
  console.log(JSON.stringify(record, null, 2));
  process.exit(pass ? 0 : 1);
}

const [, , mode, arg] = process.argv;
if (mode === 'hold') await hold(arg ?? 'athanor-probe-terminals');
else if (mode === 'check') await check(arg ?? 'athanor-probe-terminals');
else if (mode === '--remote') await automated(arg);
else await automated();
