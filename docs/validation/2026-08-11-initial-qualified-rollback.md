# Initial qualified-release rollback repair

## Real Pilot finding

The exact merged candidate `eeef8e7a45f64af034be7220913c37bcc970b2ed` passed its local portable checks and merged-head Windows/Ubuntu CI, then entered disposable Task 12 capture session `pilot-session-20260811-eeef8e7a`. The first update to qualified candidate `release_hunter-pi-0.1.0-dev.0-16bd5f4b1295` applied successfully and passed a real-terminal Safe Mode smoke without a Provider request.

The immediate rollback to the installed baseline was safely blocked by operation `op_update-rollback-a3d80943-3e14-4e4d-8fb5-5f67d3851212` with `rollback target is not a known applied qualified candidate`. The active update remained usable and no Provider budget was consumed. This is a product defect, not acceptable Task 12 Evidence: a portable release is activated before a new user's append-only update journal exists, so the manager could not discover the otherwise installed baseline as a rollback candidate.

The failed capture remains incomplete and superseded. It is not retried, finalized, or counted as acceptance.

## Repair contract

- The Windows portable adapter can return an installed candidate only after re-verifying its exact artifact bytes and extracted file tree.
- Rollback may consult that installed candidate only when no previously applied journal candidate exists and an append-only `APPLY` receipt proves the target was previously active. A qualified release that was only staged is ineligible.
- The normal channel, qualification status, verifier fingerprint, unsigned-preview, Pi self-update, and release identity gates still apply.
- CI output remains `NOT_PROVEN` until a separate metadata-only `QUALIFY` operation obtains the exact hosted Evidence itself. The official command accepts an installation root and main CI run ID, not a caller-authored `PASS` candidate. It performs one run query and one named artifact download, then requires the exact repository/main push/workflow/source, all six required jobs, hosted/local bundle bytes, and hosted/local non-qualification candidate identity.
- `QUALIFY` binds an operation ID derived from the complete canonical request, a path-free target, deadline, and fail-closed elapsed timeout shared by both fixed `gh` calls. It writes an intent before metadata mutation, syncs and atomically publishes strict Evidence without replacement, retains the intent through Receipt acknowledgement, reconciles interruption under the original operation identity, and serves exact replay or an already-qualified same-source invocation without another GitHub query.
- Qualification changes only `portable-release-candidate.json` and the matching version directory's `.hpi-candidate.json`; the update bundle and executable payload retain their original fingerprint.
- Missing, unqualified, identity-drifted, or damaged initial releases remain ineligible for rollback. Verification failure preserves the currently active release and appends a failure receipt.

## Local evidence

The first test was written RED against the real portable adapter shape: a qualified initial version was staged and activated before manager journal creation, a second version was applied, and rollback was blocked. A second RED proved that a qualified release which was only staged could otherwise be selected as the fallback. The first repair head `a5e566152582981e0ab482932f8987ba44c8a964` and PR #75 run `31451189405` passed all six hosted jobs, but review found that its standalone mutator trusted arbitrary `PASS` JSON, had no update operation/journal/reconciliation contract, could expose raw paths on failure, and used a hand-maintained immutable-field projection. That head was not merged.

The first review-hardened replacement, commit `bb5431f`, removes the public direct-write API. Its focused matrix passed 5 test files / 72 updater/portable/CLI tests, including nine exact authority/operator tests for hosted run and artifact binding, non-main or incomplete-run rejection, source and byte-drift rejection, immutable hosted-candidate rejection, local replay with no second GitHub access, durable Evidence, both direct-restart and manager-caught interruption recovery, first update/rollback success, staged-only rollback rejection, tamper rejection, and path-free script failure. Lint and type checking passed. That commit was not pushed while independent review was pending.

The complete local verification passes 70 test files / 705 tests, lint, type checking, strict compiler smoke, production build, formatting, all 13 external package smokes, single-artifact CLI smoke, clean npm installation, and the provider-independent Pi public-interface probe. The first sandboxed invocation retained one environment-only failure because sandbox policy denied Git access to the user-level ignore file and emitted stderr inside a temporary-repository cleanliness test; the uninterrupted rerun under normal machine permissions passed every gate.

Independent standards review of `bb5431f` found that first-rollback lookup did not reload retained Evidence, the adapter removed its intent before the manager Receipt, the operator reused a date-only operation identity with a changed deadline, Evidence publication could leave a partial final file, and the two `gh` calls did not share one elapsed timeout. Its separate Spec-axis attempt was interrupted before reading the diff and is explicitly not counted as a clean review. The follow-up repair proves Evidence-deletion rejection, pre-Receipt and post-Receipt interruption recovery, non-replacing atomic Evidence publication, request-bound operation identities, local same-source no-op, and a decreasing shared timeout. Its focused matrix passes 5 files / 74 tests, including 11 authority/operator tests; lint, type checking, and formatting pass. A fresh complete local verification and replacement dual-axis review are `PENDING` at this point in the record.

The superseded first repair tool also processed the full 64 MB `eeef8e7a` bundle and allowed the disposable fixture to return to `eeef8e7a`; that historical recovery remains useful for preserving the failed Pilot fixture but is not accepted as final qualification Evidence. The final candidate must be rebuilt and qualified through the replacement live-run path.

Remote PR CI, exact merged-head CI, a newly promoted artifact, and a complete replacement Task 12 Pilot are `PENDING`. Daily-use acceptance remains `NOT_PROVEN` until those gates actually pass.
