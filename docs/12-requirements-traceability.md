# Requirements traceability

This matrix assigns each designed user outcome and non-functional family to an implementation task. Assignment is not proof of implementation; the task's receipts must replace `DESIGNED` with an actual result.

## User stories to tasks

| Task | Primary user stories | Required milestone evidence |
|---|---|---|
| Task 1 — Engineering skeleton | enabling work only | owner-selected license/NOTICE gate, clean install/build/test/package smoke, actual Windows/Ubuntu CI |
| Task 2 — Domain/Kernel/Fake | HP-US-020, HP-US-023, HP-US-024, HP-US-052, HP-US-053 | strict schemas, transition scenarios, Fake Host contracts, fork threshold represented in capability outcomes |
| Task 3 — Events/Evidence | HP-US-005, HP-US-027, HP-US-031 | crash/fault replay, redaction/data-category corpus, deterministic summary |
| Task 4 — Pi spike | HP-US-003, HP-US-012, HP-US-030, HP-US-052, HP-US-053 | fixed-version Extension/JSON/RPC/SDK receipts on Windows and Ubuntu |
| Task 5 — Product Shell | HP-US-001–005, HP-US-010, HP-US-012, HP-US-042 | clean external install, Doctor privacy, provider disclosure/login cancellation, Quick Session, Safe Mode, raw Pi coexistence |
| Task 6 — Managed fixture slice | HP-US-011, HP-US-020, HP-US-022–025, HP-US-027 | disposable fixture promotion/dirty-state assignment, real failed Attempt, fixback Attempt, independent Verification, review, deterministic value scorecard |
| Task 7 — Worktree/process | HP-US-021, HP-US-031 | dirty/unique-work preservation, process-tree containment, reconnect/cancel receipts |
| Task 8 — Adequacy/fixback | HP-US-022–027 | selected/executed/passed accounting, stale reuse rejection, Human Receipt, blocking findings |
| Task 9 — Recovery/archive | HP-US-030–033 | forced interruption matrix, identity reconciliation, outcome/archive separation, archive replay, clean second-device clone/import fixture and portable-device limits |
| Task 10 — Plugins | HP-US-040–043 | exact package provenance, effective tool graph, separate Compatibility/Trust/Isolation receipts, broken-plugin Safe Mode |
| Task 11 — Update/package | HP-US-001, HP-US-050–052 | clean artifact install, qualified candidate, failed update, rollback, dependency/license inventory |
| Task 12 — Daily-use pilot | all P0 stories and selected P1 stories | ten-task Windows pilot, actual final CI, privacy/hash gates, GO/REVISE/STOP decision |

## NFR families to tasks

| NFR family | First owning task | Final proving task |
|---|---|---|
| Reliability (`REL`) | Tasks 2–3 | Tasks 7–9 and 12 |
| Performance (`PERF`) | Tasks 3 and 5 | Task 12 measured pilot |
| Platform/portability (`PORT`) | Task 1 | Tasks 4, 7, 11, and 12 |
| Security/privacy (`SEC`) | Tasks 3 and 5 | Tasks 7, 10, 11, and 12 |
| Compatibility (`COMP`) | Task 2 | Tasks 4, 10, and 11 |
| Observability (`OBS`) | Task 3 | Tasks 6, 8, 9, and 12 |
| Maintainability (`MAINT`) | Task 1 | every PR plus Task 11 release reproduction |
| Usability (`UX`) | Task 5 | Tasks 6 and 12 |

## Decision gates

| Decision | Earliest evidence | Required action if negative |
|---|---|---|
| Public Pi interfaces are sufficient | Task 4 | Stop Tasks 5+; owner chooses revise, upstream contribution, minimal fork ADR, or abandon |
| Managed workflow adds practical value | Task 6 | Stop scope expansion; simplify/revise or archive the approach |
| Windows containment is safe enough | Task 7 | Stop real-repository use and packaging |
| Standard Pi packages can coexist with core guarantees | Task 10 | Restrict plugin scope or Compatibility/Trust/Isolation claims; revise product promise |
| One-product update/rollback is reliable | Task 11 | Remain developer-only; do not call it daily-use preview |
| Product is ready for daily use | Task 12 | Record `REVISE` or `STOP`; do not proceed automatically to 1.0 |

## Unowned work

The following deliberately have no implementation task in the current plan:

- desktop/mobile applications;
- team and organization governance;
- hosted source or cloud execution;
- automatic deployment/publishing;
- a second production engine;
- broad OMP feature parity;
- Pi/OMP fork maintenance;
- Windows ARM64, macOS, or Linux end-user installers;
- a Hunter-Harness interoperability server.

Adding any of these requires a new owner-approved outcome and plan rather than silently attaching it to an existing task.
