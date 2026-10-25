# 0023. A named command carries its own limits, arguments and outputs

Date: 2026-10-24 · Status: accepted · Extends: 0003, 0007, 0009 · Source: the
owner's decisions q1 to q16, relayed by the lead session and recorded in the
spec on issue 46 (revision 4)

Running Stryker through athanor showed four gaps. A named command could not
take arguments, its limits were repo-wide, a file staged with `git add -N`
made every run exit 125, and nothing came back from the container but its
output streams. This record covers all four.

**A command can be an object.** In `commands`, a value is an argument array,
as before, or an object: `argv` (required), `args`, `outputs`, and `memory`,
`cpus` and `timeoutMinutes`. Any other key exits 125 and the message names it
as `commands.<name>.<key>`. Every command is shape-checked, whether or not it
runs.

**Per-command limits.** Each limit takes the command's own value, then the
repo's top level, then the machine configuration, then the default. The
machine's ceilings hold for a command's own value, and only the command that
runs is checked against them. The `--` form uses the top-level values.

**Arguments.** `athanor run <name> -- <args…>` appends the words after `--` to
the command's `argv`, each as one literal argument (ADR 0002). It needs
`"args": true` on the command; without it the run exits 125 before any Docker
call and the message gives the two ways out. `<name> -- <cmd>` used to drop the
name and run `<cmd>`. Its new meaning, arguments for the named command, is
recorded as a fix with no `schema` or major version bump, because the old form
ran something other than what it named. The owner chose this (q3).

**`git add -N` files are in the snapshot.** `git stash create` refused an index
copy holding an intent-to-add entry. The snapshot now runs `git add -u -- .`
on its index copy first, which turns each such entry into a real one at its
working-tree content. The repo's own index, working tree, refs and stash list
do not change (ADR 0007). The `add -u` runs the host's clean filters on these
files, as the build context's `add -u` already did (accepted risk 23).

**Outputs come back through a copy.** A command's `outputs` are paths relative
to the work folder in the container. With `athanor run <name> --output <dir>`,
and only when the test ran and exited (`pass` or `fail`), each is copied with
`docker cp <id>:<work>/<output> -`, while the slot is held and before the
container is removed. The container is addressed by its ID, read by the same
`docker inspect` that reads its exit, and every `cp` runs with the run's pinned
environment (ADR 0021). The work folder comes from one line the boot script
prints before the marker, `athanor-work <path>`; nothing else in the boot
script or the `docker run` options changes (ADR 0016).

The container chose every name and byte, so the copy refuses rather than
repairs:

- `<dir>` must not exist. athanor makes it, mode 0700 on Linux, and never
  merges into a folder.
- athanor reads the tar itself (ADR 0001): ustar headers with their checksums,
  PAX `path` and `size`, and GNU long names. Links, devices and FIFOs are
  skipped and counted. So are the files Windows acts on when it shows a folder
  (`desktop.ini`, `.lnk`, `.url`, `.scf`, `.library-ms`, `.searchConnector-ms`,
  `.theme`, `.themepack`), on every engine (the owner's q2 at Test). A folder
  that would hold `HEAD` with `objects` or `refs`, the layout of a bare git
  repository, is refused (q3). Any other header type, a bad record or a truncated
  stream is an error.
- Names are read as text and never resolved. Each segment must pass rules that
  hold on every platform: no empty, `.` or `..` part, no `.git` in either case
  fold, no backslash, control or format character, no `<>:"|?*`, no trailing dot
  or space, no Windows device name. Two names that differ only in case are
  refused.
- Every create is exclusive. Size (`maxOutputMegabytes`, machine only, default
  1024), entry count (100 000) and time (10 minutes) are capped.
- On any refusal, what the copy made is removed from a list, deepest first, one
  non-recursive call each, and the run ends `error` with exit 125 and a
  `testExitCode` field holding the test's own exit. A hard kill during the copy
  can leave a partial folder; a folder is complete only when the result reports
  `outputs`.

The core takes two more options for tests only, marked `@internal` (ADR 0003):
`maxOutputEntries` and `copyTimeMs`, which lower the entry cap and the time
bound so a test does not need 100 000 entries or ten minutes.

Consequences: the threat model gains a boundary, "What comes back from the
container", and accepted risks 28 (a copied file's content is the test code's
choice) and 30 (the `--output` folder inherits its parent's access, and a
parent another account can change). The result gains `outputs` and
`testExitCode`, and the CLI gains `--output`; both are additions. The owner
chose not to add a Windows access step (q5).
