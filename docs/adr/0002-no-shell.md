# 0002. No command string, no shell

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4, C16)

Every child process (`docker`, `git`) starts from an argument array with
`shell: false`. No command string is built, and no `exec`-family call that
takes a string is used. The test command reaches the container as separate
arguments and runs through `exec "$@"`.

`scripts/check-source.mjs` fails the build when `shell: true`, `exec(`,
`execSync(` or `execFile` with a shell option appears in the source.
