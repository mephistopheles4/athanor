# Releasing

The first version of `@mephistopheles4/athanor` is published by hand. Every
later one is staged by the release workflow, which the owner's push of a
version tag starts, and made live by the owner (ADR 0019, ADR 0035); see
[Later releases, through the workflow](#later-releases-through-the-workflow).
The owner's last step for each later stable version not unpublished or
deprecated in step 17 is a GitHub release, made by hand as a draft and
published once read, from which Zenodo archives the repo (ADR 0029, ADR 0031).
A release candidate gets none.
Only the owner does any step on this page.

## Versions and dist-tags

A release version is `X.Y.Z` or `X.Y.Z-rc.N`, where X, Y, Z and N are whole
numbers without leading zeros and N is at least 1. Any other form
(`-beta.1`, `-rc.0`, `-rc.01`, `1.02.3`, `+build`, a leading `v`) is refused.

- `X.Y.Z` is a stable version. It is staged for the dist-tag `latest`, which
  a plain `npm install` of the package reads.
- `X.Y.Z-rc.N` is a release candidate. It is staged for the dist-tag `next`,
  and `latest` never moves to it.

The tag is `v` plus the version: `v0.3.0` or `v0.3.0-rc.1`. The workflow
takes the dist-tag from the version inside the tarball it stages, not from
the tag name, and stops if the two differ (ADR 0035). npm fixes the dist-tag
when a version is staged: `npm stage approve` takes no tag. Your check in step
15, that the one staged entry is for this version and matches your local pack
file for file, is what ties the dist-tag to the version npm stages.

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

`.github/workflows/release.yml` starts when you push a tag named `v` plus the
version, and only then. It builds, tests and packs the tagged commit, which
must be `main`'s head or behind it, then, after your approval of the `npm`
environment, stages that tarball on npm through the trusted publisher, with
provenance and the dist-tag the version's form gives. The trusted publisher
can only stage. A staged version goes live only when you approve it on npm
with two-factor authentication, after comparing it with a local pack of the
same commit. The first approval proves the commit the tag names is the one you
merged; the second proves the staged files are the ones that commit builds to.

A tag run uses the `release.yml` at the tagged commit, so the guards in its
`check` job (the owner as actor, the commit on `main`, CI green, the tag
matching `package.json`) guard against mistakes. The controls that hold
sit outside the file: the "Only admins create tags" ruleset, the `npm`
environment's tag policy with you as its reviewer, npm's binding to
`release.yml` and `npm`, your look in step 13, and stage-only publishing with
your two-factor approval (ADR 0035). That is why step 12 checks, before the
tag is pushed, that its commit is on `main`, and step 13 checks it again
before the approval.

### Before the merge of the workflow, once

1. Make the first publish by hand, as above.
2. On npmjs.com, set the package's publishing access to "Require two-factor
   authentication and disallow tokens".
3. Make the `npm` environment before the workflow first runs. GitHub creates
   an environment a job names, with no protection, when it doesn't exist. In
   the repo's Settings, Environments, set:
   - required reviewers: you;
   - deployment branches and tags: selected branches and tags, one tag
     pattern `v*` (type **tag**) and no branch pattern (this was `main` only
     until ADR 0035; see "The `npm` environment, after the tag workflow
     merges, once");
   - "Allow administrators to bypass configured protection rules": off;
   - "Prevent self-review": off, since you are the only reviewer and also
     push the tag that starts the run;
   - no environment secrets or variables.

### After the merge, once: the dry run

`<tarball>` below is the file name `npm pack` prints,
`mephistopheles4-athanor-<version>.tgz`. Every folder in angle brackets is a
new, empty folder outside any checkout.

4. Bump `version` in `package.json` past the hand-published one in a pull
   request, merge it, and wait for CI on `main` to pass.
5. Push the tag `v<version>` for step 4's commit, after the pre-tag check of
   step 12. In Actions, the `release` run starts. When `check` has passed,
   approve the deployment. With no trusted publisher yet, `publish` reaches
   its stage step and fails on authentication, and nothing is staged. The
   tag stays; the run is re-run on it in step 10.
6. Try the guards with the checks and tests, not with a real tag, because
   every tag you push is permanent (ADR 0031):
   - Run `node scripts/check-workflows.mjs` in a checkout of the dry run's
     commit: it prints "every rule kept". The fast tier's `F1`, `F2` and `F5` to
     `F8` tests (`test/fast/release.test.ts`) show each rule failing on a bad case: the
     version and tag forms, the dist-tag rule, the trigger, the checkout and
     the staging commands.
   - Read `check`'s first four steps in `release.yml`: the ref must be a
     `v*` tag, the actor the owner, the commit `main`'s head or behind it (the
     compare API's `identical` or `behind`), and a green `ci` run on `main`
     for the commit.
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
10. Run steps 12 to 17 for the version from the dry run, whose tag step 5
    already pushed: in step 12, check the commit but push no tag, and instead
    re-run the dry run's `release` on its tag (Re-run all jobs; the dry run
    staged nothing, because `publish` failed on authentication, so "If a run
    fails" does not forbid it). In step 13,
    diff against the hand-published version's tag, `v<hand-published
    version>`. If the trusted publisher expires, or the first stage fails:
    - follow "If a run fails" for any entry the run left;
    - revoke the trusted publisher on the settings page, or with
      `npm trust revoke`, logged in as in step 9;
    - add it again, bump the version, and start again from step 12 with a new
      tag.
11. When step 17 is done:
    1. Re-run `release` on the same tag (Re-run all jobs). `check` must fail
       at "Check that this version is new on npm", with "already on npm".
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

The commands on this page need gh 2.103.0 or later and PowerShell 7.4 or
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
fix it in Settings and check again before any release. Step 12 runs both
checks and the environment check below before the tag is pushed, and step 17
runs the two above again.

### The `npm` environment, after the tag workflow merges, once

A tag starts the release, so the `npm` environment must admit tags, and no
branch. After the pull request that changes `release.yml` to start on a tag
merges, and before the first tag is pushed, change the environment in the
repo's Settings, Environments, `npm`, Deployment branches and tags: remove the
`main` branch pattern and add one pattern, `v*`, of type **tag**. A branch
pattern named `v*` would let a branch deploy, so check the type. Leave the
other settings as step 3 has them.

Check it with your own gh login, now and before each release (step 12):

```powershell
gh api repos/mephistopheles4/athanor/environments/npm --jq '{name, can_admins_bypass, deployment_branch_policy, rules: [.protection_rules[] | {type, prevent_self_review, reviewers: [.reviewers[]?.reviewer.login]}]}'
gh api repos/mephistopheles4/athanor/environments/npm/deployment-branch-policies --jq '{total_count, policies: [.branch_policies[] | {name, type}]}'
```

The first prints:

- `name` `npm`, and `can_admins_bypass` `false`;
- `deployment_branch_policy` with `custom_branch_policies` `true` and
  `protected_branches` `false`;
- two `rules`: one of type `branch_policy` (its `reviewers` are empty and its
  `prevent_self_review` is `null`), and one of type `required_reviewers` with
  `prevent_self_review` `false` and `reviewers` exactly `["mephistopheles4"]`.

The second prints exactly `{"policies":[{"name":"v*","type":"tag"}],"total_count":1}`:
one policy, named `v*`, of type `tag`. Anything else is a stop: a `branch`
type, a second policy, a `main` policy left in, administrators allowed to
bypass, a reviewer other than you, or "Prevent self-review" on (you are the
only reviewer and push the tag, so every release would become unapprovable).
Fix it in Settings and check again.

Once this is set, every `v*` tag you push is a deployable ref, the old tags
`v0.1.0` and `v0.1.1` among them. Each stays safe through its own file's
guards (v0.1.0 has no `release.yml`, and v0.1.1's starts only by hand and
refuses any ref but `main`), the "already on npm" check, your approval and
stage-only publishing (ADR 0035).

### Each release

Every log-out on this page ends with `npm whoami` failing, as in step 16.

12. Choose the version: `X.Y.Z` for a stable one, `X.Y.Z-rc.N` for a release
    candidate. If it is already on npm, was unpublished, or had a tag that was
    rejected or failed, bump it: a tag is never moved, so that number is used
    up. Bump `version` in `package.json` in a pull request, merge it, and wait
    for CI on `main`. Run the checks of "Before the next release, once" and of
    "The `npm` environment" above. Then, **before tagging**, check that the
    commit is `main`'s head or behind it. `<commit>` is the full hash of the
    merge commit:

    ```powershell
    git fetch origin
    git merge-base --is-ancestor <commit> origin/main
    $LASTEXITCODE
    ```

    `merge-base` prints nothing; `$LASTEXITCODE` must print `0`. Anything else
    is a stop: the commit is not on `main`. Then tag it and push the tag, which
    starts `release` (the workflow checks that the tag is `v` plus the version
    in `package.json`):

    ```powershell
    git tag v<version> <commit>
    git push origin v<version>
    ```

    A pushed tag is permanent (ADR 0031): if a run is rejected, fails for good
    or the version is unpublished, the tag stays and the next release bumps the
    version.
13. When `check` has passed, check that you started this run, that the commit
    named on the approval is the one you merged, and read the diff since the
    last version that went live, an rc included:

    ```powershell
    git diff v<last> <commit>
    ```

    `v<last>` is the newest tag whose version went live. The identity token is
    minted when you approve, so repeat the ancestor check from step 12 first,
    with its visible result (`$LASTEXITCODE` prints `0`), in the same checkout
    after `git fetch origin`. Then approve the deployment, within 3 days of
    the check job, while its artifact lasts. If it has expired, reject the
    deployment and re-run the run on its tag, or bump the version and tag anew.
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
    - Check the dist-tag. The publish job's summary has a `dist-tag:` line,
      and it must be `latest` for `X.Y.Z` and `next` for `X.Y.Z-rc.N`. If
      `npm stage view <id> --json` shows the entry's dist-tag, it must equal
      the summary's. A difference is a stop: `npm stage reject <id>` (see
      "Stop conditions and rollback"). If the view shows none, compare the
      summary's line with the version and record on issue 88 that the view
      showed none; the first rc's approval waits for that answer.
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

      The five dependency fields must all be `null`. If any isn't, stop
      before approving: reject the entry, log out, and record it on issue 6
      for the owner's decision. `scripts` and `bin` print the same in both,
      because the file comparison above already passed: read them as what
      ships, not as a check of their own. A change to them in the repo shows
      in step 13's diff. The registry's own manifest, which a publish sends apart
      from the tarball, is first seen in step 17, after the version is live
      (accepted class "The release and CI supply chain").
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
    shows no `dependencies`, `optionalDependencies`, `peerDependencies` or
    `bundleDependencies` or `bundledDependencies` (`devDependencies` are not installed for users and
    may show), and the same `scripts` and `bin` as the
    local `package.json`. If it doesn't, unpublish the version while npm's
    unpublish policy allows it, else deprecate it at once; a deprecated
    version still installs. For either, log in again from a new, empty folder
    outside any checkout, checked as in step 15, run
    `npm unpublish @mephistopheles4/athanor@<version>` or, if npm refuses,
    `npm deprecate @mephistopheles4/athanor@<version> "<reason>"`, and log out
    as in step 16. An unpublished version number can't be published again, so
    the next release bumps it (step 12). A version you unpublished or
    deprecated keeps its tag (step 12 pushed it) and gets no release.

    Then check the dist-tags, logged out: `npm view` is a public read and
    needs no login, so no new session token goes on disk. Run it from a new,
    empty folder outside any checkout, checked as in step 15, so that no
    project `.npmrc` picks the registry:

    ```powershell
    npm view @mephistopheles4/athanor dist-tags --json
    ```

    `latest` must be the newest stable version, and for an rc `next` must be
    that rc. If an rc is on `latest`, see "Stop conditions and rollback".

    Then publish the GitHub release for a stable version, from which Zenodo
    archives the repo and mints a DOI. An rc gets no release: the tag and the
    npm page are its record. Skip this too for a version you unpublished or
    deprecated above: a Zenodo record can't be deleted. "Tags never move" keeps a release tag on
    its commit against anyone without admin rights; an admin can lift it, and
    the immutable release then holds the tag while the release exists. The
    folder check on the Zenodo record below is a cross-check, and it stays a
    stop. First check, by eye:
    - `git ls-remote origin refs/tags/v<version>` prints `<commit>`, the
      commit you tagged in step 12;
    - `npm view @mephistopheles4/athanor@<version> dist.integrity` prints
      the integrity the **check** job's summary shows.

    Then, with your own gh login, where `<last>` is the newest **stable**
    version that went live (not an rc), whose tag is `v<last>`; step 13's
    diff may have used a newer rc's tag:

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
    gh api repos/mephistopheles4/athanor/releases/<id> --jq '{tag_name, name, draft, author: .author.login, assets: [.assets[].name], body}'
    ```

    - `tag_name` and `name` must be `v<version>`, `draft` true, `author`
      your account, and `assets` `[]`.
    - The notes must hold nothing you wouldn't put on a permanent public
      record. To change them, edit this draft with
      `gh api -X PATCH repos/mephistopheles4/athanor/releases/<id> -F body=@<notes-file>`,
      the notes file outside any checkout, and read it again. Notes you
      edited in your own draft are yours.
    - To drop the draft, delete it with
      `gh api -X DELETE repos/mephistopheles4/athanor/releases/<id>`. A
      deleted draft made no record, and can be made again.

    Once the notes are right, save them to a file outside any checkout, and
    read that file: it is what the publish puts on record.

    ```powershell
    gh api repos/mephistopheles4/athanor/releases/<id> --jq .body > <read-notes>
    ```

    Just before publishing, repeat the `git ls-remote` check, which must
    still print `<commit>`; the release list, which must still print the one
    draft, with the same `id`; the read by id, whose `name` must still be
    `v<version>` and `assets` still `[]`; and the two checks of "Before the
    next release, once". Anything else is a stop. As the last thing before
    the publish, and again before every rerun of it, note the time from
    GitHub's own clock, which also stamps `published_at`; the line it prints
    is in UTC, to the second:

    ```powershell
    gh api -i rate_limit | Select-String '^Date:'
    ```

    Then publish the draft by its id, with
    the tag and the notes you read set in the same call, so that an edit made
    after your read can't reach the record:

    ```powershell
    gh api -X PATCH repos/mephistopheles4/athanor/releases/<id> -f tag_name=v<version> -f name=v<version> -F body=@<read-notes> -F draft=false --jq '{tag_name, name, draft, author: .author.login, assets: [.assets[].name], published_at}'
    ```

    `published_at` is the check: it must be later than the GitHub time you
    noted just before the call. An earlier time means someone else published
    the draft first. The author must still be your account, but it is likely
    set when the draft is made, so it may not show who published. The tag,
    the name and `false` echo the call's own inputs, so they only confirm
    that the call landed. `assets` must be `[]`: an asset is one nobody
    should have added. Each of these is an incident under "If a run fails". Within a few
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

- **A run is re-run on its own tag, never on a new one.** A run that failed in
  `check` staged nothing: re-run it (Re-run all jobs, on the failed run's
  page) after fixing what the failed step names, as long as the tagged commit
  is still `main`'s head or behind it. Two tags pushed close together can
  replace the older waiting run (the `release` concurrency group): re-run the
  older one on its tag. The actor check passes only for you, so a Re-run all
  jobs from another account fails at its second step. A Re-run failed jobs on a
  failed `publish` re-runs `publish` alone and skips `check`, so it skips the
  actor check too; the `npm` environment's approval, which only you can give,
  is what stops it.
- **Don't re-run a run once `publish` has reached its stage step.** If its
  summary shows a stage id, or `npm stage list` shows an entry, re-running
  could stage a second entry for the version. Check for the entry as below,
  reject it, then bump the version and tag anew (step 12). If `publish`
  stopped before its stage step, at the dist-tag step, nothing was staged:
  find out why before you re-run, because that step stops only when the
  tarball's version, file name or tag disagree, and that is not a flake. If
  you can't explain it, record it on issue 88 and stop.
- In a new, empty folder outside any checkout, checked as the first workflow
  release says, log in and run `npm stage list @mephistopheles4/athanor`.
- An entry counts as left by your failed run only if both hold:
  - it is the one staged entry, for that run's version;
  - its integrity, in `npm stage view <id>`, matches that run's check job
    summary.

  Reject it with `npm stage reject <id>`. Then log out and check that
  `npm whoami` fails, as in step 16. The version's tag stays, so bump the
  version and tag anew from step 12.
- Any other staged entry is an incident: reject it, log out, and revoke the
  trusted publisher.
- **A release already on the tag, or a failed `gh release create` or
  publish in step 17.** Run step 17's release list, and act on what it
  prints:
  - **Nothing,** after a refused `gh release create` (a network error, say,
    or no tag found): fix what the error names, repeat the `git ls-remote`
    check, and go on from step 17's release list. This is not an incident.
  - **One draft, your own,** left by a run of yours that stopped: go on from
    step 17's read by id. A failed publish is rerun by that id, after
    noting GitHub's time again.
  - **One published release, your own:** read it by its id with the
    publish call's fields:

    ```powershell
    gh api repos/mephistopheles4/athanor/releases/<id> --jq '{tag_name, name, draft, author: .author.login, assets: [.assets[].name], published_at, body}'
    ```

    Apply step 17's rules to what it prints: `tag_name` and `name`
    `v<version>`, `draft` false, `author` your account, `assets` `[]`, and
    `published_at` later than the GitHub time you noted before your last
    publish. Its notes must match your saved read-notes file. Every publish
    in step 17 sends that file, so a published release with no saved file,
    or no noted time, is an incident. If it all holds, don't make it again,
    and carry on with step 17's Zenodo checks.
  - **Anything else** is an incident: two releases on the tag, another
    author, an asset, a `published_at` earlier than the GitHub time you
    noted just before the publish, or notes you
    didn't write or generate. Stop releasing. Open a
    private security advisory on the repo (`SECURITY.md`), and copy into it
    each release's id, author, tag and notes, as the list and the read by id
    show them. Only then delete a draft that isn't yours; a published release
    that isn't yours stays, as evidence. If any of those notes hold a
    secret, rotate it. Don't cite any DOI. Find and remove
    that write access, and make no release until accepted class "The release and CI supply chain" has been
    revisited (ADR 0031).

### Stop conditions and rollback

- **Stop and reject the staged entry** (`npm stage reject <id>`, then log out)
  if its dist-tag, or the publish summary's, is not the one the version's form
  gives: `latest` for `X.Y.Z`, `next` for `X.Y.Z-rc.N`.
- **If an rc went live on `latest`:** log in as in step 15, move `latest` back
  to the newest stable version, deprecate the rc, and log out as in step 16:

  ```powershell
  npm dist-tag add @mephistopheles4/athanor@<newest stable> latest
  npm deprecate @mephistopheles4/athanor@<rc version> "<reason>"
  npm logout
  npm whoami
  ```

  `npm whoami` must fail. Then check `npm view @mephistopheles4/athanor dist-tags --json`.
  The session token is on disk from the login to the logout, as in step 15.
- **To back the tag path out:** first set the `npm` environment back to the
  `main` branch (delete the `v*` tag policy, add `main` as a branch policy),
  which closes the tag path at once. Then revert the pull request that moved
  `release.yml` to a tag start, which restores the by-hand start. The tags
  stay.

### Testing an unreleased build locally

On the owner's machine, `athanor` resolves to a global `npm link` of a
checkout, which shadows the mise pin until it is unlinked. To test an
unreleased build, point that link's checkout at the ref you want:

```powershell
git checkout <ref>
npm ci --ignore-scripts
node scripts/build.mjs
```

Run these in the linked checkout. If the link was ever removed, `npm link`
makes the checkout the machine's `athanor` again. To go back to the release
the mise pin names:

```powershell
npm unlink -g @mephistopheles4/athanor
```

To see which one answers, run `npm ls -g @mephistopheles4/athanor` (a link
shows `->` and the checkout's path) or `Get-Command athanor`.
`athanor --version` alone can't tell, because a checkout and a release can
print the same number. Cautions:

- The link is `athanor` for every repo and every agent session on the
  machine. Use a checkout no session works in, and switch only when no athanor
  run is in flight.
- `<ref>` is `main`, an rc tag or your own branch. Never an unmerged pull
  request: the build runs that ref's scripts and compiler as you.
- Never build while logged in to npm (the session token is on disk until you
  log out).
- A repo opts in to a release candidate by pinning the exact rc in mise (see
  the README). The link overrides the pin on this machine; a repo's other
  clones and CI still use the pin.

### Upkeep

- Check `npm trust list @mephistopheles4/athanor` from time to time.
- From time to time, review the authorized OAuth apps, authorized GitHub
  Apps, installed GitHub Apps and personal access tokens that have access to
  the repo, and revoke any that is no longer used. Each acts as your account
  (accepted class "The release and CI supply chain").
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
  (accepted class "The release and CI supply chain" in the threat model).
- **A publish makes your npm account's name and email address public** in the
  registry's records. Publish from an account whose email address you are
  content to show.
- **The compiler runs as you in step 3 of the first publish, in step 7 of
  the dry run, and in step 14 of each release.** A hijacked compiler can
  shape the published code, and
  neither the install-scripts setting nor CI's comparison with a rebuild sees
  it (accepted class "The release and CI supply chain" in the threat model).
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
  release. Their tags stay, because steps 13 and 17 diff from the last tag
  that went live. A release candidate gets no GitHub release, so it makes no
  Zenodo record.
- **A tag run uses the workflow at the tagged commit.** A tag on a commit off
  `main`, with an edited `release.yml`, would run the edited file, so the
  file's guards cannot be what stops it. The admin-only tag ruleset, the `npm`
  environment's tag policy, npm's binding to `release.yml` and `npm`, your
  look in step 13 and stage-only publishing with your two-factor approval do
  (ADR 0035). Against whoever holds your GitHub account or your gh login, who
  can also create tags and change the rulesets and the environment, only
  stage-only publishing and your npm two-factor approval hold. Check the
  environment and the rulesets before each release.
- **If a bad version goes live,** deprecate it with `npm deprecate` and
  publish a fixed one, or unpublish it where npm's unpublish policy allows.
  To stop releases altogether, delete `release.yml` and revoke the trusted
  publisher with `npm trust revoke`; the first publish's steps still work.
