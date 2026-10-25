# Releasing

The first version of `@mephistopheles4/athanor` is published by hand. Every
later one is staged by the release workflow and made live by the owner
(ADR 0019); see [Later releases, through the workflow](#later-releases-through-the-workflow).
The owner's last step for each later version not unpublished or deprecated in
step 17 is a GitHub release, made by hand as a draft and published once read,
from which Zenodo archives the repo (ADR 0029, ADR 0031).
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

`<tarball>` below is the file name `npm pack` prints,
`mephistopheles4-athanor-<version>.tgz`. Every folder in angle brackets is a
new, empty folder outside any checkout.

4. Bump `version` in `package.json` past the hand-published one in a pull
   request, merge it, and wait for CI on `main` to pass.
5. In Actions, choose `release`, then Run workflow on `main`. When `check`
   has passed, approve the deployment. With no trusted publisher yet,
   `publish` reaches its stage step and fails on authentication, and nothing
   is staged.
6. Try the guards:
   - Run `release` on another branch. `check` fails at its first step,
     "Refuse any ref but main", with "The release runs only from main".
   - Merge a pull request to `main`, and run `release` before that commit's
     CI run on `main` has finished. `check` fails at its second step, "Check
     that CI passed on this commit", with "CI has not passed on this commit".
7. In a clean checkout of the dry run's commit, make two packs, extract each,
   and compare them:

   ```powershell
   git status --porcelain
   npm ci
   New-Item -ItemType Directory <pack-1>, <pack-2>, <files-1>, <files-2>
   node scripts/build.mjs
   npm pack --pack-destination <pack-1>
   node scripts/build.mjs
   npm pack --pack-destination <pack-2>
   tar -xzf <pack-1>/<tarball> -C <files-1>
   tar -xzf <pack-2>/<tarball> -C <files-2>
   git -c core.autocrlf=false diff --no-index --exit-code <files-1> <files-2>
   ```

   `git status --porcelain` must print nothing. If the two packs differ,
   stop and record it on issue 6: a local pack that doesn't repeat can't be
   compared with a staged one.
8. Record on issue 6: that the run waited for your approval, the job
   summaries, where `publish` failed, the two guard runs of step 6 and the
   result of step 7.

### The first workflow release, within 2 days of adding the trusted publisher

A new trusted publisher expires if no publish uses it within 2 days, so add
it only when a version is ready to release. Run every `npm login`, and what
follows it, from a new, empty folder outside any checkout. npm takes a
project `.npmrc` from the nearest parent folder that holds a `package.json`
or a `node_modules`, so check the folder first, before each `npm login` and
before the npm-side install in step 15:

```powershell
npm prefix
npm config get registry
```

`npm prefix` must print the folder itself, and the registry must be
`https://registry.npmjs.org/`. Otherwise, choose another folder.

9. On the package's npm settings, add a trusted publisher: GitHub Actions,
   owner `mephistopheles4`, repository `athanor`, workflow `release.yml`,
   environment `npm`, with direct publish and dist-tag management left off.
   With the CLI instead, check the folder as above, log in as in step 5 of
   the first publish, check the flags against `npm help trust`, and log out
   straight after, as in its step 7:

   ```powershell
   npm trust github @mephistopheles4/athanor --repo mephistopheles4/athanor --file release.yml --env npm --allow-stage-publish
   npm trust list @mephistopheles4/athanor
   ```

   Record on issue 6 what `npm trust list @mephistopheles4/athanor` and the
   settings page show, the package's publishing access, the `npm`
   environment's settings, and that your npm account's two-factor mode is
   authorization and writes.
10. Run steps 12 to 17 for the version from the dry run. On this first
    workflow release there is no release tag yet: in step 13, diff against
    the hand-published commit instead, and in step 17 tag that commit too, as
    `v<hand-published version>`. If the trusted publisher expires, or the
    first stage fails:
    - follow "If a run fails" for any entry the run left;
    - revoke the trusted publisher on the settings page, or with
      `npm trust revoke`, logged in as in step 9;
    - add it again, and start again from step 12.
11. When step 17 is done:
    1. Run `release` once more, with no bump. `check` must fail at "Check
       that this version is new on npm", with "already on npm".
    2. In a new, empty folder outside any checkout, run
       `npm install @mephistopheles4/athanor@<version>`, then
       `npm audit signatures`, which must report a verified attestation.
    3. Record on issue 6:
       - the results of 1 and 2;
       - what `npm stage view <id> --json` showed in step 15;
       - that the trusted publisher shows as validated in `npm trust list`;
       - which npm user the version's record names, and whether it shows an
         email address.

### Before the next release, once

Zenodo makes a permanent record of whatever a tag holds when a release is
published on it, so every tag is fixed once pushed (ADR 0031). In the repo's
Settings, Rules, Rulesets, keep two tag rulesets, both active, both on every
tag (`~ALL`), with no exclusions:

- "Tags never move" restricts updates and deletions, with no bypass;
- "Only admins create tags" restricts creations, with only the repository
  admin role on its bypass list, so only you can push a tag.

They hold against anyone without admin rights. An admin can lift them, so in
Settings, General, Releases, also turn on immutable releases: a published
release's tag then stays on its commit while the release exists.

The commands on this page need gh 2.103.0 or later and PowerShell 7.3 or
later (`gh --version`, `$PSVersionTable.PSVersion`). Run these checks with
your own gh login, which is the repo's admin; without admin rights, fields
can come back empty:

```powershell
gh api repos/mephistopheles4/athanor/rulesets --jq '.[] | select(.target == "tag") | .id' | ForEach-Object { gh api "repos/mephistopheles4/athanor/rulesets/$_" --jq '{name, enforcement, include: .conditions.ref_name.include, exclude: .conditions.ref_name.exclude, rules: [.rules[].type], bypass: .bypass_actors}' }
gh api repos/mephistopheles4/athanor/immutable-releases --jq .enabled
```

The first prints exactly two rulesets, each with enforcement `active`,
include `["~ALL"]` and exclude `[]`:

- "Tags never move": rules `update` and `deletion`, and bypass `[]`;
- "Only admins create tags": rule `creation` alone, and bypass one entry,
  `RepositoryRole` with id 5 and mode `always`.

The second prints `true`. Anything else, a `null` field included, is a stop:
fix it in Settings and check again before any release. Step 17 runs both
checks again.

### Each release

Every log-out on this page ends with `npm whoami` failing, as in step 16.

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
    `npm --version` must match the `npm:` line of the check job's summary:
    11.19.1, the npm that Node 24.22.0 bundles, which the release jobs pin. If
    it doesn't, install that Node before you go on. No install, build or repo
    script runs after the login.

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
15. Leave the checkout for a new, empty folder outside any checkout, and check
    it as the first workflow release says. Log in there, as in step 5 of the
    first publish, and look. `<id>` is the stage id that the publish job's
    summary and `npm stage list` show.

    ```powershell
    Set-Location <outside>
    npm prefix
    npm config get registry
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
      shows.
    - The two entry lists must be the same, so the staged tarball holds
      exactly the entries the pack check passed in step 14. Every extracted
      file must be the same.
    - npm 11.19.1's `npm stage view` shows no manifest. Once the comparisons
      above pass, read the staged tarball's own `package.json`, then the
      checkout's, with the same command:

      ```powershell
      Get-Content -Raw <staged-files>/package/package.json | ConvertFrom-Json | Select-Object dependencies, optionalDependencies, peerDependencies, bundleDependencies, bundledDependencies, scripts, bin | ConvertTo-Json
      Get-Content -Raw <checkout>/package.json | ConvertFrom-Json | Select-Object dependencies, optionalDependencies, peerDependencies, bundleDependencies, bundledDependencies, scripts, bin | ConvertTo-Json
      ```

      The five dependency fields must all be `null`, and `scripts` and `bin`
      must be the same in both. If they aren't, stop before approving:
      reject the entry, log out, and record it on issue 6 for the owner's
      decision. The registry's own manifest, which a publish sends apart
      from the tarball, is first seen in step 17, after the version is live
      (accepted risk 22).
    - Only npm, `tar`, `git` and PowerShell run here: nothing from the repo
      or from the extracted folders.

    Run this only after the integrity, `tar` and `package.json` checks above
    have passed. It unpacks the staged tarball as npm would install it, with
    install scripts, git dependencies and URL dependencies all off, and it
    must match the local pack file for file. This covers a tarball that
    `tar` and npm would read differently.

    ```powershell
    New-Item -ItemType Directory <npm-files>
    Push-Location <npm-files>
    npm prefix
    npm config get registry
    npm install <staged>/<tarball> --ignore-scripts --allow-git=none --allow-remote=none --no-save
    Pop-Location
    git -c core.autocrlf=false -c core.filemode=false diff --no-index --exit-code <npm-files>/node_modules/@mephistopheles4/athanor <local-files>/package
    ```


    If anything differs, reject every staged entry with
    `npm stage reject <id>`, log out, and stop. Any other entry is an
    incident: revoke the trusted publisher. The one exception is an entry
    left by a run of yours that failed, as "If a run fails" says.
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
    local `package.json`. If it doesn't, unpublish the version while npm's
    unpublish policy allows it, else deprecate it at once; a deprecated
    version still installs. For either, log in again from a new, empty folder
    outside any checkout, checked as in step 15, run
    `npm unpublish @mephistopheles4/athanor@<version>` or, if npm refuses,
    `npm deprecate @mephistopheles4/athanor@<version> "<reason>"`, and log out
    as in step 16. An unpublished version number can't be published again, so
    the next release bumps it (step 12). A version you unpublished or
    deprecated gets no tag and no release.

    Then, back in the checkout, tag the commit by hand:

    ```powershell
    git tag v<version> <commit>
    git push origin v<version>
    ```

    Then publish the GitHub release, from which Zenodo archives the repo and
    mints a DOI. Skip this for a version you unpublished or deprecated above:
    a Zenodo record can't be deleted. "Tags never move" keeps a release tag on
    its commit against anyone without admin rights; an admin can lift it, and
    the immutable release then holds the tag while the release exists. The
    folder check on the Zenodo record below is a cross-check, and it stays a
    stop. First check, by eye:
    - `git ls-remote origin refs/tags/v<version>` prints `<commit>`, the
      commit you tagged above;
    - `npm view @mephistopheles4/athanor@<version> dist.integrity` prints
      the integrity the **check** job's summary shows.

    Then, with your own gh login, where `<last>` is the version whose tag,
    `v<last>`, you diffed against in step 13:

    ```powershell
    gh auth status
    ```

    It must show your account, with the token in the system keyring. Any
    other source is a stop:
    - **gh's config file:** run `gh auth logout`, and revoke the token where
      it was made: a browser login under your account's Settings,
      Applications, Authorized OAuth Apps, GitHub CLI; a pasted token under
      Developer settings, Personal access tokens. Then run `gh auth login`
      again, without `--insecure-storage`, and check `gh auth status` again.
    - **`GH_TOKEN` or `GITHUB_TOKEN`:** remove the variable wherever it is
      set, revoke that token as above, and check again.

    Check that no release, draft or published, is on the tag. This prints
    nothing when none is:

    ```powershell
    gh api repos/mephistopheles4/athanor/releases --paginate --jq '.[] | select(.tag_name == "v<version>") | {id, draft, author: .author.login}'
    ```

    If it prints anything, see "If a run fails". Otherwise make the release
    as a draft, which makes no Zenodo record:

    ```powershell
    gh release create v<version> -R mephistopheles4/athanor --draft --verify-tag --title v<version> --generate-notes --notes-start-tag v<last>
    ```

    If it refuses, change nothing and see "If a run fails". Run the release
    list again: it must print exactly one release, `draft` true, with your
    account as author. Note its `id`, and read it by that id:

    ```powershell
    gh api repos/mephistopheles4/athanor/releases/<id> --jq '{tag_name, draft, author: .author.login, body}'
    ```

    - `tag_name` must be `v<version>`, `draft` true, and `author` your
      account.
    - The notes must hold nothing you wouldn't put on a permanent public
      record. To change them, edit this draft with
      `gh api -X PATCH repos/mephistopheles4/athanor/releases/<id> -F body=@<notes-file>`,
      the notes file outside any checkout, and read it again. Notes you
      edited in your own draft are yours.
    - To drop the draft, delete it with
      `gh api -X DELETE repos/mephistopheles4/athanor/releases/<id>`. A
      deleted draft made no record, and can be made again.

    Just before publishing, repeat the `git ls-remote` check, which must
    still print `<commit>`; the release list, which must still print the one
    draft, with the same `id`; and the two checks of "Before the next release,
    once". Anything else is a stop. Then publish the draft by its id:

    ```powershell
    gh api -X PATCH repos/mephistopheles4/athanor/releases/<id> -F draft=false --jq '{tag_name, draft, author: .author.login}'
    ```

    It must print `v<version>`, `false` and your account. Within a few
    minutes, Zenodo's GitHub page, under your Zenodo account's settings,
    lists `v<version>` with a DOI. Check that its record names the author and
    ORCID iD from `CITATION.cff`; if they are wrong, edit the record's
    metadata on Zenodo. Check too that the archived source is `<commit>`: the
    record's file listing shows one top folder, which GitHub names after the
    first seven characters of the commit. If it is another commit, stop,
    don't cite the DOI, and record it in a private security advisory on the
    repo (`SECURITY.md`). If no record appears, repeat the `git ls-remote`
    check, then open the Zenodo webhook's recent deliveries in the repo's
    settings and use Redeliver on the release event whose action is
    `published`. If no record appears after that, stop: record it on issue
    63 for your decision, and make no other release. Never copy a delivery's
    address or payload into an issue or a session. Never publish a second
    release for the same version. If the publish itself fails, see "If a run
    fails".

### If a run fails

- **Don't re-run a failed `publish` job.** Start a new run of `release`
  instead, so each staged entry belongs to one run you can name.
- In a new, empty folder outside any checkout, checked as the first workflow
  release says, log in and run `npm stage list @mephistopheles4/athanor`.
- An entry counts as left by your failed run only if both hold:
  - it is the one staged entry, for that run's version;
  - its integrity, in `npm stage view <id>`, matches that run's check job
    summary.

  Reject it with `npm stage reject <id>`. Then log out and check that
  `npm whoami` fails, as in step 16, and start a new run from step 12.
- Any other staged entry is an incident: reject it, log out, and revoke the
  trusted publisher.
- **A release already on the tag, or a failed `gh release create` or
  publish in step 17.** Run step 17's release list, and act on what it
  prints:
  - **Nothing,** after a refused `gh release create` (a network error, say,
    or no tag found): fix what the error names, repeat the `git ls-remote`
    check, and go on from step 17's release list. This is not an incident.
  - **One draft, your own,** left by a run of yours that stopped: go on from
    step 17's read by id. A failed publish is rerun by that id.
  - **One published release, your own:** check its notes against the
    generated ones, which
    `gh api repos/mephistopheles4/athanor/releases/generate-notes -f tag_name=v<version> -f previous_tag_name=v<last> --jq .body`
    prints; notes you edited in your own draft are yours. If it all holds,
    don't make it again, and carry on with step 17's Zenodo checks.
  - **Anything else** is an incident: two releases on the tag, another
    author, or notes you didn't write or generate. Stop releasing. Open a
    private security advisory on the repo (`SECURITY.md`), and copy into it
    each release's id, author, tag and notes, as the list and the read by id
    show them. Only then delete a draft that isn't yours; a published release
    that isn't yours stays, as evidence. Don't cite any DOI. Find and remove
    that write access, and make no release until accepted risk 38 has been
    revisited (ADR 0031).

### Upkeep

- Check `npm trust list @mephistopheles4/athanor` from time to time.
- From time to time, review the authorized OAuth apps, authorized GitHub
  Apps, installed GitHub Apps and personal access tokens that have access to
  the repo, and revoke any that is no longer used. Each acts as your account
  (accepted risk 38).
- After any rename or transfer of the repo or the account, revoke the trusted
  publisher and add it again. Before deleting the repo, revoke it.
- A bot pull request that moves an action SHA in `release.yml`, and a change
  to its `node-version`, are security-sensitive work: the pull request names
  each release and its date, at least 7 days old. A change to `node-version`
  also updates the npm version step 14 names.

## What to know

- **The build is explicit.** The repo's `.npmrc` turns lifecycle scripts off
  (ADR 0018), so `npm pack` and `npm publish` do not run `prepack`. Run
  without step 3 of the first publish, `npm publish` ships a stale or missing
  `dist/`.
- **No npm token stays on the machine.** Never write a token into the repo's
  `.npmrc`, and never keep one on the machine between publishes. Log in just
  before the publish and out straight after.
- **The login sits in your npm configuration until you log out.** From
  `npm login` to `npm logout`, the session token is in your user npm
  configuration file. That file is not encrypted: it relies on your disk
  encryption, and any program running as you can read it. npm's two-factor
  check on every write is what keeps the token alone from approving
  (accepted risk 26 in the threat model).
- **A publish makes your npm account's name and email address public** in the
  registry's records. Publish from an account whose email address you are
  content to show.
- **The compiler runs as you in step 3 of the first publish, in step 7 of
  the dry run, and in step 14 of each release.** A hijacked compiler can
  shape the published code, and
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
- **Who the record names.** A version approved from staging names "GitHub
  Actions" as its npm user, with GitHub's no-reply address, not yours (claim
  R8 of the spec on issue 6, recorded at 0.1.1). The version's maintainer
  list still names your npm account and its email, as "A publish makes your
  npm account's name and email public" says.
- **A GitHub release makes a permanent, public Zenodo record,** naming the
  authors and ORCID iDs in `CITATION.cff`. Zenodo archives the
  repo at the release's tag and mints a DOI, and the record can't be
  deleted, so the release comes last in step 17, once the version is live
  and checked. The archive holds every file at the tag, so a secret ever
  committed and still there stays in a record no history rewrite can
  reach: rotate it, and remove it from the tree, before you release.
  Zenodo reads `CITATION.cff` from that tag. v0.1.0 and v0.1.1
  predate it and have no release; the first record comes with the next
  release. Their tags stay, because steps 13 and 17 diff from the last
  release tag.
- **If a bad version goes live,** deprecate it with `npm deprecate` and
  publish a fixed one, or unpublish it where npm's unpublish policy allows.
  To stop releases altogether, delete `release.yml` and revoke the trusted
  publisher with `npm trust revoke`; the first publish's steps still work.
