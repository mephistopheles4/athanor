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
CI runs athanor on Linux. athanor uses the Docker engine and builder the user
has configured, on this machine, or on another one when the machine
configuration allows it (ADR 0012, ADR 0021).

**What athanor does.** It reads the repo configuration (`athanor.json`, or the
`athanor` key in `package.json`) and an optional machine
configuration, builds the repo's Dockerfile into an image, takes a snapshot of
the work with git, holds one of N slot locks, and pipes the snapshot into a
fresh container that runs the test command. It writes only to its state folder (`~/.athanor`, or `ATHANOR_HOME`), except that a host clean filter can write the repo's git folder (accepted risk 23).

**Who could act against it.**

- **The repo's own code.** The Dockerfile's `RUN` lines run at build time;
  the test suite runs in the container. athanor is for repos the owner
  trusts to build.
- **Another local program** running as any user on the machine, which can
  connect to or squat on the slot names (accepted risks 2, 3 and 9).
- **A process that can write the owner's home folder,** which can change the
  machine configuration or the Docker configuration, as it could the
  environment.
- **Whoever runs the Docker engine or builder the user has configured**, when
  the machine configuration allows a remote one (accepted risk 7).
- **Other users of a Docker engine shared between machines or people**
  (accepted risk 8).
- **Someone on the network path to a remote engine or builder node**
  (accepted risk 10).
- **An authenticated network user who can reach the Windows slot pipe**
  (accepted risk 3).
- **Whoever can publish a release of a dev package or an action that CI uses,
  or take over the account or repository that does.** A hijacked release runs
  in CI on the bot's pull request before any merge, and can set that check's
  result. It reaches `main`, and the owner's machine through `npm ci`, only
  through a merge. The compiler is the one dev package that runs: once merged,
  it runs as the owner in every test run and in the build before a publish
  (accepted risk 18). These, too, run once merged: the actions the release
  workflow uses, among them `actions/upload-artifact` and
  `actions/download-artifact`, and the build on the runner before a staged
  release (accepted risks 21 and 22).
- **Whoever controls the owner's GitHub account, or can push a branch to this repo,** can
  change and start the release workflow; whoever controls the account can
  also approve its deployment. They can
  stage a version, but cannot make one live without the owner's npm
  two-factor approval. Before that approval the owner checks that they
  started the run, on the commit they merged, and reads the diff since the
  last release tag. The GitHub approval guards the token only as far as npm
  enforces the environment the trusted publisher names, which is unconfirmed
  (claim R10 of the spec on issue 6). The actor stays "can push a branch"
  until npm's docs say the environment is enforced, or a deliberate run from
  a job with no environment, or another one, is shown refused.

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
  value, no Docker socket, no privileged mode, and only six Linux capabilities: `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETUID` and `SETGID`, every other one
  dropped by an allow-list (ADR 0016, C6, C19, K1, K2, P1). The run
  blocks, with empty values, the ten proxy names the Docker CLI fills from the
  five proxy settings it reads today (accepted risk 11). A value the build
  writes into the image or its cache is accepted risk 1. This, and
  the limits below, hold only as far as the engine enforces them: on an
  engine the owner runs, they hold; on someone else's engine, the operator
  decides (accepted risk 7).
- **Fixed limits on each run:** memory and memory-swap, a process limit of 1024, `no-new-privileges`, a host-side time limit and an in-container timer (C7, C11, K4), and CPUs when `cpus` or `maxCpus` is configured (U1, U4, accepted risk 17). The ceilings that the machine configuration sets bound what any repo can ask for; only `maxCpus` has no default (C31, U3).
- **Configured paths stay in the repo.** Every `dockerfile`, `context` and
  `inputs` path is resolved through symlinks with the same realpath function
  as the repo root and compared segment by segment, ignoring case on Windows,
  before any Docker call (C17). The configuration files themselves, `athanor.json`
  and `package.json`, must each be a regular file whose real path is inside the
  repo, and must have no second hard link. The file is opened once, and the
  open handle must be the regular file that was checked, before any of its
  content is read (J6).
- **Only the hashed set reaches the build.** The build context is exactly the
  tracked files under `context` plus the listed `inputs`, each of which must
  be tracked: no untracked or ignored file and no git folder (ADR 0006, C28).
