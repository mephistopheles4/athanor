# 0039. An outside configuration is a second source of build files

Date: 2026-11-27 · Status: accepted · Source: the spec in `docs/spec/0001-outside-configuration.md` and the owner's decisions on ATH-11; amends 0006 and 0038 for an outside configuration, and extends 0010

athanor read its configuration only from the repo it tests, so it could not run
on a repo whose owner can't or won't add the file. The owner chose a permissive
way out: a configuration file anywhere on the machine, which may name build
files that sit beside it.

## Decision

- **Finding it.** `--config <path>`, else `ATHANOR_CONFIG`, on `run` and
  `serve`. It wins over the repo's own configuration, nothing of which is then
  read beyond which file it stands in for. athanor says so on every run, and the
  `--json` result carries the file's absolute path and where it came from.
- **The file.** Any readable regular file holding the repo configuration's keys,
  with the same checks and the same machine ceilings. It needs no git.
- **Paths, per key.** In an outside configuration, `dockerfile`, `context` and
  each `inputs` entry is a repo-relative string, as before, or
  `{ "config": "<path>" }`: a path under the **configuration folder**, the
  folder that holds the file as named. After links and junctions it must stay
  inside that folder, and it may not go through a `.git` entry, and the folder itself may not
  lie in one. The repo configuration does not take the object form.
- **Where they go.** A configuration-side context is the build context itself. A
  configuration-side Dockerfile with a repo context goes to
  `.athanor-dockerfile` at the context's root. A configuration-side input keeps
  its path relative to the configuration folder (as 0010 does for a repo's). A
  repo Dockerfile with a configuration-side context is refused. A path already
  taken in the tree is refused.
- **The files.** A configuration-side context takes every regular file under its
  folder but any `.git` entry, whether git tracks, ignores or knows nothing of
  it. A link or any other kind of entry is refused. athanor reads each file once,
  writes it to the run's object folder with no filter, and gives it mode
  `100644`.
- **The tag.** The formula of 0006 is unchanged: every file the build sees is in
  the hashed tree.

## What follows

- The build can receive files that no repo tracks. A secret in a
  configuration-side context goes to a step that has the network. This loosens
  the guard that kept configuration files, configured paths and build files in
  the repo (tests C17, J6), for an outside configuration only. The premise is
  ADR 0038's: the owner's machine is trusted, and the owner names the file.
- The build may still read the tested repo's tracked files, and a
  configuration-side Dockerfile runs on them.
- The archive step is unchanged. It runs no filter, and it still applies the
  tree's own `text`, `eol`, `ident` and `working-tree-encoding` attributes
  (0020), to configuration-side files too: a `.gitattributes` file in the tree
  can change what the build receives.
- The test container takes no new option or variable. A file the build copies
  into the image is in it, where the tested repo's code can read it.
- A variable left set applies to every repo athanor then runs in. The source
  line is how a user sees it.
