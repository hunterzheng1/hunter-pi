---
status: accepted
date: 2026-08-03
---

# Bind one plan revision to one run

A Hunter Pi Run binds exactly one immutable Plan Revision. If goal, scope, required checks, budgets, or other material plan facts change after execution begins, the current Run ends as `CANCELLED` with reason `PLAN_SUPERSEDED`; a linked new Run starts against the new Plan Revision. Attempts never cross this boundary. Run outcome is also independent of `ArchiveStatus`, so archiving any ended Run preserves rather than replaces its result.

## Consequences

- Verification and Evidence can always be interpreted against one fixed acceptance contract.
- Fixback and retry remain new Attempts only while the Plan Revision is unchanged.
- A plan change costs a new Run identity and preserves the predecessor's incomplete or failed history.
- `READY`, `FAILED`, `BLOCKED`, `CANCELLED`, and `INCOMPLETE` remain outcome facts; `UNARCHIVED` and `ARCHIVED` form a separate lifecycle.
- Projections must reconcile predecessor/successor links without merging Attempts across Runs.
