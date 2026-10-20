# 0013. A plain tcp Docker endpoint is refused by default

Date: 2026-10-20 · Status: accepted · Source: the owner's answer to q8 (A2),
after the security pair's review, recorded as a spec amendment on issue 1

athanor uses Docker as configured (ADR 0012), but before any build or run it
refuses a plain `tcp://` engine endpoint, from `DOCKER_HOST` or the active
context, when its TLS is not verified. The refusal exits 125 and names the
setting and the opt-out. These pass: ssh://, tcp with TLS verification
(`DOCKER_TLS_VERIFY` for `DOCKER_HOST`; a context's TLS material with
verification on), loopback addresses (localhost, 127.0.0.1, ::1), and local
pipes and sockets.

A plain tcp endpoint would carry the snapshot, the build context and the test
output across the network unencrypted, where anyone on the path could read
them or forge the result.

The opt-out is `"allowPlainTcp": true` in the machine configuration, for
networks the owner trusts: a home lab, an office build box, a VM on the same
machine, or CI running Docker inside Docker. It is read only from the machine
configuration, never from a repo's `athanor` key (where it is an unknown key)
or from the environment, so a repo cannot turn it on.
