# AGENTS.md — athanor

athanor runs a repo's tests on the current commit inside a fresh Docker
container with no network, and keeps a machine-wide limit on how many runs go
at once. It is a Node 24 package, `athanor-testbox`, with a command named
`athanor`. Words used here are defined in [GLOSSARY.md](GLOSSARY.md); the
lasting decisions are in [docs/adr/](docs/adr/).

## Rules for changes

- **No runtime dependencies.** `package.json` has no `dependencies`. Node's own
  modules only (ADR 0001).
- **No shell, ever.** Every child process is started with an argument array
  and `shell: false`. Never build a command string, and never use `exec`,
  `execSync`, or `execFile` with a shell. `scripts/check-source.mjs` fails the
  build on any of these (ADR 0002).
- **The core never prints, exits or registers signal handlers.** It takes
  options, returns results, and reports progress through a callback. Only
  `src/cli.mjs` prints, sets the exit code and handles signals (ADR 0003).
- **The public interface is stable.** The JSON fields, the exit codes, the
  flags, the configuration keys and the environment variables are athanor's
  public interface. A removal, or a change in what one means, bumps `schema`
  and the package's major version. An addition bumps neither.
- **Nothing reaches the container but the snapshot and `ATHANOR_GRACE_LIMIT`.**
  No `-v`, `--mount`, `--privileged`, no other `-e`, and `--network none`
  (ADR 0005). A change here is security-sensitive work.
- **Messages use plain words.** Each says what happened and, for a warning or
  an error, what to do next.
- **Source files use LF line endings** (`.gitattributes`). The container's
  boot script is passed to `sh -c` and breaks on a carriage return.

## Running the tests

One runner, named tiers, from the repo root:

- `node test/run.mjs fast` — a fake Docker and real git in temporary repos.
  Runs anywhere Node 24 and git run.
- `node test/run.mjs docker` — real Docker with a small Alpine fixture. Needs a
  local Docker engine.
- `node scripts/check-source.mjs` — the source check (no shell use).

CI runs `node --check` on every source file, the source check, both tiers and
a pack-and-install check, on Linux and Node 24. Every test sets its own
`ATHANOR_HOME` and name prefix, so tests never touch a live machine's slots,
configuration or image marks.

Each test is named by the acceptance claim it backs (`C1` to `C33`, from the
spec on issue 1). C22 (the Windows check) and the required-check half of C23
are manual checks on the owner's machine.

## The tracker

Issues on `mephistopheles4/athanor`. Before you read or post to the tracker,
read [the issue tracker rules](docs/agents/issue-tracker.md), including whose
text counts. Labels: [triage labels](docs/agents/triage-labels.md).

## Security

The threat model is [docs/threat-model.md](docs/threat-model.md). Report a
hole privately, as [SECURITY.md](SECURITY.md) says.
