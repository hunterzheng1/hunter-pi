# Task 7 — Worktree, leases, and managed process host

- Created: 2026-08-04
- Source baseline: `b77937f689bca859a29c7df22025ce12e875bda4`
- Branch: `codex/task7-worktree-process`
- Status: `ACTIVE / LOCAL IMPLEMENTATION IN PROGRESS / REMOTE CI PENDING`
- Scope: provider-neutral, automatically created Git and process fixtures only

## Outcome

Make the Managed Change runtime safe enough to isolate ordinary Git repositories and long-running commands without yet mutating a real user repository. Task 7 succeeds only when exact worktree ownership, writer/resource exclusion, process-tree finality, adversarial cleanup, and branch hygiene are reproducible on Windows and portable contracts pass on Ubuntu.

This task does not send Provider requests, operate on a real user repository, publish an artifact, implement recovery/archive, or authorize Task 8.

## Deep module seams

### Workspace module

The Workspace Interface exposes only three lifecycle operations: prepare an owned worktree, inspect its exact hygiene, and dispose it under a declared policy. Its implementation hides Git invocation, physical-path validation, ownership nonce, source/branch fingerprints, dirty and unique-work detection, reparse-point inspection, long-path handling, and cleanup reconciliation.

Absolute device paths may appear only in an in-process local handle. Portable receipts contain stable identities, fingerprints, relative names, outcomes, and reason codes; they never contain a home, temporary, repository, or worktree absolute path.

### Execution module

The Execution Interface owns exclusive writer/resource leases and managed process sessions. It hides atomic lease publication, expiry/renewal, ownership reconciliation, explicit argv launch, incremental output cursors, heartbeats, timeout/cancel behavior, output-handle draining, and platform containment.

Process exit and a successful kill request are Observations. Terminal finality requires a reconciled owned process tree, closed output handles, and released resource leases.

## Change clusters

### Cluster 0 — Baseline and status

- correct Task 6 merge/main-CI status without rewriting the immutable Task 6 Evidence envelope;
- freeze this Task 7 scope and hard-stop policy;
- establish an isolated short-path Task 7 worktree and passing baseline.

This documentation-only cluster uses formatting, link, privacy, and diff checks instead of a manufactured RED.

### Cluster 1 — Git workspace lifecycle and branch hygiene

RED cases:

- reject a non-root repository, unresolved base commit, destination alias, broad target, or pre-existing destination;
- create an exact clean worktree without changing dirty/staged/untracked content in the source checkout;
- preserve dirty, untracked, staged, unpushed, uniquely committed, or open-review work;
- reject a symlink, junction, reparse-point, hard-link, or resolved cleanup target that can escape the owned worktree;
- report `BLOCKED` rather than `PASS` if Git registration and physical deletion disagree;
- never delete a branch unless its declared recoverability and review state are proven.

GREEN implements the minimum Workspace Interface and strict receipts. REFACTOR centralizes Git execution, path containment, and portable fingerprints behind the Interface.

### Cluster 2 — Writer and resource leases

RED cases:

- two active writers cannot own one workspace;
- conflicting resource sets are rejected atomically without partial acquisition;
- replay by the same operation identity is idempotent, while a changed payload is rejected;
- expiry alone does not let an uncertain live owner get overwritten;
- renewal is monotonic and release by a non-owner is rejected;
- a lease file alias, malformed record, partial publication, or clock rollback fails closed.

GREEN adds file-backed local leases suitable for process boundaries. REFACTOR keeps storage details and atomic publication internal.

### Cluster 3 — Managed process sessions

RED cases:

- argv and cwd are passed without shell reconstruction;
- output is incrementally cursor-addressable, byte-bounded, digest-bound, and explicit about truncation;
- heartbeat distinguishes live, exited, timed-out, cancelled, and unreconciled sessions;
- exit zero, timeout delivery, or cancel acknowledgement alone cannot produce terminal finality;
- finality waits for stdout/stderr closure, process-tree reconciliation, and resource-lease release;
- stale or mismatched process identity is never killed by PID alone.

GREEN implements a portable host and strict session receipts. REFACTOR separates platform containment behind an internal adapter without widening the public Interface.

### Cluster 4 — Platform containment matrix

Windows fixtures include spaces, non-ASCII names, nested child/grandchild processes, long output, timeout, explicit cancellation, open log handles, junction traps, and branch/worktree long paths. Windows Managed execution requires a proven process-tree containment adapter; absence or ambiguity is `BLOCKED`, never a portable-success inference.

Ubuntu runs the same provider-neutral contracts with process-group containment. CI identity receipts must bind the exact source, Node, Git, platform, schemas, and test matrix.

### Cluster 5 — Evidence and closeout

- generate a strict redacted Task 7 Evidence envelope from deterministic fixture results;
- scan for credential-shaped content, raw private prompts, and device-local absolute paths;
- run focused suites, full `npm run verify`, and `git diff --check`;
- obtain an independent code review;
- push one focused branch, create one PR, wait for actual Windows/Ubuntu and aggregate gates, merge only on exact PASS, then verify main and clean the topic branch/worktree safely.

## Hard stops

Stop Task 7 immediately on any reproducible source loss, cleanup outside an exact owned target, escaped matching child process, overwritten live lease, ambiguous terminal finality, credential/private-path leakage, or requirement to weaken fail-closed behavior. Preserve the fixture and failure history for diagnosis.

No Task 7 fixture may call Pi or a model Provider. A future real-repository pilot requires Task 7 PASS plus separate owner authorization in its owning task.

## Completion evidence

The handoff records every RED and GREEN command, focused/full local result, exact source and Evidence digest, Windows/Ubuntu CI URL and conclusion, skipped or `NOT_PROVEN` capability, branch/worktree disposition, and the fact that Task 8 has not started.
