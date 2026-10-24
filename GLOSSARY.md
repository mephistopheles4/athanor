# Glossary

- **Run.** One `athanor run`: settle the image, take a snapshot, wait for a
  slot, pipe the snapshot into a fresh container, run the test command there,
  and exit with its exit code.
- **Snapshot.** The work a run tests, as git sees it: a commit made by
  `git stash create` from a copy of the index (tracked files, staged and
  unstaged), or `HEAD` on a clean tree, or with `--untracked` a tree that also
  holds the untracked, non-ignored files. It reaches the container as a tar
  stream on stdin, made with no git content filter in the archive step.
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
  per-run object folders. Run output is never written there.
- **Machine configuration.** The optional `config.json` in the state folder:
  the run limit, default per-run limits, their ceilings, and the default age
  for `prune`.
- **Repo configuration.** What the repo sets for athanor: the `athanor.json`
  file at the repo root, or the `athanor` key in its `package.json`, never
  both. A run with both exits 125.
- **Run configuration.** Everything a run needs from the repo configuration
  and the machine configuration: the build settings, the command, the limits,
  the time limit and the Docker endpoint settings. Its paths are checked to
  stay inside the repo, its limits are held to the machine's ceilings where the machine
  configuration sets them, and
  each value keeps the file it came from, so a message names the file to fix.
  One table says which keys a repo may set and which only the machine may set.
- **Container settings.** What reaches the container, worked out from the run
  configuration, the slot, the image tag and the test command: the
  `docker run` options, the boot script and the command after it. They hold
  ADR 0016's rules: no network, no new privileges, no mounts, only six
  capabilities (`--cap-drop ALL`, then six `--cap-add`), and no
  environment variable but `ATHANOR_GRACE_LIMIT` and the ten proxy names
  (listed in ADR 0016), each set empty with `-e NAME=` and never `-e NAME`.
- **Container run.** Starting the container from its settings, piping the
  snapshot in, ending it on an interrupt or at the time limit, finding the
  boot marker, and reading how it ended into the run's outcome.
- **Boot script.** The short `sh` script that unpacks the snapshot in the
  container, prints the boot marker, and runs the test command.
- **Boot marker.** The line `athanor-boot-ok` the boot script prints on stderr
  just before the test command. Without it the test never started, and the
  outcome is `error`.
