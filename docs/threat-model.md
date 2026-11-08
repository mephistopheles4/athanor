# Threat model

Last revised: 2026-11-07

This page explains how athanor could break, what it does about each way, and
which threats it accepts. Read it before you use athanor on a repo, and before
you change it. It describes athanor as at the `Last revised:` date above. A
change that alters a defence named here updates this page in the same pull
request. The owner decided the accepted classes; a change that would ease a
path a class names, or remove a control it relies on, is raised in full at
review. [`SECURITY.md`](../SECURITY.md) says how to report a hole.

## Residual risk at a glance

```mermaid
quadrantChart
  title Residual risk by class
  x-axis Unlikely --> Likely
  y-axis Minor --> Severe
  quadrant-1 Act now
  quadrant-2 Guard closely
  quadrant-3 Accept
  quadrant-4 Watch
  Windows slot pipe on the network: [0.15, 0.20]
  A server's port on this machine: [0.30, 0.25]
  A compromised machine: [0.08, 0.97]
  Shared or remote engine: [0.15, 0.82]
  The machine's load: [0.50, 0.38]
  Recorded, shown, left behind: [0.72, 0.25]
  Release and CI supply chain: [0.25, 0.92]
```

The chart places each class by what is left after today's guards: most of the
severe ones are rare, and the common ones are small. A repo's own code is not
on it: it is trusted, and out of scope (see Scope).

