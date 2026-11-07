# 0033. athanor isolates parallel test runs; it does not contain a hostile repo

Date: 2026-11-07 · Status: accepted · Extends: 0016, 0020 · Source: spec revision 1 on issue 84 (S2, D1 to D9), with Plan answers Q1 to Q7, the owner's word relayed by the lead session

athanor was built to queue test runs and keep a set number running at once,
so that many agents on one machine don't overload it or collide with each
other. Its controls grew since then as if the repo's own tests were hostile,
while the threat model already trusted the repo's code and left a compromised
machine out. Each change was then reviewed against an attacker the owner never
put in scope.

- **The purpose.** athanor is a queue and an isolation tool for test runs. It
  isolates so that parallel runs don't collide: ports, files, and the
  machine's load. Each run gets its own container, its own snapshot and a
  slot, and never writes the owner's working tree.
- **What it does not do.** It does not contain a hostile repo, and it does not
  protect a compromised machine. A repo's own code (its configuration, its
  Dockerfile and its tests) is trusted, as the machine is. athanor is not a
  sandbox for a repo you don't trust.
- **What is in scope.** The boundaries athanor itself creates or exposes: a
  shared or remote engine, what athanor exposes on the network, what it
  records and leaves behind, and the release and CI supply chain, since other
  people install athanor.
- **Every control stays.** This record changes no control, flag, key, exit
  code or message. Each control the threat model or AGENTS.md names now gives
  its reason under this scope: collision, the machine's load, or a boundary
  in scope. A control with none is a candidate to loosen, listed on issue 84.
  Each loosening is its own spec, decided by the owner.
- **The extended records.** ADR 0016 (which carries ADR 0005's rule that the
  container gets nothing from the host) and ADR 0020 (the archive step's clean
  environment) keep their controls; only the reason they rest on changes, as
  the threat model's boundary bullets say. This record supersedes nothing.

The threat model's Scope, its actors and its accepted classes follow this
record. The README's "What athanor doesn't protect you from" and SECURITY.md's
"What counts" follow it too. AGENTS.md's security-sensitive marks are not
changed here; each is on the candidate list.
