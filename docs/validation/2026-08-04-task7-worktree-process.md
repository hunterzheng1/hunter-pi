# Task 7 — Worktree, lease, and managed-process validation

- Preregistered: 2026-08-04
- Implementation baseline: `b77937f689bca859a29c7df22025ce12e875bda4`
- Selected v2 Evidence source: `75e4a17d4ecd9d8c1243a8746c1c2790745bdc03`
- Branch: `codex/task7-worktree-process`
- Local platforms: Windows x64 and Ubuntu 22.04 x64 under WSL
- Provider requests: `NOT_RUN`
- Real user repositories: `NOT_RUN`
- Task result: **LOCAL V2 PASS / INDEPENDENT REREVIEW PASS / REMOTE CI PENDING / TASK 8 NOT_STARTED**

## Independent-review disposition

The pre-push independent review found reproducible hard-stop gaps: repository hooks and filters could execute; ignored files could be deleted; same-shape source content drift and post-create failures could orphan a worktree; physical/registration mismatch emitted no receipt; lease inspection could race launch and lease generations could be stranded between two publications; a detached Linux descendant could escape the process group; Windows exit code 259 was ambiguous; OS-bound strings admitted NUL; and Evidence did not bind its verifier/CI definition.

The seven v1 receipts below remain immutable historical observations, but none is selected as Task 7 completion Evidence after that review. The first replacement v2 pair also remains preserved: a later review found that included Git configuration could still activate filters, a second Host could replay a process operation without recovering the original process identity, stale disposal intent did not bind a workspace generation, invalid owner-reconciler output fell through as `DEAD`, and Linux PID signalling still had a reuse window. It also found missing branch-only compensation, post-remove ambiguity receipts, final-receipt state constraints, source revalidation, Ubuntu distribution qualification, and hard-link coverage.

Commit `869e456c9d5feaa86dd4b359908bb3e2f7884812` remediates those findings. Attempt #3 Windows and Ubuntu receipts bind that exact clean commit and pass the expanded local matrix. The subsequent full-suite run retained one non-assertion failure: the first real-Git Workspace case took 5720 ms under parallel load and exceeded Vitest's default 5000 ms, while the same case passed alone in 3312 ms. Commit `ea38a6b5f397bdc1ddb6d16b4e7dbe1ca3d2d7cd` applies the explicit 15-second case bound already used by comparable real-Git fixtures; the Workspace file rerun passes 22/22 and attempt #4 binds that source.

The next independent rereview still reproduced two Critical gaps on `c188695`: changing a caller-supplied bind operation identity let the same start operation launch once in each Host, and distinct prepare operations with the same payload fingerprint produced the same workspace-generation fingerprint, letting stale disposal delete the replacement generation. Commit `d47c4decfb6c857160004aa602f93d99b9943538` derives the only durable process-reservation key from the canonical start operation, rejects caller-selected bind identities, and includes the unique prepare operation in workspace fingerprint v2. Attempt #5 is the selected local pair.

Final independent rereview of `eda8274` confirms both Critical findings are closed: old-generation disposal is blocked while the replacement directory remains, and exact or changed-payload start reuse in another Host stops before a second driver call. It found no new Critical or Important correctness issue, independently reconciled the 65 focused and 295 full test counts, and recomputed the attempt #5 source/verifier/receipt identities. Actual PR/main CI are still required.

## Frozen outcome and limits

Task 7 establishes provider-neutral workspace, lease, and managed-process boundaries before a Managed Change may operate on a real user repository. All mutations in this task use automatically created disposable Git or process fixtures. It does not connect the Task 6 CLI slice to a real repository, call Pi or a model Provider, implement recovery/archive, publish a package, or authorize Task 8.

A process exit, timeout delivery, cancellation acknowledgement, terminal idle state, or closed window remains an Observation. Managed-process terminal finality proves only that the owned tree is empty, stdout/stderr are closed, and declared leases are reconciled; it never proves a Step or Change succeeded.

## Implemented boundaries

### Workspace Interface