| Class | Risk | L | I | What stops it | What is left open |
| --- | --- | --- | --- | --- | --- |
| [The Windows slot pipe on the network](#the-windows-slot-pipe-on-the-network) | A user elsewhere on the network reads what slot holders report | 0.15 | 0.20 | Windows' own sign-in for the pipe | The pipe does not refuse remote clients |
| [A server's port on this machine](#a-servers-port-on-this-machine) | A program, another container or, on a Linux engine before 28.0, a host on the network reaches a dev server's published port | 0.30 | 0.25 | The port is published on 127.0.0.1 only; the tree is read-only | Every program and account here, and every container on Docker's default bridge network, can reach it; the engine's version is not checked |
| [A compromised machine or sandbox](#a-compromised-machine-or-sandbox) | A program or agent already working against the owner, a local program that takes the slot names or swaps a file a run reads | 0.08 | 0.97 | Nothing inside athanor | All of it |
| [A shared or remote engine, and the network](#a-shared-or-remote-engine-and-the-network) | Whoever runs the engine or builder, or sits on its path, sees and decides the run | 0.15 | 0.82 | Local engines only unless the machine file allows more; no plain tcp unless it opts in | The operator decides the result and the limits; a shared engine's users can read runs; a local address can lead elsewhere |
| [The machine's load](#the-machines-load) | A run, a leftover container or a server holds every CPU, or a raised `maxProcesses` fills the engine's process table | 0.50 | 0.38 | Memory, swap, a default process limit, the time limits, the next run's removal, the next `serve`'s sweep | No default CPU limit; no time limit for a server; a full process table can block removal |
| [What athanor records, shows and leaves behind](#what-athanor-records-shows-and-leaves-behind) | Paths, history, copied files and arguments reach places the owner did not expect | 0.72 | 0.25 | Only the hashed set reaches the build; names checked as text; no container log; the README's advice | Host git filters run; messages carry paths; the history of a base goes wherever the snapshot goes |
| [The release and CI supply chain](#the-release-and-ci-supply-chain) | A hijacked dev package, action or account shapes what is built, staged or tagged | 0.25 | 0.92 | SHA pins, a 7-day wait, signatures, stage-only publishing, the owner's look and 2FA, the admin-only tag ruleset and the `npm` environment's tag policy | A merged hijacked compiler; the release's `check` and `publish` jobs; any tag already pushed can be released; a tag run uses the workflow file at its commit |

## Scale

- **L and I** are likelihood and impact of what is left after today's guards,
  from 0 to 1. They are judgement, used to rank; they do not measure.
- **A class takes the highest L and the highest I** of the threats it covers,
  per axis, so a class can sit higher than any one of them.

## Scope

athanor is a queue and an isolation tool for test runs. It isolates so that
parallel runs don't collide (ports, files, the machine's load), not to contain
a hostile repo or protect a compromised machine (ADR 0033).

**In scope:** the boundaries athanor itself creates or exposes:

- a shared or remote engine: the Docker engine and builder the user
  configured, whoever runs them, their other users, and whoever sits on their
  network path;
- what athanor exposes on the network, such as the Windows slot pipe;
- what athanor records, shows and leaves behind: what a run prints, copies
  back, or leaves in the state folder, the repo or the engine;
- the release and CI supply chain, since other people install athanor: this
  repo's dev packages, actions, CI and release path.

**Out of scope:**

- **A repo's own code.** Its configuration, Dockerfile and tests are trusted,
  like the machine. athanor is not a sandbox for a repo you don't trust. The
  image build runs the repo's Dockerfile with the network, so a repo from
  someone else can run code that reaches the internet, and a `FROM` line can
  pull the owner's private images with the owner's registry login and send
  their content out. The build gets the Docker client's proxy settings as
  build arguments, and a proxy setting can hold a password: a build step can
  send it out or print it into the build output, and a Dockerfile can leave it
  in the image or the build cache, which `prune` does not clear. Files added
  with `git add -N` under `context` reach the build too. The test runs as the image's user, root unless the
  Dockerfile names another, with six Linux capabilities that a flaw in Docker
  or the kernel could use. What a copied file holds is the test code's choice:
  athanor checks names and types, never content, so a report lands as written
  and opening it, or a viewer previewing it, does what it holds, and copied
  files carry no Mark-of-the-Web. Git's error text is printed as git wrote it,
  so a name in the repo can carry terminal escape codes to the caller or
  session. A host run of the same tool writes the same files and prints the
  same text.
- **A compromised machine,** already working against the owner as the
  owner's user, and a local program under any account working against the
  owner (see the accepted class "A compromised machine or sandbox").
- **Flaws in Docker, Docker Desktop and its VM, git, Node and the operating
  system themselves.** The operator of a remote engine or builder is in scope
  as an actor below; the software they run is not.

## Who is in scope

| Actor | Reaches athanor through |
| --- | --- |
| Whoever runs the configured engine or builder, other users of a shared engine, someone on the network path | The build context, the snapshot, the result and the limits, when the machine configuration allows a remote engine |
| An authenticated network user | The Windows slot pipe |
| Whoever can publish a release of a dev package or an action CI uses, or take over the account or repository that does | CI on the bot's pull request before any merge; once merged, the compiler in every test run and the build before a publish, and the actions the release workflow uses |
| Whoever controls the owner's GitHub account, or can push a branch to this repo | The release workflow: a tag starts it, and a tag run uses the file at the tagged commit (ADR 0035). Only an admin creates a `v*` tag, and the `npm` environment admits `v*` tags, with the owner as its reviewer. They can stage a version, but cannot make one live without the owner's npm two-factor approval. The environment's approval and its tag policy guard the token only as far as npm enforces the environment the trusted publisher names, which is unconfirmed (claim R10 of the spec on issue 6); the actor stays "can push a branch" until npm's docs say it is enforced, and the tag policy counts as a control only under that caveat |

## How athanor works

**The setup.** One person, the owner, runs many Claude Code sessions on one
Windows 11 machine with Docker Desktop, often in clones or worktrees of one
repo. Each session runs `athanor run` to test its work in a Linux container. CI
runs athanor on Linux. athanor uses the Docker engine and builder the user has
configured, on this machine, or on another one when the machine configuration
allows it (ADR 0012, ADR 0021).

**What athanor does.** It queues test runs and keeps a set number running at
once, each in its own container, so that parallel runs don't collide (ADR
0033). It reads the repo configuration (`athanor.json`, or the
`athanor` key in `package.json`) and an optional machine configuration, builds
the repo's Dockerfile into an image, takes a snapshot of the work with git,
holds one of N slot locks, and pipes the snapshot into a fresh container that
runs the test command. It writes only to its state folder (`~/.athanor`, or
`ATHANOR_HOME`), except that a host clean filter can write the repo's git
folder; with `--output`, it also writes into the new folder the caller names
(ADR 0023). Both are covered by the class "What athanor records, shows and
leaves behind".

**Serving.** `athanor serve <name>` runs a server declared under `servers` in
one container, in the foreground, until a signal or until the server exits. The
container sees the working tree read-only and has a network, and one port is
published on 127.0.0.1 (ADR 0034). It holds a server lock, not a run slot.

## Boundaries and how each holds

Each control below ends with its reason under the scope above (ADR 0033):
`collision` (parallel runs, or a run and the owner's working tree, stay
apart), `machine load`, or the boundary in scope it holds, named short as
`shared or remote engine`, `network exposure`, `records and leaves behind`
or `release and CI` for the four in-scope boundaries above. A control with
none says `none under this scope`: it is a candidate to loosen, on issue 84,
and stays until the owner decides its own spec. A value outside those, such as
correctness, is named where a control keeps one, but is not a reason.

```mermaid
flowchart LR
    subgraph Host["Owner's machine (a compromised one is out of reach)"]
        Repo["Repo and its configuration"]
        Athanor["athanor (no shell, git and docker by full path)"]
        State["State folder and slot locks"]
    end
    subgraph Engine["Docker engine and builder (a shared or remote one is the operator's)"]
        Build["Image build (has the network)"]
        Run["Test container (no network, six capabilities, limits)"]
    end
    Repo --> Athanor
    Athanor --- State
    Athanor -- "build context" --> Build
    Build --> Run
    Athanor -- "snapshot on stdin" --> Run
    Run -- "output, and --output files" --> Athanor
```

- **No shell on the host.** Every child process starts from an argument array
  with `shell: false` (ADR 0002). The source check fails the build on any
  shell use. A test command with `;`, `&&`, `$(...)`, quotes or spaces reaches
  the container as the same literal arguments (C16).
  Reason: none under this scope; it keeps correctness, a command's words
  reaching the container as written.
- **Nothing from the host reaches a run's test container** but the snapshot on
  stdin and `ATHANOR_GRACE_LIMIT`. This is `athanor run`'s container; a
  server's gets the tree, a network and a port by design (see "A server's container"
  below, ADR 0034). This, and the limits below, hold only as
  far as the engine enforces them: on an engine the owner runs, they hold; on
  someone else's engine, the operator decides (accepted class "A shared or
  remote engine, and the network"). With a base, the snapshot's stream also
  carries the base's history: the commit, tree and file objects from the merge
  base onward, a list of the commits whose parents were left out, two refs and
  the snapshot's tree id; never a git setting, hook or remote (ADR 0032;
  accepted class "What athanor records, shows and leaves behind"). Reason,
  for leaving out the settings, hooks and remotes: records and leaves behind.
  Each control below gives its own.
  - **No host folder and no Docker socket:** no `-v` and no `--mount` (ADR
    0016, C6). Reason: collision; a run can't write the owner's working tree,
    another run's files or another run's container.
  - **No network for the test run:** `--network none` (C19; the image build
    has the network, see Out of scope). Reason: none under this scope; it
    keeps tests from touching real services by accident, and keeps a run's
    ports off the host's, though a bridge network would do that too. The
    class "What athanor records, shows and leaves behind" gives "the test
    container has no network" as part of why it is accepted: loosening this
    control reopens that class.
  - **No host environment value, and the ten proxy names blocked:** the only
    `-e` are `ATHANOR_GRACE_LIMIT` and, with empty values, the ten proxy names
    the Docker CLI fills from the five proxy settings it reads today (ADR
    0016). Reason: records and leaves behind, and shared or remote engine; the
    engine keeps a container's environment in its record of it, where a
    shared engine's users and a remote engine's operator can read it. A
    known gap: a proxy setting that a later Docker client adds reaches the
    container until athanor's list of ten blocked names is updated. A value
    the build writes into the image or its cache is the build's own (out of
    scope, a repo's own code), and the engine end can read it (accepted class
    "A shared or remote engine, and the network").
  - **No privileged mode, and six capabilities:** `--cap-drop ALL`, then
    `--cap-add` for `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID` and
    `SETGID` only, an allow-list (ADR 0016, K1, K2, P1). Reason: none under
    this scope.
- **Fixed limits on each run:** memory and memory-swap, a process limit (1024 unless `processes` is configured or `maxProcesses` is lower, held to the machine's `maxProcesses`, default 1024; N2, N3, N4), a host-side time limit and an in-container timer (C7, C11, K4), and CPUs when `cpus` or `maxCpus` is configured (U1, U4, accepted class "The machine's load"). The ceilings that the machine configuration sets bound what any repo can ask for, including a command's own limits (M4, N3), and `maxProcesses` bounds the process limit; only `maxCpus` has no default (C31, U3).
  Reason: machine load.
- **`no-new-privileges`** on each run. Reason: none under this scope.
- **A server's container** (`athanor serve`, ADR 0034). It is not a run's
  container: it gets the working tree read-only, a bridge network and one
  published port, and it has no time limit.
  - **One port, on 127.0.0.1 only:** `-p 127.0.0.1::<port>`, or
    `-p 127.0.0.1:<host port>:<port>` with `--port`. If Docker reports the
    port on any other address, athanor removes the container and exits 125
    (E5). Reason: network exposure; what athanor exposes on the network is in
    scope. Every program on the machine, and every other container on Docker's
    default bridge network, can still reach it (accepted class "A server's port
    on this machine").
  - **The tree read-only, and a volume per writable folder:** the tree is a
    read-only bind mount at the image's `WORKDIR`, each `writable` folder is an
    anonymous volume that Docker seeds from the image, and nothing else is
    mounted: no `-v` and no Docker socket (E2, E11). Reason: collision; two
    servers of one tree never write the same files, and athanor never writes the
    tree.
  - **`maxServers` and the limits:** a server lock for each server, at most
    `maxServers` (default 2), and the same memory, swap, process and CPU
    limits as a command's (E7, E2). Reason: machine load. A server has no time
    limit (accepted class "The machine's load").
  - **The engine on this machine:** `serve` refuses an engine that is not on
    this machine, even with `allowRemoteDocker`, since a bind mount takes its
    path from the engine's machine and 127.0.0.1 is that machine's (E4). Reason:
    shared or remote engine.
  - **The kept capabilities and the proxy blanks:** `--cap-drop ALL` with the
    six `--cap-add` of ADR 0016, `--security-opt no-new-privileges`, the ten
    `-e NAME=` proxy blanks and no other `-e`, as for `run` (E2). Reason: none
    under this scope for the capabilities and `no-new-privileges`; for the proxy
    blanks, records and leaves behind, and shared or remote engine (they keep a
    proxy password out of the engine's record).
  - **A fixed boot script, and a check container:** `SERVE_BOOT` is fixed text
    with nothing interpolated into it, and the short-lived container that checks
    each `writable` folder has no mount and `--network none`, with the same caps,
    limits and proxy blanks (E2 pins the boot text and the server's call; E4
    runs the check; the check container's own arguments are checked by
    reading). Reason: none under this scope.
- **Configured paths stay in the repo.** Every `dockerfile`, `context` and
  `inputs` path is resolved through symlinks with the same realpath function
  as the repo root and compared segment by segment, ignoring case on Windows,
  before any Docker call (C17). Reason: collision; the image's tag keys on
  files in the repo, so a run never gets an image built from files outside
  what the tag covers.
- **The configuration files are checked as they are opened.** `athanor.json`
  and `package.json` must each be a regular file whose real path is inside the
  repo, and must have no second hard link. The file is opened once, and the
  open handle must be the regular file that was checked, before any of its
  content is read (J6). Reason: none under this scope; it held against a
  local program swapping the file, now the class "A compromised machine or
  sandbox".
- **Only the hashed set reaches the build.** The build context is exactly the
  tracked files under `context`, and files added with `git add -N` under
  `context`, plus the listed `inputs`, each of which must be tracked: no
  untracked or ignored file and no git folder (ADR 0006, C28). Reason:
  collision, and records and leaves behind; parallel runs never share an image
  built from other files, and an ignored file, such as a `.env`, never reaches
  the build or a remote builder.
- **The archive step carries the tree as committed.** Every `git archive`, and
  the `git init` of athanor's archive folder, run with every inherited `GIT_*`
  variable removed, no global or system git config or attributes (on git 2.32
  or later), and no git template; the archive also has `-filter` on every
  path. So no content filter runs on the host while the stream is made, and no
  host git setting changes a file in that step. This keeps host git settings
  out of the archive step; it is not a control against a process that can
  write the environment or the home folder, which already chooses the git that
  runs. The line endings and file modes are
  pinned, and the tree's own `text`, `eol`, `ident` and
  `working-tree-encoding` attributes still apply (ADR 0020, C32, G1–G6). The
  git calls that make the snapshot's and the build context's trees still run
  with the host's git config and environment (accepted class "What athanor records, shows and leaves behind", issue 42).
  Reason: none under this scope; it keeps the same bytes on every machine.
- **git and docker by full path.** git and docker start by a full path from
  PATH's absolute entries, so a program of that name in the working folder, or
  one found through a relative or empty PATH entry, never runs in their place,
  which on Windows was the repo's own folder (ADR 0020, G8). A full PATH entry
  into the repo, such as the one npm adds for its scripts, or another spelling
  of the working folder, is the environment's choice, as above. Reason: none
  under this scope; a program planted there is the repo's own code or the
  class "A compromised machine or sandbox".
- **athanor's own git calls never write the repo.** Snapshots use a copy of the index and a
  per-run object folder (ADR 0007, C21, C30), except as accepted class "What athanor records, shows and leaves behind" says:
  a clean filter the host defines, such as Git LFS's, can write the repo's git
  folder (issue 42). Reason: collision; parallel runs and the owner's own work
  in the repo never touch each other's index, stash or working tree.
- **Docker on this machine, unless the machine allows otherwise, and never in
  clear.** A run refuses an engine or builder that is not local (a unix
  socket, the local pipe in its exact form, or tcp to loopback) unless the
  machine configuration sets `allowRemoteDocker`, which a repo cannot set; the
  machine file follows `ATHANOR_HOME`. It refuses plain tcp to the engine and
  to every builder node, and any builder whose transport it could not read,
  unless `allowPlainTcp` is set (ADR 0013, ADR 0021). What was checked is
  pinned by name for the whole run and checked again once the slot is held
  (ADR 0021; L2, L5, L6, L8, L10, L11). Reason: shared or remote engine.
- **What comes back from the container.** The test's stdout and stderr stream
  to the caller. With `--output`, the paths a named command declares are
  copied from the stopped container, addressed by its ID with the pinned
  Docker environment, into a new folder the caller names. That folder is made
  by athanor. It is owner-only on Linux (mode 0700), and on Windows it
  inherits its parent folder's access rules (accepted class "What athanor records, shows and leaves behind").
  - Names are checked as text and never resolved, `.git` included.
  - Only regular files and folders are written. Links and devices are skipped.
  - Every create is exclusive.
  - Size, entry count and time are capped.
  - On error, what was made is removed from a list (M10–M17).
  - The file names Windows acts on when it shows a folder are skipped, and a
    folder laid out as a bare git repository athanor recognises is refused.

  Reason: records and leaves behind, and shared or remote engine; a copy
  writes only into the folder the caller named, and a remote engine's
  operator, who chooses what the copy holds, can't write past it. The caps
  also serve machine load.
- **The run limit holds through a hard kill.** The slot is an OS lock that the
  OS frees when the process ends, and a run removes its slot's labelled
  container before starting its own (ADR 0004, C8, C10). Reason: machine
  load, and collision; this is the queue itself.
- **What athanor keeps of a run.** The container runs with `--log-driver
  none`, so the engine keeps no copy of the test output. The state folder is
  mode 0700 on Linux, and the stale-run sweep removes a hard-killed run's
  folder a day later. Reason: records and leaves behind.
- **Temporary names are random.** Temporary names use Node's crypto random
  source. Reason: collision; parallel runs never pick the same name.
- **The `--output` parent is checked.** On Linux, athanor refuses a parent
  that other accounts can write unless it has the sticky bit, and every path
  is built from the parent's real path recorded at the start. Reason: records
  and leaves behind.
- **Machine configuration is data.** It is validated key by key and holds no
  paths or commands, and only it can set `allowRemoteDocker` and
  `allowPlainTcp`. Reason: shared or remote engine; where a run's work goes is
  the machine owner's choice, and never comes in with a repo.
- **Holder answers are shown, not trusted.** `status` skips an answer that is
  not one well-formed JSON line of the expected shape, or whose repo name holds
  control characters. Reason: none under this scope; a local program faking
  an answer is the class "A compromised machine or sandbox". It keeps
  correctness, `status` not breaking on a garbled answer.
- **The ceilings are checked before use.** A repo's or a command's limits
  above the machine configuration's ceilings exit 125 with a plain message
  (C31, M4, N3, N4). Reason: machine load.
- **Other values are validated before use.** Repo configuration, machine
  configuration, environment values, CLI arguments, command names and
  configured paths are each checked, and a bad value exits 125 with a plain
  message (the Input validation item below). Reason: none under this scope.
  It keeps correctness.
- **A named base is checked and resolved apart from the repo's settings.** The
  name is checked before git sees it (a command's `base` only to a
  remote-tracking branch or a tag), resolved to one ref with replace refs and
  grafts off (on git 2.32 to 2.41 the repo's own config may turn replace refs
  back on, issue 72) and lazy fetching off on git 2.45 and later, and a
  shallow or partial clone is refused (the Input validation item below, ADR
  0032). Reason: none under this scope; a
  planted git setting or ref is the repo's own code or the class "A
  compromised machine or sandbox". The shallow and partial refusals keep
  correctness, a base that carries all its history.
- **The build's own supply chain.**
  - Install scripts are off in the repo (`.npmrc`) and on CI's `npm ci`.
  - The lockfile pins each dev package by integrity hash, and every package
    resolves from the public registry.
  - CI checks registry signatures against the public registry's keys.
  - Actions are pinned by full SHA. zizmor checks each pin belongs to the
    action's own repository, using the job's read-only token, which it sends
    only to GitHub's API.
  - Updates come from the update bot after a 7-day wait, except security
    updates. A bot pull request's passing check is not evidence the update is
    safe: the wait and the owner's merge are the controls.
  - CI holds no secrets. Its token is read-only (accepted class "The release and CI supply chain").
  - The first publish is by hand, as before (`docs/releasing.md`).
  - The owner's push of a tag `v<version>` starts the release workflow
    (ADR 0035). `X.Y.Z` stages for the dist-tag `latest`, `X.Y.Z-rc.N` for
    `next`. A tag run uses the `release.yml` at the tagged commit, so the
    guards in `check` (the owner as actor, the commit `main`'s head or behind
    it, CI green, the tag matching `package.json`) and the workflow check's
    rules (a tag-only trigger, no checkout where the token is minted,
    `--tag` always set, no `npm publish`, `npm dist-tag` or
    `npm stage approve`) guard against honest mistakes only. The controls that
    hold are the admin-only tag ruleset, the `npm` environment's tag policy
    with the owner as reviewer (under the R10 caveat), npm's binding to
    `release.yml` and `npm`, the owner's look in step 13 and stage-only
    publishing with two-factor approval. The dist-tag is read from the
    tarball's own `package.json`, by a block that never unpacks the tarball.
  - Later versions are staged from the release workflow's `publish` job.
    GitHub issues an identity token there only after the owner approves the
    `npm` environment. That token proves the job's identity to any service
    that trusts it, including Sigstore for provenance. npm exchanges it for a
    token that can only stage, once the owner has added the trusted publisher
    with staging as its only allowed action (step 9 of `docs/releasing.md`,
    R10).
  - A staged version goes live only when the owner approves it with npm 2FA.
    The owner logs in only after the local build and logs out straight after.
    Publishing access disallows tokens, once the owner has set it before the
    merge (`docs/releasing.md` step 2, recorded in step 9).
  - See ADR 0018, A1 to A6, and ADR 0019.
  - The package has no runtime dependencies (ADR 0001).
  - The GitHub release has two tag rulesets on every tag and immutable
    releases, and the owner reads each release as a draft before it is
    published (ADR 0031).

  Reason: release and CI.

## The sensitive-work list

- **Authentication and authorization.** athanor has no accounts or logins.
  The slot locks are open to any local program (accepted class "A compromised
  machine or sandbox", for a local program under any account; and accepted
  class "The Windows slot pipe on the network", for the pipe's reach from the
  network). It
  relies on the operating system's user separation for the state folder
  (mode 0700 on Linux; on Windows, the home folder's own access rules). The
  `--output` folder is mode 0700 on Linux, and on Windows inherits its parent's
  rules (accepted class "What athanor records, shows and leaves behind"). It relies on whatever access control the configured Docker engine has. Docker Desktop's
  local engine is the owner's; when the machine configuration allows a remote
  engine, its access control is its operator's (accepted class "A shared or remote engine, and the network"). The
  release path has its own: npm's trusted-publisher binding to this repo,
  workflow and environment, the `npm` environment's required reviewer and
  tag policy, the admin-only tag ruleset, and the owner's npm two-factor
  approval (the supply-chain bullet above; ADR 0019, ADR 0035). The GitHub release has two tag rulesets on every tag, which
  keep each tag on its commit and let only an admin create one, immutable
  releases, and the owner's read of each release as a draft before it is
  published (ADR 0031; accepted class "The release and CI supply chain").
- **Secrets.** athanor stores no secret of its own. A secret committed to the
  repo goes into the container with the snapshot, and into the build if it is
  under `context` or listed in `inputs`; the build has the network
  (out of scope: a repo's own code). With `--untracked`, the untracked files git doesn't
  ignore go into the container too, so a secret in one the ignore list misses
  goes with them; they never reach the build. With a remote engine or builder, those copies go to that
  machine when the machine configuration allows it (accepted class "A shared or remote engine, and the network"), and a
  remote builder can ask this machine for the
  owner's registry credentials (accepted class "A shared or remote engine, and the network"). A file added with `git add -N`
  goes where tracked files go. With a base, the commits from the merge base
  onward go into the container too, with every file they hold, deleted ones
  included, and their authors' names, emails and messages, and they go
  wherever the snapshot goes (accepted class "What athanor records, shows and leaves behind"). Copied outputs can hold whatever the tests
  wrote, such as a mutation report's copy of the source, and stay in the
  caller's folder, as plain files (accepted class "What athanor records, shows and leaves behind"); athanor never cleans them
  up. A named command's arguments show in the host's process list and the
  engine's record of the container (accepted class "What athanor records, shows and leaves behind"). The Docker client's proxy
  settings can hold a password: the run blocks it (ADR 0016), and the build
  receives it (out of scope: a repo's own code). Plain tcp transport is refused
  by default (ADR 0013; accepted class "A shared or remote engine, and the network" for the opt-out). Test output can hold
  secrets: athanor streams it to the caller, keeps no copy, and runs the
  container with `--log-driver none`. When the caller is an agent session, the
  output goes on to that session's model provider, as it does when tests run
  on the host. The release path holds two credentials for a short time: the
  publish job's identity token (accepted class "The release and CI supply chain"), and the owner's npm login
  around an approval, around a step 17 unpublish or deprecate, around a check
  or reject after a failed run, and around a rollback (`docs/releasing.md`, "Stop conditions and rollback"; accepted class "The release and CI supply chain"); see the supply-chain bullet above and ADR 0019. The GitHub
  release uses a third, long-lived one: the owner's gh login, kept in the
  system keyring, which can publish releases, create tags, change the tag
  rulesets and immutable releases, push branches, edit workflows and read
  the repo's private security advisories (accepted class "The release and CI supply chain"). The owner's
  npm session token sits in the user npm configuration from login to logout,
  unencrypted at file level. It relies on the machine's disk encryption, which
  the owner confirmed is on (2026-10-24), and on npm's two-factor check on
  every write.
- **Crypto.** SHA-256 keys the image cache and is not a security control,
  except that on a shared engine the tag is the only link between a run and
  its image (accepted class "A shared or remote engine, and the network"). Temporary names use Node's crypto random source.
  athanor encrypts nothing itself; transport to a remote engine or builder is
  ssh or verified TLS unless `allowPlainTcp` is set (ADR 0013, ADR 0021). The
  `--output` folder sits unencrypted on the host's disk, like the state folder.
  With a base, a run's pack of the base's history sits unencrypted in the state
  folder until the run has streamed it into the container (or, if it can't be
  removed then, until the run ends), and after a hard kill until the stale-run
  sweep, like the rest of it.
  Image layers, the build cache and a container's writable layer sit
  unencrypted on the engine's or builder's disk: on this machine they rely on
  its disk encryption; on a remote one, which the machine configuration must
  allow, on that machine's owner (accepted class "A shared or remote engine, and the network"). `prune` does not clear Docker's build
  cache; the README names the commands that do. Each released version's
  provenance is signed by npm through Sigstore (the supply-chain bullet above;
  ADR 0019).
- **Input validation.** Repo configuration, machine configuration,
  environment values, CLI arguments, command names and configured paths are
  each validated before use, and a bad value exits 125 with a plain message
  (C17, C18, C24, C31, N4). A named command's arguments are accepted only when it
  sets `args`, and are passed as literal arguments (M5, M6). The `outputs`
  entries, `--output`, and every entry name and header in a copied tar are
  checked too (M10, M11, M13). The engine endpoint and every builder node are
  checked for locality and plain tcp, read as Docker reads them (a value with
  no "://" is tcp; a pipe in one exact form), pinned for the run and checked
  again once the slot is held (ADR 0013, ADR 0021; L1, L2, L5, L8, L10, L11). Holder answers are shown as reported, never as checked facts.
  git settings, attributes, templates and `GIT_*` variables inherited from the
  host are kept out of the archive step (ADR 0020); the git calls that record
  the work still use them (accepted class "What athanor records, shows and leaves behind").
  A base name is checked before git sees it (no leading `-`, no revision
  syntax, no control or format character), then resolved, with the ambiguity
  check pinned on, to one branch, remote-tracking branch or tag (a command's
  `base` to the last two), in ADR 0020's clean environment with the repo's own
  config still read, replace refs off (on git 2.32 to 2.41 the repo's own
  config may turn them back on, issue 72), grafts off, and lazy fetching off on
  git 2.45 and later. The name git resolves to gets the same control-set check. A
  shallow or partial clone, and a snapshot holding the reserved path, are
  refused; on git 2.32 to 2.44 the partial-clone refusal is the only guard
  against a fetch (ADR 0032; B1, B5, B7).
  The release path's untrusted inputs are the pushed tag's name, the artifact
  `publish` takes from `check` (its `package/package.json` is read by one
  fixed block and nothing else of it is unpacked there), the staged tarball
  the owner downloads, the registry's manifest,
  which is checked once the version is live, and the
  registry's answer to the version check. They are covered by the owner's
  look before approval (`docs/releasing.md`), accepted class "The release and CI supply chain", and
  ADR 0019.
- **Data migrations.** None. The state folder holds only marks, temporary
  indexes and per-run folders (with a base, a run's pack of the base's
  history among them), which are safe to delete.

## Accepted threat classes

The owner accepts each class below. A finding that fits one needs nothing,
though a session may still fix it in passing if it's cheap. A finding that fits
none comes to the owner as a new class, and only a merge the owner confirms
adds or widens one. A class says what it covers, never the steps. A class a
user has to act on or know about has a line in the README's "What athanor
doesn't protect you from"; the release and CI class stays here alone.

- **The Windows slot pipe on the network.** On Windows, a slot is a named
  pipe, and the pipe does not refuse remote clients, so an authenticated user
  elsewhere on the network can possibly read the details a holder reports
  (pid, start time, repo folder name, limit, and for a server lock also the server's name and host port). Accepted because limiting the
  pipe needs a native package, which "no dependencies" rules out, and the
  details are small.

- **A server's port on this machine.** `athanor serve` publishes a server's port on 127.0.0.1 only, so other machines can't reach it on Docker 28.0 or later. Every program and account on this machine can reach it, and so can every other container on Docker's default bridge network, another server included, at the container's own port. On a Linux engine before 28.0, hosts on the same network segment can also reach a port published on 127.0.0.1, as Docker's documentation says; athanor does not check the engine's version (q2). Accepted because the server is the repo's own dev server, a local program working against the owner is in the class "A compromised machine or sandbox", and the owner chose a documented minimum over a check.

- **A compromised machine or sandbox.** Once a program, process or agent on
  the machine or in the sandbox works against you, it can plant programs a
  bare command name runs, change files a session or a hook reads, and act as a
  session would; athanor does not defend against it. That covers local prompt
  injection and planted files: a rogue agent in the system can change what a
  session reads and runs, and athanor cannot tell it from the owner. It adds
  to "a compromised machine" under Out of scope.
  It also takes over the paths of the former class "Other local programs",
  which ADR 0033 folds in here:
  - Any local program can take the slot names to block runs, or answer
    `status` with false holder details, and can read the details a holder
    reports. A program that owns a slot name and holds the Windows privilege
    to impersonate clients can act with the owner's identity for that
    connection.
  - A program that can write the repo or the folders around it can swap a
    folder under an in-repo link to a configuration file while a run reads
    it, give an outside file its only name in the repo for the moment of the
    read, or mount a file over a configuration name on Linux (root), so that
    at most a key name or path value from it appears in a message; a dangling
    link named `athanor.json` counts as absent, so the `athanor` key in
    `package.json` is used with no conflict message; and on Windows a link at
    the repo root to a network location is followed before athanor tests
    whether it is inside the repo, so the machine can start a sign-in there,
    with no content read.
  - A local program can hold an endpoint athanor counts as local while the
    engine does not (Docker Desktop stopped, say).
  - The agent test hook (ADR 0024) is a nudge, not a control: it fails open
    on any error, stays silent when it cannot find athanor, and reads only a
    command's plain forms.

  No control named here is removed or eased by the fold: the argument-array
  starts, the full-path git and docker lookup, the clean archive environment,
  the configuration file checks and the container's limits keep holding
  against what they hold against. Accepted because a program that already
  acts as the owner or as a session reaches everything athanor reads and
  starts, so no control inside athanor can stop it; a process with the
  impersonation privilege can usually reach SYSTEM anyway; and the hook exists
  to make a skipped rule visible.

- **A shared or remote engine, and the network.** With `"allowRemoteDocker":
  true` in the machine configuration, athanor uses the engine and builder the
  user has configured, including one on another machine or a cloud builder.
  Whoever runs it receives the build context and the snapshot, uncommitted
  changes, files added with `git add -N` and any committed secret included,
  and keeps copies in its image layers and build cache. The build arguments,
  a proxy password among them, and whatever the build leaves in the image's
  files, metadata or history or in the build cache, are readable there by its
  operator and, on a shared engine, by its other users. It decides the result
  athanor reports, whether "no network" and the limits are enforced, the text
  streamed back into the session and the files a copy writes to the host; as a
  builder it can ask this machine for the owner's registry credentials; and
  before athanor decides on a builder, `buildx inspect` contacts its nodes, so
  a remote builder host sees the connection and, for an ssh node, the owner's
  login, but no repo data. Other users of a shared engine can put their own
  image under the tag athanor runs, read the snapshot in a running container
  and the build context in an image, reach a stopped container for the length
  of a copy, and remove containers, which also breaks the run limit across
  machines. With `"allowPlainTcp": true`, the snapshot, the build context, the
  build arguments, the test output and copied files cross the network
  unencrypted, readable and changeable by anyone on the path; plain tcp to
  another host also needs `allowRemoteDocker`, and the opt-in covers builder
  nodes and builders whose transport athanor could not read (ADR 0021). An
  endpoint athanor counts as local, a `unix://` socket, the local pipe or a
  loopback port, can lead elsewhere when it is forwarded to another machine;
  `localhost` is trusted as loopback. The files a copy writes are the engine's
  choice: athanor skips the file names Windows acts on when it shows a folder
  (`desktop.ini`, `.lnk`, `.url`, `.scf`, `.library-ms`,
  `.searchConnector-ms`, theme files), and refuses a folder laid out as a bare
  git repository it recognises, but a spelling or layout it does not know is
  written, so the README advises `safe.bareRepository=explicit`.
  Accepted because the owner chose to let athanor run against any Docker the
  user sets up and the user chooses whom to trust with that; the README and
  SECURITY.md say not to share an engine with people you don't trust; the
  opt-ins can be set only in the machine configuration, never by a repo; and
  athanor cannot tell where a local address leads without trusting the
  machine, and Docker offers no check of the engine's identity.

- **The machine's load.** athanor exists to keep parallel runs from
  overloading the machine (ADR 0033); this class names the limits it leaves
  open. A server has no time limit. A server whose caller was killed hard on Windows keeps running, with its memory, CPU and the tree's mount, until the next `athanor serve` on the machine sweeps it; `athanor status` lists it as an orphan until then. A test that kills the in-container timer, together with
  a hard-killed caller, leaves one container running until its slot is next
  used, when the next run removes it; until then it keeps the run's snapshot,
  uncommitted files included. With no CPU limit configured (`maxCpus` unset), a
  run, or such a leftover container, can keep every CPU the engine has busy,
  which on Docker Desktop is every core of the VM, slowing the host and the
  owner's other runs; the run's time limit ends it. A machine that raises
  `maxProcesses` lets a repo's test code hold that many processes in each
  run, all from the engine's one process table; several runs near a high
  ceiling can fill it, and the engine and its other containers then cannot
  start processes (on Docker Desktop that may reach other programs sharing the
  VM; on a Linux host the table is the host's own). While it is full,
  athanor's stop at the time limit may fail to start, so a test that has ended
  the in-container timer can outlast the limit, and removing a leftover
  container can fail too, so recovery may need an engine restart (on Linux,
  the host's own recovery). A ceiling near the top (4194304) is in effect no
  limit. Memory, swap and the default of 1024 processes stay bounded. Accepted
  because the next run on the slot removes a leftover container, the next `serve` removes a leftover server and `status` shows one, the owner
  chose speed by default and `maxCpus` bounds it, the repo is code the owner
  trusts to build, raising the ceiling is the machine owner's act, and the
  README advises keeping `maxProcesses` times the largest run limit, plus the
  engine's other containers, well below the engine's process limit.

- **What athanor records, shows and leaves behind.** The git calls that make
  the snapshot and the build context (`stash create`, `add`, `hash-object`)
  run with the host's git config and environment, so a clean filter the repo's
  attributes name runs on the host, its output reaches the container and the
  build, and Git LFS's filter writes the repo's `.git/lfs` folder, where the
  copy stays, including, with `--untracked`, files the owner has not added
  (issue 42). Messages that name the machine configuration file, a path in the
  state folder, or the repo carry the full path, which holds the account's
  home-folder name, to whatever reads athanor's output, such as an agent
  session and its model provider; an unexpected file-system error while
  copying, such as a full disk, can end athanor with a stack trace showing
  local paths, though the copy is still removed and the slot released. The
  `--output` folder gets no access rules from athanor and, on Windows,
  inherits its parent's: under a parent other accounts can read, they can read
  the copied files, and under a parent they can change, they can swap a folder
  inside it for a link while the copy runs, so a write or cleanup lands
  elsewhere the owner can write, on any platform without a sticky bit; every
  path is built from the parent's real path recorded at the start, which
  narrows the swap of the parent but not of a folder inside. Copied outputs sit
  as plain files with nothing encrypting them, and can hold a copy of the
  source or anything the test read; the README advises a parent under the user
  profile. A named command's arguments show in the host's process list, in the
  engine's record of the container until it is removed, and to a remote
  engine's operator. A named base carries every commit from the merge base
  onward, on the base's side and the branch's, into the snapshot: its files, a
  file since deleted (a secret, say) among them, and its metadata (author and
  committer names, emails, dates, messages with trailers, signatures, a merged
  signed tag's tagger and message). It lands in the container's repository,
  where the test code can read it and the output can carry it out, and it goes
  wherever the snapshot goes; a run killed hard can leave its pack of that
  history, unencrypted, in the state folder until the stale-run sweep a day
  later. Accepted because the owner's own `git add` runs the same filters and a
  fix changes what the snapshot holds (issue 42); the names are the owner's
  own, going to the owner's own session, and naming the file to fix is what
  makes a message actionable; the rare failure is not worth wrapping each file
  call in code; the owner chose the folder's place and a host run's reports
  land under the same rules; the repo's working tree sits unencrypted on the
  same disk; the README says not to pass secrets as arguments; and the history
  is the repo's own, a base is named only for checks that need it, and the test
  container has no network.

- **The release and CI supply chain.** A hijacked release of a dev package or
  an action that CI uses, or a taken-over account or repository, runs in CI on
  the bot's pull request before any merge, with the job's read-only token, and
  can set that check's result; CI holds no secrets. Once merged, the
  TypeScript compiler, the one dev package that runs, runs as the owner in
  every test run and in the build before a publish: it can read what the owner's
  account can read, shape the published code, and use the owner's `gh` login,
  kept in the system keyring between releases, with which it can publish a
  GitHub release (a permanent Zenodo record), create tags, edit or delete the
  tag rulesets, turn immutable releases off, push branches, edit workflows and
  read the repo's private security advisories; a rebuild uses the same
  compiler, so it cannot see the change. A hijacked action run on a push to
  `main` can write Actions cache entries that a later workflow restoring the
  cache would read; nothing restores a cache today, and the workflow check
  fails one that does. Code in the release's `check` job (a dev package, the
  compiler, the test code, an action, or a process an earlier step left
  running) can change any file that is packed, and `publish` stages exactly
  that; the owner's comparison of every staged file with a local pack of the
  same commit, before the login, catches every change made only on the runner.
  An action in the `publish` job (`actions/download-artifact`,
  `actions/setup-node`, or the npm it provides) can ask for the identity token,
  and with it stage another tarball or extra versions, use up the 2-day
  validation of a new trusted publisher, or get a Sigstore signature in this
  workflow's name for some other file. The registry's manifest, which a publish
  sends apart from the tarball, is first seen in step 17's `npm view`, after
  the version is live, so whoever installs before then gets that manifest's
  dependencies; a bad one is unpublished while npm's policy allows, else
  deprecated, and a deprecated version still installs. A tag starts the
  release workflow (ADR 0035), and a run started by a tag uses the
  `release.yml` at the tagged commit: a tag on a commit off `main`, with an
  edited workflow, runs the edited file. The workflow's guards (the owner as
  actor, the commit `main`'s head or behind it, CI green, the tag matching the
  version, the four workflow rules) guard against honest mistakes only. What
  gates the identity token is the `npm` environment's approval (the owner,
  with the owner's two-factor approval at npm for anything that goes live) and
  the admin-only tag ruleset, only as far as npm enforces the environment the
  trusted publisher names (R10, unconfirmed). Against whoever holds the owner's
  GitHub account or gh login, who can also create tags and change the rulesets
  and the environment, only stage-only publishing and the owner's npm
  two-factor approval hold, as before this change. Any tag already pushed can start
  a run, the tags of rejected and unpublished versions and of release
  candidates among them, and a pushed tag never moves. An action in `publish`,
  or the npm it provides, could stage the owner's reviewed rc under `latest`
  if `npm stage view` shows no dist-tag. The dist-tag is read from the
  tarball's own version, by a block that lists the tarball by name and
  accepts only entries under `package/` with exactly one `package/package.json`,
  so code in `check` shapes it only through that version. What binds the
  dist-tag to the version npm stages is the owner's step 15: one staged entry
  for this version, the entry list and every file compared with a local pack,
  and the summary's dist-tag compared with the version. The rollback in
  `docs/releasing.md` ("Stop conditions and rollback") recovers it. From
  `npm login` to `npm logout`, around an approval, around a step 17 unpublish
  or deprecate, around a check or reject after a failed run, and around a
  rollback, the npm session token sits in the
  user npm configuration
  unencrypted at file level, readable by any program running as the owner,
  including one left behind by the local build. Whoever can write to the repo,
  or act as the owner's account, can publish a GitHub release on any tag
  already pushed, and Zenodo then archives that tag's tree for good and mints a
  DOI; the tag rulesets keep each tag on its commit and let only an admin
  create one, but no repository setting limits who publishes a release.
  Accepted because the wait before the update bot's pull requests, the
  registry's signatures, the SHA pins, the owner's merge, the admin-only tag
  ruleset, the `npm` environment's approval, stage-only
  publishing, the owner's look at the staged version and the owner's npm
  two-factor approval narrow every window, nothing goes live without that look
  and approval, no cheap independent check of the compiler's output exists,
  npm requires two-factor on every write, and no other collaborator or deploy
  key can write to the repo; the owner makes each release by hand, as a draft
  read before it is published (ADR 0019, ADR 0031, ADR 0035). The owner
  accepts this change to the class by merging ADR 0035.

## Open issues

- **#42:** the snapshot's git calls still run the host's content filters and
  can write the repo's LFS store.
- **#72:** a named base's git calls do not yet pin replace refs off on git 2.32
  to 2.41, or match an inherited `GIT_DIR`.
