# 0017. TypeScript compiled to dist, with install scripts off

Date: 2026-10-22 · Status: accepted · Supersedes: 0014 · Source: spec revision 3 on issue 34 (S3 to S5)

The source is TypeScript, using all of its syntax, one module at a time. `tsc`
in strict mode compiles `src/` to a flat `dist/` (`rootDir` is `src`) with
declaration files. `src/` holds only `.ts` files, and `allowJs` is off.

Both test tiers run the compiled output. `scripts/build.mjs` clears `dist/`
and runs the compiler. The test runner calls it before every tier, and every
pack runs it first, as an explicit step, because the repo's `.npmrc` turns
lifecycle scripts off (`prepack` included) for every npm command in the repo,
so no test or package uses a stale build. The compiler is started as Node
itself from `node_modules`, with `shell: false` (ADR 0002). Each run clears
`dist/`, so one worktree runs one test run at a time.

The tests and the fake Docker are `.ts` files with erasable syntax only, which
Node runs directly with no compile step. They still import the core from
`dist/`, as `#dist/...` (the `imports` key of `package.json`). A separate
`test/tsconfig.json` maps the same names to `src/` and runs `tsc --noEmit` in
CI, so the tests see the options marked `@internal` that the shipped
declarations leave out. The helpers start the fake Docker with
`--disable-warning=ExperimentalWarning`, so the warning Node prints when it
strips types from a `.ts` file does not reach the output that tests check.

`typescript` and `@types/node` are exact-pinned devDependencies with a
committed lockfile, installed by `npm ci`. `package.json` still has no
`dependencies` (ADR 0001). The package ships `bin/` and `dist/`, with the
compiled JavaScript and its declarations, and no source or test file. The
declarations are an addition outside the stable public interface for now.

**Install scripts are off in the repo.** A `.npmrc` at the repo root holds
`ignore-scripts=true`, so a plain `npm ci` or `npm install` on a developer's
machine runs no package's install scripts, as CI's `npm ci --ignore-scripts`
already did. CI keeps the flag as a second layer, and checks before `npm ci`
that npm reads the file, that the registry is `https://registry.npmjs.org/`,
that `.npmrc` holds nothing but comments and `ignore-scripts=true`, and that
every `resolved` URL in the lockfile is on that registry. The file is public:
it never holds a credential.

**What this changes, checked with npm 11.19.1:**

- With `ignore-scripts=true`, `npm pack` and `npm publish` skip `prepack`, so
  they pack whatever `dist/` is on disk, stale or missing. Every pack builds
  first: CI's pack step clears `dist/`, runs `node scripts/build.mjs`, packs,
  and compares the packed `dist/` with a rebuild; the hand publish in
  `docs/releasing.md` runs the build before `npm pack` and `npm publish`.
- `npm test` and `npm run <name>` still run the named script, but their `pre`
  and `post` hooks don't run. The repo has no such hooks.
- `prepack` stays in `package.json`. It runs when a pack is made without the
  repo's `.npmrc` or with `--ignore-scripts=false`.
- An `npm_config_ignore_scripts` environment variable, or a command-line flag,
  overrides the project file.
- Installing athanor from GitHub ships no `dist/`, with or without the
  `.npmrc`, because npm runs `prepare` and not `prepack` for a git install.
  This change doesn't alter that.

**Signatures.** CI runs `npm audit signatures` right after `npm ci`. It checks
that the registry's signature over each installed package's own metadata (its
name, version and integrity) verifies, using the keys of the public registry.
It does not compare the installed files with anything; `npm ci` enforces the
lockfile's integrity hashes.

**The compiler is the one dev package that runs.** It runs as the owner in
every test tier, in CI and in the build before a publish. A rebuild uses the
same compiler, so the comparison of the packed `dist/` with a fresh build
cannot see a hijacked compiler (accepted risk 17 in the threat model).

ADR 0001 to 0013 are unchanged.