The public workspace module exposes prepare, inspect, and dispose operations while keeping Git commands, ownership nonces, physical paths, and cleanup mechanics private. Its disposable Git fixtures prove:

- an exact clean worktree is created from the declared repository root and base commit without changing dirty, staged, or untracked source-checkout bytes;
- operation replay is idempotent and a changed payload conflicts;
- dirty/untracked content, unique commits, unpushed work, review-dependent branches, and ambiguous cleanup are preserved;
- effective included Git configuration is enumerated before mutation, filter drivers are neutralized, and conditional or worktree-specific configuration surfaces fail closed;
- stale disposal intent binds the exact workspace fingerprint and cannot remove a replacement generation;
- symlink, junction/reparse, hard-link, existing-target, destination-race, and Windows current-directory lock cases fail closed;
- portable receipts contain relative identities and fingerprints, not device-local absolute paths.

### Writer and resource leases

The file-backed lease module publishes each operation receipt and all resulting generations as one immutable transaction under an exact physical state root. Managed-process startup atomically reserves its operation and binds its complete lease set to one session fingerprint before launch, including an empty lease set; only that binding may release owned leases. A different Host cannot turn a replayed reservation into a second external process when the original identity is unavailable. The focused suite proves one active writer per workspace, atomic resource-set exclusion, monotonic renewal, non-owner/binding release rejection, idempotent replay, pre-commit crash cleanup, and fail-closed handling of clock rollback, malformed committed transactions, aliases, and hard links. Expiry alone never authorizes takeover: owner liveness must parse as exactly `DEAD`; invalid or `NOT_PROVEN` reconciliation preserves the lease.

### Managed process host

The public host accepts an explicit executable, argument array, physical cwd, explicit target environment, timeout, output budget, and optional lease bindings. Receipts store fingerprints and bounded counters rather than raw command text, environment values, paths, or output. Incremental stdout/stderr chunks remain local; the portable receipt retains full-stream digest, observed/retained bytes, cursor, EOF, and truncation state.

The production factory has no shell or PID-only fallback:

- Windows creates a Job Object with `KILL_ON_JOB_CLOSE`, restricts inherited handles, creates the target suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, verifies membership, and only then resumes it. The helper checks `WaitForSingleObject` before reading the exit code, so literal code 259 is not confused with `STILL_ACTIVE`; finality still waits for an empty Job and both output pipes at EOF.
- Ubuntu uses canonical `/usr/bin/python3` to establish `PR_SET_CHILD_SUBREAPER` before executing a dedicated Node helper as the exact process-group and session leader. The helper follows `/proc` parentage and repeatedly identity-checks all live descendants, including a `setsid` child with closed stdio. Final signalling opens a Linux pidfd before rechecking `/proc` start time and signals through that descriptor, so PID reuse cannot redirect the termination request. Its private control protocol is separate from target stdout/stderr; missing subreaper or pidfd prerequisites fail closed without a weaker fallback.
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

The replacement implementation defines strict v2 successful platform and consistency schemas. Historical v1/v2 failure envelopes remain parseable; current failures use strict v3 so every failure emitted after source identification binds the exact source commit, source digest, source pathspec, and verifier fingerprint. Before and after hashing or test execution, the probe requires the exact source commit and entire Git worktree to remain clean. Its source digest covers all application/package implementation, scripts, tests, tools, lockfile, Node/npm/build/lint/format/test configuration, and the pinned CI workflow; a separate verifier fingerprint binds the exact parser, comparator, focused tests, configuration, lockfile, and CI definition. Cross-platform consistency includes the exact source commit and rejects a verifier/pathspec mismatch. Linux receipts qualify `/etc/os-release` as Ubuntu rather than relabelling an arbitrary Linux host.

