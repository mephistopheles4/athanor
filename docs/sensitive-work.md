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
