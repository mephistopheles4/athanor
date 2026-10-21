![athanor: your tests, sealed](docs/brand/athanor-social.png)

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

A plain `tcp://` engine without TLS verification is refused, because your
work and the test output would cross the network unencrypted. Use `ssh://`,
tcp with TLS verification, or a local engine; loopback addresses pass. On a
network you trust (a home lab, an office build box, a VM on this machine, or
CI running Docker inside Docker), set `"allowPlainTcp": true` in the machine
configuration. A repo cannot set it.

Don't run athanor on a Docker engine shared with people you don't trust:
anyone with access to the engine can read your runs and change their results.
Teammates you trust on an office build box are fine.

```bash
npm install --save-dev @mephistopheles4/athanor
```

The command is `athanor`.

## Set up a repo

Put the repo configuration in one of two places: an `athanor.json` file at the
repo root, or an `athanor` key in the `package.json` at the repo root. Use one,
never both: a run that finds both exits 125 and says to keep one.

As the `athanor` key in `package.json`:

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

The same object works as `athanor.json`, at the top level of the file with no
`athanor` wrapper, for a repo that has no `package.json` or does not want one:

```json
{
  "dockerfile": "test/Dockerfile",
  "commands": { "test": ["npm", "test"] }
}
```

Save `athanor.json` as UTF-8 without a byte-order mark. PowerShell 5.1's `>`
writes UTF-16, which athanor rejects as invalid JSON. Whichever
file you use must be a regular file inside the repo, not a link to a place
outside it.

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
  "maxMemory": "8g", "maxCpus": 4, "maxTimeoutMinutes": 120, "allowPlainTcp": false }
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

## Proxy settings

Every run sets the ten proxy variables (`HTTP_PROXY`, `http_proxy`,
`HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`, `no_proxy`,
`ALL_PROXY` and `all_proxy`) to empty in the test container, so a proxy
password in your Docker client configuration does not reach the test code. That
also blanks a value the image's own `ENV` gives them; the container has no
network, so a proxy in it does nothing. The image build still gets the proxy
settings as build arguments, so a Dockerfile can read them. See
[the threat model](docs/threat-model.md), accepted risk 1.

## Secrets

Keep secrets out of the files a run sends: everything tracked in the repo goes
into the container, and everything tracked under `context` plus each `inputs`
file goes into the image build, which has network access.

## More

- [AGENTS.md](AGENTS.md): rules for changing athanor.
- [docs/threat-model.md](docs/threat-model.md) and [SECURITY.md](SECURITY.md).
- [docs/adr/](docs/adr/): the lasting decisions.

Licence: MIT.
