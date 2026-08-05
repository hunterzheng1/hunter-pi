# Linux process-tree hosted validation

## Symptom and retained history

At source head `557c3d0`, the hosted Ubuntu full quality job passed the ordinary 45-file suite but timed out the focused `times out and reconciles the exact nested process tree` test at its bounded 30-second test budget. The independent Task 7 Ubuntu probe failed at the same `TEST_EXECUTION` stage. The failed structured receipts were retained in PR run [`31028497285`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31028497285); a failed-job rerun kept the quality job green but reproduced the Task 7 probe failure. No source-identity, privacy, or Evidence-parser failure was involved.

The local Windows focused suite and a clean Ubuntu temporary copy passed, which narrowed the issue to the Linux hosted process-tree reconciliation path under runner scheduling rather than to the workflow contracts or ordinary Vitest suite.

## Fix

Commit `b2906ab` replaces the Linux helper's serial whole-`/proc` enumeration with a bounded owned-tree walk. Each scan follows only `/proc/<parent>/task/*/children`, verifies the observed process still has the expected parent, ignores only documented concurrent `ENOENT`/`ESRCH` races, and continues to discover descendants reparented to the subreaper. The existing two-complete-empty-scan finality rule and pidfd identity checks remain unchanged. A contract test fails if the generated helper regresses to unrelated whole-`/proc` enumeration.

## Verification

- Local: 46 files / 362 tests passed; lint, typecheck, format, strict compiler smoke, build, external package smoke, clean install smoke, Pi interface probe, developer-preview packaging, and Windows portable packaging passed.
- Local Windows focused platform suite: 9/9 passed.
- Local Ubuntu focused platform suite: 7 passed / 2 Windows-only skipped.
- Earlier exact PR CI [`31032218373`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31032218373): Windows and Ubuntu quality passed; both Task 7 containment jobs passed; Task 7 Evidence and Pi Evidence consistency passed for the pre-hardening source. Replacement PR CI for the reviewed source is pending.

## Limits

This proves the provider-neutral disposable-fixture process boundary for the exact PR source. It does not prove real user-repository safety, broad Provider reliability, a signed release, exact main CI, or Task 12 daily-use acceptance. Those remain `NOT_PROVEN` or `PENDING`.
