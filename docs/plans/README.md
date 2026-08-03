# Plans

## Status

Tasks 0–4 are complete and merged. Task 5 is implemented locally through its automated developer-preview boundary: `hpi`, isolated setup, honest Doctor, Provider disclosure/login handoff, Core-only Safe Mode resource planning, Quick Session, explicit manual TUI smoke acknowledgement state, and a clean single-tarball install all exist. Safe Mode does not imply global mediation of fixed-Pi built-in slash commands; that boundary is visible and `ProviderRequests` remains `NOT_PROVEN` in blocked-prompt smoke/login modes. Task 5 remote Windows/Ubuntu CI, exact bundled-Core Windows TUI execution, and a real Windows terminal smoke are still pending; real Provider login/request remains separately authorized and `NOT_PROVEN`. Task 6 must not start merely because a Pi process exits.

The owner selected MIT in ADR-0006. The root `LICENSE`, `NOTICE.md`, and `docs/provenance/` policy must remain committed before executable code, and every external source port requires a specific record.

The next implementation sequence is defined in:

- [2026-08-03 — Foundation to daily use](2026-08-03-foundation-to-daily-use.md)

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
