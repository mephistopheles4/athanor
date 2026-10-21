# Threat model

**Status: decided by the owner on 2026-10-20.** The owner accepted the risks
under "Accepted risks" below, each with its date, the finding it came from and
how the owner's word arrived. A change that would ease a path an accepted risk
names, or remove a control it relies on, is raised in full at review.

This page explains how athanor could break, what it does about each way, and
which risks it would accept. A change that alters a defence named here
updates this page in the same pull request.

## Who and what this covers

**The setup.** One person, the owner, runs many Claude Code sessions on one
Windows 11 machine with Docker Desktop, often in clones or worktrees of one
repo. Each session runs `athanor run` to test its work in a Linux container.
CI runs athanor on Linux. athanor uses Docker as the user has it configured,
local or remote (ADR 0012).

**What athanor does.** It reads the repo configuration (`athanor.json`, or the
`athanor` key in `package.json`) and an optional machine
configuration, builds the repo's Dockerfile into an image, takes a snapshot of
the work with git, holds one of N slot locks, and pipes the snapshot into a
fresh container that runs the test command. It writes only to its state folder (`~/.athanor`, or `ATHANOR_HOME`).

**Who could act against it.**

- **The repo's own code.** The Dockerfile's `RUN` lines run at build time;
  the test suite runs in the container. athanor is for repos the owner
  trusts to build.
- **Another local program** running as any user on the machine, which can
  connect to or squat on the slot names (accepted risks 2, 3 and 9).
- **A process that can write the owner's home folder,** which can change the
  machine configuration or the Docker configuration, as it could the
  environment.
- **Whoever runs the Docker engine or builder the user has configured**
  (accepted risk 7).
- **Other users of a Docker engine shared between machines or people**
  (accepted risk 8).
- **Someone on the network path to a remote engine** (accepted risk 10).
- **An authenticated network user who can reach the Windows slot pipe**
  (accepted risk 3).

**Out of scope.** Flaws in Docker, Docker Desktop and its VM, git, Node and
the operating system themselves. A machine already compromised as the owner's
user. The operator of a remote engine or builder is in scope as an actor
above; the software they run is not.

## Boundaries and how each holds

- **No shell on the host.** Every child process starts from an argument array
  with `shell: false` (ADR 0002). The source check fails the build on any
  shell use. A test command with `;`, `&&`, `$(...)`, quotes or spaces reaches
  the container as the same literal arguments (C16).
- **Nothing from the host reaches the container** but the snapshot on stdin
  and `ATHANOR_GRACE_LIMIT`: no network, no host folder, no host environment
  value, no Docker socket, no privileged mode (ADR 0015, C6, C19, P1). The run
  blocks, with empty values, the ten proxy names the Docker CLI fills from the
  five proxy settings it reads today (accepted risk 11). A value the build
  writes into the image or its cache is accepted risk 1. This, and
  the limits below, hold only as far as the engine enforces them: on an
  engine the owner runs, they hold; on someone else's engine, the operator
  decides (accepted risk 7).
- **Fixed limits on each run:** memory and memory-swap, CPUs, a process limit
  of 1024, `no-new-privileges`, a host-side time limit and an in-container
  timer (C7, C11). The machine configuration's ceilings bound what any repo
  can ask for (C31).
- **Configured paths stay in the repo.** Every `dockerfile`, `context` and
  `inputs` path is resolved through symlinks with the same realpath function
  as the repo root and compared segment by segment, ignoring case on Windows,
  before any Docker call (C17). The configuration files themselves, `athanor.json`
  and `package.json`, must each be a regular file whose real path is inside the
  repo, opened once and checked on the open handle, before any of their content
  is read (J6).
- **Only the hashed set reaches the build.** The build context is exactly the
  tracked files under `context` plus the listed `inputs`, each of which must
  be tracked: no untracked or ignored file and no git folder (ADR 0006, C28).
- **The repo is never written.** Snapshots use a copy of the index and a
  per-run object folder (ADR 0007, C21, C30).
- **Docker as configured, but not in clear.** athanor does not check where the
  engine or the builder runs (ADR 0012, which supersedes ADR 0008; C29 is
  removed). It refuses a plain `tcp://` engine endpoint without TLS
  verification unless the machine configuration sets `allowPlainTcp`, which a
  repo cannot set (ADR 0013). Loopback, ssh and local pipes and sockets pass.
