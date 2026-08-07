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

## Hosted CI stabilization

The first exact merged-head main run `31150894319` failed only on Windows: the out-of-scope-path integration test at `test/real-managed-change.test.ts` exceeded Vitest's default 5-second test timeout while performing its Git and child-process fixture work. The assertion did not fail; the subsequent Pi receipt upload was absent because the test step had already stopped. The same PR run had passed, and the test completes locally, but the hosted timing variance exposed an under-sized test timeout.

The real Managed Change and CLI integration suites now use an explicit finite 30-second Vitest suite timeout, matching the existing Git/process integration-suite policy. This changes test-harness tolerance only; product command and Engine timeouts remain unchanged.

## Task 7 hosted scheduling resilience

The exact merged-head main run `31153056987` retained one independent Ubuntu Task 7 failure at `TEST_EXECUTION`: the platform probe exited after the host-sensitive process-tree test exceeded its bounded 180-second test budget. Windows quality, Ubuntu quality, Windows containment, and Pi Evidence had passed; the failure was not a GitHub API rate-limit response, source-identity mismatch, or Evidence-parser failure. The structured Linux failure receipt was preserved as an append-only artifact.

CI commit `6cef8ba` adds a narrow one-retry policy to the Task 7 containment job:

- attempt 1 is always run and its receipt is preserved when it is a structured `FAIL` at `TEST_EXECUTION`;
- only that exact receipt class is retried once;
- source-identity, report-parse, pre-publication, build, and retry failures remain blocking;
- the job has an explicit final `PASS` receipt gate, and uploads both the retained attempt history and the canonical receipt.

PR #42 run `31156567656` passed Windows/Ubuntu quality, both Task 7 containment jobs, Pi Evidence, and Task 7 Evidence. Both platform jobs passed on attempt 1, so the retry branch was skipped while the new gates executed on hosted Windows and Ubuntu. The exact merge-head main run `31157880366` passed the same gates. This reduces manual reruns for the previously observed transient hosted scheduling class without converting a real failure into a PASS.

The follow-on documentation head `7bbce75` also passed the exact merged-head main run [`31160657104`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31160657104) across Windows/Ubuntu quality, Pi Evidence, both Task 7 containment jobs, and Task 7 Evidence. The real-pilot disposition is unchanged: hosted CI proves the checked-in implementation, not daily-use acceptance against real repositories.

## Follow-on Windows quality timeout (2026-08-07)

The exact main run [`31165481401`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31165481401) for merge `99ed2ea` preserved a Windows quality failure in `test/doctor.test.ts`: the privacy-safe CLI subprocess assertion exceeded Vitest's default 5-second test budget. The assertion itself did not fail; 50 of 51 test files and 413 of 414 tests passed before the timeout. The missing Windows Pi receipt was a dependent upload failure, not an independent product or Provider failure. Ubuntu quality passed, and no GitHub API rate-limit response occurred.

The repair gives the `repository doctor` integration suite the same finite 30-second Vitest budget already used by the real Git/process suites. It changes test-harness tolerance only; the Doctor command, product runtime, and privacy contract are unchanged. In the isolated repair worktree, the focused Doctor suite passed 11/11 and the full local suite passed 52/52 files / 423/423 tests. The main run failure remains retained.

## Repair verification

PR #45 passed all Windows/Ubuntu quality, Pi Evidence, Task 7 containment, and Task 7 Evidence gates. The exact repaired main run [`31167482153`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31167482153) for merge `17993a1` passed the same six jobs, including the previously failing Windows Doctor CLI test. This restores `MAIN_CI_PASS` for the checked-in implementation while leaving the real Task 12 pilot `NOT_PROVEN`.

## Provider-scope evaluator hardening (2026-08-07)

The Task 12 evaluator now fails closed with zero-tolerance `STOP` when a pilot Evidence set records an acknowledged Provider send while its frozen operator scope is `NO_PROVIDER_REQUESTS`; it uses the frozen plan policy even if the Evidence scope is forged. `NO_PROVIDER_REQUESTS` is reserved for preflight/negative fixtures and cannot produce daily-use `GO`; a real daily-use run requires explicit operator authorization. Focused regression tests reproduced the prior incorrect `GO` and `NOT_PROVEN` outcomes and now pass with the new gate. This is provider-policy contract hardening only; no Provider request, credential, or external repository was used, and the real pilot remains `NOT_RUN` / `NOT_PROVEN` pending its separately authorized target and observation Archive.

PR #47 merged as `c3aa454`; exact main CI [`31176158257`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31176158257) passed Windows/Ubuntu quality, Pi Evidence, both Task 7 containment jobs, and Task 7 Evidence. The Windows Task 7 attempt-1 `TEST_EXECUTION` receipt was preserved and its narrow retry passed. A separate local full-verify attempt retained an npm `ECONNRESET` at package smoke; the standalone package smoke rerun passed, so this is recorded as external npm registry transport variance, not converted into a product PASS or a new source failure.
