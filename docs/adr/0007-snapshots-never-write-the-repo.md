# 0007. Snapshots never write the repo

Date: 2026-10-19 · Status: accepted, extended by 0023 · Source: spec revision 5 on issue 1 (S4, C4, C5, C21, C30)

`git stash create` rewrites the index it is given, so it runs against a copy
of the real index in the state folder (`GIT_INDEX_FILE`). `--untracked` fills
a temporary index from `HEAD` and adds the work tree to it. Every git call in
a run sets `GIT_OBJECT_DIRECTORY` to a per-run folder in the state folder.
That folder's `info/alternates` names the repo's own object store, from
`git rev-parse --git-path objects`, which finds the shared store in a
worktree. athanor writes the alternates file rather than setting
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, because that variable's separator differs
by platform and clashes with drive letters.

The repo's index, refs, stash list, working tree and object store are the
same after a run as before it. The per-run folder and the temporary index are
deleted when the run ends. Ones older than 24 hours, left by a hard kill, are
cleared at each run start and by `prune`.
