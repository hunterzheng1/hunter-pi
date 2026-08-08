# Task 11 — Qualified update and portable package validation

## Local result

The updater qualification path rejects preview candidates on Stable, non-PASS qualification, unsigned Stable candidates, enabled Pi self-update, private/credential-bearing references, and artifact digest/length mismatch. It stages a candidate, performs a bounded health check, runs an injected state-migration hook, records failed source/health/migration operations with redacted reasons, verifies the active identity after apply and rollback, preserves the previous release on mismatch, and retains append-only failure history.

The Windows x64 adapter now provides the production-shaped local seam: deterministic `tar.gz` bundles, safe extraction, side-by-side version directories, an atomic active pointer, activation-intent and migration recovery, persisted reversible migration fixtures, rollback re-verification, and a read-only `reconcile` operation. The focused Task 11 updater/adapter tests pass (19 tests), and the full CI test slice passes 47 files / 410 tests. A serial full-suite run passes 59 files / 527 tests; one earlier parallel full-suite run retained a single host-scheduling failure, while the affected file passes independently.

The portable builder requires Windows x64, Node 24, a clean source tree, and one exact output child under `.artifacts`. It packages the pinned Node runtime, exact CLI dependency tree, launcher, `hpi.cmd`, license/notice files, and strict candidate/portable manifests. It then probes the launcher, active version, and JSON update status. On clean source commit `0bd97653be9fa99fdb444cb06da4a2a60ac856b6`, the artifact manifest records `sourceState=CLEAN`, `updateChannel=developer-preview`, `signed=false`, release `release_hunter-pi-0.1.0-dev.0-0bd97653be9f`, artifact `sha256:ca56d9474455e883cf1e8ef764077896434db7c18b5888e7bf4bd77800dad9f` / `64,264,811` bytes, and Node `24.14.0`. The pack command exited 0 in 186.3 seconds. The root launcher `version --json` exited 0 in 0.21 seconds; `update status --json` exited 0 with `status=READY` in 0.58 seconds, and the `hpi.cmd` entry point returned the same READY result in 0.63 seconds. The resulting artifact is deliberately `qualification=NOT_PROVEN`; that is a usable unsigned developer preview, not a qualified release candidate.

The GitHub Actions workflow reuses the quality job's locked install and build, runs the compiled portable packer only on Windows, and uploads the exact portable directory for 14 days. The CI policy test now covers this single-build behavior and the complete local CI slice passes.

## Exact evidence still required

- A clean committed source identity and the corresponding Windows x64 pack output must be captured after the branch is committed.
- The exact source commit must pass the required Windows and Ubuntu hosted quality/Evidence jobs, with the portable artifact's source and digest retained.
- Any qualified or Stable claim still needs a separately authorized signing/publisher decision and the release gates in the update strategy.

## Not proven

No npm publication, Windows installer/signing, migration of an existing user's state, Stable promotion, third-party plugin compatibility, real-user repository safety, or broad Provider reliability/recovery has occurred. The portable adapter and its fixture tests do not substitute for the Task 12 real-use Archive. Remote CI that has not yet run for the exact Task 11 source remains `PENDING`, never inferred as `PASS`.
