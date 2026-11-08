// A caller for the docker tier's E12: it runs serve with a test prefix and
// state folder, prints the serving event as JSON, and keeps serving until it
// is killed. The test kills it hard.
//   node serve-driver.ts '<json options>'
import { serve } from '#dist/index.js';

const options = JSON.parse(process.argv[2]);
process.env.ATHANOR_HOME = options.home;
const controller = new AbortController();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => controller.abort());
const result = await serve({
  cwd: options.cwd,
  name: options.name,
  prefix: options.prefix,
  signal: controller.signal,
  onServing: (s) => process.stdout.write(JSON.stringify(s) + '\n'),
  stdout: process.stderr,
  stderr: process.stderr,
});
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode;
