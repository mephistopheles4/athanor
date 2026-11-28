# 0040. Two Node lines: the floor and the newest LTS

Date: 2026-11-27 · Status: accepted · Source: the spec in `docs/spec/0002-node-26-beside-the-floor.md`

athanor was tested on Node 24 alone. Node 26 has been the newest long-term
support (LTS) line since 26.13.0 (2026-10-28), and Node 24 stays supported
until April 2028. A user on either should get the same tested package.

The **floor** is the oldest Node line the package supports: 24 here.

## Decision

- **The floor is named once,** in `package.json` as `engines: >=24`.
  `@types/node` keeps major 24, and both TypeScript configurations keep
  `target` and `lib` at `es2024`, so an API only a newer line has fails the
  type check. The test image of `athanor run` stays on `node:24`.
- **Every pull request and push runs the floor on every system, and the newer
  line on Linux.** `suite`, on Linux, is a matrix over `['24', '26']` with
  `fail-fast: false`. `ci-macos` and `ci-windows` run 24. zizmor and the
  workflow rules, whose verdict does not move with Node, run once, in
  `workflows`, on 24.
- **Node 26 is not tested on macOS or Windows.** The reason is cost: the
  owner's repos share this pattern, and each further leg is runner time in each
  of them. What a new Node line breaks mostly breaks the same way on every
  system, so the Linux leg is the one that pays.
- **One job holds the required name.** `ci` needs `workflows` and `suite`, runs
  with `if: always()`, and fails on any result but `success`. The ruleset
  requires `ci` and does not change when the matrix does. As before, the macOS
  and Windows jobs do not block a merge; a release waits for the whole run.
- **A test holds it,** `test/fast/node-lines.test.ts`: the floor, the types
  major, which system runs which line, every literal `node-version`, the release
  pins and the test image agree, and `ci` keeps its shape.
- **The release stays on the floor,** pinned to an exact release, moved by hand
  (0019). Its fast tier then proves the floor. The tarball is plain JavaScript
  from `tsc`, so the publishing Node does not shape it.

## What follows

- A break that only Node 26 on macOS or Windows shows, such as one in the lock,
  reaches a user before CI sees it.
- The floor is tested at its newest release. Nothing runs or types the code
  against 24.0, so a user on an old 24.x should update within the line.
- A newer push that cancels a pull request's run leaves a red `ci` on the old
  commit. That fails closed. `!cancelled()` in place of `always()` would skip
  the job, and GitHub counts a skipped required check as passing.
- A second leg is a second chance of a flaky red. Re-run a flaky leg from the
  run's page.
- A floor move is a breaking change for users of the package.

## To copy it

For another repo; athanor's file names are examples only.

1. Name the floor once in `engines` (`>=N`). Keep the types package at major N,
   and the TypeScript `lib` and `target` at what Node N runs. The floor is
   tested at its newest release.
2. On every pull request and push, run N on every system the package supports,
   and M, the newest LTS, on Linux alone: one matrix `['N', 'M']` with
   `fail-fast: false` on the Linux job that runs the code, and a literal N on the
   others. The other systems do not test M. That saves runner time, and what a
   new line breaks mostly shows on Linux too. A check whose verdict does not move
   with Node runs once, on N.
3. Use one aggregator job with the required check's name.
   - It has `needs:` on every job a merge must wait for, and `if: always()`.
   - It fails on any result but `success`, and on an empty list.
   - It has no checkout, no secret and no permission beyond the workflow's.
   - It reads the results through `env:`, never inline.
   - No job it needs, and no step of one, sets `continue-on-error`, which lets
     a failure arrive as `success`.
   - `if: always()` is what keeps a skipped aggregator from passing as success,
     so a test holds it.
4. Write a test that reads the floor, the types major, the matrix, which system
   runs which line, every literal `node-version`, every other Node pin and the
   aggregator's shape, and fails when they disagree (here
   `test/fast/node-lines.test.ts`).
5. Keep an exact release pin on line N, moved by hand to a release at least 7
   days old.
6. **When a line comes or goes:**
   - When a newer line becomes LTS (each October), make it M.
   - Move the floor to the next line before N's end of life. Do it in one change
     that moves `engines`, the types major, the release pin, every literal and
     the matrix together; the test enforces this.
   - For a published package, a floor move is a breaking change.
