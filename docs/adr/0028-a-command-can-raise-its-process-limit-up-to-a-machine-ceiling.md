# 0028. A command can raise its process limit, up to a machine ceiling

Date: 2026-10-25 · Status: accepted · Supersedes in part: 0016 · Extends: 0009, 0023 · Source: the spec on issue 54 (revision 4, N1 to N10), signed off by the owner through the lead session

Every container got `--pids-limit 1024`, which no file could change. A full
Stryker run at 16 CPUs held up to 1,018 of those 1,024 processes, with mutants
failing as runtime errors, and at 32 CPUs it crashed as its runners started.
The limit guards against runaway test code, so it stays on by default and
bounded by the machine, as memory is.

- **`processes`** is a new key in the repo configuration, a command's object
  form and the machine configuration. **`maxProcesses`** is its machine-only
  ceiling. Both must be whole numbers from 1 to 4194304, the Linux kernel's
  largest process limit; `0` and `-1`, which Docker reads as unlimited, are
  refused with exit 125 before any Docker call.
- The pick order is ADR 0023's: the command's own value, the repo's top
  level, the machine file, then the default. A picked value above
  `maxProcesses` exits 125 with the ceiling message.
- The default is the smaller of 1024 and `maxProcesses` (the owner's q9). A
  raised ceiling never raises the default, unlike `maxCpus` (ADR 0017); a
  lowered one lowers it.
- `docker run` gets `--pids-limit <processes>` in place of `--pids-limit
  1024`, at the same position. Nothing else in ADR 0016's options changes.
- A run that hits its process limit gets no outcome of its own: Docker sets no
  flag for it, so the outcome is whatever the test's exit gives. The README
  says how a hit shows.
- Two configuration keys are added, so neither `schema` nor the major version
  changes. A rollback after a release keeps the keys and sets the default and
  the ceiling back to 1024.

This supersedes the `--pids-limit 1024` item of ADR 0016's `docker run` list.
The threat-model consequences are accepted risk 36 (a raised ceiling and the
engine's shared process table), a clause on accepted risk 4, and accepted
risk 25 widened to every message that names the machine configuration file.
