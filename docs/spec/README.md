# Specs

This folder holds the repo's specs in force, one file each: `<NNNN>-<slug>.md`. `NNNN` is four digits, the highest in the folder plus one, from `0001`; `slug` is lower-case letters, digits and hyphens. Whether a spec is in force is decided by the owner's rule, the-pact's `claude/tracker.md` ("Specs in the tree"), installed as `~/.claude/tracker.md`, not by this file. Every file here is public, so a spec holds nothing a public record may not: no secret, personal detail, open security reason, weakness in others' software that is not yet public, or Linear id beyond a team key.

To add a spec: write the file, put its line at the top of "All specs" (and delete `None yet.` there if it is the first), and change nothing else. A line is one of:

- `- [<stem>](<stem>.md) — <one-line summary>`, `<stem>` being the file name without `.md`;
- `- history: [#<n>](<issue URL>) — <one-line summary>`, for a spec still on an issue; it names no file.

## Read these first

None yet.

## All specs

- [0002-node-26-beside-the-floor](0002-node-26-beside-the-floor.md) — test athanor on Node 24 and 26 in CI, with 24 still the lowest version it supports
- [0001-outside-configuration](0001-outside-configuration.md) — `--config` and `ATHANOR_CONFIG`: read athanor's configuration from a file outside the repo under test
