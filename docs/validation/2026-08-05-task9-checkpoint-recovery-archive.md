# Task 9 — Checkpoint, recovery, Archive, and second-device validation

## Scope

Task 9 was implemented on the isolated `codex/daily-use` worktree using provider-neutral durable event fixtures. No real Provider request or user repository mutation was performed.

## Implemented and locally verified

- event- and elapsed-time Checkpoints with exact Attempt, budget, engine, operation, lease, and process bindings;
- idempotent Checkpoint recording after reopen;
- reconciliation of exact Distribution Release, Workspace, active Operations, Attempt process/Writer Lease finality, and Engine identities;
- new recovery Attempts with exact operation identity, idempotent replay, one immutable Attempt Finality Receipt, preserved failure Evidence, and fail-closed `NOT_PROVEN` decisions on missing, mismatched, or throwing adapters;
- durable cancellation only after both a terminal execution Observation and an Attempt Finality Receipt bound to the latest Checkpoint; `AGENT_RETURNED` or `PROCESS_EXITED` alone is rejected;
- immutable Archive manifests and packages for `READY`, `BLOCKED`, `FAILED`, `CANCELLED`, and `INCOMPLETE` outcomes;
- event replay, projection, Evidence, Attempt, Checkpoint, and digest identity validation;
- canonical Kernel-bound Archive read/export validation and cross-process durable mutation locks;
- durable import/export/delete operation receipts (including `hpi-archive-delete-export-receipt.v2` artifact identity), strict export-envelope deletion, portable import rejection for live Attempts/leases/processes/device paths/credentials, and clean-profile second-device import followed by policy/Doctor/login-readiness checks.

## Local evidence

The 2026-08-08 finality hardening passes the focused recovery/cancellation/Archive/Kernel set (5 files / 59 tests) and full `npm run verify` (52 files / 433 tests, strict compile, build, format, external package install, single-artifact smoke, clean locked install, and Pi public-interface probe). Historical Task 6 Evidence remains parseable through the backward-compatible empty finality-receipt projection default. Remote CI for this new source is `PENDING`. Earlier PR CI run `31032218373` covers the pre-hardening source; hardened replacement PR CI [`31042109585`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31042109585) and exact merged-head main CI [`31044936543`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31044936543) pass only their prior Windows/Ubuntu quality, containment, and Evidence assertions. The preceding updater lint failure is retained in `31022928024`, and the hosted Linux process-tree timeout/fix history is recorded in [Linux process-tree validation](2026-08-05-linux-process-tree-hosted.md).

## Not proven

The platform adapter that maps exact Task 7 final receipts and released Writer Leases into the Attempt Finality Receipt, real power loss, stale-lock/forced-kill recovery, an arbitrary user repository, a read-only imported projection on a second device, Task 9 cross-platform machine Evidence, and Provider recovery remain `NOT_PROVEN`. A portable Archive is not permission to migrate an active Run; the importer rejects that state.
