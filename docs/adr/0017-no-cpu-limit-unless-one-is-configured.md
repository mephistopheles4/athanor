# 0017. No CPU limit unless one is configured

Date: 2026-10-22 · Status: accepted · Supersedes in part: 0009, 0016 · Source: spec revision 5 on issue 36 (S2, S7, U1 to U7)

A run used to get `--cpus 2` by default, held to a `maxCpus` ceiling of 4. A
test suite that could use every core of the machine got two. The owner wants a
run to use the whole machine unless someone asks for a limit.

- `cpus` has no default. The repo's value wins, then the machine file's, and
  either gives `--cpus <value>`. With neither, `docker run` gets no `--cpus`.
- `maxCpus` has no default either. When the machine file sets it, a `cpus`
  above it exits 125 with the same message as before, and a run with no
  `cpus` gets `--cpus <maxCpus>`.
- Docker refuses a `--cpus` above the CPUs the engine has. The run then ends
  with outcome `error` and exit 125, with Docker's message. athanor does not
  read the engine's CPU count or clamp the value. The README says to keep
  `maxCpus` at or below the engine's CPUs.
- No key, flag, field or exit code is added or removed. A set `maxCpus` now
  also sets the CPUs of a run with no `cpus`, which is a change in meaning.
  The owner chose no `schema` bump and no major version, as a deliberate
  exception to the rule in AGENTS.md.

This supersedes the CPU defaults in ADR 0009 and the "CPU limits" item in the
`docker run` list of ADR 0016. The rest of both stands. The threat-model
consequence is accepted risk 17.
