# Spec: Node 26 beside the Node 24 floor — V1

Status: proposed, revision 4. Revision 3 followed Design rounds 1 and 2, the second final. Revision 4 holds the owner's decision of 2026-11-27: Node 26 runs on Linux alone, and no scheduled run covers the other systems. Tier: thorough, on the sensitive route (the lead's pick, flagged for the owner). The work touches `release.yml`, the fast tier that `release.yml` runs, the required check, and, in the-pact, the signed Node that every cloud session runs.

## S1. Objective

athanor is tested on Node 24 alone. Node 26 has been the newest LTS line since 26.13.0 (2026-10-28), and Node 24 stays supported until April 2028. athanor should be tested on both, with 24 still the lowest version it supports, its **floor**. A user on Node 26 gets the same package as a user on Node 24, tested on Linux.

Done looks like this:

- Every pull request and push runs athanor's tests on 24 on Linux, macOS and Windows, and on 26 on Linux.
- The required check `ci` stays the one name the ruleset requires, and a test holds its shape.
- A type check still refuses an API only Node 26 has.
- A fast-tier test fails when the places that name the floor disagree.
- The release pin and the cloud sessions' Node pin move to the newest Node 24 security release.
- The pattern is written down so the owner's other repos can copy it.

## S2. The stacks pattern, and what this keeps and changes

stacks tested Node 22 beside 24 from 2026-07-31 to 2026-10-16 (its ADR-0023, then ADR-0110 when it dropped 22). stacks is a public repo.

- **Kept: one matrix job for the code that runs on Node.** A `suite` job with `strategy.matrix.node: ['22', '24']` and `fail-fast: false`, so one red leg does not cancel the other.
- **Kept: checks whose verdict does not move with Node run once,** in their own jobs. A finding is then reported once, not once per leg.
- **Kept: one aggregator holds the required name.** The ruleset requires one check, `gates`, which `needs:` the matrix. Requiring each leg by name would mean editing the ruleset whenever the list changes.
- **Changed: the floor and the matrix agree by a test, not by hand.** stacks' ADR-0110 says nothing tied `engines` to the matrix, and it left a gate for that as a follow-up. Here a fast-tier test holds them together (S5).
- **Changed: the types stay at the floor.** stacks had `engines >=22` beside `@types/node ^26`, so a Node-26-only API type-checked. Here `@types/node` keeps the floor's major (S3).
- **Changed: the aggregator fails closed, and a test holds it so.** GitHub counts a skipped required check as passing. So the aggregator runs with `if: always()` and checks every result itself, and the same fast-tier test checks its shape (S4, S5).

## S3. The Node lines

- **The floor** is line 24. `package.json` keeps `"engines": { "node": ">=24" }`. `@types/node` keeps major 24 (today `24.19.2`). Both `tsconfig.json` files keep `target` and `lib` at `es2024`. So the type checks see only what Node 24 declares: a Node-26-only API, or a language feature past ES2024, fails them.
- **What is tested on the floor is its newest release.** CI's `'24'` resolves to the newest 24.x, and `@types/node` 24.19.2 declares APIs added in later 24 minors. Nothing runs or types the code against 24.0. This was so before this change, and it stays an accepted gap: a user on an old 24.x should update within the line.
- **The newest line** is 26. It appears only in the matrix of the Linux job `suite`.
- Dependabot already holds `@types/node` to its major ("The major tracks the Node floor"), and that stays. Dependabot moves setup-node's action SHA, never a `node-version`.
- `test/container/Dockerfile` keeps `FROM node:24-alpine`. `athanor run fast` tests the floor on the owner's machine, and only CI tests 26.

## S4. The CI shape

`.github/workflows/ci.yml` goes from three jobs to five:

| Job | Runs on | Node | Steps |
| --- | --- | --- | --- |
| `workflows` | ubuntu-24.04, `timeout-minutes: 10` | `'24'` | checkout, zizmor, setup-node, `node scripts/check-workflows.mjs` |
| `suite (node 24)`, `suite (node 26)` | ubuntu-24.04, `timeout-minutes: 30` | matrix `['24', '26']` | every other step of today's `ci` job, unchanged and in order: the install-scripts and registry check, `npm ci`, `npm audit signatures`, both tsc checks, the `.mjs` syntax check, the source check, the fast tier, the docker tier, pack and install, the typed import |
| `ci-macos` | macos-15 | `'24'` | today's `ci-macos` steps |
| `ci-windows` | windows-2025 | `'24'` | today's `ci-windows` steps |
| `ci` | ubuntu-24.04, `timeout-minutes: 5` | none | the aggregator below |

