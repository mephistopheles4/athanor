# athanor

Run a repo's tests on your current work in a fresh Linux container with no
network, with at most N runs at once on the machine.

athanor is for many coding-agent sessions on one machine. Each session stays
on the host; only the test run goes into the container. Two suites can't
break each other through the file system or ports, and the machine stays
usable.

athanor is for repos you trust to build: the image build runs the repo's own
Dockerfile with network access.

## Install

Needs Node 24 or later, git, and a Docker engine (Docker Desktop on Windows).

athanor uses Docker as you have it configured (`DOCKER_HOST`, the Docker
context and the buildx builder), local or remote. With a remote engine or
builder, your build context and your snapshot, uncommitted changes included,
go to that machine.

```bash
npm install --save-dev @mephistopheles4/athanor
```

The command is `athanor`.

## Set up a repo

Add an `athanor` key to the `package.json` at the repo root:

```json
{
  "athanor": {
    "dockerfile": "test/Dockerfile",
    "context": "test",
    "inputs": ["package-lock.json"],
    "commands": { "test": ["npm", "test"], "fast": ["node", "test/run.mjs", "fast"] },
    "memory": "2g",
    "cpus": 2,
    "timeoutMinutes": 30
  }
}
```

- `dockerfile` (required) and `context` (default: the Dockerfile's folder)
  are repo-relative paths. Every tracked file under `context` keys the image,
  so keep it small.
- `inputs` lists files outside `context` that the build needs. Each must be
  tracked by git, and keeps its repo-relative path under the context root.
- `commands` maps names to argument arrays. A string is an error.
- `memory` (`512m`, `2g`), `cpus` and `timeoutMinutes` default to the machine
  configuration, else 2g, 2 and 30.

The image must have `sh` and `tar`, and its user must be able to write
`$HOME/work`. An `ENTRYPOINT`, if any, must run the arguments it is given.

## Use

```bash
athanor run                 # run the "test" command
athanor run fast            # run another named command
athanor run --untracked     # include untracked, non-ignored files
athanor run -- node --test test/one.test.mjs
athanor status              # who holds the slots, which containers exist
athanor prune --dry-run     # list images unused for 30 days
athanor prune --days 7
```

Every command takes `--json`: stdout then holds exactly one JSON object, and
everything else goes to stderr.

A run tests your tracked files as they are in the working tree, staged or
not, and tells you how many untracked files it left out. It never changes
your working tree, index, refs or stash list.

### Exit codes

| Code | Meaning |
| --- | --- |
| the test's own | the test command ran and exited with it |
| 124 | the time limit ended the run |
| 125 | athanor could not run the test: configuration, build, Docker, snapshot or environment |
| 130 | an interrupt ended the run |
| 137 | with outcome `memory`, the memory limit ended the run |

The JSON `outcome` field (`pass`, `fail`, `timeout`, `memory`,
`interrupted`, `error`) tells a test's own 124, 125 or 130 apart from
athanor's.

## Machine configuration

An optional `~/.athanor/config.json` (or `$ATHANOR_HOME/config.json`):

```json
{ "maxRuns": 2, "memory": "2g", "cpus": 2, "timeoutMinutes": 30, "pruneDays": 30,
  "maxMemory": "8g", "maxCpus": 4, "maxTimeoutMinutes": 120 }
```

`ATHANOR_MAX_RUNS` overrides `maxRuns` for one shell or for CI. A repo value
above a `max*` ceiling is an error.

The state folder holds copies of your uncommitted files while a run lasts, and
for up to a day after a run that was killed hard. If you set `ATHANOR_HOME`,
point it at a folder only you can read.

## Disk

`athanor prune` removes athanor's own images. It does not clear Docker's
build cache, which can hold copies of build contexts. Clear it with:

```bash
docker builder prune
```

With a named buildx builder, clear its cache with
`docker buildx prune --builder <name>`. With a remote engine or builder, these
copies sit on that machine.

## Secrets

Keep secrets out of the files a run sends: everything tracked in the repo goes
into the container, and everything tracked under `context` plus each `inputs`
file goes into the image build, which has network access.

## More

- [AGENTS.md](AGENTS.md): rules for changing athanor.
- [docs/threat-model.md](docs/threat-model.md) and [SECURITY.md](SECURITY.md).
- [docs/adr/](docs/adr/): the lasting decisions.

Licence: MIT.
