# 0015. Empty overrides for the Docker client's proxy settings

Date: 2026-10-21 · Status: superseded by 0016 · Supersedes: 0005 · Source: spec revision 4 on issue 23 (S2, S3, P1 to P3)

The Docker CLI adds proxy environment variables to a container from its own
client configuration (`proxies` in `config.json`), after it has parsed the
arguments athanor passes. A proxy setting can hold a password, so the values
would reach the test code. The check on issue 23 confirmed this on Docker
29.9.2: ten names were filled with the configured values. An empty override,
`-e NAME=`, stops the CLI from filling that name.

`docker run` gets `-i --init --pull never --log-driver none --network none`,
memory, memory-swap and CPU limits, `--pids-limit 1024`,
`--security-opt no-new-privileges`, the fixed name `<prefix>-slot-<n>` and the
label `athanor.slot=<n>`. It gets no `-v`, `--mount` or `--privileged`, and no
`-e` but these:

- `ATHANOR_GRACE_LIMIT`, which holds no host value;
- the ten proxy names, each set empty: `HTTP_PROXY`, `http_proxy`,
  `HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`,
  `no_proxy`, `ALL_PROXY` and `all_proxy`. Each is written `-e NAME=`, with
  nothing after the `=`. The bare form `-e NAME` would copy the host's own
  value in, so it is never used.

The snapshot arrives on stdin. Docker keeps no log of the output.

The container is not started with `--rm`, so athanor can read its exit code,
and whether the memory limit killed it, before it removes it.

The empty overrides also blank a value an image's own `ENV` gives these names.
The test container has no network, so a proxy in it does nothing.

**The list is fixed.** It holds the names the Docker client fills from the five
proxy settings it reads today. A setting that a later client adds reaches the
container until the list is updated, and test P1 cannot see it. This is
accepted risk 11 in the threat model. A Docker release that adds a proxy
setting is a reason to update the list. athanor does not read the client
configuration to find the names (ADR 0012, Docker as configured).

**The build is unchanged.** `docker build` still gets the proxy settings as
build arguments, which a build behind a proxy needs. Accepted risk 1 in the
threat model says so.
