# A hook holds an agent's fast runs to athanor

athanor runs its own fast tier, its type checks and its source check in its own
container, from `athanor.json` and `test/container/Dockerfile`. A PreToolUse
hook in `.claude/settings.json` refuses an agent session's host run of
`node test/run.mjs fast` while athanor is installed. When athanor can't run,
the session names why with `--host-fallback=<reason>`, which the runner prints.
The model is the-pact's hook (its ADR 0104); grimoire, stacks and
aymandiab.com hold the same rule.

## Why

- **The repo that keeps runs off the host ran its own tests on the host.**
  `athanor run` refused here with exit 125: there was no configuration.
- **A written rule alone gets skipped.** The other repos found that a hook
  makes a skip visible; this one follows them.

## How

- **What runs where.** The fast tier, `tsc` on `src/` and `test/`, and the
  source check run in the container: Node 24 on Alpine with git, and the
  compiler installed from the lockfile at image build time with install
  scripts off. The docker tier stays on the host: it needs a Docker engine,
  and nothing may reach the container but the snapshot (ADR 0005, ADR 0016).
- **Only the fast tier is guarded.** The type checks and the source check only
  read files, so a host run of them executes no test code.
- **A nudge, not a control.** It fails open on any error, gives no explicit
  allow, and is silent when athanor is missing. Its refusal is fixed text.
- **No shell, a full path.** The probe looks for athanor in PATH's absolute
  entries only. On Windows it runs Node on the package's `bin/athanor.mjs`
  beside the `athanor.cmd` shim, so no shell starts (ADR 0002, ADR 0020's
  amendment). `scripts/check-source.mjs` reads `.claude/hooks/`.
- **The reason is plain words.** It can reach a posted record, so the runner
  takes at most 80 letters, digits, spaces and basic punctuation, no word
  over 24, and refuses anything else without echoing it.
- **The hook is code that runs on load.** A checkout or pull that changes it
  takes effect on the next shell call in an agent session.

## Limits

- `npm test` and a bare `node --test` pass, as they don't name the runner,
  and so do a run through `bash -c` or from inside `test/`.
- On Windows the probe looks for npm's `athanor.cmd` with the package beside
  it. If the hook's PATH lacks npm's global folder, as with a version
  manager's own shim alone, it finds nothing and stays silent.
- It adds a Node start to every shell call an agent makes in this repo.
