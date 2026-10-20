# 0008. Local Docker only

Date: 2026-10-19 · Status: superseded by 0012 (the owner removed C29) · Source: spec revision 5 on issue 1 (S4, C29)

Before any build or run, athanor checks three settings:

- `DOCKER_HOST`, when set, must be `npipe://` or `unix://`.
- The active context's endpoint, from `docker context inspect` (which honours
  `DOCKER_CONTEXT`), must be local in the same way.
- The builder, from `docker buildx inspect` (which honours `BUILDX_BUILDER`),
  must have the `docker` driver, or `docker-container` on a local endpoint.

Anything else exits 125, naming the setting. `docker buildx inspect` has no
format flag, so its `Driver:` and `Endpoint:` lines are read as text. When
buildx is missing, the classic builder runs in the local engine, which the
context check covers.