- **The archive step carries the tree as committed.** Every `git archive`, and
  the `git init` of athanor's archive folder, run with every inherited `GIT_*`
  variable removed, no global or system git config or attributes (on git 2.32
  or later), and no git template; the archive also has `-filter` on every
  path. So no content filter runs on the host while the stream is made, and no
  host git setting changes a file in that step. This keeps host git settings
  out of the archive step; it is not a control against a process that can
  write the environment or the home folder, which already chooses the git that
  runs. git and docker start by a full path from PATH's absolute entries, so a
  program of that name in the working folder, or one found through a relative
  or empty PATH entry, never runs in their place, which on Windows was the
  repo's own folder (ADR 0020, G8). A full PATH entry into the repo, such as
  the one npm adds for its scripts, or another spelling of the working folder,
  is the environment's choice, as above. The line endings and file modes are
  pinned, and the tree's own `text`, `eol`, `ident` and
  `working-tree-encoding` attributes still apply (ADR 0020, C32, G1–G6). The
  git calls that make the snapshot's and the build context's trees still run
  with the host's git config and environment (accepted risk 23, issue 42).
- **athanor's own git calls never write the repo.** Snapshots use a copy of the index and a
  per-run object folder (ADR 0007, C21, C30), except as accepted risk 23 says:
  a clean filter the host defines, such as Git LFS's, can write the repo's git
  folder (issue 42).
- **Docker on this machine, unless the machine allows otherwise, and never in
  clear.** A run refuses an engine or builder that is not local (a unix
  socket, the local pipe in its exact form, or tcp to loopback) unless the
  machine configuration sets `allowRemoteDocker`, which a repo cannot set; the
  machine file follows `ATHANOR_HOME`. It refuses plain tcp to the engine and
  to every builder node, and any builder whose transport it could not read,
  unless `allowPlainTcp` is set (ADR 0013, ADR 0021). What was checked is
  pinned by name for the whole run and checked again once the slot is held
  (ADR 0021; L2, L5, L6, L8, L10, L11).
- **The run limit holds through a hard kill.** The slot is an OS lock that the
  OS frees when the process ends, and a run removes its slot's labelled
  container before starting its own (ADR 0004, C8, C10).
- **Machine configuration is data.** It is validated key by key and holds no
  paths or commands.
- **Holder answers are shown, not trusted.** `status` skips an answer that is
  not one well-formed JSON line of the expected shape, or whose repo name holds
  control characters.
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
  - CI holds no secrets. Its token is read-only (accepted risk 19).
  - The first publish is by hand, as before (`docs/releasing.md`).
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

## The sensitive-work list

- **Authentication and authorization.** athanor has no accounts or logins.
  The slot locks are open to any local program (accepted risks 2, 3 and 9). It
  relies on the operating system's user separation for the state folder
  (mode 0700 on Linux; on Windows, the home folder's own access rules), and on
  whatever access control the configured Docker engine has. Docker Desktop's
  local engine is the owner's; when the machine configuration allows a remote
  engine, its access control is its operator's (accepted risks 7 and 8). The
  release path has its own: npm's trusted-publisher binding to this repo,
  workflow and environment, the `npm` environment's required reviewer, and
  the owner's npm two-factor approval (the supply-chain bullet above;
  ADR 0019).
- **Secrets.** athanor stores no secret of its own. A secret committed to the
  repo goes into the container with the snapshot, and into the build if it is
  under `context` or listed in `inputs`; the build has the network
  (accepted risk 1). With a remote engine or builder, those copies go to that
  machine when the machine configuration allows it (accepted risk 7), and a
  remote builder can ask this machine for the
  owner's registry credentials (accepted risk 7). The Docker client's proxy
  settings can hold a password: the run blocks it (ADR 0016), and the build
  receives it (accepted risk 1). Plain tcp transport is refused
  by default (ADR 0013; accepted risk 10 for the opt-out). Test output can hold
  secrets: athanor streams it to the caller, keeps no copy, and runs the
  container with `--log-driver none`. When the caller is an agent session, the
  output goes on to that session's model provider, as it does when tests run
  on the host. The release path holds two credentials for a short time: the
  publish job's identity token (accepted risk 22), and the owner's npm login
  around an approval (accepted risk 26); see the supply-chain bullet above
  and ADR 0019. The owner's
  npm session token sits in the user npm configuration from login to logout,
  unencrypted at file level. It relies on the machine's disk encryption, which
  the owner confirmed is on (2026-10-24), and on npm's two-factor check on
  every write.