- `suite` sets `strategy.fail-fast: false`, `matrix.node: ['24', '26']`, `name: suite (node ${{ matrix.node }})` and `node-version: ${{ matrix.node }}`. It is the one job with a matrix.
- **Node 26 is not tested on macOS or Windows,** on a pull request, a push or a schedule. The owner's reason is cost: the pattern goes to the owner's other repos, and each further leg is runner time in each. What a new Node line breaks mostly breaks the same way on every system. The residual: a break that only Node 26 on macOS or Windows shows reaches a user before CI sees it.
- **The aggregator `ci`** has `needs: [workflows, suite]` and `if: always()`. It has no checkout, no setup-node and no `permissions:` of its own. Its one step fails unless every needed job's result is `success`:

  ```yaml
  - name: Every job it needs passed
    env:
      RESULTS: ${{ join(needs.*.result, ' ') }}
    run: |
      test -n "$RESULTS" || { echo "ci needs no job. Put the jobs a merge waits for in its needs: list."; exit 1; }
      for r in $RESULTS; do
        test "$r" = success || { echo "A job ci needs ended $r. Open that job in this run: fix a failure and push again, or re-run a cancelled or flaky job."; exit 1; }
      done
      echo "Every job ci needs passed: $RESULTS"
  ```

  Its check name stays `ci`, the one context `main`'s ruleset requires, so the ruleset does not change. As today, the macOS and Windows jobs are not required for a merge (Q1). The release still waits for the whole workflow (S6).
- **A cancelled run.** `if: always()` also runs the aggregator when a newer push cancels a pull request's run, so the old commit shows a red `ci`. That is accepted: it fails closed, and the newer run is the one that counts. With `!cancelled()`, a cancelled run would skip the aggregator, and GitHub would count the skip as a pass.
- Every other rule holds:
  - `persist-credentials: false` on every checkout;
  - `package-manager-cache: false` on every setup-node;
  - the same pinned SHAs;
  - `permissions: contents: read`;
  - the same `concurrency`.

  `node scripts/check-workflows.mjs` passes on the new file.
- The header comment of `ci.yml` is rewritten. It names the five jobs, the two lines and which system runs which, and the jobs `ci` needs, and says why `if: always()` must stay.

## S5. The agreement check

A new fast-tier test, `test/fast/node-lines.test.ts`, reads these as text, with no YAML package (ADR 0001 keeps the dev packages to the compiler and its types):

1. the floor: `engines.node` in `package.json`, which must be exactly `>=N`;
2. `@types/node`'s major in `package.json`'s `devDependencies`;
3. **the legs** in `ci.yml`:
   - `suite` runs on an `ubuntu-` runner, its matrix is N and one newer line, and each of its `node-version`s reads the matrix;
   - `ci-macos` and `ci-windows` run on a `macos-` and a `windows-` runner;
   - each of the three has a setup-node step;
   - no other job has a matrix;
4. every `node-version` in `ci.yml` outside `suite`: each must be `'N'`;
5. every `node-version` in `release.yml`: each must be an exact `N.y.z`;
6. the `FROM node:N-...` line of `test/container/Dockerfile`;
7. **the aggregator's shape** in `ci.yml`:
   - a job `ci` exists, and its `if:` is `always()`;
   - its `needs:` names every other job in the file, except the ones on a list the test holds (`ci-macos`, `ci-windows`, per Q1);
   - it has no `actions/checkout`, no `actions/setup-node` and no `permissions:` key;
   - no job its `needs:` names has a `continue-on-error` key, which would make a failed job's result read `success`.

The test fails, naming the file and what to change, when:

- any of 2, 4, 5 or 6 disagrees with 1;
- 3 does not hold;
- a `ci.yml` setup-node step names no `node-version`;
- 7 does not hold.

The logic is one pure function over the files' text. It is tested on the real files, and on copies with one input changed at a time:

