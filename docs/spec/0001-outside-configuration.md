# Spec: an outside configuration — V1

Status: proposed, revision 2. Tier: standard.

<!-- toc -->

- [Objective](#objective)
- [The owner's decisions (from chat, 2026-11-27)](#the-owners-decisions-from-chat-2026-11-27)
- [Behaviour](#behaviour)
- [Commands](#commands)
- [Project structure](#project-structure)
- [Code style](#code-style)
- [Testing strategy](#testing-strategy)
- [Success criteria](#success-criteria)
- [Boundaries](#boundaries)
- [Trade-offs](#trade-offs)
- [Out of scope (deferred)](#out-of-scope-deferred)
- [Open questions](#open-questions)

<!-- /toc -->

## Objective

athanor reads its configuration only from the repo it tests: `athanor.json`,
or the `athanor` key in `package.json`. So it can't run on a repo whose owner
can't or won't add those files. A local branch that carries them never reaches
the repo's other branches or worktrees.

An **outside configuration** is a configuration file named by `--config <path>`
or `ATHANOR_CONFIG`, read instead of the repo configuration. The user is anyone
who tries athanor on a repo they don't control. The task a new user completes:
on a fresh clone with no athanor files, write one configuration file elsewhere,
run `athanor run --config <file> test`, and see the tests' result; then change
`memory` in that file and run again, with no change to the clone.

## The owner's decisions (from chat, 2026-11-27)

| Decision | Choice |
| --- | --- |
| How it is set | `--config <path>`, and `ATHANOR_CONFIG` |
| Commands | `run` and `serve` |
| The tested repo also has a configuration | The outside configuration wins, and athanor says so |
| Where the file may sit | Anywhere, inside the tested repo included |
| State of the file | Any readable file; no git repo needed |
| Which repo the paths use | Per key |
| The build may read the tested repo's files | Yes |
| `--json` | Reports where the configuration came from |

These follow from them: the archive step gains a second source of files, so
this is security-sensitive work (AGENTS.md); the image tag keeps its formula,
because every file the build sees is in the hashed tree (ADR 0006).

## Behaviour

1. **Finding it.** `src/cli.ts` reads `--config` and `ATHANOR_CONFIG`; the
   flag wins. An empty variable counts as unset. A flag value that is empty or
   starts with `-` exits 125, as `--output` does. The CLI resolves a relative
   path against its current folder and passes the core
   `config: { file: <absolute path>, from: 'flag' | 'environment' }` in
   `RunOptions` and `ServeOptions`. The core refuses a relative `file`.
   `status` and `prune` don't take the flag; on them it is unknown.
2. **Reading it.** The file holds one JSON object with the repo
   configuration's keys and checks. The machine configuration limits it
   exactly as it limits a repo configuration. A missing, unreadable or invalid
   file exits 125. The message names the path as the user gave it, and whether
   it came from `--config` or `ATHANOR_CONFIG`.
3. **The source line.** Every run and serve with an outside configuration
   prints one line on stderr, through the progress callback, such as
   `athanor: using the configuration from ATHANOR_CONFIG, not the repo's athanor.json.`
   The part after the comma shows only when the repo has its own.
4. **The repo has its own.** athanor uses the outside configuration and reads
   nothing else of the repo's. `replaced` is `athanor.json` when that file
   exists; else `package.json` when it parses and has the `athanor` key; else
   absent. A `package.json` that doesn't parse causes no error.
5. **Paths.** In the outside configuration, `dockerfile`, `context` and each
   `inputs` entry is either:
   - a string: a repo-relative path in the tested repo, checked as today; or
   - `{ "config": "<path>" }`: a path relative to the outside configuration
     file's folder (the **configuration folder**). After symlinks and
     junctions it must stay inside that folder, compared as `src/paths.ts`
     compares paths on each platform.

   Servers' `writable` paths keep their meaning. The object form in the repo's
   own configuration exits 125 with
   `"dockerfile" in athanor.json must be a repo-relative path; { "config": ... } works only in an outside configuration.`
   (the key and place as they are).
6. **Combinations.**

   | `dockerfile` | `context` | Result |
   | --- | --- | --- |
   | string | string or absent | As today |
   | object | absent | The context is the Dockerfile's folder, configuration side |
   | object | object | The Dockerfile must be inside the context, as today |
   | object | string | The tested-repo context, plus the Dockerfile at `.athanor-dockerfile` at the context's root |
   | string | object | Exits 125: a tested-repo Dockerfile can't be inside a configuration-side context |

   A tested-repo file at `.athanor-dockerfile` exits 125. An input from either
   side exits 125 when its path in the tree is already taken.
7. **Files from the configuration side.** No git is needed. Each file must be
   a regular file; any other kind, a symlink inside a configuration-side
   context included, exits 125. athanor reads each file's bytes once, writes
   them to its own git folder's store with no filters, and gives each mode
   `100644`. The tag and the build context both come from those blobs. A
   context in object form takes every regular file under its folder except any
   `.git` entry (see open question 1). An input goes into the tree at its path
   relative to the configuration folder.
8. **The image tag** stays `sha256("athanor-image-v2\n" + tree)`.
9. **`--json`** gains one field, present only with an outside configuration,
   on `RunResult` and on serve's `Serving` object:
   `"config": { "file": "<absolute path>", "from": "flag" | "environment", "replaced"?: "athanor.json" | "package.json" }`.
   No `schema` bump (AGENTS.md).
10. **The test container** is unchanged: no new `docker run` option, and
    `ATHANOR_CONFIG` never reaches it.

## Commands

```
npm ci --ignore-scripts
athanor run fast --untracked
athanor run types --untracked
athanor run check --untracked
node test/run.mjs docker
```

Before merge, the owner runs the fast tier on Windows by hand (T14), because
this change adds path and link checks on disk, and no CI job runs Windows.

## Project structure

- `src/cli.ts`: the flag and the variable on `run` and `serve`.
- `src/run-config.ts`: reading the outside configuration, the object path
  form, the combinations, `replaced`.
- `src/git.ts`: `buildContext` takes configuration-side files from disk.
- `src/index.ts`, `src/serve.ts`: the new option, the source line, the
  `config` field.
- `test/fast/config.test.ts`, `run.test.ts`, `serve.test.ts`, `cli.test.ts`,
  `archive.test.ts`; `test/docker/docker.test.ts` for OC9.
- `README.md` (the flag, and a line in "What athanor doesn't protect you
  from"), `GLOSSARY.md` ("outside configuration", "configuration folder"),
  `docs/threat-model.md`, `docs/sensitive-work.md`, and an ADR for the second
  source of build files.

## Code style

The core throws `AthanorError` with a plain message that says what to do; only
`src/cli.ts` prints (ADR 0003). Child processes take argument arrays with
`shell: false` (ADR 0002). For example:

```ts
throw new AthanorError(`The configuration file named by --config, ${shown}, could not be read. Make it a regular file you can read, then run again.`);
```

## Testing strategy

Fast tier, a fake Docker and real git in temporary repos, one test per claim,
named by its id. The configuration folder is a temporary folder outside the
tested repo unless the test says otherwise. Every test sets its own
`ATHANOR_HOME`. The docker tier gets one test, OC9, on a real build.

Review: the spec pair ran on revision 1. At Test, the QA pair and the
standards pair run, and the security pair is offered once (the owner's rules,
for a change that touches the archive step).

## Success criteria

- **OC1:** `run --config <file>` on a repo with no repo configuration runs the
  named command, and its exit code is the test's.
- **OC2:** `serve --config <file>` starts the named server from the outside
  configuration.
- **OC3:** `ATHANOR_CONFIG` is used when no flag is given; the flag wins over it;
  an empty value counts as unset; a flag value that is empty or starts with `-`
  exits 125.
- **OC4:** Every run with an outside configuration prints the source line. With
  a repo configuration too, the line names it and `--json` has `replaced`, for
  each case in Behaviour 4. A broken `package.json` causes no error.
- **OC5:** `--json` has `config` only with an outside configuration; without
  one, the JSON is byte-for-byte what it is today.
- **OC6:** A string path resolves in the tested repo; `{ "config": ... }`
  resolves under the configuration folder; the object form in the repo's own
  configuration exits 125 with the message in Behaviour 5.
- **OC7:** A path that leaves the configuration folder, by `..` or a symlink,
  exits 125; so does a symlink, or a file that isn't regular, inside a
  configuration-side context.
- **OC8:** Each row of the combinations table gives its result; a tested-repo
  file at `.athanor-dockerfile`, or two files at one tree path, exits 125.
- **OC9:** Changing a configuration-side file's content changes the image tag;
  the same content gives the same tag; a clean filter in the tested repo's
  attributes doesn't run on configuration-side files; every one has mode
  `100644`.
- **OC10:** A missing, unreadable or invalid outside configuration file exits
  125, naming the path as given and whether it came from the flag or the
  variable.
- **OC11:** An outside configuration file inside the tested repo is accepted.
- **OC12:** `--config` on `status` or `prune` is an unknown flag; the
  `docker run` option list is unchanged; machine-configuration ceilings hold
  over an outside configuration's limits.
- **OC13:** The README, `GLOSSARY.md`, `docs/threat-model.md` and
  `docs/sensitive-work.md` name the outside configuration; Y5 and X3 pass.
- **OC14:** Every existing test passes with its assertions unchanged.
- **OC15:** A configuration-side context never puts a `.git` entry in the tree.

## Boundaries

- **Always:** keep the existing string path meaning; keep every child process
  shell-free; keep the core free of printing.
- **Stop and ask the owner:** an existing assertion must change; the
  `docker run` option list must change; the image tag formula must change.
- **Never:** pass `ATHANOR_CONFIG` or any configuration-side path into the test
  container; add a runtime dependency.
- **Rollback:** revert the change. Nothing persists but images, which `prune`
  clears.

## Trade-offs

- **Security against ease of use.** The owner chose any file, anywhere, with no
  git. Any file under a configuration-side context then goes to the build,
  which has the network. This loosens a guard the threat model names: the
  build gets only tracked files, and only from the repo (C17, J6). The owner
  took ease of use; ADR 0038's trust in the owner's machine is the premise.
  There is no business driver in AGENTS.md, so where nothing else decides, the
  spec leans to what is cheaper to reverse.
- **Compatibility against flexibility.** "The flag wins" can't later become
  "refuse" without a `schema` bump. The owner took flexibility.

## Out of scope (deferred)

- A machine configuration key for the path: it would apply to every repo.
- Merging the two configurations key by key.
- `status` reporting an outside configuration.
- A `--help` output: athanor has none today.

## Open questions

1. **What a configuration-side context takes** (owner's call, security). The
   spec takes every regular file but `.git`. Should it also leave out what git
   ignores, when the configuration folder is in a git work tree?
2. **Filters** (owner's call, security). The spec writes configuration-side
   files with no git filters. Confirm.
3. **A stale `ATHANOR_CONFIG`** (owner's call, security). The spec prints the
   source line on every run and exits 125 for a missing file. Confirm, or ask
   for more, such as a refusal inside an agent session.
4. **Paths shown** (owner's call, security). Messages show the path as given;
   `--json` carries the absolute path, which holds the account name. Confirm.
5. **The security pair** (owner's call). Run it on this spec now, or only at
   Test, where it is a third lens pair, past the limit of two.
