# Threat model

**Status: draft for the owner's approval.** Nothing on this page is an
accepted risk yet. Each item under "Accepted-risk candidates" stays a
candidate until the owner decides it. A session records those decisions in a
separate change, never in the change that reviews them.

This page explains how athanor could break, what it does about each way, and
which risks it would accept. A change that alters a defence named here
updates this page in the same pull request.

## Who and what this covers

**The setup.** One person, the owner, runs many Claude Code sessions on one
Windows 11 machine with Docker Desktop, often in clones or worktrees of one
repo. Each session runs `athanor run` to test its work in a Linux container.
CI runs athanor on Linux.

**What athanor does on that machine.** It reads the repo's `athanor` key in
`package.json` and an optional machine configuration, builds the repo's
Dockerfile into an image, takes a snapshot of the work with git, holds one of
N slot locks, and pipes the snapshot into a fresh container that runs the
test command. It writes only to its state folder (`~/.athanor`, or
`ATHANOR_HOME`).

**Who could act against it.**

- **The repo's own code.** The Dockerfile's `RUN` lines run at build time;
  the test suite runs in the container. athanor is for repos the owner
  trusts to build.
- **Another local program** running as any user on the machine, which can
  connect to or squat on the slot names.
- **A process that can write the owner's home folder,** which can change the
  machine configuration, as it could the environment.
- **Someone who controls a remote Docker engine or cloud builder** that a
  setting points at.

**Out of scope.** Docker, Docker Desktop and its VM, git, Node and the
operating system. A machine already compromised as the owner's user.

## Boundaries and how each holds

- **No shell on the host.** Every child process starts from an argument array
  with `shell: false` (ADR 0002). The source check fails the build on any
  shell use. A test command with `;`, `&&`, `$(...)`, quotes or spaces reaches
  the container as the same literal arguments (C16).
- **Nothing from the host reaches the container** but the snapshot on stdin
  and `ATHANOR_GRACE_LIMIT`: no network, no host folder, no host environment
  value, no Docker socket, no privileged mode (ADR 0005, C6, C19).
- **Fixed limits on each run:** memory and memory-swap, CPUs, a process limit
  of 1024, `no-new-privileges`, a host-side time limit and an in-container
  timer (C7, C11). The machine configuration's ceilings bound what any repo
  can ask for (C31).
- **Configured paths stay in the repo.** Every `dockerfile`, `context` and
  `inputs` path is resolved through symlinks with the same realpath function
  as the repo root and compared segment by segment, ignoring case on Windows,
  before any Docker call (C17).
- **Only the hashed set reaches the build.** The build context is exactly the
  tracked files under `context` plus the listed `inputs`: no untracked or
  ignored file and no git folder (ADR 0006, C28).
- **The repo is never written.** Snapshots use a copy of the index and a
  per-run object folder (ADR 0007, C21, C30).
- **Docker stays local.** A remote engine, a remote context or a cloud or
  remote builder exits 125 before any build or run (ADR 0008, C29).
- **The run limit holds through a hard kill.** The slot is an OS lock that the
  OS frees when the process ends, and a run removes its slot's labelled
  container before starting its own (ADR 0004, C8, C10).
- **Machine configuration is data.** It is validated key by key and holds no
  paths or commands.

## The sensitive-work list

- **Authentication and authorization.** athanor has no accounts or logins.
  The slot locks are open to any local program (candidates 2 and 3). It
  relies on the operating system's user separation for the state folder
  (mode 0700 on Linux) and on Docker Desktop's own access control for the
  engine.
- **Secrets.** athanor reads, stores and passes no secret. A secret committed
  to the repo goes into the container with the snapshot, and into the build
  if it is under `context`, and the build has the network (candidate 1). Test
  output can hold secrets: athanor streams it to the caller, keeps no copy,
  and runs the container with `--log-driver none`. When the caller is an
  agent session, the output goes on to that session's model provider, as it
  does when tests run on the host.
- **Crypto.** SHA-256 keys the image cache and is not a security control.
  Temporary names use Node's crypto random source. Nothing is encrypted by
  athanor. Image layers, the build cache and a container's writable layer sit
  unencrypted on Docker's data disk and rely on the host's disk encryption.
  `prune` does not clear Docker's build cache; the README names the command
  that does.
- **Input validation.** Repo configuration, machine configuration,
  environment values, CLI arguments and configured paths are each validated
  before use, and a bad value exits 125 with a plain message (C17, C18, C24,
  C31). Holder answers on the slot locks are shown as reported, never as
  checked facts, and `status` skips one that is not a well-formed JSON line.
- **Data migrations.** None. The state folder holds only marks, temporary
  indexes and per-run object folders, which are safe to delete.

## Accepted-risk candidates

None of these is accepted. The owner decides each when approving this draft.

1. **The image build has the network.** The image build runs the repo's own
   Dockerfile with network access, so a repo from someone else can run code
   that reaches the internet. athanor is for repos the owner trusts to build.
2. **The slot names are open to local programs.** Any local program can take
   the slot names to block runs, or answer `status` with false holder
   details. Limiting the Windows pipe to the owner's account needs a native
   package, which "no dependencies" rules out.
3. **Holder details are readable locally.** The pid, start time and repo
   folder name a holder reports can be read by any local program.
4. **A hostile test can outlive a hard-killed caller.** A test that kills the
   in-container timer, together with a hard-killed caller, leaves one
   container running until its slot is next used.
5. **Linux capabilities are not dropped, and the run limit has no upper
   bound.**
6. **The folder lock's shared count.** This candidate does not arise: the
   probe selected the OS lock, and the folder lock was not built. It is kept
   here so the owner can see it was considered.
