# 0001. No runtime dependencies

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4, T7)

athanor uses Node's own modules only, and `package.json` has no
`dependencies`. No third-party package runs on the owner's machine through it.

Consequences: no native file lock and no argument parser from a library. The
slot lock is the OS lock (ADR 0004). Arguments are parsed by hand in
`src/cli.mjs`. Limiting the Windows pipe to the owner's account would need a
native package, so it is not done (threat model, candidate 2).
