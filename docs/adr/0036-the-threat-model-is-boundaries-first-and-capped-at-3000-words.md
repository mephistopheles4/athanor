# 0036. The threat model is boundaries first, the machine is out of scope, and it is capped at 3,000 words

Date: 2026-11-12 · Status: accepted · Amends: 0033 · Source: spec revision 3 on the-pact issue 542 (S2, S5, S8), ticket 5 on issue 96, with the owner's words relayed by the lead session; the pact's ADR 0153 holds the same decision for its own threat models

Security rulings kept coming back to the owner. The threat model said what to
fear, but not which control already holds each boundary, so sessions rebuilt
controls in prose, proposed boundaries and classes that already existed, and
brought rulings on paths wholly on the machine. The page had grown to about
9,100 words, most of it history, and a page that long is skipped.

- **Boundaries first.** The threat model opens with its boundaries: where
  something comes in from outside, or where an act goes out. Each names what
  crosses, the controls that hold it by source (athanor, Windows, GitHub, the
  repo's files, npm), each with when it doesn't hold, and its residual. The
  page's old rules for itself are not repeated there: a change that alters a
  defence it names updates it in the same pull request (AGENTS.md); a finding
  that fits no class goes to the owner, and only a merge the owner confirms adds
  or widens one (the pact's review procedure).
- **The machine is out of scope.** Your own computer, or a sandbox run on it,
  with every program, process, account, file and memory made there, is held by
  its own controls and is not a finding. This extends ADR 0033: what athanor
  records and leaves behind on the machine, and machine load, leave the
  in-scope list, since neither crosses a boundary. What athanor sends to an
  engine, and what the network can reach, stay in scope. What came in from
  outside stays outside input wherever it sits.
- **The classes.** Kept by name: "The Windows slot pipe on the network", "A
  shared or remote engine, and the network" and "The release and CI supply
  chain". "A server's port on this machine" becomes "A server's port on the
  network", with the older-engine case and other containers on Docker's default
  bridge network left. "A compromised machine or
  sandbox", "The machine's load" and "What athanor records, shows and leaves
  behind" leave as classes. The sent parts of the last one, a base's history and
  a command's arguments reaching an engine, join the engine class. A class is
  one sentence of at most 40 words.
- **Every control stays.** This record changes no control, flag, key, exit
  code or message. The `Reason:` lines of ADR 0033 are gone from the page; the
  main guards that hold no boundary are named under its Scope, each with the ADR
  or test that keeps it. Those are the candidates to loosen on issue 84, each
  its own spec decided by the owner. The set is larger than under ADR 0033: the
  fixed limits, the configured-paths check, the `--output` parent check and the
  stale-run sweep had a reason there (collision, machine load, records), and
  have none now that records and load are the machine's.
- **The sensitive-work list moves,** unchanged, to `docs/sensitive-work.md`,
  and AGENTS.md points at it.
- **A cap.** The threat model is at most 3,000 words, counted by splitting the
  whole file on whitespace, mermaid included. A fast-tier test holds the cap
  and shows it can fail with a padded copy. Raising the cap is a spec change.
- **No provenance.** The page carries no dates, no "since" history and no
  old row ids; the ADRs and issues hold the history. Control ids that are
  names stay.
- **Controls are read live.** A control the page names as GitHub's was read
  from GitHub when the page was written; one that was not there is not named.

Older ADRs cite rows of the old page, such as "accepted risk 23"; those ids
refer to the threat model as it stood before this record. The sensitive-work
list moves unchanged, so its parentheticals still use the old class names.

The README's "What athanor doesn't protect you from", SECURITY.md's "What
counts" and the code comments that cite a class follow this record.
