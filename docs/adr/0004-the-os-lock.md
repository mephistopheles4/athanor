# 0004. The slot lock is the OS lock

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4,
C33), and [the probe record](https://github.com/mephistopheles4/athanor/issues/1#issuecomment-6279250023)

The spec made the build's first step a probe of the Windows named pipe, and
let its result pick the one lock the build ships. The owner ran
`scripts/probe-pipe.mjs` on Windows 11: a second listen on a held pipe failed,
the holder answered with its JSON line, a new listen succeeded within 2
seconds of `taskkill /F`, and the same held between two terminals. A
connection from another machine was not tried.

So a run holds slot n by listening on `\\.\pipe\<prefix>-slot-<n>` on Windows,
or on the abstract socket `\0<prefix>-slot-<n>` on Linux, with
`net.createServer`. The OS frees it when the process ends, even after a hard
kill. The holder answers each connection with one JSON line (slot, pid, start
time, repo folder name, its limit) and closes it.

The folder lock is not built, and the source holds no code for it. Changing
the lock means a new probe and a new ADR.
