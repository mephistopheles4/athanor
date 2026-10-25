# Decision records

One record per lasting decision. A new decision gets the next number; a
changed one gets a new record that names the one it replaces.

| ADR | Decision |
| --- | --- |
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies |
| [0002](0002-no-shell.md) | No command string, no shell |
| [0003](0003-core-and-thin-cli.md) | A core module with a thin CLI (extended by 0023) |
| [0004](0004-the-os-lock.md) | The slot lock is the OS lock |
| [0005](0005-the-container-gets-nothing-from-the-host.md) | The container gets nothing from the host (superseded by 0015) |
| [0006](0006-the-image-is-built-from-the-hashed-set.md) | The image is built from exactly the files that key its tag |
| [0007](0007-snapshots-never-write-the-repo.md) | Snapshots never write the repo (extended by 0023) |
| [0008](0008-local-docker-only.md) | Local Docker only (superseded by 0012) |
| [0009](0009-machine-configuration-and-ceilings.md) | Machine configuration, with ceilings (superseded in part by 0017, extended by 0023) |
| [0010](0010-inputs-keep-their-repo-relative-path.md) | An inputs file keeps its repo-relative path |
| [0011](0011-the-state-folder.md) | The state folder is .athanor in home |
| [0012](0012-docker-as-configured.md) | Docker as configured (superseded in part by 0021) |
| [0013](0013-plain-tcp-refused-by-default.md) | A plain tcp Docker endpoint is refused by default (extended by 0021) |
| [0014](0014-typescript-compiled-to-dist.md) | TypeScript source, compiled to dist (superseded by 0018) |
| [0015](0015-empty-overrides-for-the-docker-clients-proxy-settings.md) | Empty overrides for the Docker client's proxy settings (superseded by 0016) |
| [0016](0016-the-container-keeps-six-capabilities.md) | The container keeps six capabilities (superseded in part by 0017 and 0028) |
| [0017](0017-no-cpu-limit-unless-one-is-configured.md) | No CPU limit unless one is configured |
| [0018](0018-typescript-compiled-to-dist-with-install-scripts-off.md) | TypeScript compiled to dist, with install scripts off |
| [0019](0019-releases-are-staged-by-a-trusted-publisher-and-approved-twice.md) | Releases are staged by a trusted publisher and approved twice |
| [0020](0020-the-archive-step-carries-the-tree-as-committed.md) | The archive step carries the tree as committed |
| [0021](0021-docker-off-this-machine-refused-by-default.md) | A Docker engine or builder off this machine is refused by default |
| [0023](0023-a-named-command-carries-its-own-limits-arguments-and-outputs.md) | A named command carries its own limits, arguments and outputs (extends 0003, 0007 and 0009) |
| [0024](0024-a-hook-holds-agent-fast-runs-to-athanor.md) | A hook holds an agent's fast runs to athanor |
| [0028](0028-a-command-can-raise-its-process-limit-up-to-a-machine-ceiling.md) | A command can raise its process limit, up to a machine ceiling (extends 0009 and 0023) |
| [0029](0029-a-github-release-is-made-by-hand-after-the-version-is-live.md) | A GitHub release is made by hand, after the version is live (extends 0019) |
