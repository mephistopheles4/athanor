# 0006. The image is built from exactly the files that key its tag

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4, C3, C28)

athanor makes the build context itself, as a git tree: the tracked files under
`context` at their working-tree state, plus each `inputs` file (ADR 0010). It
wraps the tree in a commit with no parent and a fixed author, date and
message, and streams `git archive` of that commit into `docker build -`. The
tag is `athanor:` plus the first 32 hex digits of a SHA-256 over a format
version and the tree id.

So untracked and ignored files and the git folder never reach the build, and
the tag is the same across clones, worktrees and git versions. The hash is a
cache key, not a security control. Every `git archive` pins
`core.autocrlf=false` and `core.eol=lf`, and the build archive pins
`tar.umask=0022`.
