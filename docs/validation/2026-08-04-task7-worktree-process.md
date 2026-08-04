# Task 7 — Worktree, lease, and managed-process validation

- Preregistered: 2026-08-04
- Implementation baseline: `b77937f689bca859a29c7df22025ce12e875bda4`
- Evidence source: `760518c28cbd7a4b49cdd5e7e9b8b2db3cf71d10`
- Branch: `codex/task7-worktree-process`
- Local platforms: Windows x64 and Ubuntu 22.04 x64 under WSL
- Provider requests: `NOT_RUN`
- Real user repositories: `NOT_RUN`
- Task result: **REMEDIATION ACTIVE / PRIOR LOCAL EVIDENCE SUPERSEDED / REMOTE CI PENDING / TASK 8 NOT_STARTED**

## Independent-review disposition

The pre-push independent review found reproducible hard-stop gaps: repository hooks and filters could execute; ignored files could be deleted; same-shape source content drift and post-create failures could orphan a worktree; physical/registration mismatch emitted no receipt; lease inspection could race launch and lease generations could be stranded between two publications; a detached Linux descendant could escape the process group; Windows exit code 259 was ambiguous; OS-bound strings admitted NUL; and Evidence did not bind its verifier/CI definition.

The seven receipts below remain immutable historical observations, but none is selected as Task 7 completion Evidence after that review. New Windows and Ubuntu receipts must be generated from a clean fixed commit using a verifier-bound schema, pass the expanded adversarial matrix, pass review again, and then pass actual PR/main CI.

## Frozen outcome and limits

Task 7 establishes provider-neutral workspace, lease, and managed-process boundaries before a Managed Change may operate on a real user repository. All mutations in this task use automatically created disposable Git or process fixtures. It does not connect the Task 6 CLI slice to a real repository, call Pi or a model Provider, implement recovery/archive, publish a package, or authorize Task 8.

A process exit, timeout delivery, cancellation acknowledgement, terminal idle state, or closed window remains an Observation. Managed-process terminal finality proves only that the owned tree is empty, stdout/stderr are closed, and declared leases are reconciled; it never proves a Step or Change succeeded.

## Implemented boundaries

### Workspace Interface

The public workspace module exposes prepare, inspect, and dispose operations while keeping Git commands, ownership nonces, physical paths, and cleanup mechanics private. Its disposable Git fixtures prove:

- an exact clean worktree is created from the declared repository root and base commit without changing dirty, staged, or untracked source-checkout bytes;
- operation replay is idempotent and a changed payload conflicts;
- dirty/untracked content, unique commits, unpushed work, review-dependent branches, and ambiguous cleanup are preserved;
- symlink, junction/reparse, hard-link, existing-target, and Windows current-directory lock cases fail closed;
- portable receipts contain relative identities and fingerprints, not device-local absolute paths.

### Writer and resource leases

The file-backed lease module publishes each operation receipt and all resulting generations as one immutable transaction under an exact physical state root. Managed-process startup atomically binds its complete lease set to one session fingerprint before launch, and only that binding may release it. The focused suite proves one active writer per workspace, atomic resource-set exclusion, monotonic renewal, non-owner/binding release rejection, idempotent replay, pre-commit crash cleanup, and fail-closed handling of clock rollback, malformed committed transactions, aliases, and hard links. Expiry alone never authorizes takeover: owner liveness must be independently `DEAD`; `NOT_PROVEN` preserves the lease.

### Managed process host

The public host accepts an explicit executable, argument array, physical cwd, explicit target environment, timeout, output budget, and optional lease bindings. Receipts store fingerprints and bounded counters rather than raw command text, environment values, paths, or output. Incremental stdout/stderr chunks remain local; the portable receipt retains full-stream digest, observed/retained bytes, cursor, EOF, and truncation state.

The production factory has no shell or PID-only fallback:

- Windows creates a Job Object with `KILL_ON_JOB_CLOSE`, restricts inherited handles, creates the target suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, verifies membership, and only then resumes it. The helper checks `WaitForSingleObject` before reading the exit code, so literal code 259 is not confused with `STILL_ACTIVE`; finality still waits for an empty Job and both output pipes at EOF.
- Ubuntu uses canonical `/usr/bin/python3` to establish `PR_SET_CHILD_SUBREAPER` before executing a dedicated Node helper as the exact process-group and session leader. The helper follows `/proc` parentage and repeatedly identity-checks/terminates all live descendants, including a `setsid` child with closed stdio. Its private control protocol is separate from target stdout/stderr; missing subreaper prerequisites fail closed without a weaker fallback.
- A mismatched or unproven identity is not terminated. Adapter or reconciliation ambiguity produces `NOT_PROVEN` and keeps resource ownership conservative.

The Windows sequencing was independently implemented against Microsoft Win32 documentation; the exact external research cross-check and license review are recorded in [Task 7 Windows Job Object provenance](../provenance/2026-08-04-task7-windows-job-object-reference.md).

## Versioned Evidence

The superseded Task 7 receipts use strict `hpi-task7-platform-receipt.v1`, `hpi-task7-platform-failure.v1`, and `hpi-task7-platform-consistency.v1` schemas. Their historical parsers remain available and all seven local records are retained:

