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
6. Record on issue 6 that the run waited for your approval, the job
   summaries, and where `publish` failed. Also record that a run on another
   branch fails at its first step, and that a run on a commit where CI has
   not passed fails at its second.

### The first workflow release, within 2 days of adding the publisher

A new trusted publisher expires if no publish uses it within 2 days, so add
it only when a version is ready to release.

7. On the package's npm settings, add a trusted publisher: GitHub Actions,
   owner `mephistopheles4`, repository `athanor`, workflow `release.yml`,
   environment `npm`, with direct publish and dist-tag management left off.
   With the CLI, check the flags against `npm help trust` first:

   ```powershell
   npm trust github @mephistopheles4/athanor --repo mephistopheles4/athanor --file release.yml --env npm --allow-stage-publish
   ```

   Record on issue 6 what `npm trust list @mephistopheles4/athanor` and the
   settings page show, and the `npm` environment's settings.
8. Run steps 9 to 14 for the version from the dry run. If the setting
   expires, or the first stage fails, revoke it with `npm trust revoke`, add
   it again, and start again from step 9.

### Each release

9. If the version is already on npm, bump it in a pull request, merge it, and
   wait for CI on `main`. Then start `release` on `main`.
10. When `check` has passed, check that you started this run, on the commit
    you merged, and read the diff since the last release tag:

    ```powershell
    git diff v<last> <commit>
    ```

    Then approve the deployment, within 3 days of the check job, while its
    artifact lasts. If it has expired, reject the deployment and start again.
11. Before logging in, in a clean checkout at that commit, build and pack.
    Use the npm version the check job's summary shows; under another npm
    version, a difference in `package.json` alone means look closely, not
    reject. No install or build runs after the login.

    ```powershell
    git status --porcelain
    npm ci
    node scripts/build.mjs
    New-Item -ItemType Directory <local>
    npm pack --pack-destination <local>
    ```

    `git status --porcelain` must print nothing. `<local>` is a new, empty
    folder outside any checkout.
12. Log in, as in step 5 of the first publish, and look:

    ```powershell
    npm login
    npm stage list @mephistopheles4/athanor
    npm stage view <id>
    New-Item -ItemType Directory <staged>
    Set-Location <staged>
    npm stage download <id>
    ```

    - The list must show exactly one staged entry, for this version.
    - `npm stage view` must show the integrity the **check** job's summary
      shows.
    - Extract each tarball into its own new, empty folder outside any
      checkout, with no other tar options, and run nothing from them. Then
      compare every file:

      ```powershell
      tar -xzf <staged tarball> -C <staged-files>
      tar -xzf <local tarball> -C <local-files>
      git diff --no-index --exit-code <staged-files>/package <local-files>/package
      ```

    If anything differs, or any other entry is staged, reject every staged
    entry with `npm stage reject <id>`, log out, and stop. An extra entry is
    an incident: revoke the trusted publisher.
13. Approve with two-factor authentication, then log out straight after:

    ```powershell
    npm stage approve <id>
    npm logout
    npm whoami
    ```

    `npm whoami` must fail.
14. Check that the version's npm page shows provenance naming this repo, the
    commit and the run, and note which npm user the version's record names.
    Then tag the commit by hand:

    ```powershell
    git tag v<version> <commit>
    git push origin v<version>
    ```

### Upkeep

- Check `npm trust list @mephistopheles4/athanor` from time to time.
- After any rename or transfer of the repo or the account, revoke the binding
  and make it again. Before deleting the repo, revoke it.
- A bot pull request that moves an action SHA in `release.yml`, and a change
  to its `node-version`, are security-sensitive work: the pull request names
  each release and its date, at least 7 days old.

## What to know

- **The build is explicit.** The repo's `.npmrc` turns lifecycle scripts off
  (ADR 0018), so `npm pack` and `npm publish` do not run `prepack`. Run
  without step 3, `npm publish` ships a stale or missing `dist/`.
- **No token stays on the machine.** Never write a token into the repo's
  `.npmrc`, and never keep one on the machine between publishes. Log in just
  before the publish and out straight after.
- **A publish makes your npm account's name and email address public** in the
  registry's records. Publish from an account whose email address you are
  content to show.
- **The compiler runs as you in step 3.** A hijacked compiler can shape the
  published code, and neither the install-scripts setting nor CI's comparison
  with a rebuild sees it (accepted risk 18 in the threat model).
- **A new trusted publisher lasts 2 days unused.** npm expires one that no
  publish has validated within 2 days, and the first publish binds it to the
  repository's fixed ids. After a rename or transfer, make it again.
- **Provenance shows where a version was built, not that its code is safe.**
  It names the repo, the commit, the workflow and the run.
- **Staging writes a permanent public record.** The provenance of a staged
  tarball, its digest, commit and run, goes into Sigstore's public
  transparency log when it is staged, and stays there even for a version you
  later reject.
- **Who the record names.** Which npm user a version approved from staging
  names is shown by the first workflow release (R8), and is written here then.
