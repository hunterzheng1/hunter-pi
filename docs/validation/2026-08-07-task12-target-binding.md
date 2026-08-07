# Task 12 — frozen target binding for real Managed Change (2026-08-07)

## Disposition

`IMPLEMENTED` within the provider-neutral disposable-fixture contract; the real Windows pilot and daily-use decision remain `NOT_RUN` / `NOT_PROVEN`.

## Contract change

`hpi-managed-change-request.v2` requires a path-free, explicitly selected target containing `targetId`, `repositoryFingerprint`, `sourceFingerprint`, and `targetReferenceFingerprint`. The fields are the same identities emitted by `hpi pilot target`; they are not replaced by a raw repository path.

The runner recomputes the canonical Git root, branch, base commit/tree, and the three pilot target fingerprints immediately before the Agent operation. Any mismatch returns `TARGET_IDENTITY_MISMATCH` before the Agent or Provider operation starts. Final `hpi-managed-change.v2` Evidence repeats the exact target binding under `repository.target`.

Git inspection uses a minimal environment with global/system configuration disabled, disables fsmonitor and untracked-cache behavior, and rejects local external clean/process/smudge filters as `EXTERNAL_FILTER_CONFIGURED`. The filter command is inspected before worktree status and is never executed.

## Local evidence

- `npx vitest run test/real-managed-change.test.ts test/real-managed-change-cli.test.ts test/task12-pilot-target.test.ts test/hpi-cli.test.ts --reporter=dot`: 54/54 tests passed.
- `npm test -- --reporter=dot`: 52 files / 422 tests passed.
- `npm run lint`, `npm run typecheck`, `npm run strict:check`, `npm run build`, `npm run format:check`: passed.
- `npm run package-smoke`, `npm run clean-install-smoke`, and `npm run probe:pi`: passed.

All repositories used by these tests were temporary Git fixtures. No user repository, Provider credential, paid request, or external network operation was used. This evidence does not create the required dated Task 12 real-use Archive.