- **The run limit holds through a hard kill.** The slot is an OS lock that the
  OS frees when the process ends, and a run removes its slot's labelled
  container before starting its own (ADR 0004, C8, C10).
- **Machine configuration is data.** It is validated key by key and holds no
  paths or commands.
- **Holder answers are shown, not trusted.** `status` skips an answer that is
  not one well-formed JSON line of the expected shape, or whose repo name holds
  control characters.

## The sensitive-work list

- **Authentication and authorization.** athanor has no accounts or logins.
  The slot locks are open to any local program (accepted risks 2, 3 and 9). It
  relies on the operating system's user separation for the state folder
  (mode 0700 on Linux; on Windows, the home folder's own access rules), and on
  whatever access control the configured Docker engine has. Docker Desktop's
  local engine is the owner's; a remote engine's access control is its
  operator's (accepted risks 7 and 8).
- **Secrets.** athanor stores no secret of its own. A secret committed to the
  repo goes into the container with the snapshot, and into the build if it is
  under `context` or listed in `inputs`; the build has the network
  (accepted risk 1). With a remote engine or builder, those copies go to that
  machine (accepted risk 7), and a remote builder can ask this machine for the
  owner's registry credentials (accepted risk 7). The Docker client's proxy
  settings can hold a password: the run blocks it (ADR 0015), and the build
  receives it (accepted risk 1). Plain tcp transport is refused
  by default (ADR 0013; accepted risk 10 for the opt-out). Test output can hold
  secrets: athanor streams it to the caller, keeps no copy, and runs the
  container with `--log-driver none`. When the caller is an agent session, the
  output goes on to that session's model provider, as it does when tests run
  on the host.
- **Crypto.** SHA-256 keys the image cache and is not a security control,
  except that on a shared engine the tag is the only link between a run and
  its image (accepted risk 8). Temporary names use Node's crypto random source.
  athanor encrypts nothing itself; transport to a remote engine is ssh or TLS
  unless the owner opts out (ADR 0013). Image layers, the build cache and a
  container's writable layer sit unencrypted on the engine's or builder's
  disk: on this machine they rely on its disk encryption; on a remote one, on
  that machine's owner (accepted risk 7). `prune` does not clear Docker's build
  cache; the README names the commands that do.
- **Input validation.** Repo configuration, machine configuration,
  environment values, CLI arguments, command names and configured paths are
  each validated before use, and a bad value exits 125 with a plain message
  (C17, C18, C24, C31). The Docker endpoint is checked only for plain tcp
  (ADR 0013). Holder answers are shown as reported, never as checked facts.
- **Data migrations.** None. The state folder holds only marks, temporary
  indexes and per-run object folders, which are safe to delete.

## Accepted risks

The owner decided each of these on 2026-10-20. Each keeps the number it had as a
candidate, so other work can point at it.

1. **The image build has the network.** The image build runs the repo's own
   Dockerfile with network access, so a repo from someone else can run code
   that reaches the internet, and a `FROM` line can pull the owner's private
   images with the owner's registry login and send their content out.
   Accepted because athanor is for repos the owner trusts to build, and most
   Dockerfiles need the network to install packages.
   Accepted 2026-10-20. From: Spec revision 5, S9 and T4; the security review of the first build (adversarial-lens F8, data-lens F6). How the word arrived: the owner, in chat with the lead session, relayed to the build session.

   The build also gets the Docker client's proxy settings as build arguments,
   and a proxy setting can hold a password.

   - A build step can read it and send it out over the build's network.
   - It can print it into the build output, which reaches the caller and, from
     an agent session, the session's model provider.
   - A Dockerfile that writes it into the image, or only refers to it, can
     leave it in the image's files, metadata or history, or in the build cache.
     There it stays until removed, and `prune` does not clear the build cache.
     The test run, the engine's operator and a shared engine's other users can
     read it there (accepted risks 7 and 8).
   - The configured builder receives it too (accepted risk 7).

   Accepted because the build needs the proxy behind one, and blocking it would
   mean athanor choosing the build's Docker configuration, against ADR 0012.
   Extended 2026-10-21. From: issue 23 (a data-lens finding in the Test review of #13; the Design reviews of this spec). How the word arrived: the owner, in chat with the lead session, relayed to the planning session.
2. **The slot names are open to local programs.** Any local program can take
   the slot names to block runs, or answer `status` with false holder
   details. Accepted because limiting the Windows pipe to the owner's account
   needs a native package, which "no dependencies" rules out.
   Accepted 2026-10-20. From: The spec review (adversarial-lens: the slot locks trust any local process); the security review of the first build. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
3. **Holder details are readable by local programs, and possibly over the
   network.** The pid, start time, repo folder name and limit a holder reports
   can be read by any local program, and, on Windows, possibly by an
   authenticated network user, since the pipe does not refuse remote clients
   (the probe's "another machine" criterion was not tried). Accepted because
   the details are low in value and the pipe's access rules need a native
   package.
   Accepted 2026-10-20. From: The spec review (adversarial-lens and data-lens: holder details disclosed); the security review of the first build (adversarial-lens F5, data-lens F7). How the word arrived: the owner, in chat with the lead session, relayed to the build session.
4. **A hostile test can outlive a hard-killed caller.** A test that kills the
   in-container timer, together with a hard-killed caller, leaves one
   container running until its slot is next used. Accepted because the next
   run on the slot removes it.
   Accepted 2026-10-20. From: Spec revision 5, S9. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
5. **Linux capabilities are not dropped, and the run limit has no upper
   bound.** Accepted because the container already has no network, no host
   folders and `no-new-privileges`, and the run limit is the owner's own
   setting.
   Accepted 2026-10-20. From: Spec revision 5, S9; follow-up issue #4 (try --cap-drop ALL) stands against it. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
6. **The folder lock's shared count.** This candidate does not arise: the
   probe selected the OS lock, and the folder lock was not built. It is kept
   here so the owner can see it was considered. The owner confirmed on
   2026-10-20 that it does not arise.
7. **The configured engine or builder's operator has full control of a run.**
   athanor uses the Docker engine and builder the user has configured,
   including one on another machine or a cloud builder. Whoever runs it
   receives the build context and the snapshot, uncommitted changes and any
   committed secret included, and keeps copies in its image layers and build
   cache. It also decides the result athanor reports, whether "no network" and
   the limits are enforced, and the text streamed back into the session; and,
   as a builder, it can ask this machine for the owner's registry credentials.
   Accepted because the owner chose to let athanor run against any Docker the
   user sets up, and the user chooses whom to trust with that.
   Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F1, data-lens F2), after the owner removed C29. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
8. **A shared engine's other users can read and change runs.** The slot lock
   is per machine, but the container names `athanor-slot-<n>`, the images and
   their tags are per engine. Anyone else who can use the engine can put their
   own image under the tag athanor runs, read the snapshot in a running
   container and the build context in an image, and remove containers, which
   also breaks the run limit across machines. Accepted because the README and
   SECURITY.md say not to share an engine with people you don't trust; this
   is decided under the security bar, not the Hardening budget.
   Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F3, data-lens F3). How the word arrived: the owner, in chat with the lead session, relayed to the build session.
9. **A squatter on a slot name can impersonate the owner on Windows.** Every
   run connects as a client to the other slot names, and `status` does too. A
   local program that owns one of those names and holds the Windows privilege
   to impersonate clients can act with the owner's identity for that
   connection. Accepted because a process with that privilege can usually
   reach SYSTEM by other means, so the gain is marginal, and the fix would drop
   a spec'd warning.
   Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F4); the owner's q10 A. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
10. **Plain tcp, when the owner opts in.** With `"allowPlainTcp": true` in the
    machine configuration, the snapshot, the build context, the build arguments and the test output
    cross the network unencrypted, readable and changeable by anyone on the
    path. Accepted because the opt-out is for networks the owner trusts, and
    only the machine configuration can set it.
    Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F2, data-lens F1); the owner's q8 A2. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
11. **A proxy setting a later Docker client adds.** athanor blanks the ten
    proxy names the Docker client fills from the five proxy settings it reads
    today (ADR 0015). A setting that a later client adds, beyond those five,
    reaches the container until athanor's list is updated, and P1 cannot see
    it. Accepted because a guard at run time would mean either reading the
    client configuration, against ADR 0012, or blanking names in the boot
    script, which is fragile and leaves the engine's copy in place. A Docker
    release that adds a proxy setting is a reason to update the list.
    Accepted 2026-10-21. From: issue 23, the Design review of the spec (adversarial-lens, the fixed list of names; data-lens, P1's reach). How the word arrived: the owner, in chat with the lead session, relayed to the planning session.
