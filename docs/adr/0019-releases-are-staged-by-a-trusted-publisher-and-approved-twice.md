# 0019. Releases are staged by a trusted publisher and approved twice

Date: 2026-10-24 · Status: accepted · Source: spec revision 2 on issue 6 (S3 to S7, R1 to R10)

The first publish of `@mephistopheles4/athanor` is the owner's, by hand
(`docs/releasing.md`). Every later version goes through
`.github/workflows/release.yml`, and nothing goes live without the owner. No
long-lived npm token exists anywhere, and each version carries provenance.

**The trusted publisher stages only.** npm's trusted publisher for the package
names this repo, the workflow file `release.yml` and the environment `npm`.
Direct `npm publish` and `npm dist-tag` are left off, so the workflow can only
run `npm stage publish`. A staged version goes live only when the owner
approves it with npm two-factor authentication, from a login held just for
that step, after building and packing the same commit locally and comparing
every file. Publishing access is set to require two-factor authentication and
disallow tokens, so no npm token can publish around the staging step.

**Two jobs.** The workflow starts only by hand (`workflow_dispatch`), only on
`main`, and only when CI passed on the commit.

- `check` holds no identity token. It runs the dev packages, the compiler and
  the fast tier, builds, packs once, checks the tarball with
  `scripts/check-pack.mjs` and hands it on as an artifact.
- `publish` runs in the environment `npm`, which needs the owner's approval
  and allows `main` only. It holds `id-token: write`. It never checks out the
  repo, installs no npm package and runs no repo code: its code is two pinned
  actions and the Node and npm that setup-node provides. It stages exactly the
  tarball `check` made, with `--provenance`.

So no dev package or test code runs where an identity token can be minted.

**Pinned.** Every action is pinned by full SHA to a release at least 7 days
old, and both jobs pin an exact Node release at least 7 days old. The update
bot does not move `node-version`; a person does, by hand. No job restores or
saves an Actions cache, and no setup-node step writes a registry `.npmrc`.
`scripts/check-workflows.mjs` enforces the checkout, cache, registry and token
rules on every workflow, in CI and in the release.

**Why direct publish is off.** With staging only, a hijacked action in the
publish job, or someone with the owner's GitHub account, can stage a version
but cannot make one live. The cost is a second approval and a look at the
tarball on each release.

**If staging loses provenance.** npm's docs don't say whether a staged
version keeps its provenance through approval, or whether a staged publish
validates a new trusted publisher within its 2 days. The first workflow
release checks both (R8). If either fails, the owner decides between allowing
direct `npm publish` behind the environment approval alone, which reopens the
threat model's paths for the identity token, and keeping staging without
provenance.

ADR 0001 to 0018 are unchanged.
