# 0038. Guards against the owner's own machine are cut

Date: 2026-11-26 · Status: accepted · Source: ATH-9's plan and the owner's relayed approval of it; settles issue 84's candidates

ADR 0033 and ADR 0036 put the owner's machine out of scope, with its programs,
accounts and agents, and the code of a repo it runs. Issue 84 listed the
controls left with no reason under that scope, K1 to K10, for the owner to
sort. Guards that protect only against that machine still cost tests and review
on every change. The owner approved one plan that cuts them. This record takes
that plan as the owner-decided spec that ADR 0033 and ADR 0036 ask for before a
candidate is loosened. Each cut can be reverted.

## What is cut

Each part below replaces that part of the records it names. The rest of each
record stands.

- **The state folder's mode (0011, 0037).** athanor sets no mode on it. On
  Linux and macOS the umask decides who can read it, and the README says how to
  make it private.
- **The clean archive environment (0020).** The archive folder is made with the
  host's template, and its `git init` and every `git archive` run with the
  host's environment, git configuration and system attributes. Kept: `-filter`
  on every path, the pinned line endings, file modes and global attributes file,
  and a folder of athanor's own, so `GIT_COMMON_DIR` and `GIT_WORK_TREE` are
  still dropped. A host git setting can now change the files the container and
  the build get.
- **Programs by full path (0020's amendment, 0024, 0037).** git and docker start
  by name, and the agent hook looks for athanor in relative PATH entries too. On
  Windows a program file in the repo or the working folder can start in place of
  git or docker, on the host. So can one on any system when PATH holds a
  relative entry such as `.`. A program missing from PATH still ends in the
  plain "not found on PATH" message.
- **The second Docker check (0021).** The checked context and builder stay
  pinned for the run and are not read again once the slot is held. A builder
  node's context name is looked up whatever its shape, still after `--`.
- **The output copy's extras (0023).** athanor no longer refuses a parent folder
  other accounts can write, checks the parent again, sets mode 0700 on the new
  folder, opens files with `O_NOFOLLOW`, skips the files Windows acts on when it
  shows a folder, or refuses the layout of a bare git repository. Kept: the
  caps, exclusive creates, cleanup on error, skipped links, devices and FIFOs,
  the name rules and the `.git` refusal.
- **The named base's extras (0032).** A name with a control or format character
  is taken, and so is the ref it resolves to. A message shows the name as given
  escaped and the resolved ref as it is. The repo's replace refs and grafts
  apply, so in a repo that has them the carried history can be missing commits.
  The boot script checks only that the base folder is there. Kept: the other
  name rules, the clean environment of the base's git calls, lazy fetching off,
  the shallow and partial refusals, and what a command's `base` may name. This
  settles issue 72.
- **A server's linked folder (0034).** `serve` no longer refuses a `writable`
  folder that is a link. A missing folder and a file are still refused.
- **Configuration files and holder answers** (no record; tests J6 and C13). A
  configuration file is read with no check that it is a regular file or has one
  link; its real path must still be inside the repo. `status` shows a holder's
  answer with whatever characters it holds. An answer that is not JSON, or has
  the wrong shape, is still skipped.

## What is kept

Among the guards that stay: no shell (ADR 0002), `--network none` and the rest
of the run container's rules (ADR 0016), the limits and their ceilings, the
refusal of an engine or builder off this machine (ADR 0021) and of plain tcp
(ADR 0013), and a server's read-only mount and loopback port (ADR 0034).

The run's, the server's and the writable check's containers keep `--cap-drop
ALL` with the six `--cap-add`, and `no-new-privileges`. The plan listed them as
a cut that needs its own spec. They are kept: cutting either needs the owner's
yes to that spec and a new record.

## Issue 84's candidates

| Candidate | Outcome |
| --- | --- |
| K1 no shell | Kept |
| K2 `--network none` | Kept |
| K3 dropped capabilities | Kept, as above |
| K4 `no-new-privileges` | Kept, as above |
| K5 configuration file checks | Cut in part: the regular-file and one-link checks |
| K6 clean archive environment | Cut in part |
| K7 programs by full path | Cut |
| K8 holder answers skipped | Cut in part: the control-character filter |
| K9 input validation | Cut in part: the context-name pattern and a base name's character check |
| K10 named base checks | Cut in part |

## The version numbers

`outputs.skipped` now counts only links, devices and FIFOs: the files Windows
acts on are copied. AGENTS.md says a change in what a field means bumps
`schema` and the package's major version. Neither is bumped. This is an
exception, as in ADRs 0017, 0021 and 0023: the owner approved the cut, and
merging this record approves the exception.
