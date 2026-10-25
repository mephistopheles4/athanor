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
  build on any of these (ADR 0002). git and docker start by a full path found
  in PATH's absolute entries, never by bare name, and never from the working
  folder or a relative entry (ADR 0020's amendment).
- **The core never prints, exits or registers signal handlers.** It takes
  options, returns results, and reports progress through a callback. Only
  `src/cli.ts` prints, sets the exit code and handles signals (ADR 0003).
- **The public interface is stable.** The JSON fields, the exit codes, the
  flags, the configuration keys and the environment variables are athanor's
  public interface. A removal, or a change in what one means, bumps `schema`
  and the package's major version. An addition bumps neither. One exception:
  a form that ran something other than what it named may be fixed without a
  bump, as `athanor run <name> -- <cmd>` was (ADR 0023).
- **Nothing reaches the container but the snapshot and `ATHANOR_GRACE_LIMIT`.**
  No `-v`, `--mount`, `--privileged`, and `--network none` (ADR 0016). The container drops every capability
  with `--cap-drop ALL` and gets six back with `--cap-add`: `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID` and `SETGID`. The only
  `-e` are `ATHANOR_GRACE_LIMIT` and the ten proxy names, each set empty to
  block a value the Docker CLI would otherwise add: `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY` and `all_proxy`. Each is
  written `-e NAME=` and never `-e NAME`, which would copy the host's value in. The boot script also prints one line,
  `athanor-work <path>`, on stderr before the marker (ADR 0023); the run strips it. A change here is security-sensitive work.
- **The archive step carries the tree as committed.** Every `git archive`,
  and the `git init` of its folder, run in the clean environment of ADR 0020:
  no inherited `GIT_*` variable, no global or system config or attributes, no template, and
  `-filter` on every path. A change here is security-sensitive work.
- **A user-facing accepted risk has a README line.** A change that adds or
  changes an accepted risk a user has to act on or know about also adds or
  changes its line in the README's "What athanor doesn't protect you from".
  Every new accepted risk lists its number in the threat model's table of
  who each risk concerns: in the User-facing row, or in the Maintainer-only
  row for one that stays in the threat model alone. The
  threat model stays the record; the README line names the class of risk and
  what the user can do, never the steps of a path.
- **Messages use plain words.** Each says what happened and, for a warning or
  an error, what to do next.
- **Source files use LF line endings** (`.gitattributes`). The container's
  boot script is passed to `sh -c` and breaks on a carriage return.

## Running the tests

**An agent session runs the tests through athanor** (ADR 0024), with the
repo's own `athanor.json`: `athanor run fast` for the fast tier,
`athanor run types` for both type checks, `athanor run check` for the source
check; add `--untracked` for new files not yet added to git. The docker tier
stays on the host, `node test/run.mjs docker`: it needs a Docker engine,
which never reaches the container. A hook in `.claude/settings.json` refuses
a host `node test/run.mjs fast` while athanor is installed. When athanor
can't run (no Docker, or a run that ends 124, 125 or 137), rerun on the host
with `--host-fallback='<reason>'`, the reason short and in plain words, and
name the fallback in your report. A change to `.claude/settings.json` or
`.claude/hooks/` runs on the next shell call of every agent session that
checks it out.

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
issue 4; `U1` to `U7`, from the spec on issue 36; `G1` to `G8`, from the spec on issue 20; `L1` to `L15`, from the spec on issue 33, L15 added at its Test review; `R1` to `R10`, from the spec on
issue 6; `H1` to `H4`, from the PR that added the agent test hook; `M1` to `M20`, from the spec on issue 46). C22 (the Windows check), the required-check half of C23, T14 (C22
and the fast tier on Windows), P1 on Windows and K5 (the docker tier on
Windows) are manual checks on the owner's machine. P3, K6 and L14 are checked by
reading at review; no test carries their names. K3 is shown by the docker
tier's pass, and no test carries its name either. `A1` to `A7`, from the spec
on issue 34, are CI steps, one-time checks recorded in the PR, or checks by
reading; no test carries their names. M18 is checked by reading at review (ADR
0023, the docs, the threat-model text as the owner approved it, and that
`src/container-settings.ts` changes only by the work line). M19 is a manual
check, one Stryker run on a repo the owner names. M20 is checked at Test by the
security pair. R1 and R2 are fast-tier tests. R3, R4,
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
