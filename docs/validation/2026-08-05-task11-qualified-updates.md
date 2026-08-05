# Task 11 — Qualified update and portable package validation

## Local result

The release qualification runner creates a candidate only from exact declared check results with bound Evidence. The updater rejects preview candidates on Stable, non-PASS qualification, unsigned Stable candidates, enabled Pi self-update, private/credential-bearing references, and artifact digest/length mismatch. It stages, health-checks, runs an injected state-migration hook, records failed source/health/migration operations with redacted reasons, verifies the active identity after both apply and rollback activation, preserves the current release on mismatch, applies a second candidate, and rolls back only to a previously applied qualified candidate with an append-only hash journal and request-fingerprint replay protection.

The Windows x64 portable builder assembled a directory with Node `24.14.0`, the exact CLI dependency tree, `hpi.cmd`, license/notice files, and a strict manifest. Its isolated version probe passed. The rebuilt local manifest is `sourceState=CLEAN`, `updateChannel=developer-preview`, and `signed=false`; it is a clean unsigned developer-preview artifact, not a release candidate.

External package smoke and clean `npm ci` pass. The package smoke imports nine workspace packages from outside the workspace and validates the single-artifact CLI/Core input gate. The focused Task 11 contract tests pass (13 tests).

## Not proven

No npm publication, Windows installer/signing, migration of existing user state, or stable promotion occurred. Final exact PR CI run `31032218373` passes Windows/Ubuntu quality, containment, and both Evidence aggregators; exact main CI remains `PENDING`. The initial fresh-checkout updater lint failure is preserved in `31022928024`, and the later hosted Linux process-tree history is preserved in `31028497285`. The clean unsigned artifact and these PR-only CI results still do not establish a qualified release claim.