- each of inputs 2, 4, 5 and 6;
- `suite`'s matrix off N, short of a newer line, dropped, or unread by its setup-node step;
- a matrix, or a newer line, on `ci-macos` or `ci-windows`;
- a leg on another system, removed, or without its setup-node step;
- the aggregator's `if:` dropped;
- a job left out of its `needs:`;
- a checkout, a setup-node or a `permissions:` key added to the aggregator;
- `continue-on-error` set on a job it needs.

A layout the function cannot read fails the test, never passes it. The test file's header names this spec and claim NV4.

## S6. The release pin

`release.yml` pins `node-version: '24.22.0'` in both jobs. Two Node 24 security releases have come out since: 24.22.1 (2026-10-20) and 24.22.3 (2026-11-10). **The pin moves to `24.22.3`** in both jobs. It bundles npm 11.19.1, as 24.22.0 does. So the npm check (at least 11.15.0) and the npm version in step 14 of `docs/releasing.md` stay the same. Step 14's "the npm that Node 24.22.0 bundles" changes to name 24.22.3.

- **The release stays on the floor line.** Its fast tier then runs on the floor. The tarball is plain JavaScript compiled by tsc, so the publishing Node does not shape it. The release moves to the next line when the floor does, and the agreement check (S5) holds it there.
- **AGENTS.md's rule holds:** the pull request names the release and its date, v24.22.3 of 2026-11-10. On 2026-11-27 it is 17 days old, past the 7 days.
- The release's "Check that CI passed on this commit" reads the whole `ci.yml` run, so a release now also waits for the Node 26 leg. `release.yml` needs no other change.

## S7. The cloud sessions' Node pin

The owner asked to recheck the backlog's cloud Node 24 pin here. It is the-pact's backlog item for the cloud Node pin, "Bump the cloud Node pin: Node.js 24.22.3 (November 2026 security release)". The pin is `NODE_VERSION` in `CLOUD_PINS` in the-pact's `cloud-sessions/gen.mjs`, which installs every cloud session's Node. It still names 24.22.1.

- **A new pin is needed:** `24.22.3`, the newest Node 24 release on 2026-11-27 and the same security release as S6. The cloud pin stays on line 24. Moving the-pact's sessions to 26 belongs to the-pact's own Node 26 item, not this one.
- **It is its own ticket, T3, in the-pact repo, on the-pact's sensitive route,** with the security pair on its diff, because it changes a signature-checked binary every cloud session runs. This spec's security pair read athanor's threat model and does not stand in for that review. T3 follows ADR 0088's pin bump, in a build thread's container, where `gpgv` is:
  1. check the signature of `SHASUMS256.txt` with `gpgv` against the committed keyring;
  2. check the releaser's fingerprint against nodejs/node's list;
  3. update both hashes, `NODE_TAR_SHA256` and `NODE_BIN_SHA256`;
  4. regenerate the setup;
  5. write the dated log.

  If 24.22.3's releaser key is not yet in the keyring, the pull request adds it by ADR 0088's key-change rule and shows the second source for its fingerprint. The pull request closes the-pact's backlog item for the cloud Node pin.
- athanor's repo has no cloud setup of its own, no `.nvmrc` and no mise file. Its pins are the ones in S3, S4 and S6.

## S8. The docs

- **AGENTS.md:**
  - "It is a Node 24 package" says it is tested on Node 24, the lowest version it supports, and on 26.
  - "Runs anywhere Node 24, git and `tar` run" says Node 24 or later.
  - The CI paragraph says 26 runs in the Linux `suite` job alone, and that `ci` is the job the ruleset requires, which waits for the Linux jobs.
  - AGENTS.md uses plain words, not "floor", so GLOSSARY.md (1,199 of its 1,200 words) needs no entry.
  - AGENTS.md is at 1,688 of its 1,700 words. The builder first cuts history or a duplicate, as `test/fast/docs.test.ts` says. The builder raises the number only for an instruction in force, and says why in the pull request.
- **README, Install:** "Needs Node 24 or later" adds that athanor is tested on Node 24, and on Node 26 on Linux only.
- **docs/releasing.md:** step 14's Node version (S6).
- **ADR 0040,** "Two Node lines: the floor and the newest LTS", with its line in `docs/adr/README.md`. It holds the decision (S3 to S6), why, and a section "To copy it" (S9). ADRs may use "floor", and the ADR defines it.
- The threat model names no Node version and no CI job. It does not change (S11).

