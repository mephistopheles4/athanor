# 0003. A core module with a thin CLI

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4, S5)

`src/index.ts` exports `run`, `status` and `prune`. The core never prints,
exits or registers signal handlers: it takes options, reports progress through
an `onProgress` callback, takes an `AbortSignal` for interrupts, and returns a
result. `src/cli.ts` parses arguments, prints, handles signals and sets the
exit code.

The core takes three options for tests only, which the CLI does not expose:
`docker` (the Docker command as an argument-array prefix, so tests can stand a
fake Docker in its place), `prefix` (the name prefix for pipes and
containers), and `timeLimitSeconds` with `graceSeconds`, so time-limit tests
end in seconds.

Tests drive the core API, or the CLI as a child process for argument and
exit-code checks. These are the two seams the owner approved.
