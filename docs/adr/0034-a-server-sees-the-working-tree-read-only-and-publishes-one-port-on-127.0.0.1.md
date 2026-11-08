# 0034. A server sees the working tree read-only and publishes one port on 127.0.0.1

Date: 2026-11-07 · Status: accepted · Extends: 0004, 0016, 0021 · Source: spec revision 2 on issue 35 (S1, S2, S8), with the owner's answers q1 to q4

`athanor run` can't serve a dev server. Its container has `--network none`,
sees a snapshot taken once, and ends with a pass or a fail. The owner wants an
agent or a person to start a repo's dev server in a container, open it in a
browser and see an edit on the host show up. `athanor serve <name>` does that,
and it gives the container three things `run`'s never gets: the live working
tree, a network, and a published port.

- **A foreground command.** `serve` runs until a signal or until the server
  exits, then removes the container. There is no daemon, no detached mode and
  no `stop` subcommand.
- **A declared server.** A repo key, `servers`, beside `commands`: `argv`,
  `port`, and optionally `writable`, `memory`, `cpus` and `processes`. `run`
  never reads it. A name that is both a command and a server is refused (q4).
- **The tree, read-only.** The whole working tree is bind-mounted read-only at
  the image's `WORKDIR`, untracked files, gitignored files and `.git`
  included. athanor still never writes the tree (ADR 0007, ADR 0033). The mount
  is read-only so that two servers of one tree never write the same files.
- **A volume per writable folder.** Each `writable` path gets an anonymous
  volume that Docker seeds from the image's content at that path, fresh on
  every start. The folder must exist on the host (a mount inside a read-only
  mount can't create it) and in the image as a folder the image's user can
  write; athanor checks both before `docker run` and says how to make a missing
  one. It creates nothing.
- **The network.** `--network bridge`, so the server has outbound access and a
  publish. One port, published as `-p 127.0.0.1::<port>`, or on a host port
  given with `--port`. A server listens on 0.0.0.0 inside; that is the repo's
  argv.
- **The rest of `run`'s container.** The dropped capabilities with six back
  (ADR 0016), `no-new-privileges`, the limits and the ten proxy blanks stay. No
  `-v`, no `--privileged`, and no `ATHANOR_GRACE_LIMIT`, since a server has no
  time limit.
- **Server locks (extends 0004).** Each server holds a server lock,
  `<prefix>-server-<n>`, by the same OS lock as a run slot. A server holds no
  run slot. `maxServers` (default 2) limits them, and a `serve` with every lock
  held exits 125 at once, after one retry a second later.
- **The sweep and the stdin line.** On Linux a server's caller dying
  closes the container's stdin, and the boot script ends the server. On
  Windows a hard kill of the caller leaves the container, and the next `serve`
  removes a leftover container whose lock is free. `status` lists one as an
  orphan and removes nothing.
- **A local engine (extends 0021).** `serve` refuses an engine that is not on
  this machine, even with `allowRemoteDocker`: a bind mount takes its path from
  the engine's machine, and 127.0.0.1 is that machine's.
- **The container rule's mark.** AGENTS.md's container rule is scoped to
  `athanor run`'s container, a rule is added for `athanor serve`'s, and the
  two sentences that called a change there, and a change to what reaches the
  image build, security-sensitive work are removed (q1: "almost everything in
  athanor is a container change"). ADR 0033 listed that mark as a candidate to
  loosen; this record is the owner's decision. The archive-step and release
  marks stay.
- **No security pair.** The owner ruled out a security review of the spec and
  of the change (q1).
- **A Linux engine before 28.0.** Docker before 28.0 lets other hosts on the
  network reach a port published on 127.0.0.1. athanor does not check the
  engine's version. The README says to use 28.0 or later on Linux (q2).
- **The accepted classes.** One class is new, "A server's port on this
  machine", and two widen, "The Windows slot pipe on the network" and "The
  machine's load" (q3).

What the spike found, on Docker Desktop 29.9.2 on Windows:

- A publish on `127.0.0.1` with a free port answered there, and the LAN address
  refused.
- A read-only bind of the tree failed a write with `EROFS`, and a host edit
  showed on the next read.
- A host edit did not wake `fs.watch` inside the container, so a dev server
  must poll on Docker Desktop for Windows.
- A volume nested in the mount held the image's content and was writable.
  When the folder didn't exist on the host, `docker run` failed.
- A volume on a folder the image lacks started owned by root, and the image's
  user couldn't write it.
- In `sh -c`, a background list reads `/dev/null` as its stdin, so the boot
  script saves the container's stdin on descriptor 3 first.
- A hard kill of the node process that started `docker run -i` left the
  container running on Windows.

The extended records. ADR 0004 (the slot lock is the OS lock) gains a second
kind of lock. ADR 0016 (the container keeps six capabilities) stays whole for
`run`; `serve`'s container gets the tree, a network and a port, and nothing
else the rule forbids. ADR 0021 (the engine and builder are checked again
before `docker run`) gains a local-engine check for `serve`.

Rollback. Before a release, revert the pull request. After one, `serve`, its
flags, the `servers` and `maxServers` keys and the new JSON fields are public
interface: a fix goes forward, and a removal is a major bump, the owner's
decision.
