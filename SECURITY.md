# Security policy

## Reporting a security hole

Report a hole in athanor privately, through the "Report a vulnerability"
button on this repo's [Security tab](https://github.com/mephistopheles4/athanor/security).
GitHub keeps the report visible only to you, the repo's maintainers, and
anyone they add to the advisory.

Don't open a public issue, comment or pull request for it: issues and their
reviews here are public. Leave keys, tokens and personal details out of the
report; say where they are instead.

## What counts

[The threat model](docs/threat-model.md) says what athanor defends and which
risks it accepts. Read it before you report. A hole is a boundary that
doesn't hold: for example, a host folder, host environment value or network
reaching the test container, a configured path escaping the repo, or a
command reaching a shell on the host.

athanor is for repos you trust to build: the image build runs the repo's own
Dockerfile with network access. athanor sends the build context and snapshot
to the Docker engine and buildx builder you have configured. It refuses one on
another machine unless the machine configuration sets `allowRemoteDocker`, and
refuses plain tcp without TLS verification unless it sets `allowPlainTcp`.
The machine configuration is read from the state folder, which `ATHANOR_HOME`
moves. Which of these risks are accepted is decided in the threat model.

Don't run athanor on a Docker engine shared with people you don't trust:
anyone with access to the engine can read your runs and change their results.
Teammates you trust on an office build box are fine.

Docker, Docker Desktop, git and Node are outside athanor. Report a hole in one
of them to its maker.

## Supported version

The latest release of `@mephistopheles4/athanor` on npm, and `main`.

## What to expect

athanor is one person's project. There is no promised response time and no
bug bounty. Reports are handled as time allows. Say in your report if you
want credit.
