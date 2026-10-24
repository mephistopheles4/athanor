# 0020. The archive step carries the tree as committed

Date: 2026-10-24 · Status: accepted · Source: spec revision 4 on issue 20 (S2, S6, G1 to G7); amended 2026-10-24 (H2, G8)

Both tar streams, the snapshot's and the build context's, come from
`git archive` in athanor's own git folder (ADR 0006). That folder used to take
everything but its two export attributes from the host: the global and system
git config, the global attributes file, the template the folder was made from,
and every inherited `GIT_*` variable. So a content filter the repo's
attributes name, defined by the host, ran on the host while the stream was
made, and its output reached the container and the build. A Git LFS repo
failed at the archive on a machine with git-lfs set up, after a download
attempt from the host. A host `tar.umask` changed the snapshot's file modes.

The owner chose that the archive step carries the committed tree, with no
host-side conversion beyond what athanor pins:

- athanor's archive attributes are `* -export-ignore -export-subst -filter`,
  so no filter driver runs, whatever config defines one.
- athanor makes the archive folder with `git init --bare --template=`. That
  `init`, and every `git archive`, run in a clean environment: the inherited
  one with every variable whose name starts with `GIT_` removed (on Windows,
  whatever its case), `GIT_CONFIG_GLOBAL` naming an empty file in the run's
  scratch folder, `GIT_CONFIG_NOSYSTEM=1` and `GIT_ATTR_NOSYSTEM=1`. Only
  `GIT_CONFIG_NOSYSTEM` keeps out the system config at git's built-in place,
  and only `GIT_ATTR_NOSYSTEM` keeps out the system attributes file; no test
  can see either, since a test may not write the machine's own files. The archive also pins
  `core.attributesFile` to that empty file, because git reads its default
  global attributes file even with no global config.
- The snapshot's archive pins `tar.umask=0002`, git's default; the build
  context's keeps `0022`. A machine whose `tar.umask` was not the default gets
  the default modes in the snapshot again.
- The tree's own `text`, `eol`, `ident` and `working-tree-encoding` attributes
  still apply, as a checkout would apply them; they run no host command. The
  pinned `core.autocrlf=false` and `core.eol=lf` stay.
- The image tag's format version is `athanor-image-v2`, so an image built from
  a stream that host settings could change is not reused. Every repo rebuilds
  its image once. The old images stay in the engine until `athanor prune`
  removes them by age.
- A Git LFS file reaches the container and the build as its pointer file.

On git 2.55 for Windows, `git archive` did not read `GIT_ATTR_SOURCE` or
`attr.tree`, though `git check-attr` did (a probe at the build); other versions
were not tried. git 2.32 is the oldest that honours `GIT_CONFIG_GLOBAL`; on an
older git the global config is read again, but `-filter`, `--template=` and
the command-line pins still hold. Under the clean environment, git on the
owner's machine listed only athanor's own folder config as a source. Current
Git for Windows reads no machine-wide config under ProgramData; whether an
older release between 2.32 and today still reads one under
`GIT_CONFIG_NOSYSTEM` was not observed. If one did, `-filter` and the pins
would still cover filters, the attributes file, the umask and the line endings
in it.

This keeps host git settings out of the archive step. It is not a control
against a process that can write the environment or the home folder, which
already chooses the git that runs. And the git calls that record the work
(`stash create`, `add`, `hash-object`) still run with the host's git config and
environment, clean filters included: the threat model's accepted risk 23, and
issue 42. ADR 0007 still holds for git's own files; a host clean filter that
those calls run, such as Git LFS's, can write the repo's git folder.

## Amendment, 2026-10-24: programs start by a full path

Source: the owner's H2 from the Test review of issue 20, relayed by the lead
session.

On every platform, athanor starts git and docker by a full path it finds in
PATH, never by the bare name. It searches only PATH's absolute entries and
skips the working folder and every relative entry, so a program of the same
name in the repo or the current folder never runs in their place; on Windows,
starting a bare name would search the child's folder first. On Windows an entry
that hangs off the current drive, such as `	ools`, counts as relative, and
the name is tried as given, then with `.com`, then with `.exe`; never
`.cmd` or `.bat`, which need a shell. Each name is looked up once, and every
later start of it runs the same file. A path given as the program, such as the
tests' fake Docker, starts unchanged.

When no entry holds the program, athanor stops with exit 125 and says so, for
example "git was not found on PATH. Install it, or add its folder to PATH, then
run again." It never falls back to the bare name. (`findProgram` in
`src/proc.ts`, G8.)
