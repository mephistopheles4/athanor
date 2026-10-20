# 0014. TypeScript source, compiled to dist

Date: 2026-10-20 · Status: accepted · Source: spec revision 4 on issue 8 (S4), ticket issue 9

The source moves to TypeScript, using all of its syntax, one module at a
time. `tsc` in strict mode compiles `src/` to a flat `dist/` (`rootDir` is
`src`) with declaration files. Until the last module is converted, `allowJs`
lets `.mjs` and `.ts` modules sit side by side; the last ticket turns it off.

Both test tiers run the compiled output. `scripts/build.mjs` clears `dist/`
and runs the compiler. The test runner calls it before every tier, and
prepack calls it before every pack, so no test or package uses a stale build.
The compiler is started as Node itself from `node_modules`, with
`shell: false` (ADR 0002). Each run clears `dist/`, so one worktree runs one
test run at a time.

`typescript` and `@types/node` are exact-pinned devDependencies with a
committed lockfile, installed by `npm ci`. `package.json` still has no
`dependencies` (ADR 0001). The package ships `bin/` and `dist/`, with the
compiled JavaScript and its declarations, and no source or test file. The
declarations are an addition outside the stable public interface for now.

ADR 0001 to 0013 are unchanged.
