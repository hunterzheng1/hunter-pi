# Task 9 — Checkpoint, recovery, Archive, and second-device validation

## Scope

Task 9 was implemented on isolated Task 9 worktrees using provider-neutral durable event fixtures.
No real Provider request or user repository mutation was performed.

## Implemented and locally verified

- event- and elapsed-time Checkpoints with exact Attempt, budget, engine, operation, lease, and process bindings;
- idempotent Checkpoint recording after reopen;
- reconciliation of exact Distribution Release, Workspace, active Operations, Attempt process/Writer Lease finality, and Engine identities;
- new recovery Attempts with exact operation identity, idempotent replay, one immutable Attempt Finality Receipt, preserved failure Evidence, and fail-closed `NOT_PROVEN` decisions on missing, mismatched, or throwing adapters;
- durable cancellation only after both a terminal execution Observation and an Attempt Finality Receipt bound to the latest Checkpoint; `AGENT_RETURNED` or `PROCESS_EXITED` alone is rejected;
- immutable Archive manifests and packages for `READY`, `BLOCKED`, `FAILED`, `CANCELLED`, and `INCOMPLETE` outcomes;
- event replay, projection, Evidence, Attempt, Checkpoint, and digest identity validation;
- canonical Kernel-bound Archive read/export validation and cross-process durable mutation locks;
- complete owner records published atomically with no replacement, signed process-liveness
  challenge/response independent of PID reuse, one-winner physical-path-normalized recovery, and
  immutable path-free owner/claim reconciliation receipts;
- durable import/export/delete operation receipts (including `hpi-archive-delete-export-receipt.v2` artifact identity), strict export-envelope deletion, portable import rejection for live Attempts/leases/processes/device paths/credentials, and clean-profile second-device import followed by policy/Doctor/login-readiness checks;
- exact archive-bound read-only projection after reopen, v1 import-receipt reconciliation, v3 device
  receipts, immutable import intent, exact policy clone reconciliation, and interrupted-import resume
  without duplicate policy writes or manual file editing;
- process-termination recovery for device intent and final-receipt publication at all four atomic
  boundaries, with exact reserved-name/physical-link checks and fail-closed foreign remnants;
- forced owner/reconciler termination recovery at claim publication, receipt publication, and stale
  owner removal, including Windows path aliases, concurrent successors, truthful v2 recovery
  observation time, and File Lease reopen through the same lock seam.

## Local evidence

The current Windows-local Task 9 platform receipt is
`hpi-task9-platform-receipt.v2` at source `0e2a369b5a8ef6c7c49e8d616a00ad4134a91829`.
It passes all 89 assertions in the fixed eight-file daily-use matrix, including three forced-kill
reconciler boundaries, eight device-publication process kills, abandoned File Lease recovery, exact
second-device read-only projection, quoted-JSON privacy rejection, interrupted import resume,
durable recovery, cancellation, Checkpoint, and Attempt Finality cases.
The direct finality fixture adds process-final, Writer Lease release, Attempt Finality, durable
reopen, and privacy checks, for six fact-bound checks in the receipt. The non-duplicated CI test set
also passes locally (46 files / 393 tests), full `npm run verify` passes (55 files / 491 tests plus
strict compile, build, format, external package install, single-artifact smoke, clean locked install,
and Pi probe), the focused lock/lease/Archive regression passes (3 files / 60 tests), and the
concurrent reconciler case passed 15 consecutive Windows stress iterations.
The implementation never terminates an owner outside the test harness.

Historical Task 6 Evidence remains parseable through the backward-compatible empty
finality-receipt projection default. Earlier failed and v1 local receipts remain preserved in the
ignored Evidence workspace. Remote CI for this source is `PENDING`. Exact merged-head main CI
[`31244419248`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31244419248) passes the prior
rate-limit/CI hardening baseline but does not prove this Task 9 v2 source. Earlier replacement and
merged-head runs remain recorded as
[`31042109585`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31042109585) and
[`31044936543`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31044936543). The preceding
updater lint failure is retained in `31022928024`, and hosted Linux process-tree timeout/fix history
is recorded in [Linux process-tree validation](2026-08-05-linux-process-tree-hosted.md).

## Not proven

Hosted Windows and Ubuntu v2 receipts for the final source and their exact aggregate comparator,
real OS power loss, an arbitrary user repository, a physically separate operator device, and
Provider recovery remain `NOT_PROVEN`. The clean-profile fixture proves device-independent import
semantics but is not presented as a field pilot. A portable Archive is not permission to migrate an
active Run; the importer rejects that state.
