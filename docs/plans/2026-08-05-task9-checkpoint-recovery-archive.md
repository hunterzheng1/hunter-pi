# Task 9 — Checkpoint recovery and Archive

- Preregistered: 2026-08-05
- Baseline: `75c35adb759a7379a290179f4274c5182a03c118`
- Branch: `codex/daily-use`
- Boundary: provider-neutral deterministic fixtures only until the required real-use pilot gates explicitly open

## Outcome

Make interruption handling and Run finalization durable without rewriting workflow history. A recovery is allowed only after the exact Distribution Release, workspace/source, active operations, and Engine session facts are reconciled. A successful recovery creates a new recovery Attempt linked to the Checkpoint and preserves the interrupted Attempt. An Archive is an immutable post-Run manifest that can be replayed, exported, imported into a clean device profile, and deleted only at an exact artifact target; deleting an export never deletes workflow facts, Evidence, Checkpoints, or the Archive manifest.

## Contract

- `RecoveryCoordinator` is the deep module at the recovery seam. Callers provide a Checkpoint identity and provider-neutral reconciliation adapters; the module validates identities, reconciles unknown operations, records failure Evidence, and asks the Workflow Kernel to create exactly one recovery Attempt.
- A recovery result is `RECOVERED`, `BLOCKED`, `NOT_PROVEN`, or `NOT_FOUND`. No recovery Attempt is created for ambiguous, stale, unresolved, or device-local facts.
- `RunArchiveStore` finalizes only terminal Runs and binds the immutable Run projection, event stream digest, Evidence identities/digests, source/release identities, and recovery limits into one manifest. Same archive operation and fingerprint is idempotent; a changed request is rejected.
- Portable Archive import rejects device-local paths, live leases, live processes, credentials, and an active Attempt. It imports redacted immutable facts only and never claims a migrated live execution.
- Import, export, and deletion receipts bind exact archive/target references and operation identities. The hardened `hpi-archive-delete-export-receipt.v2` retains the deleted envelope identity. Import and delete replay is append-only; deletion validates the exact export envelope, records `BLOCKED`/`NOOP` outcomes, and is scoped to the exported artifact.

## Required RED/GREEN coverage

1. Recovery creates one new recovery Attempt after all four reconciliations pass, and replay preserves the old Attempt plus the Checkpoint.
2. Recovery blocks without creating an Attempt when release, workspace, operation, or Engine reconciliation is missing, stale, ambiguous, or `NOT_PROVEN`.
3. Archive finalization is idempotent, rejects non-terminal Runs, preserves all terminal outcomes, and fails closed on missing/stale Evidence or projection identity.
4. Second-device import accepts a redacted archive only after rejecting live/device-local state; imported facts remain portable and do not create a live Attempt.
5. Exact export deletion cannot traverse or delete workflow state, Evidence, Checkpoints, or the Archive manifest.

## Verification

- Focused Task 9 contract tests with RED → GREEN → REFACTOR.
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run strict:check`
- `npm run build`
- `npm run format:check`
- privacy/path/credential scan over committed Task 9 Evidence and fixtures
- exact Windows and Ubuntu Evidence comparator before any merge claim

## Stop and pause conditions

- Stop if recovery would require manual state-file editing, mutable history, or guessed external identity.
- Stop if Archive import would imply that a live Attempt, lease, process, credential, or device-local path migrated successfully.
- Pause before real Provider requests, real user repositories, paid operations, publication, signing, or destructive deletion outside an exact disposable export target.
- Preserve every failed, skipped, timed-out, and `NOT_PROVEN` receipt; later success never overwrites it.
