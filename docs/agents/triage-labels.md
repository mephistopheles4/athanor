# Triage labels

Five triage roles and three tier labels, the same set the pact uses.

| Label | Meaning |
| --- | --- |
| `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | Fully specified; an agent can start it unasked |
| `ready-for-human` | An owner decision or owner-only action is open |
| `wontfix` | Will not be actioned |

## Tier labels

Every issue carries one tier, which says how much checking the work needs.
Triage sets it. An issue with no tier label is not yet triaged.

| Label | Checking |
| --- | --- |
| `tier:quick` | Small, one session, no plan: tests, then the QA pair offered. |
| `tier:standard` | A short spec on the issue, read for what is unstated; one build session, ending with tests and the lenses the diff calls for. |
| `tier:thorough` | A spec read before the owner approves it, cut into tickets; one build session per ticket. |

By default, auth, secrets, crypto, input validation and data migrations are
sensitive work: the session recommends `tier:thorough` with the security pair,
and the owner takes it or not. In athanor, a change to what reaches the
container, to path checks, or to how athanor handles the Docker endpoint is
input validation.

## Creating the labels

The owner creates them, or lets a session create them:

```bash
gh label create needs-triage -R mephistopheles4/athanor --description "Maintainer needs to evaluate this issue" --color fef2c0
gh label create needs-info -R mephistopheles4/athanor --description "Waiting on reporter for more information" --color f9d0c4
gh label create ready-for-agent -R mephistopheles4/athanor --description "Fully specified; an agent can start it unasked" --color c2e0c6
gh label create ready-for-human -R mephistopheles4/athanor --description "An owner decision or owner-only action is open" --color bfd4f2
gh label create wontfix -R mephistopheles4/athanor --description "Will not be actioned" --color ffffff
gh label create tier:quick -R mephistopheles4/athanor --description "Quick tier: small, one session, no plan: tests, then the QA pair offered" --color c5def5
gh label create tier:standard -R mephistopheles4/athanor --description "Standard tier: a short spec on the issue, then one build session" --color fbca04
gh label create tier:thorough -R mephistopheles4/athanor --description "Thorough tier: a reviewed spec cut into tickets, one build session each" --color d93f0b
```
