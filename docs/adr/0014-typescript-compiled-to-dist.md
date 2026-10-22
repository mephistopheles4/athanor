# 0014. TypeScript source, compiled to dist

Date: 2026-10-20 · Status: superseded by 0018 · Source: spec revision 4 on issue 8 (S4), ticket issue 9

The source moves to TypeScript, using all of its syntax, one module at a
time. `tsc` in strict mode compiles `src/` to a flat `dist/` (`rootDir` is
`src`) with declaration files. `src/` holds only `.ts` files, and `allowJs` is
off.

Both test tiers run the compiled output. `scripts/build.mjs` clears `dist/`
and runs the compiler. The test runner calls it before every tier, and
prepack calls it before every pack, so no test or package uses a stale build.
The compiler is started as Node itself from `node_modules`, with
`shell: false` (ADR 0002). Each run clears `dist/`, so one worktree runs one
test run at a time.

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

ADR 0001 to 0013 are unchanged.
