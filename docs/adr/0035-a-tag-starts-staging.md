# 0035. A tag starts staging

Date: 2026-11-08 · Status: accepted, on the owner's merge · Amends: 0019, 0031 · Source: spec revision 4 on issue 88 (S1 to S11, F1 to F12)

The owner decides when a version ships, by pushing a tag, and nothing goes live
without the owner's look and npm two-factor approval. So the release workflow
starts on a pushed tag and only stages, as it did when started by hand, and
release candidates go out under their own npm dist-tag. When two designs both
keep that, the one with fewer paths to a live version wins.

## Decision

- **Versions.** A release version is `X.Y.Z` (dist-tag `latest`) or
  `X.Y.Z-rc.N` (dist-tag `next`): whole numbers, no leading zeros, N at least
  1. Every other form is refused.
- **One start.** `.github/workflows/release.yml` starts on a `push` of tags
  `v*` and on nothing else; `workflow_dispatch` is gone. A failed run is
  re-run on the same tag. The file name, the `npm` environment and the two-job
  shape stay, so the trusted publisher is unchanged. The package still
  disallows tokens, the trusted publisher still stages only, and the owner
  still approves each staged version on npm with two-factor authentication
  after comparing it with a local pack.
- **Guards in `check`, before any build.** The ref is a `v*` tag; the actor is
  the repository owner; the tagged commit is `main`'s head or behind it
  (GitHub's compare API says `identical` or `behind`); `ci` passed on `main`
  for the commit; and, after the checkout, the tag is `v` plus
  `package.json`'s version and that version has one of the two forms
  (`scripts/check-release-ref.mjs`). The first four use the API, so no repo
  code runs at a commit not yet known to be on `main`.
- **The dist-tag comes from the tarball.** In `publish`, a marked block of
  plain `sh` reads only the `package/package.json` member of the tarball, to
  standard output, requires its version to equal the file name's and the
  tag's, and derives `--tag` from it. The block lists the tarball by name
  first and accepts only entries under `package/` with exactly one
  `package/package.json`, as tar lists them, because npm drops the first
  folder of every entry and reads the manifest that is left. npm's reader can
  see a different archive from tar's (a lone zero block, a pax global path),
  so the listing is a mistake guard. `npm stage publish` is always passed
  `--tag`. What binds the version npm stages is the owner's step 15: one
  staged entry for this version, the `npm install` compare that unpacks as npm
  does, and the entry list and every file compared with a local pack. Against
  code in `check` that also binds the dist-tag; against an action in
  `publish`, see the residual below.
- **The `npm` environment admits `v*` tags, not `main`.** The owner changes it
  after this workflow merges and before the first tag, and checks it before
  each release (`docs/releasing.md`).
- **The workflow check enforces four rules** (`scripts/check-workflows.mjs`):
  a workflow with `id-token: write` starts only on a push of tags `v*`; the
  job that names `environment: npm` has no checkout; `npm stage publish`
  carries `--tag`; no workflow runs `npm publish`, `npm dist-tag` or
  `npm stage approve`. They are mistake guards behind stage-only publishing.
- **Owner steps.** The owner checks, before pushing the tag and again before
  approving the `npm` deployment, that the commit is an ancestor of
  `origin/main`. A rejected, failed or unpublished version keeps its tag, and
  the next release bumps the version. A release candidate gets no GitHub
  release, so it makes no Zenodo record.

## What this changes, for the owner to confirm by merging

1. **The external "environment allows `main` only" is replaced by the tag
   policy.** A run started by a tag uses the `release.yml` at the tagged
   commit. A tag on a commit off `main`, with an edited workflow, runs the
   edited file, so the guards above guard against mistakes. The controls that
   hold are outside the file: the "Only admins create tags" ruleset (a pushed
   `v*` tag is owner-only and permanent), the environment's tag policy with
   the owner as its required reviewer, npm's binding to `release.yml` plus
   `npm`, the owner's look in step 13, and stage-only publishing with
   two-factor approval. The environment, its tag policy and npm's binding
   guard the identity token only as far as npm enforces the environment the
   trusted publisher names, which is unconfirmed (claim R10 of the spec on
   issue 6). Until it is confirmed, the actor stays "whoever controls the
   owner's GitHub account, or can push a branch", and the tag policy counts as
   a control only under that caveat. Against whoever holds the owner's GitHub
   account or gh login, who can also create tags and change the rulesets and
   the environment, only stage-only publishing and the owner's npm two-factor
   approval hold, as before this change.
2. **ADR 0031's "a version unpublished or deprecated in step 17 gets no tag"
   is replaced.** The tag is pushed before the version is checked, and a pushed
   tag never moves, so a rejected, failed or unpublished version, and every
   rc, keeps its tag and burns its number. Such a version still gets no GitHub
   release.
3. **ADR 0019's "no dev package or test code runs where an identity token can
   be minted" now holds for a tag on a commit of `main`.** The owner checks
   that the commit is on `main` before pushing the tag and again before
   approving the `npm` deployment (step 13), because the token is minted at
   that approval.

Once the environment admits every `v*` tag, the old tags `v0.1.0` and `v0.1.1`
(and every later tag) are deployable refs. They stay safe through their own
files' guards (v0.1.0 has no `release.yml`; v0.1.1's starts only by hand and
refuses any ref but `main`), the "already on npm" check, the owner's approval
and stage-only publishing.

## Residual the owner accepts

An action in `publish`, or the npm it provides, could stage the owner's
reviewed rc under `latest`. `check` shapes the dist-tag only through the
tarball's version, which the marked block reads, but whether
`npm stage view --json` shows the dist-tag is undocumented. The owner records it at the first rc
(claim F9) and holds that rc's approval until then. If the view shows none, the
owner compares the publish summary's dist-tag line with the version, and the
way back is in `docs/releasing.md`, "Stop conditions and rollback": move
`latest` back to the newest stable version and deprecate the rc. The residual
stays in the threat model until a later release shows the view lists the tag.

## Revisit

- If npm documents or confirms that it enforces the environment the trusted
  publisher names (R10), or that `npm stage view` shows the dist-tag.
- If the tag path is backed out: set the `npm` environment back to `main`
  first, then revert the workflow change. The tags stay.
- If another account, a deploy key, or a new or widened app, token or workflow
  permission gains write access to the repo (ADR 0031).
