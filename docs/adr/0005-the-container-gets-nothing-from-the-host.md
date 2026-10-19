# 0005. The container gets nothing from the host

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4, S9, C6, C7, C19)

`docker run` gets `-i --init --pull never --log-driver none --network none`,
memory, memory-swap and CPU limits, `--pids-limit 1024`,
`--security-opt no-new-privileges`, the fixed name `<prefix>-slot-<n>` and the
label `athanor.slot=<n>`. It gets no `-v`, `--mount` or `--privileged`, and no
`-e` but `ATHANOR_GRACE_LIMIT`, which holds no host value. The snapshot
arrives on stdin. Docker keeps no log of the output.

The container is not started with `--rm`, so athanor can read its exit code,
and whether the memory limit killed it, before it removes it.
