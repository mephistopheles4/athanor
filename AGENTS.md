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
  and the package's major version. An addition bumps neither.
- **Nothing reaches the container but the snapshot and `ATHANOR_GRACE_LIMIT`.**
  No `-v`, `--mount`, `--privileged`, and `--network none` (ADR 0016). The container drops every capability
  with `--cap-drop ALL` and gets six back with `--cap-add`: `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID` and `SETGID`. The only
  `-e` are `ATHANOR_GRACE_LIMIT` and the ten proxy names, each set empty to
  block a value the Docker CLI would otherwise add: `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY` and `all_proxy`. Each is
  written `-e NAME=` and never `-e NAME`, which would copy the host's value in. A change here is security-sensitive work.
- **The archive step carries the tree as committed.** Every `git archive`,
  and the `git init` of its folder, run in the clean environment of ADR 0020:
  no inherited `GIT_*` variable, no global or system config or attributes, no template, and
  `-filter` on every path. A change here is security-sensitive work.
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
  Runs anywhere Node 24 and git run.
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

CI runs zizmor on the workflows, a check that install scripts are off and
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
issue 4; `U1` to `U7`, from the spec on issue 36; `G1` to `G8`, from the spec on issue 20; `L1` to `L15`, from the spec on issue 33, L15 added at its Test review). C22 (the Windows check), the required-check half of C23, T14 (C22
and the fast tier on Windows), P1 on Windows and K5 (the docker tier on
Windows) are manual checks on the owner's machine. P3, K6 and L14 are checked by
reading at review; no test carries their names. K3 is shown by the docker
tier's pass, and no test carries its name either. `A1` to `A7`, from the spec
on issue 34, are CI steps, one-time checks recorded in the PR, or checks by
reading; no test carries their names.

## The tracker

Issues on `mephistopheles4/athanor`. Before you read or post to the tracker,
read [the issue tracker rules](docs/agents/issue-tracker.md), including whose
text counts. Labels: [triage labels](docs/agents/triage-labels.md).

## Security

The threat model is [docs/threat-model.md](docs/threat-model.md). Report a
hole privately, as [SECURITY.md](SECURITY.md) says.
