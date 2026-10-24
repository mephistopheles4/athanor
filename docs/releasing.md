# Releasing

The first version of `@mephistopheles4/athanor` is published by hand. Every
later one is staged by the release workflow and made live by the owner
(ADR 0019); see [Later releases, through the workflow](#later-releases-through-the-workflow).
Only the owner does any step on this page.

## The first publish, by hand

Run these commands in PowerShell 7, from a checkout of the commit being
released.

1. Check that the checkout is clean and that nothing stray can ship from
   `bin/`. Each command prints nothing when it is. The first covers every
   tracked and untracked file, so an edit outside `bin/` cannot be built and
   published; the second adds the ignored files under `bin/`:

   ```powershell
   git status --porcelain
   git status --porcelain --ignored -- bin
   ```

   `dist/` needs no check here, because the build in step 3 clears it.
2. Install the dev packages from the lockfile:

   ```powershell
   npm ci
   ```

3. Build `dist/`:

   ```powershell
   node scripts/build.mjs
   ```

4. List what the package would hold:

   ```powershell
   npm pack --dry-run
   ```

   The list holds only `bin/*.mjs`, the JavaScript and declaration files of
   `dist/`, `README.md`, `LICENSE` and `package.json`, as CI's pack check
   allows. If anything else is listed, stop.
5. Log in to npm, just before the publish. Your npm account must require
   two-factor authentication for authorization and writes (the account's
   security settings). Afterwards, `git status --porcelain -- .npmrc` must
   print nothing: the login belongs in your own npm configuration, never in the
   repo's file.

   ```powershell
   npm login
   ```

6. Publish, approving it with two-factor authentication. After the first
   publish, set the package's publishing access on npmjs.com to require
   two-factor authentication and disallow tokens.

   ```powershell
   npm publish
   ```

7. Log out straight after, whether or not the publish worked. This revokes the
   session token and removes it from your npm configuration:

   ```powershell
   npm logout
   npm whoami
   ```

   `npm whoami` must fail. If it prints your name, you are still logged in.

## Later releases, through the workflow

`.github/workflows/release.yml` builds, tests and packs on `main`, then, after
your approval of the `npm` environment, stages that tarball on npm through the
trusted publisher, with provenance. The trusted publisher can only stage. A
staged version goes live only when you approve it on npm with two-factor
authentication, after comparing it with a local pack of the same commit. The
first approval proves you started this run on the commit you merged; the
second proves the staged files are the ones that commit builds to.

### Before the merge of the workflow, once

1. Make the first publish by hand, as above.
2. On npmjs.com, set the package's publishing access to "Require two-factor
   authentication and disallow tokens".
3. Make the `npm` environment before the workflow first runs. GitHub creates
   an environment a job names, with no protection, when it doesn't exist. In
   the repo's Settings, Environments, set:
   - required reviewers: you;
   - deployment branches and tags: selected branches, `main` only;
   - "Allow administrators to bypass configured protection rules": off;
   - "Prevent self-review": off, since you are the only reviewer and also
     start the run;
   - no environment secrets or variables.

### After the merge, once: the dry run

4. Bump `version` in `package.json` past the hand-published one in a pull
   request, merge it, and wait for CI on `main` to pass.
5. In Actions, choose `release`, then Run workflow on `main`. When `check`
   has passed, approve the deployment. With no trusted publisher yet,
   `publish` reaches its stage step and fails on authentication, and nothing
   is staged.
6. Try the guards. Run `release` on another branch: `check` fails at its
   first step, "The release runs only from main". Then push a commit to
   `main` and run `release` on it before its CI run has finished: `check`
   fails at its second step, "CI has not passed on this commit".
7. In a clean checkout of the dry run's commit, make two packs into two new,
   empty folders outside any checkout, extract each into its own new folder,
   and compare them. They must be the same:

   ```powershell
   npm ci
   node scripts/build.mjs
   npm pack --pack-destination <pack-1>
   node scripts/build.mjs
   npm pack --pack-destination <pack-2>
   New-Item -ItemType Directory <files-1>, <files-2>
   tar -xzf <pack-1>/<tarball> -C <files-1>
   tar -xzf <pack-2>/<tarball> -C <files-2>
   git -c core.autocrlf=false diff --no-index --exit-code <files-1> <files-2>
   ```

8. Record on issue 6: that the run waited for your approval, the job
   summaries, where `publish` failed, the two guard runs of step 6 and the
   result of step 7.

### The first workflow release, within 2 days of adding the trusted publisher

A new trusted publisher expires if no publish uses it within 2 days, so add
it only when a version is ready to release.

9. On the package's npm settings, add a trusted publisher: GitHub Actions,
   owner `mephistopheles4`, repository `athanor`, workflow `release.yml`,
   environment `npm`, with direct publish and dist-tag management left off.
   With the CLI instead, log in as in step 5 of the first publish, check the
   flags against `npm help trust`, and log out straight after, as in its
   step 7:

   ```powershell
   npm trust github @mephistopheles4/athanor --repo mephistopheles4/athanor --file release.yml --env npm --allow-stage-publish
   npm trust list @mephistopheles4/athanor
   ```

   Record on issue 6 what `npm trust list @mephistopheles4/athanor` and the
   settings page show, and the `npm` environment's settings.
10. Run steps 12 to 17 for the version from the dry run. If the trusted
    publisher expires, or the first stage fails, revoke it with
    `npm trust revoke`, add it again, and start again from step 12.
    On this first workflow release there is no release tag yet: in step 13,
    diff against the hand-published commit instead, and in step 17 tag that
    commit too, as `v<hand-published version>`.
11. When step 17 is done, record on issue 6:
    - that the trusted publisher shows as validated in `npm trust list`;
    - that `npm audit signatures`, in a new, empty folder outside any
      checkout where you have run `npm install @mephistopheles4/athanor@<version>`,
      reports a verified attestation;
    - which npm user the version's record names, and whether it shows an
      email address;
    - that a run of `release` with no bump fails at "Check that this version
      is new on npm" with "already on npm".

### Each release

12. If the version is already on npm, bump it in a pull request, merge it, and
    wait for CI on `main`. Then start `release` on `main`.
13. When `check` has passed, check that you started this run, on the commit
    you merged, and read the diff since the last release tag:

    ```powershell
    git diff v<last> <commit>
    ```

    Then approve the deployment, within 3 days of the check job, while its
    artifact lasts. If it has expired, reject the deployment and start again.
14. Before logging in, in a clean checkout at that commit, build and pack.
    `npm --version` must be 11.19.1, the npm that Node 24.22.0 bundles, which
    the release jobs pin. No install, build or repo script runs after the
    login.

    ```powershell
    npm --version
    git status --porcelain
    npm ci
    node scripts/build.mjs
    New-Item -ItemType Directory <local>
    npm pack --pack-destination <local>
    node scripts/check-pack.mjs <local>/<tarball>
    ```

    `git status --porcelain` must print nothing, and the pack check must pass.
    `<local>` is a new, empty folder outside any checkout.
15. Log in, as in step 5 of the first publish, and look. `<id>` is the stage
    id that the publish job's summary and `npm stage list` show.

    ```powershell
    npm login
    npm stage list @mephistopheles4/athanor
    npm stage view <id> --json
    New-Item -ItemType Directory <staged>, <staged-files>, <local-files>
    Push-Location <staged>
    npm stage download <id>
    Pop-Location
    tar -tzf <staged>/<tarball> > <staged>/entries.txt
    tar -tzf <local>/<tarball> > <local>/entries.txt
    git diff --no-index --exit-code <staged>/entries.txt <local>/entries.txt
    tar -xzf <staged>/<tarball> -C <staged-files>
    tar -xzf <local>/<tarball> -C <local-files>
    git -c core.autocrlf=false diff --no-index --exit-code <staged-files> <local-files>
    ```

    - The list must show exactly one staged entry, for this version.
    - `npm stage view` must show the integrity the **check** job's summary
      shows. If it shows the version's manifest, it must have no
      `dependencies`, `optionalDependencies`, `peerDependencies` or
      `bundleDependencies`, and the same `scripts` and `bin` as the local
      `package.json`.
    - The two entry lists must be the same, so the staged tarball holds
      exactly the entries the pack check passed in step 14, and every
      extracted file must be the same. Only npm, `tar` and `git` run here:
      nothing from the repo or from the extracted folders.

    If anything differs, reject every staged entry with
    `npm stage reject <id>`, log out, and stop. An entry you didn't stage is
    an incident: revoke the trusted publisher. An entry left by a run of
    yours that failed is not: see "If a run fails".
16. Approve with two-factor authentication, then log out straight after:

    ```powershell
    npm stage approve <id>
    npm logout
    npm whoami
    ```

    `npm whoami` must fail.
17. Check that the version's npm page shows provenance naming this repo, the
    commit and the run. Check that `npm view @mephistopheles4/athanor@<version> --json`
    shows no dependency of any kind, and the same `scripts` and `bin` as the
    local `package.json`; if it doesn't, deprecate the version at once. Then,
    from the checkout, tag the commit by hand:

    ```powershell
    git tag v<version> <commit>
    git push origin v<version>
    ```

### If a run fails

- **Don't re-run a failed `publish` job.** A re-run can stage a second entry.
- Log in, run `npm stage list @mephistopheles4/athanor`, reject any entry the
  failed run left with `npm stage reject <id>`, and log out. Then start a new
  run of `release` from step 12.
- If a staged entry is one you can't trace to a run you started, it is an
  incident: revoke the trusted publisher.

### Upkeep

- Check `npm trust list @mephistopheles4/athanor` from time to time.
- After any rename or transfer of the repo or the account, revoke the trusted
  publisher and add it again. Before deleting the repo, revoke it.
- A bot pull request that moves an action SHA in `release.yml`, and a change
  to its `node-version`, are security-sensitive work: the pull request names
  each release and its date, at least 7 days old.

## What to know

- **The build is explicit.** The repo's `.npmrc` turns lifecycle scripts off
  (ADR 0018), so `npm pack` and `npm publish` do not run `prepack`. Run
  without step 3 of the first publish, `npm publish` ships a stale or missing
  `dist/`.
- **No token stays on the machine.** Never write a token into the repo's
  `.npmrc`, and never keep one on the machine between publishes. Log in just
  before the publish and out straight after.
- **The login sits in your npm configuration until you log out.** From
  `npm login` to `npm logout`, the session token is in your user npm
  configuration file. That file is not encrypted: it relies on your disk
  encryption, and any program running as you can read it. npm's two-factor
  check on every write is what keeps the token alone from approving.
- **A publish makes your npm account's name and email address public** in the
  registry's records. Publish from an account whose email address you are
  content to show.
- **The compiler runs as you in step 3 of the first publish, and in step 14
  of each release.** A hijacked compiler can shape the published code, and
  neither the install-scripts setting nor CI's comparison with a rebuild sees
  it (accepted risk 18 in the threat model).
- **A new trusted publisher lasts 2 days unused.** npm expires one that no
  publish has validated within 2 days, and the first publish binds it to the
  repository's fixed ids. After a rename or transfer, add it again.
- **Provenance shows where a version was built, not that its code is safe.**
  It names the repo, the commit, the workflow and the run.
- **Staging writes a permanent public record.** The provenance of a staged
  tarball, its digest, commit and run, goes into Sigstore's public
  transparency log when it is staged, and stays there even for a version you
  later reject.
- **Who the record names.** Which npm user, and whether an email address, a
  version approved from staging names is shown by the first workflow release
  (step 11, and claim R8 of the spec on issue 6), and is
  written here then.
- **If a bad version goes live,** deprecate it with `npm deprecate` and
  publish a fixed one, or unpublish it where npm's unpublish policy allows.
  To stop releases altogether, delete `release.yml` and revoke the trusted
  publisher with `npm trust revoke`; the first publish's steps still work.