- **Crypto.** SHA-256 keys the image cache and is not a security control,
  except that on a shared engine the tag is the only link between a run and
  its image (accepted risk 8). Temporary names use Node's crypto random source.
  athanor encrypts nothing itself; transport to a remote engine or builder is
  ssh or verified TLS unless `allowPlainTcp` is set (ADR 0013, ADR 0021).
  Image layers, the build cache and a container's writable layer sit
  unencrypted on the engine's or builder's disk: on this machine they rely on
  its disk encryption; on a remote one, which the machine configuration must
  allow, on that machine's owner (accepted risk 7). `prune` does not clear Docker's build
  cache; the README names the commands that do. Each released version's
  provenance is signed by npm through Sigstore (the supply-chain bullet above;
  ADR 0019).
- **Input validation.** Repo configuration, machine configuration,
  environment values, CLI arguments, command names and configured paths are
  each validated before use, and a bad value exits 125 with a plain message
  (C17, C18, C24, C31). The engine endpoint and every builder node are
  checked for locality and plain tcp, read as Docker reads them (a value with
  no "://" is tcp; a pipe in one exact form), pinned for the run and checked
  again once the slot is held (ADR 0013, ADR 0021; L1, L2, L5, L8, L10, L11). Holder answers are shown as reported, never as checked facts.
  git settings, attributes, templates and `GIT_*` variables inherited from the
  host are kept out of the archive step (ADR 0020); the git calls that record
  the work still use them (accepted risk 23).
  The release path's untrusted inputs are the artifact `publish` takes from
  `check`, the staged tarball and manifest the owner downloads, and the
  registry's answer to the version check. They are covered by the owner's
  look before approval (`docs/releasing.md`), accepted risks 21 and 22, and
  ADR 0019.
- **Data migrations.** None. The state folder holds only marks, temporary
  indexes and per-run object folders, which are safe to delete.

## Accepted risks

The owner decided each of these on 2026-10-20. Each keeps the number it had as a
candidate, so other work can point at it.

Who each concerns. A user-facing risk is one a user has to act on or know
about, and has a line in the README's "What athanor doesn't protect you
from"; a maintainer-only risk stays here alone.

| Who | Accepted risks |
| --- | --- |
| User-facing | 1, 2, 3, 4, 5, 7, 8, 9, 10, 17, 23, 24, 25 |
| Maintainer-only | 6, 11, 12, 13, 14, 15, 16, 18, 19, 20 |

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
   run on the slot removes it. With no CPU limit configured, the container left running can also hold every CPU the engine has (accepted risk 17).
   Accepted 2026-10-20. From: Spec revision 5, S9. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
5. **A root test keeps six Linux capabilities, and the run limit has no upper
   bound.** The test runs as the image's user, root unless the Dockerfile names
   another. A root test holds `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`,
   `SETUID` and `SETGID`, which a flaw in Docker or the kernel that lets a
   process out of the container could use to read or change what root can reach
   on the engine's machine, such as other runs' snapshots and image layers.
   Every other capability is dropped by an allow-list, so one a later Docker
   adds does not reach the container (ADR 0016). Accepted because the container
   also has no network, no host folders and `no-new-privileges`, the other five are
   what a root-run test can plausibly need and `KILL` is what the in-container
   time limit needs for a test that switches user, and the run limit is the
   owner's own setting.
   Accepted 2026-10-20. From: Spec revision 5, S9. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
   Narrowed 2026-10-21. From: issue 4, spec revision 4; the security review of revision 3 (adversarial-lens F1, data-lens F1). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
6. **The folder lock's shared count.** This candidate does not arise: the
   probe selected the OS lock, and the folder lock was not built. It is kept
   here so the owner can see it was considered. The owner confirmed on
   2026-10-20 that it does not arise.
