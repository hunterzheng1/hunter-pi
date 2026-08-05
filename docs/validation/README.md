# Validation

Validation records bind claims to exact artifacts, source digests, environments, and observed behavior. Research and official documentation do not substitute for these receipts.

- [2026-08-03 — Task 4 fixed Pi public-interface validation](2026-08-03-task4-pi-public-interface.md)
- [2026-08-03 — Task 5 hpi product-shell validation](2026-08-03-task5-hpi-product-shell.md)
- Machine-readable receipts are stored under [`evidence/`](evidence/).
- Task 7 worktree, lease, process-finality, and local Windows/Ubuntu fixture results are recorded in [2026-08-04-task7-worktree-process.md](2026-08-04-task7-worktree-process.md).

Committed Evidence must use allowlisted schemas and must not contain credentials, private prompts, full environment dumps, or absolute user paths. A missing or unexecuted platform remains `PENDING`, `BLOCKED`, or `NOT_PROVEN`; it is never filled with an inferred pass.
