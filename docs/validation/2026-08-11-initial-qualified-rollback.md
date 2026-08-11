# Initial qualified-release rollback repair

## Real Pilot finding

The exact merged candidate `eeef8e7a45f64af034be7220913c37bcc970b2ed` passed its local portable checks and merged-head Windows/Ubuntu CI, then entered disposable Task 12 capture session `pilot-session-20260811-eeef8e7a`. The first update to qualified candidate `release_hunter-pi-0.1.0-dev.0-16bd5f4b1295` applied successfully and passed a real-terminal Safe Mode smoke without a Provider request.

The immediate rollback to the installed baseline was safely blocked by operation `op_update-rollback-a3d80943-3e14-4e4d-8fb5-5f67d3851212` with `rollback target is not a known applied qualified candidate`. The active update remained usable and no Provider budget was consumed. This is a product defect, not acceptable Task 12 Evidence: a portable release is activated before a new user's append-only update journal exists, so the manager could not discover the otherwise installed baseline as a rollback candidate.

The failed capture remains incomplete and superseded. It is not retried, finalized, or counted as acceptance.

## Repair contract

- The Windows portable adapter can return an installed candidate only after re-verifying its exact artifact bytes and extracted file tree.
- Rollback may consult that installed candidate only when no previously applied journal candidate exists.
- The normal channel, qualification status, verifier fingerprint, unsigned-preview, Pi self-update, and release identity gates still apply.
- CI output remains `NOT_PROVEN` until a separate metadata-only promotion step binds the exact hosted Evidence. Promotion refuses immutable metadata drift, artifact drift, symlinks, a non-physical installation root, an untrusted verifier, and any non-`PASS` candidate.
- Promotion changes only `portable-release-candidate.json` and the matching version directory's `.hpi-candidate.json`; the update bundle and executable payload retain their original fingerprint.
- Missing, unqualified, identity-drifted, or damaged initial releases remain ineligible for rollback. Verification failure preserves the currently active release and appends a failure receipt.

## Local evidence

The test was written RED against the real portable adapter shape: a qualified initial version was staged and activated before manager journal creation, a second version was applied, and rollback was blocked. The repaired focused matrix passes 21 updater/portable tests, including the exact pre-promotion block, metadata promotion, idempotent promotion, immutable-identity rejection, first rollback success, and tamper rejection.

The complete local verification passes 68 test files / 696 tests, lint, type checking, strict compiler smoke, production build, formatting, all 13 external package smokes, single-artifact CLI smoke, clean npm installation, and the provider-independent Pi public-interface probe.

The promotion tool also processed the full 64 MB `eeef8e7a` bundle and its installed tree, emitted candidate fingerprint `sha256:a80bd244ee95f52637b38fcc614c6ce392ed3e92245defa39f8808d4992148f2`, and allowed the previously blocked disposable fixture to recover through the supported `update apply` path. The active identity returned to `eeef8e7a`; its failed Pilot history remains preserved.

Remote PR CI, exact merged-head CI, a newly promoted artifact, and a complete replacement Task 12 Pilot are `PENDING`. Daily-use acceptance remains `NOT_PROVEN` until those gates actually pass.