7. **The configured engine or builder's operator has full control of a run.**
   With `"allowRemoteDocker": true` in the machine configuration, athanor uses
   the Docker engine and builder the user has configured,
   including one on another machine or a cloud builder. Whoever runs it
   receives the build context and the snapshot, uncommitted changes and any
   committed secret included, and keeps copies in its image layers and build
   cache. It also decides the result athanor reports, whether "no network" and
   the limits are enforced, and the text streamed back into the session; and,
   as a builder, it can ask this machine for the owner's registry credentials.
   Accepted because the owner chose to let athanor run against any Docker the
   user sets up, and the user chooses whom to trust with that. Before athanor
   decides on a builder, with or without the opt-out, `buildx inspect`
   contacts the configured builder's nodes, so a remote builder host sees the
   connection and, for an ssh node, the owner's login, but no repo data.
   Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F1, data-lens F2), after the owner removed C29. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
   Narrowed 2026-10-24. From: the spec on issue 33, S6, and the Design review of revision 2 (data-lens F5). How the word arrived: the owner, in the lead session's chat, relayed by head-chef-field-test.
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
    only the machine configuration can set it. Plain tcp to another host,
    engine or builder node, now needs `allowRemoteDocker` as well, and the
    opt-in covers builder nodes and builders whose transport athanor could not
    read (ADR 0021).
    Accepted 2026-10-20. From: The security review of the first build (adversarial-lens F2, data-lens F1); the owner's q8 A2. How the word arrived: the owner, in chat with the lead session, relayed to the build session.
    Extended 2026-10-24. From: the spec on issue 33, S6. How the word arrived: the owner, in the lead session's chat, relayed by head-chef-field-test.
