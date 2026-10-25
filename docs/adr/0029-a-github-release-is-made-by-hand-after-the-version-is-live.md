# 0029. A GitHub release is made by hand, after the version is live

Date: 2026-10-25 · Status: accepted · Extends: 0019 · Source: spec revision 1 on issue 57 (Z1 to Z6)

Zenodo archives the repo and mints a DOI when a GitHub release is published.
The owner makes that release by hand, with their own gh login, as the last
part of step 17 of `docs/releasing.md`: after the version is live on npm,
checked and tagged. No job in `release.yml` makes a release.

## Why

- **The workflow only stages.** A version goes live when the owner approves
  it on npm, outside the workflow, and the owner tags it by hand. A release
  made inside the workflow would come before that approval, and a Zenodo
  record can't be deleted, even for a version the owner then rejects.
- **No write token in the release path.** A job that makes a release needs
  `contents: write`, an environment the owner approves, and a new accepted
  risk: that token can move tags and push branches. The hand step needs none
  of these.
- **Releases stay deliberate.** The owner already approves and tags by hand;
  the release is one more command after the same checks.

## How

- Before `gh release create`, the owner checks that the tag points at the
  run's commit and that npm's integrity for the version matches the check
  job's.
- `--verify-tag` stops the command from making a tag of its own.
- A version deprecated in step 17 gets no release.
- v0.1.0 and v0.1.1 get no release: their tags predate `CITATION.cff`, which
  Zenodo reads from the release's tag.

## Revisit

If the hand step is missed or done wrong, a release job behind its own
environment, with checks that fail closed, is the alternative. It comes with
its own accepted risk, for the owner to decide.
