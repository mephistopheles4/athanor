# AGENTS.md — athanor

athanor runs a repo's tests on the current commit inside a fresh Docker
container with no network, and keeps a machine-wide limit on how many runs go
at once. It is a Node 24 package, `@mephistopheles4/athanor`, with a command named
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
  `src/cli.ts` prints, sets the exit code and handles signals (ADR 0003).
- **The public interface is stable.** The JSON fields, the exit codes, the
  flags, the configuration keys and the environment variables are athanor's
  public interface. A removal, or a change in what one means, bumps `schema`
  and the package's major version. An addition bumps neither.
- **Nothing reaches the container but the snapshot and `ATHANOR_GRACE_LIMIT`.**
  No `-v`, `--mount`, `--privileged`, and `--network none` (ADR 0016). The container drops every capability
  with `--cap-drop ALL` and gets six back with `--cap-add`: `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID` and `SETGID`. The only
  `-e` are `ATHANOR_GRACE_LIMIT` and the ten proxy names, each set empty to
  block a value the Docker CLI would otherwise add: `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY` and `all_proxy`. Each is
  written `-e NAME=` and never `-e NAME`, which would copy the host's value in. A change here is security-sensitive work.
- **Messages use plain words.** Each says what happened and, for a warning or
  an error, what to do next.
- **Source files use LF line endings** (`.gitattributes`). The container's
  boot script is passed to `sh -c` and breaks on a carriage return.

## Running the tests

Run `npm ci --ignore-scripts` first, once per worktree: it installs the
compiler from the lockfile (ADR 0018) and runs no package's install scripts,
as CI does. The repo's `.npmrc` turns install scripts off for every npm command
run in the repo, `pack` and `publish` included but global installs excepted (npm
skips the project file for those), so every pack builds `dist/` first
(`node scripts/build.mjs`); [the release steps](docs/releasing.md) show
the hand publish. Then one runner, named tiers, from the repo root:

- `node test/run.mjs fast` — a fake Docker and real git in temporary repos.
  Runs anywhere Node 24, git and `tar` run (Linux, and Windows 10 and later).
- `node test/run.mjs docker` — real Docker with a small Alpine fixture. Needs a
  Docker engine.
- `node node_modules/typescript/bin/tsc -p test/tsconfig.json` — the type check
  of the tests (no emit). `tsc -p tsconfig.json --noEmit` checks `src/`.
- `node scripts/check-source.mjs` — the source check (no shell use). It reads
  every JavaScript and TypeScript source file, not `dist/`.

The tests run the compiled output in `dist/`. Each tier first clears `dist/`
and builds it (`scripts/build.mjs`); a compile error ends the run with
`result: <tier> fail`. Because each run clears `dist/`, run one test run at a
time in a worktree. The tests and the fake Docker are `.ts` files with erasable
syntax only, which Node runs directly. They import the core as `#dist/...`
(`package.json` `imports`), which is `dist/` at run time and `src/` for
`test/tsconfig.json`, so that the type check sees the test-only options (marked `@internal`, ADR 0003).

CI runs zizmor on the workflows, the workflows' own rules
(`scripts/check-workflows.mjs`: every checkout's `persist-credentials: false`,
no Actions cache, no registry `.npmrc`, no npm token, no secret), a check that install scripts are off and
every package resolves from the public registry, `npm ci`, `npm audit
signatures` (the registry's signatures over the installed packages' metadata;
`npm ci` enforces the lockfile hashes), a strict `tsc` check of `src/` and of
`test/` (`test/tsconfig.json`, no emit), `node --check` on every `.mjs` file,
the source check, both tiers, and a pack-and-install check that builds before
it packs, compares the packed `dist/` with a rebuild, checks the packed file's
contents and type-checks an import of the package by its name, on Linux and
Node 24. Every test sets its own `ATHANOR_HOME` and name
prefix, so tests never touch a live machine's slots, configuration or image
marks.

Each test is named by the acceptance claim it backs (`C1` to `C33`, from the
spec on issue 1; `T1` to `T14`, from the spec on issue 8; `P1` to `P3`, from the spec on
issue 23; `J1` to `J9`, from the spec on issue 7; `K1` to `K6`, from the spec on
issue 4; `U1` to `U7`, from the spec on issue 36; `R1` to `R10`, from the spec on
issue 6). C22 (the Windows check), the required-check half of C23, T14 (C22
and the fast tier on Windows), P1 on Windows and K5 (the docker tier on
Windows) are manual checks on the owner's machine. P3 and K6 are checked by
reading at review; no test carries their names. K3 is shown by the docker
tier's pass, and no test carries its name either. `A1` to `A7`, from the spec
on issue 34, are CI steps, one-time checks recorded in the PR, or checks by
reading; no test carries their names. R1 and R2 are fast-tier tests. R3, R4,
R7 and R9 are CI steps or checks by reading, and R5, R6, R8 and R10 are
one-time checks by the owner recorded on issue 6; no test carries their names.

## Releases

Releases after the first are staged by `.github/workflows/release.yml` and
made live by the owner ([ADR 0019](docs/adr/0019-releases-are-staged-by-a-trusted-publisher-and-approved-twice.md),
[the release steps](docs/releasing.md)). A change to `release.yml`, or to any
script, test or dev package it runs, is security-sensitive work: among them
`scripts/check-pack.mjs`, `scripts/check-workflows.mjs`, `scripts/build.mjs`,
`scripts/check-source.mjs`, `test/run.mjs` with the fast tier, and the
compiler in `package-lock.json`. So is a bot pull request
that moves an action SHA in `release.yml`, and a hand change to its
`node-version`, which the update bot never moves: the pull request names each
release and its date, at least 7 days old.

## The tracker

Issues on `mephistopheles4/athanor`. Before you read or post to the tracker,
read [the issue tracker rules](docs/agents/issue-tracker.md), including whose
text counts. Labels: [triage labels](docs/agents/triage-labels.md).

## Security

The threat model is [docs/threat-model.md](docs/threat-model.md). Report a
hole privately, as [SECURITY.md](SECURITY.md) says.
