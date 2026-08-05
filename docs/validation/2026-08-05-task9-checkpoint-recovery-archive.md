# Task 9 — Checkpoint, recovery, Archive, and second-device validation

## Scope

Task 9 was implemented on the isolated `codex/daily-use` worktree using provider-neutral durable event fixtures. No real Provider request or user repository mutation was performed.

## Implemented and locally verified

- event- and elapsed-time Checkpoints with exact Attempt, budget, engine, operation, lease, and process bindings;
- idempotent Checkpoint recording after reopen;
- reconciliation of exact Distribution Release, Workspace, active Operations, and Engine identities;
- new recovery Attempts with exact operation identity, idempotent replay, preserved failure Evidence, and fail-closed `NOT_PROVEN` decisions on missing or throwing adapters;
- durable cancellation only after `PROCESS_EXITED` finality;
- immutable Archive manifests and packages for `READY`, `BLOCKED`, `FAILED`, `CANCELLED`, and `INCOMPLETE` outcomes;
- event replay, projection, Evidence, Attempt, Checkpoint, and digest identity validation;
- canonical Kernel-bound Archive read/export validation and cross-process durable mutation locks;
- exact export/delete receipts, portable import rejection for live Attempts/leases/processes/device paths/credentials, and clean-profile second-device import followed by policy/Doctor/login-readiness checks.

## Local evidence

The focused Task 9 tests pass (7 files / 66 tests). A sharded local run covered all 46 test files and 357 tests with every shard passing; the Git fixture file passed 22/22 after its host-sensitive fixture budgets were raised to 30 seconds. Package smoke, clean install, lint, typecheck, build, format, and strict compiler smoke also pass. Final exact PR CI run `31032218373` passes Windows/Ubuntu quality, containment, and both Evidence aggregators; exact main CI remains `PENDING`. The preceding updater lint failure is retained in `31022928024`, and the hosted Linux process-tree timeout/fix history is recorded in [Linux process-tree validation](2026-08-05-linux-process-tree-hosted.md).

## Not proven

Real power loss, an arbitrary user repository, process-host crash recovery under hostile OS scheduling, and Provider recovery remain `NOT_PROVEN`. A portable Archive is not permission to migrate an active Run; the importer rejects that state.
