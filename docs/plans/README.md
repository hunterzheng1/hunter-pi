# Plans

## Status

Tasks 0–8 are complete within their recorded bounds. Tasks 9–11 are implemented and pass the local provider-neutral bounds; earlier PR CI run `31023272061` is retained as pre-hardening history, while hardened replacement PR CI run `31042109585` and exact merged-head main CI run `31044936543` pass Windows/Ubuntu quality, containment, and Evidence jobs. Task 12's strict v4 evaluator, explicit plan compiler, exact-plan Evidence binding, and safe `hpi pilot compile`, `hpi pilot preflight`, and `hpi pilot evaluate` CLI are implemented and locally verified; the Provider-request authorization gate is explicit and fail-closed. The merged Task 12 CLI hardening passed PR run `31082027466` and exact main run `31083253052`; the real Windows pilot is `NOT_RUN`. The real request remains bounded to disposable fixtures; broader Provider reliability and real-repository safety are not proven.

Task 7 is complete within its disposable-fixture scope. Owner-authorized repository-wide fixture scheduling closed the retained full-suite blocker, but PR run `30966180228` then reproduced a Linux orphan-reparenting race in the base Ubuntu job. Source `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` serializes termination and complete process-tree scans and produced locally passing attempt #13 Evidence. Independent rereview retained the later single mixed-stress timeout without relabelling it, but exact clean and process-table-pressure reproduction closed it as non-reproducible host/test-scheduling history. Successive reviews then found that attempt #13 omitted the pure Linux-finality test from its verifier fingerprint and that locally passing attempt #14 omitted the active Vitest resource runtime/global setup. Both remain historical; the broad source digest covered the latter inputs, so the second finding is P2 rather than a runtime P1. Replacement source `0580778b260c944da06fdac2d809a0db7e5f7df5` and append-only v4/v5 attempt #15 Evidence pass the exact local Windows/Ubuntu, consistency, privacy, and 302/302 full verification gates. Independent exact-head rereview passed with no P0/P1/P2 findings. PR run `30977216739` passed after its Ubuntu Task 7 job was rerun once without source changes; main merge `91500066b3e809b92b0ab0e985adb165b2276746` also passed after one retained Ubuntu quality-job timeout rerun in `30979052589`. Task 8 is now complete within its deterministic receipt-fixture scope; its detailed result and preserved CI history are in [2026-08-05 — Task 8 verification adequacy](2026-08-05-task8-verification-adequacy.md). Real repositories and Provider requests remain prohibited during Task 8.

The owner selected MIT in ADR-0006. The root `LICENSE`, `NOTICE.md`, and `docs/provenance/` policy must remain committed before executable code, and every external source port requires a specific record.

The current implementation and next evidence gates are defined in:

- [2026-08-03 — Foundation to daily use](2026-08-03-foundation-to-daily-use.md)
- [2026-08-04 — Task 7 worktree, leases, and process host](2026-08-04-task7-worktree-leases-process-host.md)
- [2026-08-05 — Task 8 verification adequacy and review/fixback](2026-08-05-task8-verification-adequacy.md)
- [2026-08-05 — Task 9 checkpoint, recovery, and Archive](2026-08-05-task9-checkpoint-recovery-archive.md)
- [2026-08-05 — Task 10 standard Pi Package manager](2026-08-05-task10-plugin-manager.md)
- [2026-08-05 — Task 11 qualified updates and portable packaging](2026-08-05-task11-qualified-updates.md)
- [2026-08-05 — Task 12 Windows daily-use pilot](2026-08-05-task12-daily-use-pilot.md)

Only one task is active at a time; Tasks 9–12 are a documented sequential-branch exception for contract integration, not a scope expansion. Selecting a task does not authorize later tasks, a Pi/OMP fork, desktop work, publishing, paid model use, or external production writes unless the owner explicitly expands the scope.

## Execution rules

- Work in an isolated topic branch/worktree after the initial repository commit.
- Freeze exact task outcomes, non-goals, source baseline, and acceptance commands.
- Use RED → GREEN → REFACTOR for behavior.
- Keep Pi integration behind the Engine Host Interface.
- Run focused checks after each meaningful cluster and full task gates before commit.
- Preserve real failures, skipped tests, and pending CI.
- A task's Stop condition pauses later tasks until the owner accepts a new decision.
- Clean merged/abandoned branches and worktrees only after unique-work and open-PR checks.
