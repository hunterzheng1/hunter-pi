# Plans

## Status

Tasks 0–8 are complete within their recorded bounds. Task 6 product/Evidence commit `502011b8a34e9773e415643b01a838c04d5582c5` passed PR #15, documentation HEAD `3c4d5e5200f29a70a607fa6d40be63a6c99b92c9` passed the final PR gates, and merge `b77937f689bca859a29c7df22025ce12e875bda4` passed exact Windows, Ubuntu, and aggregate Evidence main CI. Task 7 merge `91500066b3e809b92b0ab0e985adb165b2276746` passed the exact Windows/Ubuntu quality, containment, and Evidence main gates after one retained Ubuntu nested-process timeout rerun. Task 8 merge `bbb409c282741431b75e7303b27154755c86ffd1` passed exact Windows/Ubuntu quality, containment, Task 7 Evidence, and Pi Evidence main gates after one retained initial PR failure run. Docs follow-up merge `75c35adb759a7379a290179f4274c5182a03c118` also passed exact main CI after one retained Ubuntu containment rerun. CI-history follow-up PR #20 retains two additional Ubuntu nested-process test timeouts and applies only a bounded test-timeout adjustment; its replacement CI is pending. The real request remains bounded to disposable fixtures; broader Provider reliability and real-repository safety are not proven.

Task 7 is complete within its disposable-fixture scope. Owner-authorized repository-wide fixture scheduling closed the retained full-suite blocker, but PR run `30966180228` then reproduced a Linux orphan-reparenting race in the base Ubuntu job. Source `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` serializes termination and complete process-tree scans and produced locally passing attempt #13 Evidence. Independent rereview retained the later single mixed-stress timeout without relabelling it, but exact clean and process-table-pressure reproduction closed it as non-reproducible host/test-scheduling history. Successive reviews then found that attempt #13 omitted the pure Linux-finality test from its verifier fingerprint and that locally passing attempt #14 omitted the active Vitest resource runtime/global setup. Both remain historical; the broad source digest covered the latter inputs, so the second finding is P2 rather than a runtime P1. Replacement source `0580778b260c944da06fdac2d809a0db7e5f7df5` and append-only v4/v5 attempt #15 Evidence pass the exact local Windows/Ubuntu, consistency, privacy, and 302/302 full verification gates. Independent exact-head rereview passed with no P0/P1/P2 findings. PR run `30977216739` passed after its Ubuntu Task 7 job was rerun once without source changes; main merge `91500066b3e809b92b0ab0e985adb165b2276746` also passed after one retained Ubuntu quality-job timeout rerun in `30979052589`. Task 8 is now complete within its deterministic receipt-fixture scope; its detailed result and preserved CI history are in [2026-08-05 — Task 8 verification adequacy](2026-08-05-task8-verification-adequacy.md). Real repositories and Provider requests remain prohibited during Task 8.

The owner selected MIT in ADR-0006. The root `LICENSE`, `NOTICE.md`, and `docs/provenance/` policy must remain committed before executable code, and every external source port requires a specific record.

The next implementation sequence is defined in:

- [2026-08-03 — Foundation to daily use](2026-08-03-foundation-to-daily-use.md)
- [2026-08-04 — Task 7 worktree, leases, and process host](2026-08-04-task7-worktree-leases-process-host.md)
- [2026-08-05 — Task 8 verification adequacy and review/fixback](2026-08-05-task8-verification-adequacy.md)

Only one task is active at a time. Selecting a task does not authorize later tasks, a Pi/OMP fork, desktop work, publishing, paid model use, or external production writes unless the owner explicitly expands the scope.

## Execution rules

- Work in an isolated topic branch/worktree after the initial repository commit.
- Freeze exact task outcomes, non-goals, source baseline, and acceptance commands.
- Use RED → GREEN → REFACTOR for behavior.
- Keep Pi integration behind the Engine Host Interface.
- Run focused checks after each meaningful cluster and full task gates before commit.
- Preserve real failures, skipped tests, and pending CI.
- A task's Stop condition pauses later tasks until the owner accepts a new decision.
- Clean merged/abandoned branches and worktrees only after unique-work and open-PR checks.