## S9. The pattern, for other repos

ADR 0040's "To copy it" is written so a repo can follow it without reading athanor:

1. Name the floor once in `engines` (`>=N`). Keep the types package at major N, and the TypeScript `lib` and `target` at what Node N runs. The floor is tested at its newest release.
2. On every pull request and push, run N on every system the package supports, and M, the newest LTS, on Linux alone: one matrix `['N', 'M']` with `fail-fast: false` on the Linux job that runs the code, and a literal N on the others. The other systems do not test M. That saves runner time, and what a new line breaks mostly shows on Linux too. A check whose verdict does not move with Node runs once, on N.
3. Use one aggregator job with the required check's name.
   - It has `needs:` on every job a merge must wait for, and `if: always()`.
   - It fails on any result but `success`, and on an empty list.
   - It has no checkout, no secret and no permission beyond the workflow's.
   - It reads the results through `env:`, never inline.
   - `if: always()` is what keeps a skipped aggregator from passing as success, so a test holds it.
4. Write a test that reads the floor, the types major, the matrix, which system runs which line, every literal `node-version`, every other Node pin and the aggregator's shape, and fails when they disagree.
5. Keep an exact release pin on line N, moved by hand to a release at least 7 days old.
6. **When a line comes or goes:**
   - When a newer line becomes LTS (each October), make it M.
   - Move the floor to the next line before N's end of life. Do it in one change that moves `engines`, the types major, the release pin, every literal and the matrix together; the test enforces this.
   - For a published package, a floor move is a breaking change.

## S10. Trade-off points

| Qualities | Side taken | Driver |
| --- | --- | --- |
| Compatibility (26 tested everywhere) against performance (runner time) | 24 on every system, 26 on Linux alone. athanor's repo is public, so its own minutes cost nothing; the cost counts across the repos that copy the pattern. Adding a system is a few lines. | The owner's, of 2026-11-27: cost across the owner's repos. What a new Node line breaks mostly breaks the same way on every system. |
| Reliability of the gates (a second leg, a second chance of a flaky red) against compatibility | Accepted. A flaky leg is re-run from the run's page. A leg that stays red on 26 alone goes by S14's stop. | Cheaper to reverse: a leg is one line. |
| Reliability of the merge gate against flexibility (which jobs block a merge) | `ci` needs the Linux jobs only, as today. macOS and Windows block the release, not the merge. | Cheaper to reverse. Widening the required set is the owner's call (Q1). |
| Maintainability (a line-based read of YAML) against a YAML dev package | Line-based, as `check-workflows.mjs` already reads workflows. A layout it can't read fails the test, never passes it. | ADR 0001 and the supply-chain rules keep dev packages to the compiler and its types. |
| Compatibility (release on 26) against reliability (release on the floor) | The floor. | The release's fast tier proves the floor, and there is one fewer line to move. |

## S11. Security

- **Placement.** The change touches two boundaries:
  - CI, inbound, which runs pull-request code with a read-only token;
  - the release, outbound, which stages to npm.

  It adds Node 26 runtimes, fetched by the same pinned `actions/setup-node` from the same source as 24, and one aggregator job with no checkout. It adds no permission, secret, token, cache or action. The release's controls are untouched: the owner's two approvals, stage-only trusted publishing, and the tag and ancestor guards. The residual fits the accepted class "The release and CI supply chain".
- **The one control at stake is the required check.** It moves from the job that ran every step to an aggregator whose fail-closed shape rests on `if: always()` and its `needs:` list.
  - NV3 checks that it fails on a failed job and on a skipped job.
  - From then on, NV4 holds its shape in the fast tier.
  - As at the base, a deliberate edit of `ci.yml` in a pull request is held by the owner's review of the diff.
  - The release's "CI passed" guard still reads the whole run.
- **The release pin** moves by hand to a newer release of the same line, from the same source, past the 7-day wait.
- **The cloud pin** (T3) is reviewed in the-pact (S7).
- The threat model and the README's "What athanor doesn't protect you from" do not change.

## S12. Acceptance claims

