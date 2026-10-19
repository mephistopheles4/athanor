// A caller for docker-tier tests that must be killed or interrupted: it runs
// the core with a test prefix and state folder, turns SIGINT/SIGTERM into an
// abort as the CLI does, prints the result as JSON and exits with its code.
//   node driver.mjs '<json options>'
import { run } from '../../src/index.mjs';

const options = JSON.parse(process.argv[2]);
process.env.ATHANOR_HOME = options.home;
if (options.maxRuns) process.env.ATHANOR_MAX_RUNS = String(options.maxRuns);
const controller = new AbortController();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => controller.abort());
const result = await run({
  cwd: options.cwd,
  prefix: options.prefix,
  command: options.command,
  timeLimitSeconds: options.timeLimitSeconds,
  graceSeconds: options.graceSeconds,
  signal: controller.signal,
  onProgress: (line) => process.stderr.write(`athanor: ${line}\n`),
  stdout: process.stderr,
  stderr: process.stderr,
});
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode;
