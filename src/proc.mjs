// Child processes, always from an argument array with shell: false (ADR 0002).
import { spawn } from 'node:child_process';

// Start argv[0] with argv.slice(1). Returns { child, done }, where done
// resolves to { code, stdout, stderr } (stdout and stderr only when captured).
export function start(argv, { cwd, env, stdin = 'ignore', capture = true, onStdout, onStderr } = {}) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: env ?? process.env,
    stdio: [stdin, 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    if (capture) stdout += chunk;
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (capture) stderr += chunk;
    onStderr?.(chunk);
  });
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, stdout, stderr: stderr + String(error.message), error }));
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : null), stdout, stderr }));
  });
  return { child, done };
}

// Run argv to the end and return { code, stdout, stderr }.
export function call(argv, options = {}) {
  const { child, done } = start(argv, options);
  if (options.input !== undefined) child.stdin?.end(options.input);
  return done;
}
