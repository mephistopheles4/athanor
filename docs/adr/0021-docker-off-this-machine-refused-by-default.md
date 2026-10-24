# 0021. A Docker engine or builder off this machine is refused by default

Date: 2026-10-24 · Status: accepted · Supersedes in part: 0012 · Extends: 0013
· Source: the owner's decisions q1 to q13, relayed by the lead session and
recorded in the spec on issue 33 (revision 3)

athanor used Docker as the user had it configured, local or remote (ADR 0012).
With a remote engine or builder, a run sends the build context and the
snapshot, uncommitted changes included, to that machine, and a notice printed
before the build comes too late to stop it. So `athanor run` now refuses an
engine or a buildx builder that is not on this machine, unless the machine
configuration sets `"allowRemoteDocker": true`. `status` and `prune` send no
repo data and keep using Docker as configured.

**Local.** Endpoints are read as Docker reads them: a value with no `://` is
a tcp host, so `unix:/x` is tcp to a host named "unix" and `10.0.0.5:2375` is
plain tcp. An endpoint is local only when it is a `unix://` address, an
`npipe:` address in exactly the form `npipe:////./pipe/<name>` (read as raw
text, since the URL parser drops the `.` that names this machine), or a
`tcp://` or `http://` address on a loopback host with no user-info part, read
with Node's URL parser. `ssh://`, other hosts, other pipe forms and anything
athanor cannot read are not local.

**The engine.** It is read as before: `DOCKER_HOST`, else the active context.
The plain tcp refusal (ADR 0013) comes first, then the locality refusal, both
before any call that contacts the engine. Then `docker version` checks the
engine answers, so a stopped engine still gets "Start Docker".

**The builder.** `docker buildx version`, which contacts nothing, decides
whether buildx is present; without it the classic builder runs in the checked
engine. With it, `docker buildx inspect` is read strictly: the builder's
`Name:` and `Driver:` first, a header `Error:` meaning athanor cannot inspect
it, node blocks after `Nodes:`, and a `cacert` option counted only from the
`Driver Options:` line straight after that node's `Endpoint:`. Every node of a
`docker`, `docker-container` or `remote` builder must be local; a `docker`
builder is not assumed to be the engine, since buildx lists every context as
one. A node that names a context is looked up with
`docker context inspect -- <name>`, only when the name fits Docker's
context-name pattern. Other drivers, zero nodes, failed lookups and builders
athanor cannot inspect are not local. The engine's own docker builder (its
context's, or `default` when the engine came from `DOCKER_HOST`) leads to the
engine as already checked, and gets no second notice.

**Plain tcp to a builder.** ADR 0013's rule now covers builder nodes. A
node's transport counts as read only for a local endpoint, `ssh://`, or tcp
with TLS verified; anything else, a buildx connection helper among them, and
a builder athanor could not read, counts as plain. Plain needs
`allowPlainTcp` as well as `allowRemoteDocker`.

**The opt-out.** `allowRemoteDocker` is read only from the machine
configuration, never from a repo (an unknown key there) or an environment
variable. The machine file lives in the state folder, which `ATHANOR_HOME`
moves, so whoever controls a run's environment controls which machine file is
read, as they already control `DOCKER_HOST`.

**The notice.** Each run the opt-out lets through names the engine or builder
before any build, image check or `docker run`. Every endpoint and line of
Docker's output that athanor shows has its user-info part removed (up to the
value's last `@`), the ssh helper's login (`-l <user>`, `<user>@<host>`)
dropped from Docker's error text, and its control characters escaped.

**Pinned, and checked again.** What was checked is what is used: every later
Docker call runs with the run's environment and `DOCKER_CONTEXT` and
`BUILDX_BUILDER` set to the checked names. When the builder cannot be
inspected and no name is set, the notice says the run cannot pin it. Once the
run holds its slot, just before the slot's container is cleared and the test
runs, the engine and builder are read again under that pin, and any
difference ends the run with exit 125 before `docker run`.

Consequences: a remote engine, an ssh engine, CI running Docker inside Docker
on another host, and a remote builder each need the opt-out set once per
machine. The owner chose no `schema` or major version bump, as a deliberate
exception while the package is unreleased. A local address that leads
elsewhere, and the machine file's path in messages, are accepted risks 24 and
25 in the threat model.