| Artifact | Actual result | Disposition |
|---|---|---|
| [`windows-local.json`](evidence/task7/windows-local.json) | `NOT_PROVEN / REPORT_PARSE`, test exit 0 | preserved first probe; Vitest reported two suites for one file/describe, while the preregistered parser expected one |
| [`windows-local-attempt-2.json`](evidence/task7/windows-local-attempt-2.json) | `PASS`, 6/6 checks | preliminary proof after parser correction but before that correction was committed; not selected for final aggregation |
| [`windows-local-attempt-3.json`](evidence/task7/windows-local-attempt-3.json) | `PASS`, 6/6 checks, 11094 ms | formerly selected Windows receipt; superseded after review |
| [`windows-local-attempt-4.json`](evidence/task7/windows-local-attempt-4.json) | `PASS`, 6/6 checks, 10612 ms | post-hardening verification after bounding the probe's own retained diagnostic output; same frozen source identity |
| [`ubuntu-wsl-attempt-1.json`](evidence/task7/ubuntu-wsl-attempt-1.json) | `PASS`, 6/6 checks, 3773 ms | formerly selected Ubuntu receipt; superseded after review |
| [`local-consistency.json`](evidence/task7/local-consistency.json) | `PASS / remoteCi=PENDING` | exact source, command, test file, and six-check identities match |
| [`local-consistency-attempt-2.json`](evidence/task7/local-consistency-attempt-2.json) | `PASS / remoteCi=PENDING` | post-hardening comparator also requires exact source-commit equality; remote status is unchanged |

The formerly selected receipts bind source commit `760518c28cbd7a4b49cdd5e7e9b8b2db3cf71d10` and source digest `sha256:931b2455ee644a70e047f67e5295386e239594692e0095d1739e374183370d6f`. Their incomplete source pathspec excluded the verifier and CI definition, which is why they are preserved but superseded.

The replacement implementation defines strict v2 platform, failure, and consistency schemas. Before hashing, the probe requires the entire Git worktree to be clean. Its source digest covers all application/package implementation, scripts, tests, tools, lockfile, Node/npm/build/lint/format/test configuration, and the pinned CI workflow; a separate verifier fingerprint binds the exact parser, comparator, focused tests, configuration, lockfile, and CI definition. Cross-platform consistency includes the exact source commit and rejects a verifier/pathspec mismatch. No v2 receipt is claimed here until both clean-commit platform probes run.

The replacement nine-check platform matrix is required to prove:

1. Unicode/spaced cwd and quote/backslash/metacharacter argv preservation without shell reconstruction;
2. nested child/grandchild cancellation as one owned tree;
3. timeout reconciliation of the exact nested tree;
4. terminal finality remaining pending while a descendant holds inherited output handles;
5. bounded retained output with a digest over every observed byte;
6. identity mismatch causing no platform termination call.
7. a detached closed-stdio descendant remaining non-final until the owned tree is empty.
8. on Windows, a source-level guard requiring kernel signaled-state disambiguation;
9. on Windows, a real process preserving literal exit code 259 after the kernel signals completion.

## Test-first history

| Cluster | RED evidence | GREEN evidence |
|---|---|---|
| Workspace | public workspace factory absent | 11 disposable Git/worktree cases pass |
| Leases | lease manager absent; later a post-initialization junction reproduced an out-of-root write inside a disposable fixture | 10 lease/storage adversarial cases pass after every transaction revalidates all physical roots |
| Portable process host | managed-process factory absent | 6 host/finality contract cases pass |
| Platform containment | production platform factory absent | Windows 6/6 and Ubuntu 6/6 real process-tree cases pass |
| Evidence | evidence/comparator modules absent | strict matrix, privacy, comparison, output-path, link, and committed-history tests pass |

The first full-suite invocation after the workspace cluster timed out without a reproducible assertion failure. No residual test process remained; a correct `npm test` rerun passed, and the failure was not rewritten as a PASS. The first formal platform probe is likewise retained as `NOT_PROVEN` rather than replaced.

## Superseded local verification

The pre-review local branch state completed these gates on Windows x64; they are retained as historical results and do not satisfy the replacement v2 gate:

- the five focused workspace, lease, portable process-host, platform, and Evidence files passed 40/40 tests;
- `npm run lint` and `npm run typecheck` exited 0;
- `npm test` passed 36 files and 270 tests;
- `npm run build` and `npm run format:check` exited 0;
- full `npm run verify` exited 0 in 490.7 seconds, including strict compiler, external package, single-artifact, clean-install, and fixed Pi public-interface smokes;
- the post-hardening `npm run probe:task7` passed the exact Windows 6/6 matrix, and `npm run compare:task7-evidence` matched it against the preserved Ubuntu receipt while retaining `remoteCi=PENDING`;
- strict tests parse and privacy-scan every committed Task 7 receipt and recompute both local consistency artifacts.

The final documentation-only diff still requires a fresh format check, `git diff --check`, allowed-path review, and the exact remote PR jobs before Task 7 may be called merged.

## CI and remaining boundaries

CI now defines independent Windows/Ubuntu Task 7 platform jobs and a strict aggregate identity comparator. They have not yet run for this branch, so remote status remains `PENDING`. Local WSL execution is useful platform evidence but is not GitHub-hosted Ubuntu CI.

Even after exact CI passes, Task 7 proves these Hunter contracts only within disposable fixtures. It does not prove arbitrary user repositories, hostile kernel/process behavior outside the declared adapter assumptions, real Pi/Provider behavior, recovery after host crash, plugin isolation, a Windows installer, production readiness, or daily-use acceptance. Those claims remain `NOT_RUN` or `NOT_PROVEN` under their later tasks.
