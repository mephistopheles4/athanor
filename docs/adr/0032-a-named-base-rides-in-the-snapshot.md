# 0032. A named base rides in the snapshot

Date: 2026-10-27 · Status: accepted · Extends: 0007, 0016, 0020, 0023 · Source: the spec on issue 70 (revision 3, B1 to B15), with q1 to q8 from its Plan round, q9 to q13 from its Design review of revision 1, q14 to q17 from the follow-up round on revision 2, q18 (proceed to Build on revision 3) and q19 to q22 from the Test review. q1 to q8, q12, q13, q16, q17, q21 and q22 are the owner's word, relayed by the lead session; q9 to q11, q14, q15 and q18 to q20 are the lead's own decisions under the owner's level-3 goal.

The snapshot reached the container as one tar of the work's tree, and the
boot script committed it as a single parentless commit. A check that compares
the branch with its base, such as grimoire's version-bump rule
(`git merge-base origin/main HEAD`, then `git show <merge-base>:<path>`), found
no base and skipped. grimoire ran it a second time on the host. The image
build can't help: it never sees the repo's history.

A run may now name a base, and athanor carries it in the snapshot's own
stream.

- **Naming (q1, q9).** A named command in object form may set `base`, which
  must resolve to a remote-tracking branch or a tag. That way a repo's
  configuration, which someone other than the owner may have written, can't
  name a local branch's unpushed history; a local tag on unpushed work, or
  another remote's branch, it still can, which accepted risk 39 covers. `athanor run --base
  <name>` sets it for one run, a local branch included, and overrides the key.
- **The name (q2).** It is refused before git sees it when it is empty,
  starts with `-`, or holds revision syntax, a space, or a character of the
  control set copy-out uses (C0, DEL, C1, U+2028, U+2029, Unicode format
  characters). `HEAD`, `@` and the all-caps pseudo-refs are refused by name,
  since `--symbolic-full-name` would turn them into the branch they point at.
  It is then resolved with `git -c core.warnAmbiguousRefs=true rev-parse
  --verify --quiet --symbolic-full-name --end-of-options`. The answer, never
  the exit code, decides: one full name under `refs/heads/`, `refs/remotes/`
  or `refs/tags/`. An ambiguous name gives an empty answer with exit 0 (a hand
  run on git 2.55), and with the repo's setting turned off a same-named tag
  would win quietly, so the setting is pinned on. `refs/heads/athanor`, and
  anything under it, is the snapshot's own branch inside the container, so it
  is refused. The name git resolves to, which a symbolic ref such as a
  remote's HEAD can make differ from the given name, gets the control-set
  check too (q20). Messages show every quoted name escaped, key and command
  names included (q11, q15, q20).
- **Resolving in a clean environment (q3).** Every git call that resolves the
  base or makes what carries it runs from the repo root, in ADR 0020's clean
  environment. On top of that environment it sets `GIT_NO_REPLACE_OBJECTS=1`,
  `GIT_GRAFT_FILE` naming an empty file, `GIT_NO_LAZY_FETCH=1`, and the run's
  own object folder, where the snapshot's commit or tree and the files of
  uncommitted edits live. The repo's own config is still read.
- **Refusals (q7).** A shallow clone, a partial clone (`extensions.partialClone`,
  or any `remote.<name>.promisor` read as a yes/no), unrelated histories, and a
  snapshot that holds a path named `.athanor-base` each end the run with 125
  before a slot is taken. A hand run showed why the partial clone is refused:
  walking a blob-less clone's history fetched the missing files from its
  remote and wrote them into the repo. `GIT_NO_LAZY_FETCH` only exists from
  git 2.45, so on git 2.32 to 2.44 the refusal is the only guard.
- **What travels (q4, q5).** Once the slot is held, athanor writes a pack in
  the run's scratch folder. It holds every commit from the merge bases onward
  on both sides, with every tree and file each one reaches, plus the
  snapshot's own tree. The objects are listed commit by commit with
  `rev-list --objects --no-walk`, never with a negative revision, which would
  leave out the files a merge base shares with later commits. Beside the pack
  go a shallow list (each carried commit with a parent that was not carried),
  two refs (the base's full name at its tip, `refs/heads/athanor` at the host's
  HEAD) and the snapshot's tree id. These four files ride after the tree in
  the snapshot's tar, under `.athanor-base/`, added by `git archive
  --add-file`, and are deleted as soon as the archive ends, so the copy of the
  history sits in the state folder only from the pack's build to the end of
  the stream (q20). `pack-objects` pins `pack.packSizeLimit=0`, so a repo's
  setting can't split the pack. Only commit, tree and file objects travel:
  never a tag object, a git setting, a hook, a remote, a reflog, a stash or
  another ref.
- **Inside (q6).** With a base, one of two fixed boot scripts, one per object
  format, replaces only `BOOT`'s git block, and every other line stays the same
  byte for byte. It checks that the folder holds exactly its four regular
  files and moves it out of the work folder. It then puts the history into a
  fresh repo of the same format (a `git init` pinned to sha1 too, for an
  image whose git defaults to sha256), sets the refs and the shallow list,
  points HEAD at `refs/heads/athanor`, reads the index from the snapshot's
  tree, and commits on top of the host's HEAD only when the tree differs. Any
  failure ends the boot before the marker. Without a base, `BOOT`, the stream
  and the result are as they were.
- **Reporting (q8).** athanor never fetches. A progress line names the base,
  its tip and the merge base, and the JSON result gains `base` (`ref`, `tip`,
  `mergeBase`), an addition under `schema` 1.

What it costs is accepted risk 39: with a base, the snapshot carries the
history from the merge base onward wherever it goes. That history includes
files deleted since, and commit metadata with other people's names and
emails. A git error from the base's steps can name a path in the state
folder, which holds the account name; accepted risk 25 was widened to cover
that (q16). Risk 39 also says the pack sits unencrypted in the state folder
while it exists, as the repo's own objects do (q21). Five hardening items are
recorded nowhere, on the owner's word (q12, q17, q22):

- the result doesn't say when `--base` overrode a command's base;
- HEAD is resolved again for an `--untracked` snapshot;
- the carried history has no size cap, and its pack holds the slot while it
  builds, though an interrupt stops it;
- the test-only `basePackFolder` option writes the pack into a folder its
  caller chose, which the run never removes;
- an interrupt doesn't reach three of the base's quick git calls, only the
  three that carry data.

athanor 0.2.0 is the first release that takes `base` and `--base` (q14).
