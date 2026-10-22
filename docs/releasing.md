# Releasing

The owner's first publish of `@mephistopheles4/athanor`, by hand. Run these
commands in PowerShell 7, from a checkout of the commit being released.

1. Check that nothing stray can ship from `bin/`. The command prints nothing
   when the checkout is clean:

   ```powershell
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

## What to know

- **The build is explicit.** The repo's `.npmrc` turns lifecycle scripts off
  (ADR 0017), so `npm pack` and `npm publish` do not run `prepack`. Run
  without step 3, `npm publish` ships a stale or missing `dist/`.
- **No token stays on the machine.** Never write a token into the repo's
  `.npmrc`, and never keep one on the machine between publishes. Log in just
  before the publish and out straight after.
- **A publish makes your npm account's name and email address public** in the
  registry's records. Publish from an account whose email address you are
  content to show.
- **The compiler runs as you in step 3.** A hijacked compiler can shape the
  published code, and neither the install-scripts setting nor CI's comparison
  with a rebuild sees it (accepted risk 17 in the threat model).