- **NV1.** On the pull request's CI run, `suite (node 24)` and `suite (node 26)` each run every step of today's `ci` job except zizmor and the workflow rules, and pass. Each leg's setup-node log shows its line. `workflows` passes. `ci.yml`'s header comment says what S4's last bullet says.
- **NV2.** `ci-macos` and `ci-windows` run today's steps of their jobs on 24 and pass. No run of `ci.yml` has a macOS or Windows job on 26, and no workflow runs on a schedule.
- **NV3.** `ci` reports on the pull request, and passes when every job it needs passes. The builder checks by hand, once, that it fails in both other cases:
  - a throwaway commit makes one step fail on the 26 leg only, and `ci` goes red;
  - a second sets `if: false` on `suite`, and `ci` goes red with `skipped`.

  Both commits are reverted, and the pull request links the three runs.
- **NV4.** `test/fast/node-lines.test.ts` passes on the tree. It fails, naming the file, for each change S5 lists:
  - inputs 2, 4, 5 and 6 changed alone;
  - each change to the legs;
  - the aggregator's `if:` dropped;
  - a job left out of its `needs:`;
  - a checkout, a setup-node or a `permissions:` key added to the aggregator;
  - `continue-on-error` set on a job it needs.
- **NV5.** The type check refuses a Node-26-only API.
  - The builder picks one API whose Node documentation says "Added in: v25.0.0" or later, with no 24.x backport, and confirms that `node_modules/@types/node` does not declare it.
  - A scratch file in `src/` that uses it fails `athanor run types --untracked`. The flag puts the untracked file in the snapshot. (This is the session's pick after the final round, for the owner's box.)
  - The pull request names the API, its documentation page and the error, with repo-relative paths only.
  - The file is not committed.
- **NV6.** Both `node-version` lines in `release.yml` read `'24.22.3'`. Step 14 of `docs/releasing.md` names 24.22.3 and npm 11.19.1. The pull request names v24.22.3 and its date. `test/fast/release.test.ts` and `check-workflows.mjs` pass. At the next release, the owner checks that the tag run's summary shows `npm: 11.19.1`.
- **NV7.** AGENTS.md and the README say what S8 says. AGENTS.md does not use "floor". `test/fast/docs.test.ts` passes.
- **NV8.** ADR 0040 and its index line exist. Its "To copy it" holds S9's six steps, the aggregator's limits among them, and names no athanor file except as an example.
- **NV9.** In the-pact (T3): `CLOUD_PINS.NODE_VERSION` is `24.22.3`, with both hashes, set by ADR 0088's procedure and its dated log, after the security pair's review of the diff. That pull request closes the-pact's backlog item for the cloud Node pin.

## S13. Tickets

| Ticket | Repo | Claims | Depends on | Files |
| --- | --- | --- | --- | --- |
| T1: the release pin to 24.22.3 | athanor | NV6 | nothing | `release.yml`, `docs/releasing.md` |
| T2: Node 26 in CI, the aggregator, the agreement check, the docs and ADR 0040 | athanor | NV1 to NV5, NV7, NV8 | nothing | `ci.yml`, `test/fast/node-lines.test.ts`, AGENTS.md, README, `docs/adr/`, `test/fast/docs.test.ts` if the budget moves, and this spec as `docs/spec/0002-node-26-beside-the-floor.md` with its README line |
| T3: the cloud Node pin to 24.22.3 | the-pact | NV9 | nothing | the-pact's `cloud-sessions/` |