11. **A proxy setting a later Docker client adds.** athanor blanks the ten
    proxy names the Docker client fills from the five proxy settings it reads
    today (ADR 0016). A setting that a later client adds, beyond those five,
    reaches the container until athanor's list is updated, and P1 cannot see
    it. Accepted because a guard at run time would mean either reading the
    client configuration, against ADR 0012, or blanking names in the boot
    script, which is fragile and leaves the engine's copy in place. A Docker
    release that adds a proxy setting is a reason to update the list.
    Accepted 2026-10-21. From: issue 23, the Design review of the spec (adversarial-lens, the fixed list of names; data-lens, P1's reach). How the word arrived: the owner, in chat with the lead session, relayed to the planning session.
12. **A configuration-file link that Windows follows to a network location.** On
    Windows, a link at the repo root named `athanor.json` or `package.json`
    that leads to a network location is followed by the path resolution before
    athanor tests whether it is inside the repo, so the machine can start a
    sign-in to that location. No content is read. Accepted because it needs a
    Windows checkout with real links turned on and a repo from someone who
    wants this, and `package.json` already had the same path before the
    `athanor.json` change.
    Accepted 2026-10-21. From: issue 7, the Test review of #30 (adversarial-lens, the Windows network location at the repo root; data-lens). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
13. **A folder swapped under an in-repo link to a configuration file.** When
    `athanor.json` or `package.json` is a link to a file in a subfolder of the
    repo, a program that can write the repo while athanor runs can swap that
    subfolder for a link out between the path check and the open, and an outside
    file is read as configuration. At most a key name or a path value from it
    appears in a message. Accepted because it needs write access to the repo
    during the run, which the owner's own programs already have, and a fix
    would either refuse links at the repo root or work on Linux only.
    Accepted 2026-10-21. From: issue 7, the Test review of #30 (adversarial-lens, a folder swapped on the path of an in-repo link). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
14. **A dangling link named `athanor.json` counts as absent.** A link named
    `athanor.json` that points nowhere is treated as not there, so an
    `athanor` key in `package.json` is used with no conflict message.
    Accepted because the spec defines "exists" as what the file system call
    sees, and anyone who can plant the link can already edit the repo.
    Accepted 2026-10-21. From: issue 7, the first-round review of #30 (unstated-lens, a broken link read as absent). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
15. **A file moved into the repo for the moment of the read.** A program that
    can write both the repo root and the folder of an outside file can give that
    file its only name in the repo for the moment athanor reads it, and no
    point-in-time check can tell it from a real configuration file. Accepted
    because the attacker needs write access to both places, and the gain is
    limited to what a message shows.
    Accepted 2026-10-21. From: issue 7, the Test review of #30 (adversarial-lens, a file whose only name is placed in the repo for the read). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
16. **A file mounted over a configuration file name on Linux.** A file mounted
    over `athanor.json` or `package.json` passes every check, because the
    path, the link count and the opened file all agree. Accepted because it
    needs mount privilege, which is root, and finding it would mean parsing the
    mount table on Linux only.
    Accepted 2026-10-21. From: issue 7, the Test review of #30 (adversarial-lens, a file mounted over the configuration name). How the word arrived: the owner in chat to the lead session on 2026-10-21, relayed.
17. **A run with no CPU limit, or with a limit the repo chose, can use every CPU the engine has.** When the machine configuration sets no `maxCpus`, the repo's test code can keep every core of the engine busy, which on Docker Desktop is every core the VM has, slowing the host and the owner's other runs. The run's time limit ends it, except in accepted risk 4's case, where it lasts until the slot is next used. Memory, swap and processes stay bounded. Accepted because the owner chose speed by default, the repo is code the owner trusts to build, and a machine that wants a bound sets `maxCpus`.
    Accepted 2026-10-22. From: the spec on issue 36, revisions 1–4 (S6; the decisions in S7, items 3 and 6), and the Design review of revision 2 (adversarial-lens F1–F5, data-lens F1–F2). How the word arrived: the owner, in chat with the session that wrote the spec.
18. **A merged hijacked compiler runs with the owner's rights.** The TypeScript
    compiler is the one dev package that runs. A hijacked release that stays
    hidden past the update bot's wait runs as the owner once the owner merges
    it: in every test run, and in the build before a publish. It can read what
    the owner's account can read, and shape the published code. A rebuild uses
    the same compiler, so it cannot see the change. Accepted because no cheap
    independent check of the compiler's output exists. The wait, the
    registry's signatures and the owner's merge narrow the window.
    Accepted 2026-10-22. From: issue 34, the Design review of spec revision 1 (adversarial-lens F1). How the word arrived: the owner in chat with the planning session on 2026-10-22.
19. **Code in the CI job can read the job's token.** A dev package, an action
    or the test code running in CI can read the job's token until the job ends.
    That includes code on a bot's pull request before merge. Accepted because
    the token is read-only, the repo is public, and CI holds no secrets. A
    workflow that holds a secret, such as issue 6's, needs its own controls.
    The release workflow keeps its OIDC permission in the `publish` job,
    which runs no repo code and installs no npm package. Its code is two
    pinned actions and the Node and npm that setup-node provides (ADR 0019).
    The release's `check` job holds the same kind of read-only token, with
    `actions: read` added. This risk's reason, that CI holds no secrets,
    doesn't cover the artifact that job hands on to be staged: see accepted
    risk 21.
    Accepted 2026-10-22. From: issue 34, the Design review of spec revision 1 (data-lens F9). How the word arrived: the owner in chat with the planning session on 2026-10-22.
    Extended 2026-10-24. From: issue 6, spec revision 2 (S10, TM3); the Design review of spec revision 1 (data-lens F7, adversarial-lens F8). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
20. **A hijacked action could leave cache entries for a later workflow.** An
    action's code, run on a push to `main`, can write Actions cache entries,
    and a later workflow that restores the cache would read them. Accepted
    because nothing restores a cache today. A workflow that restores one is a
    reason to revisit. The release workflow restores no
    cache. The workflow check fails a workflow that uses the cache actions or
    setup-node's cache in the block style it reads, and refuses a flow-style
    `with:` on those actions.
    Accepted 2026-10-22. From: issue 34, the Design review of spec revision 1 (adversarial-lens T4). How the word arrived: the owner in chat with the planning session on 2026-10-22.
    Extended 2026-10-24. From: issue 6, spec revision 2 (S10, TM4); the Design review of spec revision 1 (adversarial-lens F7). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
    Edited 2026-10-24, to drop "such as issue 6's" from the revisit sentence. From: issue 6, the Test review of `9a1b0ba` (reader-lens F7). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
21. **Code in the release's check job shapes the tarball.** A dev package,
    the compiler, the test code, an action, or a process an earlier step left
    running in `check` can change any file that is packed, and `publish`
    stages exactly that. Matching the check job's integrity proves only that
    `publish` staged what `check` made. The control is the owner's comparison
    of every file of the staged package with a local pack of the same commit,
    made before the login, which catches every change made only on the
    runner. A hijacked compiler shapes both packs (accepted risk 18). Accepted
    because the staged version goes live only after that comparison and the
    owner's npm two-factor approval.
    Accepted 2026-10-24. From: issue 6, spec revision 2 (S10, TM5); the Design review of spec revision 1 (adversarial-lens F1). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
22. **An action in the release's publish job holds the identity token.**
    `actions/download-artifact` or `actions/setup-node`, hijacked, or the npm
    it provides, can ask for the token. With it they can stage another
    tarball or extra versions, use up the 2-day validation of a new trusted
    publisher, or get a Sigstore signature in this workflow's name for some
    other file. The controls are the SHA pins and the pinned Node, each at
    least 7 days old; stage-only publishing; the owner's look, which expects
    exactly one staged entry whose integrity matches the check job's; and the
    owner's 2FA approval. Accepted because nothing goes live without that
    look and approval, and a stray signature names this workflow's run in
    the public log.
    Accepted 2026-10-24. From: issue 6, spec revision 2 (S10, TM6); the Design review of spec revision 1 (adversarial-lens F3, data-lens F2). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
23. **The git calls that record the work use the host's git config.** The
    snapshot's and the build context's git calls (`stash create`, `add`,
    `hash-object`) run with the host's git config and environment. A clean
    filter that the repo's attributes name runs on the host while they run;
    its output reaches the container and the build; and Git LFS's clean filter
    writes the repo's `.git/lfs` folder, where the copy stays after the run,
    including, with `--untracked`, untracked files the owner has not added.
    Accepted because the owner's own `git add` in the repo runs the same
    filters, and a fix changes what the snapshot holds (issue 42).
    Accepted 2026-10-24. From: issue 20, the Design review of spec revision 1 (executability-lens, the deferral of the snapshot side; data-lens F3; adversarial-lens F3). How the word arrived: the owner, in chat with the lead session, relayed to the planning session.
    Extended 2026-10-24. From: issue 20, the Test review (data-lens TM5), the owner's H1. How the word arrived: the owner, in the lead's chat, relayed by head-chef-field-test.
24. **A local address that leads elsewhere.** An endpoint athanor counts as
    local, a `unix://` socket, the local pipe or a loopback port, can lead
    elsewhere: forwarded to another machine (an ssh tunnel, a socket proxy, a
    port forward), or held by another local program, running as any user,
    that owns that loopback port, socket path or pipe name while the engine
    does not (for example while Docker Desktop is stopped). The name
    `localhost` is trusted as loopback, so a resolver that answers it with
    another address leads elsewhere too. The refusal does not stop it. Setting up a forward takes the owner's own
    configuration or a process that can already write the owner's home
    folder; holding a port or socket takes another local program, which this
    page already lists as an attacker. Accepted because athanor cannot tell
    where a local address leads without trusting the machine it runs on, and
    Docker offers no check of the engine's identity to build on.
    Accepted 2026-10-24. From: the spec on issue 33, S6, widened by the Design review of revision 1 (adversarial-lens F8) and the Test review of PR 44 (adversarial-lens F4, F6). How the word arrived: the owner, in the lead session's chat, relayed by head-chef-field-test.
25. **A message names the machine file's full path.** The refusal messages
    for `allowRemoteDocker` and `allowPlainTcp` name the machine configuration
    file by its full path, which holds the OS account's home folder name.
    That path reaches stderr, the JSON `message` and the calling session's
    model provider. Accepted because it is the owner's own account name, going
    to the owner's own session, and naming the file to fix is what makes the
    message actionable.
    Accepted 2026-10-24. From: the Design review of the spec on issue 33, revision 1 (data-lens T1). How the word arrived: the owner, in the lead session's chat, relayed by head-chef-field-test.
26. **A program running as the owner can read the npm session token.** From
    `npm login` to `npm logout`, around a release's approval, the session
    token sits in the owner's user npm configuration, unencrypted at file
    level. Any program running as the owner can read it then, including one
    left behind by the local build just before. Accepted because npm requires
    two-factor on every write, and the window lasts only from login to
    logout.
    Accepted 2026-10-24. From: issue 6, the follow-up Test review of `9fcdfcd` (data-lens F1). How the word arrived: the owner in chat with the lead session on 2026-10-24, relayed by head-chef-field-test.
29. **The agent test hook is a nudge, not a control.** The hook in
    `.claude/settings.json` (ADR 0024) refuses an agent session's host run of
    the fast tier while athanor is installed, but it fails open on any error,
    stays silent when it cannot find athanor, and reads only the command's
    plain forms: a run through another shell's command string, or from inside
    `test/`, gets past it. Accepted because it exists to make a skipped rule
    visible, the tests are the repo's own code, and the session names any
    host run in its report.
    Accepted 2026-10-24. From: the athanor-hook QA review of PR 50 (behaviour-lens F2). How the word arrived: the owner, in the lead session's chat, relayed by head-chef-field-test.
