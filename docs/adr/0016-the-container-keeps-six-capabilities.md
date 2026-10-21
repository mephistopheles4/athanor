# 0016. The container keeps six capabilities

Date: 2026-10-21 · Status: accepted · Supersedes: 0015 · Source: spec revision 4 on issue 4 (S2, S3, K1 to K6)

The test code runs as root in the container, so a container-escape bug in
Docker or the kernel would find Docker's 14 default capabilities already
granted. Most of them do nothing a test needs: there is no network, and no
test plausibly makes device nodes, writes audit records, sets file
capabilities or uses chroot.

`docker run` gets `-i --init --pull never --log-driver none --network none`,
memory, memory-swap and CPU limits, `--pids-limit 1024`,
`--security-opt no-new-privileges`, the fixed name `<prefix>-slot-<n>` and the
label `athanor.slot=<n>`. It also gets, right after `no-new-privileges` and
before the first `-e`, exactly:

`--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETUID --cap-add SETGID`

It gets no `-v`, `--mount` or `--privileged`, and no `-e` but these:

- `ATHANOR_GRACE_LIMIT`, which holds no host value;
- the ten proxy names, each set empty: `HTTP_PROXY`, `http_proxy`,
  `HTTPS_PROXY`, `https_proxy`, `FTP_PROXY`, `ftp_proxy`, `NO_PROXY`,
  `no_proxy`, `ALL_PROXY` and `all_proxy`. Each is written `-e NAME=`, with
  nothing after the `=`. The bare form `-e NAME` would copy the host's own
  value in, so it is never used. The Docker CLI adds proxy variables from its
  own client configuration after it has parsed athanor's arguments, and a
  proxy setting can hold a password; an empty override stops that.

The snapshot arrives on stdin. Docker keeps no log of the output.

The container is not started with `--rm`, so athanor can read its exit code,
and whether the memory limit killed it, before it removes it.

The empty overrides also blank a value an image's own `ENV` gives these names.
The container has no network, so a proxy in it does nothing.

**Why these six.** `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID` and `SETGID`
are what a root-run test can plausibly need: changing owners, writing another
user's folder, and switching user. `KILL` is what the in-container time limit
(`kill -s KILL -1`) needs to end a test that switched to another user; without
it, root cannot signal that user's process, and the test outlives the time
limit (test K4). The eight dropped are `NET_RAW`, `MKNOD`, `AUDIT_WRITE`,
`SETFCAP`, `SETPCAP`, `SYS_CHROOT`, `FSETID` and `NET_BIND_SERVICE`. A test
that needs one of them fails with a permission error. There is no
configuration key to give one back; that is deferred until a repo needs it.

**An allow-list.** `--cap-drop ALL` then `--cap-add`, so a capability that a
later Docker adds to its defaults does not reach the container.

**The list of proxy names is fixed.** It holds the names the Docker client
fills from the five proxy settings it reads today. A setting that a later
client adds reaches the container until the list is updated, and test P1
cannot see it. This is accepted risk 11 in the threat model. athanor does not
read the client configuration to find the names (ADR 0012).

**The build is unchanged.** `docker build` still gets the proxy settings as
build arguments, which a build behind a proxy needs (accepted risk 1).

**Rollback.** Revert the commit that added the options; ADR 0015 is current
again.
