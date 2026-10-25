# 0031. Every tag is fixed, and a release is read as a draft

Date: 2026-10-25 · Status: accepted · Extends: 0029 · Source: spec revision 3 on issue 63, for issues 53 and 63 (W1 to W10)

Zenodo archives the repo at a release's tag when a GitHub release is
published, on any tag, and the record can't be deleted. So every tag is fixed
once pushed, only an admin creates one, and each release is read before it
becomes public.

## Decision

- Two tag rulesets cover every tag (`~ALL`): "Tags never move" restricts
  updates and deletions, with no bypass, and "Only admins create tags"
  restricts creations, with only the repository admin role on its bypass
  list.
- Immutable releases are on.
- In step 17 of `docs/releasing.md`, the owner makes the release as a draft,
  reads it by its id, checks the tag, the release list and both settings
  again, and publishes it by that id.

## Why

- **A Zenodo record is permanent.** Whatever a tag holds when a release is
  published on it is archived for good, so a tag must not move, and a new
  tag must not appear, before the release.
- **The update rule is the control.** It keeps a tag on its commit against
  anyone without admin rights. An admin can lift it; the immutable release
  then holds the tag while the release exists. The seven-character folder
  check on the Zenodo record is a cross-check.
- **A draft makes no record.** Its notes, generated from pull request
  titles, are read before anything permanent exists.
- **An id names one release.** A tag may carry more than one draft, and gh
  finds a release by tag with one lookup, so the read and the publish use
  the release's id.
- **Nothing new in the workflow.** No release job and no write token are
  added (ADR 0029).

## How

- ADR 0029 says nothing of `v*`. The `v*` rulesets were in
  `docs/releasing.md`, which now describes the rulesets on every tag. 0029
  is not edited.
- A version unpublished or deprecated in step 17 gets no tag and no release.
- v0.1.0 and v0.1.1 keep their tags and get no release: steps 13 and 17 diff
  from the last release tag.
- A release on the tag by anyone else stops releasing until accepted risk 38
  is revisited.

## Revisit

- If anyone but the owner's account gains write access to the repo
  (accepted risk 38).
- If GitHub adds a rule on who may publish a release.
- If Zenodo turns out not to archive a release published from a draft (W9).
