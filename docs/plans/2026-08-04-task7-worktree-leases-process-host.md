# Task 7 — Worktree, leases, and managed process host

- Created: 2026-08-04
- Source baseline: `b77937f689bca859a29c7df22025ce12e875bda4`
- Branch: `codex/task7-worktree-process`
- Status: `COMPLETE / LOCAL V2 PASS / INDEPENDENT REREVIEW PASS / REMOTE CI PASS`
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
- bind each workspace generation to its unique prepare operation identity, even when two generations have otherwise identical payload fingerprints;
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
- process startup derives one durable reservation from the start operation identity, binds the complete lease set atomically, and does not let a caller select another reservation key;
- an external Host or second session cannot replay the start operation, release its leases, or reuse a bound lease;
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

Windows fixtures include spaces, non-ASCII names, nested child/grandchild processes, long output, timeout, explicit cancellation, open log handles, literal exit code 259, junction traps, and branch/worktree long paths. Windows Managed execution requires a proven process-tree containment adapter; absence or ambiguity is `BLOCKED`, never a portable-success inference.

Ubuntu runs the same provider-neutral contracts with a subreaper-owned process tree. A detached descendant that closes stdout/stderr remains active until `/proc` parentage is empty; missing canonical Python/subreaper support is `BLOCKED`, not a process-group fallback. CI identity receipts must bind the exact source, verifier, Node, Git, platform, schemas, tests, configuration, lockfile, and CI matrix.

### Cluster 5 — Evidence and closeout

- generate strict redacted Task 7 Evidence v2 envelopes that bind the exact clean source commit, full implementation/test/config/CI input set, and a distinct verifier fingerprint;
- scan for credential-shaped content, raw private prompts, and device-local absolute paths;
- run focused suites, full `npm run verify`, and `git diff --check`;
- obtain an independent code review;
- push one focused branch, create one PR, wait for actual Windows/Ubuntu and aggregate gates, merge only on exact PASS, then verify main and clean the topic branch/worktree safely.

## Hard stops

Stop Task 7 immediately on any reproducible source loss, cleanup outside an exact owned target, escaped matching child process, overwritten live lease, ambiguous terminal finality, credential/private-path leakage, or requirement to weaken fail-closed behavior. Preserve the fixture and failure history for diagnosis.

No Task 7 fixture may call Pi or a model Provider. A future real-repository pilot requires Task 7 PASS plus separate owner authorization in its owning task.

## Completion evidence

The handoff records every RED and GREEN command, focused/full local result, exact source and Evidence digest, Windows/Ubuntu CI URL and conclusion, skipped or `NOT_PROVEN` capability, branch/worktree disposition, and the fact that Task 8 has not started.

## Local disposition

Clusters 1–5 produced an initial implementation and preserved local receipts, but independent review reproduced source-loss, lease-race, detached-process, and verifier-identity gaps. Those receipts remain preserved and superseded without being rewritten or deleted. A later review of the first replacement receipts found additional fail-closed gaps around included Git configuration, cross-host operation replay, stale cleanup identity, owner-reconciler validation, post-remove ambiguity, Linux PID reuse, source revalidation, and Ubuntu identity. Commit `869e456c9d5feaa86dd4b359908bb3e2f7884812` remediates those findings without broadening the public Provider-neutral boundary.

Windows and Ubuntu attempt #3 receipts bind that exact clean source and pass their applicable local matrices. A subsequent full-suite run exposed only a fixture-duration boundary: one real-Git preparation case took 5720 ms under parallel load and exceeded Vitest's default 5000 ms despite passing alone in 3312 ms. Commit `ea38a6b5f397bdc1ddb6d16b4e7dbe1ca3d2d7cd` gives that case the same explicit 15-second bound already used by comparable real-Git fixtures; its Workspace file rerun passes 22/22. Attempt #4 receipts bind that source and remain preserved.

A further independent rereview reproduced two remaining hard stops: a caller could select another durable process-reservation key across Hosts, and two workspace generations could collide when distinct prepare operations reused one payload fingerprint. Commit `d47c4decfb6c857160004aa602f93d99b9943538` removes the caller-selected reservation identity, derives it from the canonical start operation, and binds each workspace fingerprint to its unique prepare operation. The new RED cases failed on the old implementation; the minimum GREEN cases pass 4/4, the complete Workspace/Host files pass 34/34, and attempt #5 Windows/Ubuntu receipts pass their applicable matrices.

The v2 Ubuntu parser failure, attempts #3/#4, the full-suite timeout, both reproduced rereview failures, and every earlier result remain retained. The current failure envelope is v3 because failures after source identification now require the exact source and verifier identities; successful platform and consistency envelopes remain v2. Attempt #5 passed its exact five-file and full local gates, and final independent rereview confirmed both reproduced hard stops were closed with no new Critical or Important finding.

PR #16 CI run `30918642613` then preserved two fixture-timing failures in the otherwise passing base matrix: Windows' structured-argv process fixture exceeded Vitest's default five seconds, while Ubuntu reached the detached-child assertion after its fixed 1.5-second lifetime had already elapsed. Both standalone Task 7 containment jobs and their identity aggregate passed in that run. Commit `135febd20e0b317ea9b631269530c3ec341bb3c9` gives the Windows real-process case an explicit 15-second bound and replaces the Ubuntu wall-clock assumption with an explicit release-file gate. Attempt #6 passed the resulting local gates.

Independent review then found that merely waiting 150 ms before releasing the child could still allow a false positive if helper shutdown, rather than the detached child, kept finality pending. Commit `75e4a17d4ecd9d8c1243a8746c1c2790745bdc03` removes that race: before release, the fixture must observe `EXITED / ACTIVE / CLOSED / PENDING` from the Host heartbeat and prove the detached PID is live. Windows and Ubuntu exact platform files pass, and attempt #7 is the selected local pair. The exact five-file gate passes 65/65, full `npm run verify` passes 295/295 plus every smoke, strict Evidence passes 10/10, and the count-only privacy scan is clean. Independent closure review confirms the prior Important is closed, reports no Critical or Important finding, and recomputes the selected identities and counts. PR #16 CI run [`30923849375`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30923849375) then passes both base platforms, both exact Task 7 containment jobs, the Task 7 identity aggregate, and the Pi Evidence identity aggregate on head `c2079bec7fdb9beafee5afbf5314b98e8b50f115`. Task 8 remains `NOT_STARTED`. See [Task 7 validation](../validation/2026-08-04-task7-worktree-process.md).
