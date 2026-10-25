# 0030. OOMKilled means some process was killed, not the test

Date: 2026-10-25 · Status: accepted · Extends: 0003, 0016, 0023 · Source: the spec on issue 60 (revision 4, V1 to V8), signed off through the lead session under the owner's standing instruction

athanor reads how a container ended from Docker's `.State.ExitCode` and
`.State.OOMKilled`, and any `OOMKilled` made the outcome `memory`, exit 137.
On issue 54, a full Stryker run at 8g printed "Done", wrote its reports, and
still ended as `memory`. Hand runs on Docker Engine 29.9.2 (cgroup v2) show
why. `OOMKilled` is set when the memory limit kills any process in the
container, at any time in the run, and it stays set:

- a child is killed and the test then exits 0: exit 0, `OOMKilled` true;
- the test process itself is killed: exit 137, `OOMKilled` true.

So the flag cannot say which process was killed, or when, and athanor threw
the container's own exit away.

- **The outcome stays `memory`, exit 137** (q1 (a), rather than letting the
  test's own exit decide pass or fail, or adding an outcome). A run in which
  the memory limit killed a process never reads as a clean pass. The test may have
  absorbed the kill, for example by replacing a worker, and finished with
  less than it was asked to do.
- **The result gains `containerExitCode`,** the container's own exit as Docker
  reported it. It is set on every `memory` result, and it stays when a later
  copy of outputs fails or is interrupted. A value other than 137 means the
  test exited on its own after another process was killed.
- **The message says which it was.** It reads "the test exited N, but the
  memory limit killed a process in the container during the run" when N is
  not 137, and keeps today's line when it is.
- **`testExitCode` keeps its value** (q4 (a), rather than changing it to the
  container's exit). After a memory run whose copy fails, it stays 137, as before, and `containerExitCode` carries the
  container's exit. Nothing in the public interface changes meaning. The
  new field is an addition, so neither `schema` nor the major version
  changes. ADR 0023 and the README called `testExitCode` "the test's own
  exit", while the code gave 137 after a memory run; the README is corrected
  here to say what the code does, as a documentation fix, without a bump.
  ADR 0023's text stays as it was recorded.
- **A third test seam.** ADR 0003 names two: the core API and the CLI as a
  child process. The CLI's result line, `resultLine`, is exported from
  `src/cli.ts` for tests, as `parseArgs` already was, and is tested directly.
  The package exports only its index, so neither is reachable by the
  package's name.

q1 and q4 are the lead's picks under the owner's standing instruction for
2026-10-25. What was killed in the 8g run itself is left to a manual check on
issue 60 (V7), with the oom events' times and the kernel's kill lines.
