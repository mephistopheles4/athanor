# Glossary

- **Run.** One `athanor run`: settle the image, take a snapshot, wait for a
  slot, pipe the snapshot into a fresh container, run the test command there,
  and exit with its exit code (125 when the test ran but its outputs could not
  be copied).
- **Snapshot.** The work a run tests, as git sees it: a commit made by
  `git stash create` from a copy of the index (tracked files, staged and
  unstaged, and files added with `git add -N` at their working-tree content),
  or `HEAD` on a clean tree, or with `--untracked` a tree that also holds the
  untracked, non-ignored files. It reaches the container as a tar stream on
  stdin, made with no git content filter in the archive step. With a base, the
  stream also carries the base's history, and inside the container HEAD is
  the host's HEAD commit, with the snapshot committed on top of it when the
  two differ.
- **Base.** A branch, remote-tracking branch or tag a run carries into the
  snapshot, named by `--base` or a command's `base`, so a check that compares
  the branch with it, such as `git merge-base origin/main HEAD`, answers in the
  container as on the host. What travels is every commit from the merge base
  onward, on both sides, with the files those commits hold; never a git
  setting, hook or remote (ADR 0032).
- **Archive step.** The `git archive` that turns the snapshot's or the build
  context's tree into a tar stream. It runs in athanor's own git folder, with
  no host git config and no content filter (ADR 0020). The git calls that make
  those trees come before it and still use the host's git config.
- **Slot.** One of the machine's N places for a running container. A run holds
  slot n by holding the OS lock `athanor-slot-<n>`: a named pipe on Windows, an
  abstract socket on Linux. The OS frees it when the process ends, even after a
  hard kill.
- **Run limit.** N, the most runs at once on the machine: `ATHANOR_MAX_RUNS`,
  else `maxRuns` in the machine configuration, else 2.
- **Orphan.** An athanor container whose slot is free, left by a caller that
  was killed hard. The next run on its slot removes it, or the in-container
  timer ends it.
- **Image tag.** `athanor:<32 hex>`, the first 32 hex digits of a SHA-256 over
  a format version and the id of the build context's git tree. The same files
  give the same tag in every clone and worktree.
- **State folder.** `.athanor` in the home folder, or `ATHANOR_HOME`. It holds
  the machine configuration, the image last-use marks, temporary indexes and
  per-run object folders, and with a base a run's pack of the base's history.
  Run output is never written there.
- **Machine configuration.** The optional `config.json` in the state folder:
  the run limit, default per-run limits, their ceilings, the copy-out size cap,
  and the default age for `prune`.
- **Repo configuration.** What the repo sets for athanor: the `athanor.json`
  file at the repo root, or the `athanor` key in its `package.json`, never
  both. A run with both exits 125.
- **Run configuration.** Everything a run needs from the repo configuration
  and the machine configuration: the build settings, the command, the limits,
  the time limit, the command's outputs, the copy-out size cap
  (`maxOutputMegabytes`, machine only) and the Docker endpoint settings
  (`allowPlainTcp` and `allowRemoteDocker`, machine only). A command's own
  limits come before the repo's and the machine's. Its paths are checked to
  stay inside the repo, its limits are held to the machine's ceilings where the machine
  configuration sets them, and
  each value keeps the file it came from, so a message names the file to fix.
  One table says which keys a repo may set and which only the machine may set.
- **Container settings.** What reaches the container, worked out from the run
  configuration, the slot, the image tag and the test command: the
  `docker run` options, the boot script and the command after it. They hold
  ADR 0016's rules, which cover the test run and not the image build: no
  network, no new privileges, no mounts, only six
  capabilities (`--cap-drop ALL`, then six `--cap-add`), and no
  environment variable but `ATHANOR_GRACE_LIMIT` and the ten proxy names
  (listed in ADR 0016), each set empty with `-e NAME=` and never `-e NAME`.
- **Container run.** Starting the container from its settings, piping the
  snapshot in, ending it on an interrupt or at the time limit, finding the
  boot marker, and reading how it ended into the run's outcome.
- **Boot script.** The short `sh` script that unpacks the snapshot in the
  container, prints the work line and the boot marker, and runs the test
  command. With a base, one of two fixed variants, by the repo's git object
  format, also puts the base's history into the container's repository.
- **Work line.** The line `athanor-work <path>` the boot script prints on
  stderr just before the boot marker, naming the work folder. The run strips it
  and, with `--output`, copies from that folder (ADR 0023).
- **Named command.** An entry of `commands`: an argument array, or an object
  with `argv` and optionally `args`, `outputs`, limits of its own (ADR 0023)
  and a `base` (ADR 0032).
- **Outputs.** The paths a named command declares, relative to the work folder
  in the container, for copy-out.
- **Copy-out.** With `--output <dir>`, copying a command's outputs from the
  stopped container into a new folder on the host, by the container's ID, after
  a test that passed, failed or hit the memory limit. athanor reads the tar itself, checks every name
  and caps size, entries and time (ADR 0023).
- **Boot marker.** The line `athanor-boot-ok` the boot script prints on stderr
  just before the test command. Without it the test never started, and the
  outcome is `error`.