| V2 artifact | Actual result | Disposition |
|---|---|---|
| [`windows-local-v2.json`](evidence/task7/windows-local-v2.json) | `PASS`, 9/9 checks | preserved attempt #1 from `bafbffd`; superseded because the Linux skip parser then changed |
| [`ubuntu-wsl-v2-attempt-1.json`](evidence/task7/ubuntu-wsl-v2-attempt-1.json) | `NOT_PROVEN / REPORT_PARSE`, test exit 0 | preserved exact failure: Vitest emitted `skipped`, while the preregistered parser expected `pending` |
| [`windows-local-v2-attempt-2.json`](evidence/task7/windows-local-v2-attempt-2.json) | `PASS`, 9/9 checks | preserved first replacement Windows receipt; superseded after later review |
| [`ubuntu-wsl-v2-attempt-2.json`](evidence/task7/ubuntu-wsl-v2-attempt-2.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks | preserved first replacement Ubuntu receipt; superseded after later review |
| [`local-consistency-v2.json`](evidence/task7/local-consistency-v2.json) | `PASS / remoteCi=PENDING` | preserved first replacement aggregate; superseded after later review |
| [`windows-local-v2-attempt-3.json`](evidence/task7/windows-local-v2-attempt-3.json) | `PASS`, 9/9 checks, 14387 ms | preserved post-review Windows receipt; superseded after the full-suite fixture timeout |
| [`ubuntu-wsl-v2-attempt-3.json`](evidence/task7/ubuntu-wsl-v2-attempt-3.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 5881 ms | preserved post-review Ubuntu receipt; superseded after the full-suite fixture timeout |
| [`local-consistency-v2-attempt-3.json`](evidence/task7/local-consistency-v2-attempt-3.json) | `PASS / remoteCi=PENDING` | preserved post-review aggregate; superseded after the full-suite fixture timeout |
| [`windows-local-v2-attempt-4.json`](evidence/task7/windows-local-v2-attempt-4.json) | `PASS`, 9/9 checks, 13843 ms | preserved post-timeout Windows receipt; superseded after final rereview |
| [`ubuntu-wsl-v2-attempt-4.json`](evidence/task7/ubuntu-wsl-v2-attempt-4.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 6397 ms | preserved post-timeout Ubuntu receipt; superseded after final rereview |
| [`local-consistency-v2-attempt-4.json`](evidence/task7/local-consistency-v2-attempt-4.json) | `PASS / remoteCi=PENDING` | preserved post-timeout aggregate; superseded after final rereview |
| [`windows-local-v2-attempt-5.json`](evidence/task7/windows-local-v2-attempt-5.json) | `PASS`, 9/9 checks, 16477 ms | preserved post-rereview Windows receipt; superseded after CI timing failures |
| [`ubuntu-wsl-v2-attempt-5.json`](evidence/task7/ubuntu-wsl-v2-attempt-5.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 5859 ms | preserved post-rereview Ubuntu receipt; superseded after CI timing failures |
| [`local-consistency-v2-attempt-5.json`](evidence/task7/local-consistency-v2-attempt-5.json) | `PASS / remoteCi=PENDING` | preserved post-rereview aggregate; superseded after CI timing failures |
| [`windows-local-v2-attempt-6.json`](evidence/task7/windows-local-v2-attempt-6.json) | `PASS`, 9/9 checks, 13123 ms | preserved local Windows receipt; superseded after closure review found a timing false-positive path |
| [`ubuntu-wsl-v2-attempt-6.json`](evidence/task7/ubuntu-wsl-v2-attempt-6.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4445 ms | preserved local Ubuntu receipt; superseded after closure review found a timing false-positive path |
| [`local-consistency-v2-attempt-6.json`](evidence/task7/local-consistency-v2-attempt-6.json) | `PASS / remoteCi=PENDING` | preserved aggregate; superseded after closure review found a timing false-positive path |
| [`windows-local-v2-attempt-7.json`](evidence/task7/windows-local-v2-attempt-7.json) | `PASS`, 9/9 checks, 14176 ms | selected local Windows receipt after proving the pre-release heartbeat state |
| [`ubuntu-wsl-v2-attempt-7.json`](evidence/task7/ubuntu-wsl-v2-attempt-7.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4395 ms | selected local Ubuntu receipt after proving the pre-release heartbeat state |
| [`local-consistency-v2-attempt-7.json`](evidence/task7/local-consistency-v2-attempt-7.json) | `PASS / remoteCi=PENDING` | selected local aggregate; exact commit, source digest, verifier, command, test, and applicability matrix match |

The selected pair binds source commit `75e4a17d4ecd9d8c1243a8746c1c2790745bdc03`, source digest `sha256:0fbe502e463fc3c3745d3cf898067bf20a16540740c37100039a46c7663b4206`, and verifier fingerprint `sha256:eebaf5e25808846242895c70c6ae6adb6cfb369b5bede5a7ce7f368100e825a2`.

The selected artifact SHA-256 values are:

- Windows attempt #7: `6f67960246689fb573214eb5b55389bcc02ae7af4d5f3da081a62c155f88f204`;
- Ubuntu attempt #7: `732a4b8d62c72a25f5f9acf8c58306244454f134e6f1612a3d241184caa29c6b`;
- local consistency attempt #7: `a2bdee2f3b77b5da107659aa7ac2b9cf10049fe567f914be109a79ef40d688d0`;
- preserved Ubuntu v2 failure: `ab1751beec9ccc1ffbc2dbaa9758acdd9aa04a02e0c10575573cd9fa525c5c66`.

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
| Workspace | public factory absent; reviews later reproduced hook/filter execution, included-filter source loss, ignored-file loss, content drift, orphan creation, stale cleanup, and registration mismatch | disposable Git/worktree fixtures cover effective config, link, destination-race, identity, and cleanup reconciliation boundaries |
| Leases | manager absent; reviews later reproduced inspect/start, cross-host replay, invalid-owner, and two-publication races | transaction/binding/storage fixtures cover non-empty and zero-resource operation reservation plus strict owner reconciliation |
| Portable process host | host absent; reviews later reproduced lease reuse, unverifiable replay, invalid final receipts, and NUL admission | host/finality/binding contract fixtures fail closed before any duplicate external process effect |
| Platform containment | factory absent; reviews later reproduced detached Linux escape, PID-reuse signalling risk, and Windows 259 ambiguity | Windows 9/9 and Ubuntu 7 applicable + 2 Windows-only `NOT_RUN` real process-tree checks pass |
| Evidence | comparator absent; reviews later reproduced incomplete source/verifier inputs, source revalidation, and Linux-distribution gaps | strict historical/current schema, privacy, comparison, clean-source, output-path, link, distro, and committed-history fixtures pass |

The first full-suite invocation after the workspace cluster timed out without a reproducible assertion failure. No residual test process remained; a correct `npm test` rerun passed, and the failure was not rewritten as a PASS. During remediation, a five-file run reached 48/52 before four Windows Workspace cases exceeded Vitest's five-second default; the fixture process was reconciled, explicit 15-second case bounds were added, and the exact rerun passed 52/52. After follow-up hardening, a full-suite run passed 293/294 tests but retained one equivalent duration failure: the first real-Git case took 5720 ms under parallel load, then passed alone in 3312 ms and as part of the 22/22 Workspace file after receiving the same explicit 15-second bound. Both formal parser failures and this full-suite timeout remain retained rather than rewritten as PASS.

The final rereview RED command then failed all three selected bypass cases: two workspace generations produced an equal fingerprint, while second Hosts with zero leases or another valid lease resolved a second `STARTED` receipt after changing the caller-selected reservation identity. After deriving the reservation from start identity and binding workspace generation to prepare identity, the minimum GREEN selection passes 4/4; complete Workspace and Managed Host files pass 34/34. The public start schema now rejects an independent bind identity before driver startup.

The Ubuntu attempt #4 launcher also preserves two pre-probe failures: the first invocation carried a PowerShell BOM into Bash and used an incorrectly expanded SHA; the second allowed the Windows/WSL argument boundary to split a multiline `bash -lc` program. Neither reached `npm ci` or the platform probe, neither generated a receipt, and no fixture remained. The third evidence-based invocation used an explicit temporary shell file, checked the exact commit, passed the probe, removed its temporary clone through a validated trap, and then deleted the launcher file.

## Superseded local verification

The pre-review local branch state completed these gates on Windows x64; they are retained as historical results and do not satisfy the replacement v2 gate:

- the five focused workspace, lease, portable process-host, platform, and Evidence files passed 40/40 tests;
- `npm run lint` and `npm run typecheck` exited 0;
- `npm test` passed 36 files and 270 tests;
- `npm run build` and `npm run format:check` exited 0;
- full `npm run verify` exited 0 in 490.7 seconds, including strict compiler, external package, single-artifact, clean-install, and fixed Pi public-interface smokes;
- the post-hardening `npm run probe:task7` passed the exact Windows 6/6 matrix, and `npm run compare:task7-evidence` matched it against the preserved Ubuntu receipt while retaining `remoteCi=PENDING`;
- strict tests parse and privacy-scan every committed Task 7 receipt and recompute both local consistency artifacts.

## Selected attempt #7 local verification

- Windows passes the exact platform file 9/9. A fresh locked Ubuntu WSL clone passes 7 applicable checks with 2 Windows-only checks skipped. The exact five-file command for source `75e4a17` passes 65/65 in 73.7 seconds.
- A disposable Ubuntu 22.04 WSL clone passes the exact platform matrix with 7 applicable checks and 2 Windows-only checks skipped by declared applicability.
- Windows and Ubuntu formal v2 platform attempt #7 receipts and their local consistency receipt pass against the exact identities above.
- `npm run lint`, `npm run typecheck`, platform formatting, and `git diff --check` pass after the heartbeat assertion change. One earlier build overlapped a still-running `tsc --clean` from an aborted parallel check and failed with transient missing `dist` declarations; after confirming zero active build processes, the serial build exited 0 and the failure was not rewritten.
- Full `npm run verify` for source `75e4a17` exits 0 in 408.5 seconds: lint and typecheck pass; 36 test files / 295 tests pass; strict compiler, build, format, external-package, single-artifact, clean-install, and fixed Pi public-interface smokes then pass.
- The Pi public-interface probe reported provider-independent `SUPPORTED` and real Provider `NOT_PROVEN`; Task 7 made no Provider request.
- Strict Evidence passes 10/10. A separate count-only scan over all three attempt #7 receipts finds zero Windows absolute paths, UNC paths, private Windows or POSIX home paths, and credential-assignment shapes; all three file hashes match the selected values above.
- Independent closure review confirms the release gate now observes `EXITED / ACTIVE / CLOSED / PENDING` plus a live detached PID before release, reports no Critical or Important finding, and independently recomputes the selected identities and 65/295 test counts. Remote CI attempt #2 remains `PENDING`; earlier CI results are not inferred.

## CI and remaining boundaries

CI defines independent Windows/Ubuntu Task 7 platform jobs and a strict aggregate identity comparator. PR #16 run [`30918642613`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30918642613) preserved its exact mixed result: both Task 7 containment jobs and the Task 7 identity aggregate passed; the base Ubuntu job failed because the detached child had completed before a fixed-delay `pending` assertion, and the base Windows job failed because the Unicode/structured-argv real-process case exceeded Vitest's default five seconds under full-suite load. Downstream Pi Evidence did not run because both base jobs were required. No Task 7 product assertion failed. Remote status for the changed source remains `PENDING` until CI attempt #2 actually runs. Local WSL execution is useful platform evidence but is not GitHub-hosted Ubuntu CI.

Even after exact CI passes, Task 7 proves these Hunter contracts only within disposable fixtures. It does not prove arbitrary user repositories, hostile kernel/process behavior outside the declared adapter assumptions, real Pi/Provider behavior, recovery after host crash, plugin isolation, a Windows installer, production readiness, or daily-use acceptance. Those claims remain `NOT_RUN` or `NOT_PROVEN` under their later tasks.
