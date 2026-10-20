# 0012. Docker as configured

Date: 2026-10-20 · Status: accepted · Supersedes: 0008 · Source: the owner's
decision, recorded as a spec amendment on issue 1 (C29 and S4's "local Docker
only" paragraph removed)

athanor uses Docker as the user has it configured: `DOCKER_HOST`, the active
context and the buildx builder, local or remote. It does not check where the
engine or the builder runs. Before a build, it checks only that the engine
answers (`docker version`), and reads the builder's driver, so that a
`docker-container` builder gets `--load` and its image lands in the engine.

Consequences: with a remote engine or builder, the build context and the
snapshot go to that machine. On an engine shared by several machines, the
fixed container names `athanor-slot-<n>` and the per-machine slot lock can
collide. Both are accepted-risk candidates in the threat model draft. No
guard is built for either.

Every other run control is unchanged: `--network none` and the rest of
ADR 0005 still apply to the test run.
