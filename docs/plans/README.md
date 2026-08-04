# Plans

## Status

Tasks 0–6 are complete within their recorded bounds. Task 6 product/Evidence commit `502011b8a34e9773e415643b01a838c04d5582c5` passed PR #15, documentation HEAD `3c4d5e5200f29a70a607fa6d40be63a6c99b92c9` passed the final PR gates, and merge `b77937f689bca859a29c7df22025ce12e875bda4` passed exact Windows, Ubuntu, and aggregate Evidence main CI. The real request remains bounded to its disposable fixture; broader Provider reliability and real-repository safety are not proven.

Task 7 is the only active task. Independent review superseded its earlier local receipts for completion and remediation is active; replacement local Evidence and PR/main CI remain `PENDING`. Its detailed execution and hard-stop rules are frozen in [2026-08-04 — Task 7 worktree, leases, and process host](2026-08-04-task7-worktree-leases-process-host.md). Real repositories and Provider requests remain prohibited during Task 7.

The owner selected MIT in ADR-0006. The root `LICENSE`, `NOTICE.md`, and `docs/provenance/` policy must remain committed before executable code, and every external source port requires a specific record.

The next implementation sequence is defined in:

- [2026-08-03 — Foundation to daily use](2026-08-03-foundation-to-daily-use.md)
- [2026-08-04 — Task 7 worktree, leases, and process host](2026-08-04-task7-worktree-leases-process-host.md)

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
