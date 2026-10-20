# Decision records

One record per lasting decision. A new decision gets the next number; a
changed one gets a new record that names the one it replaces.

| ADR | Decision |
| --- | --- |
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies |
| [0002](0002-no-shell.md) | No command string, no shell |
| [0003](0003-core-and-thin-cli.md) | A core module with a thin CLI |
| [0004](0004-the-os-lock.md) | The slot lock is the OS lock |
| [0005](0005-the-container-gets-nothing-from-the-host.md) | The container gets nothing from the host |
| [0006](0006-the-image-is-built-from-the-hashed-set.md) | The image is built from exactly the files that key its tag |
| [0007](0007-snapshots-never-write-the-repo.md) | Snapshots never write the repo |
| [0008](0008-local-docker-only.md) | Local Docker only (superseded by 0012) |
| [0009](0009-machine-configuration-and-ceilings.md) | Machine configuration, with ceilings |
| [0010](0010-inputs-keep-their-repo-relative-path.md) | An inputs file keeps its repo-relative path |
| [0011](0011-the-state-folder.md) | The state folder is .athanor in home |
| [0012](0012-docker-as-configured.md) | Docker as configured |
