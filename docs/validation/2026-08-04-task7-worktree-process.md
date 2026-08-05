# Task 7 — Worktree, lease, and managed-process validation

- Preregistered: 2026-08-04
- Implementation baseline: `b77937f689bca859a29c7df22025ce12e875bda4`
- Selected v2 Evidence source: `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672`
- Branch: `codex/task7-worktree-process`
- Local platforms: Windows x64 and Ubuntu 22.04 x64 under WSL
- Provider requests: `NOT_RUN`
- Real user repositories: `NOT_RUN`
- Task result: **IN_PROGRESS / PLATFORM V2 PASS / FULL LOCAL PASS / INDEPENDENT REREVIEW PENDING / REMOTE CI PENDING / TASK 8 NOT_STARTED**

## Independent-review disposition

The pre-push independent review found reproducible hard-stop gaps: repository hooks and filters could execute; ignored files could be deleted; same-shape source content drift and post-create failures could orphan a worktree; physical/registration mismatch emitted no receipt; lease inspection could race launch and lease generations could be stranded between two publications; a detached Linux descendant could escape the process group; Windows exit code 259 was ambiguous; OS-bound strings admitted NUL; and Evidence did not bind its verifier/CI definition.

The seven v1 receipts below remain immutable historical observations, but none is selected as Task 7 completion Evidence after that review. The first replacement v2 pair also remains preserved: a later review found that included Git configuration could still activate filters, a second Host could replay a process operation without recovering the original process identity, stale disposal intent did not bind a workspace generation, invalid owner-reconciler output fell through as `DEAD`, and Linux PID signalling still had a reuse window. It also found missing branch-only compensation, post-remove ambiguity receipts, final-receipt state constraints, source revalidation, Ubuntu distribution qualification, and hard-link coverage.

Commit `869e456c9d5feaa86dd4b359908bb3e2f7884812` remediates those findings. Attempt #3 Windows and Ubuntu receipts bind that exact clean commit and pass the expanded local matrix. The subsequent full-suite run retained one non-assertion failure: the first real-Git Workspace case took 5720 ms under parallel load and exceeded Vitest's default 5000 ms, while the same case passed alone in 3312 ms. Commit `ea38a6b5f397bdc1ddb6d16b4e7dbe1ca3d2d7cd` applies the explicit 15-second case bound already used by comparable real-Git fixtures; the Workspace file rerun passes 22/22 and attempt #4 binds that source.

The next independent rereview still reproduced two Critical gaps on `c188695`: changing a caller-supplied bind operation identity let the same start operation launch once in each Host, and distinct prepare operations with the same payload fingerprint produced the same workspace-generation fingerprint, letting stale disposal delete the replacement generation. Commit `d47c4decfb6c857160004aa602f93d99b9943538` derives the only durable process-reservation key from the canonical start operation, rejects caller-selected bind identities, and includes the unique prepare operation in workspace fingerprint v2. Attempt #5 is the selected local pair.

Final independent rereview of `eda8274` confirms both Critical findings are closed: old-generation disposal is blocked while the replacement directory remains, and exact or changed-payload start reuse in another Host stops before a second driver call. It found no new Critical or Important correctness issue, independently reconciled the 65 focused and 295 full test counts, and recomputed the attempt #5 source/verifier/receipt identities. Actual PR/main CI are still required.

