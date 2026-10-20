# 0010. An inputs file keeps its repo-relative path in the context

Date: 2026-10-19 · Status: accepted · Source: spec revision 5 on issue 1 (S4), as the build read it

S4 says each `inputs` file is added "at its repo-relative path, placed at the
root of the build context". The build reads this as: the file keeps its
repo-relative path, measured from the context's root. `package-lock.json`
lands at the context root as `package-lock.json`, and `config/a.json` lands at
`config/a.json` under the context root. A Dockerfile copies it by that path.
An input whose place is already taken by a file under `context` exits 125.