- **Side by side.** The three tickets share no file and can start in parallel. T1 and T3 are overdue security bumps, so start them first.
- **T2 starts with an experiment.** Its first push is a draft pull request with the matrix alone (S4's jobs and the aggregator, nothing else), to see what Node 26 does.
  - Fixes to the tests or the fake Docker that leave Node 24's behaviour unchanged stay in T2.
  - Any change to `src/`, or a fix that changes behaviour on 24, stops T2 at that point. It comes to the owner as a new ticket (S14).
- **Filing.** T1 and T2 are each a sub-issue of this work's issue. T3 is the-pact's backlog item for the cloud Node pin itself, linked to this work's issue as related, not filed again. The lead files and links them after the owner accepts this spec.
- **Done.** This work is done when T1 and T2 are merged and T3's pull request has closed the-pact's backlog item for the cloud Node pin. Closing this work's issue is the owner's call.
- **The spec lands** in `docs/spec/0002-node-26-beside-the-floor.md` with T2. The landed copy follows the folder's rule in every section: it holds no Linear id, with a plain name in each one's place, and S7 gives the security release no rating.

  The landed file matches no `\b(ATH|PACT)-\d+`.
- **Follow-up.** After T2 merges, one issue to copy the pattern to the owner's other repos, from ADR 0040. The owner picks the repos. It counts toward the review's Follow-up issues (limit 2).

## S14. Boundaries

- **Always:**
  - keep every workflow rule `check-workflows.mjs` holds;
  - run the tiers as AGENTS.md says;
  - keep `engines`, `@types/node` and `lib` at the floor.
- **Ask first (stop, and bring it to the owner):**
  - any change to `src/` to make a Node 26 leg pass;
  - a fix that changes behaviour on 24;
  - a fix that needs an API only 26 has;
  - any change to the ruleset;
  - moving the release off the floor line.
- **Never:**
  - widen `@types/node` past the floor;
  - add a YAML or other dev package;
  - give the aggregator a checkout, a secret or more permissions, or a condition other than `always()`;
  - set `continue-on-error` on a job `ci` needs, even for a Node 26 leg during T2's experiment;
  - skip a leg on a path filter.
- **Rollback:**
  - T1: revert its pull request. A tag run reads `release.yml` as it was tagged, so a tag run that already failed on the new pin is fixed by a new commit, a version bump and a new tag ("If a run fails" in `docs/releasing.md`).
  - T2: revert its pull request, which brings back the single `ci` job. The ruleset needs no change either way.
  - T3: by ADR 0088, paste the previous setup and revert the merge.
- **Out of scope:**
  - Node 22 or older;
  - Node 25 or 27, which are not LTS;
  - dropping 24 (before April 2028, in its own change);
  - moving the-pact's sessions to 26 (the-pact's own Node 26 item);
  - copying the pattern to the other repos (the follow-up in S13);
  - Node 26 on macOS and Windows, on a pull request, a push or a schedule (S4);
  - the Windows docker tier on Docker Desktop (K5). It stays on 24, by hand: it checks the engine on a Windows host.

## S15. Needs a human

| Item | Who | When | Session's pick |
| --- | --- | --- | --- |
| Accept this spec, or correct it | the owner | before T1, T2 and T3 start | — |
| **Q1.** Should `ci` also need the macOS and Windows jobs, so they block a merge? | the owner | before T2 starts | No, as today. They still block the release, and adding them is one line in `needs:`. |
| **Q2.** Node 26 on macOS and Windows on every pull request, or on Linux only? | the owner | answered, 2026-11-27 | Linux only, with no scheduled run either (revision 4). The session's earlier pick was all three systems. |
| **Q3.** T3 as the-pact's backlog item for the cloud Node pin in the-pact, related to this work's issue, rather than an athanor sub-issue | the owner | before T3 starts | As the-pact's backlog item for the cloud Node pin. |
| **Q4.** No business driver is named, so the trade-offs lean to what is cheaper to reverse | the owner | at acceptance | — |
| The required check is rebuilt as an aggregator (S11), a change to a named control | the owner | at acceptance | Take it, with NV3 and NV4. |
| Whether the agreement check also requires the two `release.yml` pins to be the same exact version | the owner | at acceptance | Not built unasked. It is an accepted-risk candidate: the owner reviews every `release.yml` change. |
| No `continue-on-error` on a job `ci` needs, held by NV4 (added after the final round) | the owner | at acceptance | Take it: two lines of spec and one test case, far below the security bar. |
| `--untracked` in NV5's type check (added after the final round) | the owner | at acceptance | Take it: without the flag, the claim's check cannot fail. |
| Whether NV4 also holds the body of the aggregator's run step | the owner | at acceptance | Not built unasked. It is an accepted-risk candidate: the owner reviews every `ci.yml` change. |
| File T1 and T2 as sub-issues, and relate the-pact's backlog item for the cloud Node pin to this work's issue | the lead | after acceptance | — |
| NV3's hand checks, and NV5's | T2's builder | before T2's review | — |
| A stop under S14's "Ask first" | the owner | when T2's builder raises it | — |
| Merge each pull request | the owner | after its review | — |
| NV6's `npm:` line at the next tag run | the owner | at the next release | — |
| Which repos the pattern goes to | the owner | after T2 merges | — |