That historical rereview did not cover the later repository-wide fixture-scheduling change. Source `4ae6735d1d472fe7eb902d38bb625fa182d12611` changed test orchestration and lifecycle cleanup only. A later review of attempt #12 then reproduced an `EMPTY -> ACTIVE -> EMPTY` cancel/timeout gap in the Linux helper's scan accounting. Current source `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` closes that reviewed path and has attempt #13 local Evidence; its independent rereview remains `PENDING`, and no prior review is carried forward as proof for the new head.

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
- Ubuntu uses canonical `/usr/bin/python3` to establish `PR_SET_CHILD_SUBREAPER` before executing a dedicated Node helper as the exact process-group and session leader. One serialized poll owns control delivery, pidfd signalling, and reconciliation. Every complete tree observation sandwiches the non-atomic whole-`/proc` traversal with direct-child snapshots; any active observation or control boundary invalidates an earlier empty candidate. The helper repeatedly identity-checks all live descendants, including staged `setsid` descendants with closed stdio. Final signalling opens a Linux pidfd before rechecking `/proc` start time and signals through that descriptor, so PID reuse cannot redirect the termination request. Its private control protocol is separate from target stdout/stderr; missing subreaper, direct-child visibility, or pidfd prerequisites fail closed without a weaker fallback.
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
| [`windows-local-v2-attempt-7.json`](evidence/task7/windows-local-v2-attempt-7.json) | `PASS`, 9/9 checks, 14176 ms | preserved local Windows receipt; superseded after exact-head CI exposed another fixture-budget failure |
| [`ubuntu-wsl-v2-attempt-7.json`](evidence/task7/ubuntu-wsl-v2-attempt-7.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4395 ms | preserved local Ubuntu receipt; superseded after exact-head CI exposed another fixture-budget failure |
| [`local-consistency-v2-attempt-7.json`](evidence/task7/local-consistency-v2-attempt-7.json) | `PASS / remoteCi=PENDING` | preserved aggregate; superseded after exact-head CI exposed another fixture-budget failure |
| [`windows-local-v2-attempt-8.json`](evidence/task7/windows-local-v2-attempt-8.json) | `PASS`, 9/9 checks, 13386 ms | preserved Windows receipt; superseded after the full suite retained two more default-budget timeouts |
| [`ubuntu-wsl-v2-attempt-8.json`](evidence/task7/ubuntu-wsl-v2-attempt-8.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4376 ms | preserved Ubuntu receipt; superseded after the full suite retained two more default-budget timeouts |
| [`local-consistency-v2-attempt-8.json`](evidence/task7/local-consistency-v2-attempt-8.json) | `PASS / remoteCi=PENDING` | preserved aggregate; superseded after the full suite retained two more default-budget timeouts |
| [`windows-local-v2-attempt-9.json`](evidence/task7/windows-local-v2-attempt-9.json) | `NOT_PROVEN / SOURCE_IDENTITY`, 0 captured bytes | preserved clean-worktree refusal; no platform test ran and no Ubuntu or consistency receipt was produced |
| [`windows-local-v2-attempt-10.json`](evidence/task7/windows-local-v2-attempt-10.json) | `PASS`, 9/9 checks, 12655 ms | preserved clean Windows receipt; superseded after full local verification failed |
| [`ubuntu-wsl-v2-attempt-10.json`](evidence/task7/ubuntu-wsl-v2-attempt-10.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4735 ms | preserved clean Ubuntu receipt; superseded after full local verification failed |
| [`local-consistency-v2-attempt-10.json`](evidence/task7/local-consistency-v2-attempt-10.json) | `PASS / remoteCi=PENDING` | preserved local aggregate; superseded after full local verification failed |
| [`windows-local-v2-attempt-11.json`](evidence/task7/windows-local-v2-attempt-11.json) | `PASS`, 9/9 checks, 12565 ms | preserved Windows receipt after deterministic fixture scheduling; superseded after PR CI reproduced a Linux escape |
| [`ubuntu-wsl-v2-attempt-11.json`](evidence/task7/ubuntu-wsl-v2-attempt-11.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4548 ms | preserved Ubuntu receipt; superseded after the later CI/repetition race |
| [`local-consistency-v2-attempt-11.json`](evidence/task7/local-consistency-v2-attempt-11.json) | `PASS / remoteCi=PENDING` | preserved aggregate; superseded after the later source correction |
| [`windows-local-v2-attempt-12.json`](evidence/task7/windows-local-v2-attempt-12.json) | `PASS`, 9/9 checks, 13286 ms | preserved; superseded after independent review reproduced cancel/timeout scan-accounting ambiguity |
| [`ubuntu-wsl-v2-attempt-12.json`](evidence/task7/ubuntu-wsl-v2-attempt-12.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 4607 ms | preserved; superseded by the reviewed Linux correction |
| [`local-consistency-v2-attempt-12.json`](evidence/task7/local-consistency-v2-attempt-12.json) | `PASS / remoteCi=PENDING` | preserved aggregate; superseded by attempt #13 |
| [`windows-local-v2-attempt-13.json`](evidence/task7/windows-local-v2-attempt-13.json) | `PASS`, 9/9 checks, 19835 ms | selected local Windows receipt after serialized Linux finality correction |
| [`ubuntu-wsl-v2-attempt-13.json`](evidence/task7/ubuntu-wsl-v2-attempt-13.json) | `PASS`, 7 applicable checks and 2 Windows-only `NOT_RUN` checks, 8337 ms | selected Ubuntu 22.04 WSL receipt from an exact clean clone |
| [`local-consistency-v2-attempt-13.json`](evidence/task7/local-consistency-v2-attempt-13.json) | `PASS / remoteCi=PENDING` | selected local aggregate; exact commit, source digest, verifier, command, test, and applicability matrix match |

The selected attempt #13 pair binds source commit `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672`, source digest `sha256:40f64b09fd55132913dbd2ae3fab882ff3461e9983c033b77a1f140b884b6011`, and verifier fingerprint `sha256:6b0ba90b520d9e4d49d24c32da5524e00f3a1b25c40205f6d0a3e6dc24a41d97`.

The selected artifact SHA-256 values are:

- Windows attempt #8: `16ebd1c4aa593cea31b0c648fcd544130c99ba6ed4bab4943d3b130931b8df19`;
- Ubuntu attempt #8: `accf3470e0b481b19bb0bbfa8842a10ea6edb21c7ae96602a1b0d5f0da29071e`;
- local consistency attempt #8: `166adfd47aa895abe7ddd3710a6fc02b8602456fe527dec01df34e55b34c20f4`;
- Windows attempt #9 failure: `c8d9577262ac17de42fe047423c7221a1a0d044eb048da3f9277a80bb1506234`;
- Windows attempt #10: `814abf63549414250f8cb5dcb33842d0c0ebe8a8266c7cef9474e2319d93ca2f`;
- Ubuntu attempt #10: `0363ae4113d450b9ce2e896baea9a804e28ca1a9afcec3daeb3f845b8bc91715`;
- local consistency attempt #10: `f7098e7b479eab25609e149ee1fff91dd9b26008df910ae3e6232b29297847cd`;
- Windows attempt #11: `6c5ab356e2c9038560cb52f196949f5a421c2acc79b89fefd603e2c8ec0ab4ff`;
- Ubuntu attempt #11: `56b36d09dd15ae80e78cb6bda8cf979c455086e3bbecc5334b188e5f31781efd`;
- local consistency attempt #11: `ab029a0d865520e6525e605e80fe03f82cd71df97081c9ffd6aeffacdc53d0ab`;
- Windows attempt #12: `a1f56310809e36eabf285144021e260c8aa6cd9918068e0f96e144b080fbd1ea`;
- Ubuntu attempt #12: `44bf563ad97c716ebff82b5573563266809c1702430f4371e14241c6210d265b`;
- local consistency attempt #12: `97f32bb9823ef712e184da414deb153313d67cff9b29526a189a8a4668767cc4`;
- Windows attempt #13: `02ac8a8545b5119ce30918ea530cdf5f4aa81ac7cf1b1efac395195004e0d3f6`;
- Ubuntu attempt #13: `daa4009814be6c46a6b0f6fa5a8c05439cbbeb54b75a0707d24b532b2071c9d6`;
- local consistency attempt #13: `626dd9f3c34b6c5652fd13994141c3b7f375aafb1e2655a77ec7fcb8018c008d`;
- preserved Ubuntu v2 failure: `ab1751beec9ccc1ffbc2dbaa9758acdd9aa04a02e0c10575573cd9fa525c5c66`.

### Attempt #13 reproducibility

The Windows receipt used Node `v24.14.0` and Git `2.50.1.windows.1`; the Ubuntu 22.04 x64 WSL receipt used Node `v24.15.0` and Git `2.34.1`. Both ran from an exact clean checkout of the selected commit. The sanitized commands were:

```text
npm test -- test/posix-process-tree-finality.test.ts test/managed-process-platform.test.ts
npm run verify
npm run probe:task7 -- --output docs/validation/evidence/task7/windows-local-v2-attempt-13.json
npm run probe:task7 -- --output docs/validation/evidence/task7/ubuntu-wsl-v2-attempt-13.json
npm run compare:task7-evidence -- --windows docs/validation/evidence/task7/windows-local-v2-attempt-13.json --ubuntu docs/validation/evidence/task7/ubuntu-wsl-v2-attempt-13.json --output docs/validation/evidence/task7/local-consistency-v2-attempt-13.json
npm test -- test/task7-platform-evidence.test.ts
```

Windows passed the two focused files at 11/11. Ubuntu passed 9 applicable tests with 2 Windows-only skips. Full `npm run verify` passed in 508.6 seconds: 38 files and 300/300 tests, strict compiler, build, format, package smoke, clean-install smoke, and the provider-independent Pi probe; `RealProvider=NOT_PROVEN` and no Provider request ran. The Evidence suite passed 10/10, and count-only scans found zero Windows absolute, UNC, private-home, credential-assignment, Bearer, or GitHub-token patterns in all three attempt #13 files.

Exact-head Ubuntu repetition used the same Vitest title filters with fixed bounds: staged reparent 30 times and detached cancel 20 times passed. In the first combined run, the following timeout filter exceeded the test's preregistered 15-second bound once after those 50 processes; its immediate visible rerun passed in 4.2 seconds. The aborted test left one exact helper with one zombie fixture child. Their `/proc` identities and helper command were inspected, only the exact helper PID was terminated, and no broad cleanup ran. A subsequent visible 20-run repetition of the same command passed every time in 4.1–4.3 seconds and left zero helper or zombie processes:

```text
npx vitest run test/managed-process-platform.test.ts -t "keeps a detached closed-stdio descendant inside the reconciled process tree" --reporter=verbose
npx vitest run test/managed-process-platform.test.ts -t "cancels an owned nested child and grandchild as one contained tree" --reporter=verbose
npx vitest run test/managed-process-platform.test.ts -t "times out and reconciles the exact nested process tree" --reporter=verbose
```

The failed combined stress result remains part of the history and is not relabelled as PASS. It does not alter the earlier formal receipts, but independent rereview must decide whether it exposes a Task 7 correctness issue or only the explicitly unproven host-abort/recovery boundary before this branch may be pushed.

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

## Attempts #8–#13 and local blocker resolution

- Attempt #8 passes Windows 9/9 and, in a fresh locked Ubuntu WSL clone, 7 applicable checks with 2 Windows-only checks skipped. Its exact five-file command passes 65/65 in 75.3 seconds.
- A disposable Ubuntu 22.04 WSL clone passes the exact platform matrix with 7 applicable checks and 2 Windows-only checks skipped by declared applicability.
- Windows and Ubuntu formal v2 platform attempt #8 receipts and their local consistency receipt pass against their preserved identities above.
- Full `npm run verify` for source `e8c1a60` stops in the unit-test stage at 293/295: the hooks-neutralization and same-shape content-drift real-Git cases take 5.427 and 6.220 seconds under Vitest's default five-second budget. Later verify stages did not run, and the failure was not rewritten.
- Commit `6ffee095dde672d7ebca0e4e6ec60f2fdcb07ffc` applies one inherited 15-second timeout to the entire real-Git Workspace suite; its default file run passes 22/22 in 104.9 seconds and typecheck, format, and diff checks pass.
- Windows attempt #9 stops before source hashing at `SOURCE_IDENTITY` because attempt #8 history was still uncommitted. It records `NOT_PROVEN`, zero captured bytes, and no source identity; no platform test ran, and no Ubuntu or consistency receipt exists.
- Clean attempt #10 passes Windows 9/9 and, on its evidence-preserving Ubuntu rerun, 7 applicable checks with 2 Windows-only checks skipped; the exact cross-platform identity comparator passes. The first Ubuntu launcher invocation returned a probe `FAIL`, but its pre-fix launcher exited before copying the structured failure receipt. That no-receipt failure remains recorded and is not rewritten by the later PASS.
- The attempt #10 exact five-file command passes 65/65 in 80.5 seconds.
- Full `npm run verify` stops in the unit-test stage after 224.6 seconds at 291/295. The Workspace delayed-cleanup case exceeds its inherited 15-second budget at 16.638 seconds; Task 6 runner and `hpi-cli` exceed five seconds; Provider-egress exceeds 30 seconds. The two timed-out process fixtures also report `EBUSY` while cleaning their temporary repositories. Strict compiler, build, format, package, clean-install, and Pi probe stages did not run.
- No residual Node/Vitest process matched the two failed fixture identities after the command exited. The host rejected the exact recursive fixture-cleanup command, so those two disposable Temp directories remain; no bypass was used.
- The Pi public-interface probe reported provider-independent `SUPPORTED` and real Provider `NOT_PROVEN`; Task 7 made no Provider request.
- Strict Evidence passes 10/10. A separate count-only scan over all three attempt #10 receipts finds zero Windows absolute paths, UNC paths, private Windows or POSIX home paths, and credential-assignment shapes; all three file hashes match the selected values above. These checks preserve the receipts but do not override the full-suite failure.
- This is the third evidence-based remediation round for the repository-wide fixture budget/scheduling blocker. Further timeout expansion or rerun is stopped by the iteration rule; independent review and replacement remote CI remain `NOT_RUN`/`PENDING`.
- The owner explicitly authorized a bounded scope expansion into repository-wide real Git/process fixture scheduling, timeout cleanup, and Temp lifecycle. Product contracts, Task 8, Pi/model calls, Provider requests, and real user repositories remained out of scope.
- A deterministic test-infrastructure RED first failed because the new runtime and captured-process modules did not exist. The implementation then introduced one per-run contained Temp root, exact retrying cleanup, inherited Temp restoration, child-close settlement, and a repository-wide worker cap.
- A four-resource-file baseline passed 48/48 but took 86.4 seconds, while the prior 16-worker full suite had failed; the host exposes 16 logical workers and 23 of 36 then-existing files used temporary directories. A concurrent test/typecheck/lint diagnostic reproduced the outer egress timeout and `EBUSY`; after child-close settlement, an intentionally tight 10-second child budget failed cleanly without `EBUSY` and was corrected to a 15-second inner / 60-second outer hierarchy.
- `maxWorkers=2` passed the five resource suites 51/51, but the full suite stopped at 297/298 when the first real Doctor fixture took 5488 ms and cleanup reported `EPERM`. The same Doctor file passed 9/9 alone, with the target case at 444 ms, proving cross-file resource contention rather than a Doctor contract failure.
- Final `fileParallelism=false / maxWorkers=1` scheduling passed 37 files and 298/298 tests in 148.15 seconds. Fresh full `npm run verify` then passed in 325.7 seconds, including lint, typecheck, the same 298 tests, strict compiler, build, format, package smoke, clean-install smoke, and the Pi public-interface probe. The probe reported provider-independent `SUPPORTED` and real Provider `NOT_PROVEN`.
- Attempt #11 passes Windows 9/9 and Ubuntu 7 applicable + 2 Windows-only `NOT_RUN`; the strict comparator passes. All three schemas and privacy guards pass, count-only scans find zero Windows/UNC/private-home/credential-assignment patterns, and the hashes match above. No per-run `hunter-pi-vitest-*` Temp root or Ubuntu clone remained. The two old attempt #10 Temp directories remain preserved as historical residue; no bypass was used.
- PR run `30966180228` reproduced the detached closed-stdio failure in Ubuntu base while the isolated Ubuntu containment job passed. An exact WSL reproduction passed six times and failed on the seventh; diagnostic repetition then observed a live detached child while the Host remained `EXITED / EMPTY / CLOSED / PENDING`. The child's `/proc` parent was WSL `/init`, so the helper had exited after one inconsistent whole-table scan and genuinely lost containment. Increasing the eight-second wait would not repair that escape.
- Commit `63d6b66eaefad49a58d4b99dfd45b50956ad748b` requires two consecutive complete empty scans. The candidate passed 30/30 focused Linux repetitions, both complete platform files, Windows lint/typecheck/298 tests/format/diff checks, and full `npm run verify` in 404.7 seconds. The final Pi probe remained provider-independent `SUPPORTED`; real Provider stayed `NOT_PROVEN` and no Provider request occurred.
- Attempt #12 passes Windows 9/9 and Ubuntu 7 applicable + 2 Windows-only `NOT_RUN`; the strict comparator and 10/10 Evidence suite pass. Its selected hashes and identities are listed above. Independent rereview and replacement remote CI remain `PENDING`.
- Independent review then showed the attempt #12 counter could retain an empty candidate across an intervening active pre-signal scan. The new pure RED failed 2/2 before implementation. Commit `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` serializes scan/termination, makes every scan update one candidate sequence, adds direct-child snapshots, and strengthens the existing formal cancel, timeout, and detached checks without changing the nine-check Evidence schema.
- Attempt #13 passes Windows 9/9 and Ubuntu 7 applicable + 2 Windows-only `NOT_RUN`; strict comparison and the 10/10 Evidence suite pass. Full verification passes 300/300. The later mixed stress timeout, exact cleanup, and subsequent 20/20 visible timeout rerun are retained in the reproducibility section. Independent rereview and replacement remote CI remain `PENDING`.

## CI and remaining boundaries

CI defines independent Windows/Ubuntu Task 7 platform jobs and a strict aggregate identity comparator. PR #16 run [`30918642613`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30918642613) preserved its exact mixed result: both Task 7 containment jobs and the Task 7 identity aggregate passed; the base Ubuntu job failed because the detached child had completed before a fixed-delay `pending` assertion, and the base Windows job failed because the Unicode/structured-argv real-process case exceeded Vitest's default five seconds under full-suite load. Downstream Pi Evidence did not run because both base jobs were required. No Task 7 product assertion failed, and that failure history remains retained.

PR #16 CI run [`30923849375`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30923849375) completed `success` on head `c2079bec7fdb9beafee5afbf5314b98e8b50f115`: `windows-latest / Node 24`, `ubuntu-latest / Node 24`, both exact Task 7 containment jobs, `Task 7 Evidence / Windows + Ubuntu identity`, and `Pi Evidence / Windows + Ubuntu identity` all passed. This is the GitHub-hosted confirmation for the then-selected attempt #7 source and Evidence; it is not inferred for later source changes.

The exact-head follow-up run [`30925340988`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30925340988) retained a Windows base-job timeout at `test/git-workspace-manager.test.ts:259`: 294/295 tests passed, but the real-Git operation-replay case took 5.54 seconds under the default five-second budget. Ubuntu, both Task 7 containment jobs, and the Task 7 identity aggregate passed; Pi Evidence was skipped because the Windows base dependency failed. Commit `e8c1a606e46c08c764ddf9ead039ce53b4ea1465` adds only the case-owned 15-second budget and does not change its request, receipt, registration-count, or equality assertions. Replacement remote CI remains `PENDING`.

PR #16 run [`30966180228`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30966180228) completed `failure` on head `1e6887e2a0432ebbf4754d52f0a9629a7054c9ca`: Windows base passed all steps, both standalone containment jobs passed, and Task 7 identity passed; Ubuntu base stopped at 294/295 because the detached closed-stdio test timed out waiting for `ACTIVE`, while Pi Evidence was skipped by that dependency. This is a real containment failure, not relabelled timing noise. Sources `63d6b66eaefad49a58d4b99dfd45b50956ad748b` and then `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` contain the two preserved local correction rounds; exact-head replacement remote CI has not run and remains `PENDING`.

Even after exact CI passes, Task 7 proves these Hunter contracts only within disposable fixtures. It does not prove arbitrary user repositories, hostile kernel/process behavior outside the declared adapter assumptions, real Pi/Provider behavior, recovery after host crash, plugin isolation, a Windows installer, production readiness, or daily-use acceptance. Those claims remain `NOT_RUN` or `NOT_PROVEN` under their later tasks.
