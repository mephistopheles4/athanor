# 0037. The macOS lock is a loopback port

Date: 2026-11-26 · Status: accepted (amends 0004) · Source: spec revision 3 on ATH-7

macOS has neither Windows' named pipes nor Linux's abstract sockets. So on
macOS a run holds slot n, and a server holds lock n, by listening on TCP
`127.0.0.1:<port>`, never on `0.0.0.0`, `::` or `localhost`. The OS frees the
port when the process ends, even after a hard kill. The holder answers as ADR
0004 says. Linux and Windows keep their addresses.

The other choice was a socket file in the state folder. Its mode would shut out
other accounts and a Mac engine's containers, but it makes the limit per user,
and a hard kill leaves the file behind: whoever removes a stale file can race a
caller that has just made a new one, and both then hold the slot. The owner
accepted who can reach a port instead (the threat model, "What athanor exposes
on the network").

## Ports and the cap

Run slot n is port 47300 + n and server lock n is 47400 + n. macOS holds at
most 64 of each: a limit above 64 exits 125. n goes to 65 because the
limit-mismatch warning asks about the lock above the cap. The two ranges could
not hold more than 99 before slot 100 met server lock 0. Any other name prefix,
which only tests set (ADR 0003), takes a port from 20000 to 46999 out of the
SHA-256 of `<prefix>-<kind>-<n>`.

The numbers are not part of athanor's public interface. A change to them needs
no major version; `status` prints the port of a held lock that gave no athanor
answer.

A port another program holds counts as a held lock. Any other listen error stops
the run and names the address.

## Probe records

`scripts/probe-pipe.mjs` checks: (1) a second listen fails, (2) the holder
answers, (3) a new listen succeeds within 2 seconds of `kill -9`, (4) the same
between two terminals, (5) a connection from another machine to the Mac's
network address is refused, and (6) whether a listen on `127.0.0.1:P` succeeds
beside a listener on `0.0.0.0:P`, and beside one on `[::]:P`. Criterion 6 is
recorded, not required.

CI, 2026-11-26, `macos-15-arm64` (macOS 15.8.2), Node 24.22.3, port 40486:
criteria 1, 2 and 3 met (the port was free 4 ms after the kill). Criterion 6:
the listen on 127.0.0.1 succeeds beside `0.0.0.0` and beside `[::]`, so a
program that listens on every address does not block the lock. athanor binds
beside it, and that program's clients on 127.0.0.1 reach athanor's answer.
Criteria 4 and 5 were not tried.

The owner's run on their own Mac is not yet recorded here.
