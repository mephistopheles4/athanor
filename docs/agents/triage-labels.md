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

## Creating the labels

The eight labels exist on the Linear team `athanor`. To recreate one, the owner
does it, or lets a session use the connector's `save_issue_label` with that
team's id, the name and the meaning above.
