# Task 6 — Managed Change vertical-slice validation

- Preregistered: 2026-08-04
- Implementation baseline: `d766823af8841ada77a9afc864642255395e67a2`
- Branch: `codex/task6-managed-change`
- Local platform: Windows / Node.js 24
- Engine Release: `@earendil-works/pi-coding-agent@0.83.0`
- Provider authentication metadata: **DETECTED**
- Real Provider request: **DETECTED within the exact disposable fixture run**
- Task result: **STOP — CUMULATIVE OUTPUT BUDGET NOT_PROVEN / REMOTE CI PENDING**

## Frozen outcome and non-goals

Task 6 must run one disposable-fixture Managed Change through Define → Plan → Execute → Verify → Review → Ready while preserving an intentional failed Attempt and proving that a Pi return is only an Observation. The task may send one minimal real Provider request during the fixback Attempt after the owner's 2026-08-04 authorization.

This task does not authorize a real-repository mutation, commit/push automation, third-party Plugin execution, publication, updater work, Windows installation/signing, a Pi/OMP fork, or a production-readiness claim.

## Frozen fixture and plan

The runner creates and owns a temporary Git fixture whose resolved path is independently checked before use and cleanup. Its committed baseline contains:

- `README.md`, describing the bounded task;
- `result.txt`, initially containing `BASELINE`;
- `verify.mjs`, which exits zero only when `result.txt` contains exactly `READY\n`.

Quick Session promotion then creates two known dirty paths before freezing Plan Revision 1:

- include `result.txt`, changed to `NOT_READY\n`;
- exclude `scratch.txt`, retained only as an explicit fixture-local exclusion.

Promotion must reject an unclassified dirty path, duplicate include/exclude entries, an overlap, a path outside the repository, a linked mutation target, or a repository not created by the current fixture owner. Portable Evidence stores only normalized fixture-relative paths and content fingerprints, never the temporary absolute path.

Plan Revision 1 declares one reusable Agent Step, one independent command check, and one required review:

1. Attempt 1 records the deliberate fixture preparation Observation and runs `node verify.mjs`; the check must fail and remain visible.
2. Attempt 2 is a bounded fixback linked to Attempt 1's exact failure Evidence. It sends one real Pi prompt asking the Agent to change only `result.txt` to satisfy the declared check, without shell use.
3. Pi return records `AGENT_RETURNED` but must leave the Change in `VERIFYING`.
4. The same independent command check reruns against exact workspace, baseline-source, current-input, check-definition, configuration, and environment fingerprints.
5. A deterministic review requires that only the included path changed relative to the promoted snapshot, the excluded path remained unchanged, and `result.txt` has the exact accepted content.

Frozen loop limits:

- `maxIterations = 2`;
- `maxElapsedMs = 600000`;
- `repeatedFailureLimit = 2`;
- `maxAgentTurns = 1`;
- `maxExternalOperations = 4`;
- `maxCommands = 2`;
- `maxOutputBytes = 262144`;
- stop on user input and workspace drift.

The post-review implementation keeps that total unchanged and partitions capture ceilings so execution cannot independently spend the same budget three times: Pi receives 229376 bytes, Attempt 1 Verification receives 16384 bytes, and Attempt 2 Verification receives 16384 bytes. Provider-neutral Engine Observations now retain measured output usage; the runner sums all three components and blocks `READY` when measurement is missing or any component/cumulative limit is exceeded.

## Required automated checks

| Check | Exact definition | Required |
|---|---|---|
| `check_task6-result` v1 | `node verify.mjs`, fixture repository working directory | yes |

The verifier captures bounded stdout/stderr digests and exit metadata. `sourceFingerprint` binds the promoted baseline and `inputFingerprint` binds the exact worktree snapshot evaluated by that Receipt. A later source/config/check change cannot reuse the Receipt.

## Versioned Evidence envelope

The portable artifact is `docs/validation/evidence/task6/managed-change.json`, parsed by a strict `hpi-task6-managed-change.v1` schema. It records:

- exact product source state and Engine Release;
- Provider ID, metadata-only auth status, and request outcome without credential material;
- fixture ownership policy, base commit, workspace/source/current-input fingerprints, and explicit include/exclude paths;
- immutable Plan Revision/check fingerprints and finite budgets;
- every Attempt, Observation, Verification and review result, including the deliberate failure;
- scorecard facts, privacy scan, cleanup disposition, local commands, and remote-CI status.

The artifact must not contain credential values, cookies, authorization headers, raw private prompts, complete environment dumps, or absolute user paths. The exact model prompt is represented only by a purpose label and digest.

## Preregistered scorecard and terminal decision

- zero false `READY`, source loss, secret leak, or overwritten failed Attempt;
- Attempt 1 remains failed and Attempt 2 passes every invalidated required check;
- no more than two unplanned user interventions after Plan approval;
- Hunter-only overhead, excluding Agent and declared-check runtime, is at most ten minutes;
- final summary identifies every required check, Attempt, blocking finding, and unresolved risk.

Result is **GO** only if every item passes; **REVISE** if correctness and all zero-tolerance items pass but intervention or overhead misses; **STOP** for a zero-tolerance failure or required public-interface blocker.

## Observed result

The one authorized request ran from the clean packaged product source `164fc28ac423ac3cdccf91b9a7f0c36ca51612df` through `hpi managed fixture --json`. The Provider request returned an `APPLIED` operation receipt and Pi emitted 53 bounded JSON records. Those facts are evidence of this exact request only, not a general Provider capability or production-readiness claim.

- Attempt 1: `INCOMPLETE / FAILED`, preserved with its exact failure Evidence;
- Agent return: observed while the Change was `VERIFYING`;
- Attempt 2: `RETURNED / PASSED` after independent `node verify.mjs` execution;
- deterministic review: `PASS`, zero blocking findings, no extra mutation;
- fixture cleanup: `PASS`;
- original scorecard facts: no source loss, secret leak, or overwritten failure; zero unplanned interventions; measured Hunter-only overhead `462.1939 ms`;
- full local `npm run verify`: `PASS` on the exact implementation source before the request;
- Windows/Ubuntu remote CI: `PENDING` until this branch is pushed.

Independent review found a proof gap after that run: the artifact retained the two verifier outputs (17 and 13 bytes) but not Pi's captured byte count, while the old source configured 262144 bytes separately for Pi and both verifiers. The original projection and zero-finding review remain preserved as historical facts, but they are insufficient to establish the frozen cumulative resource limit; treating that projection as deliverable would be a false `READY`.

The corrected committed Evidence artifact SHA-256 is `dc5db8f72124f0b30f430d60cc8c464637f15f50bd39646544169da1047ef195`. It records `taskResult=STOP`, `resourceAccounting.status=NOT_PROVEN`, both exact proof gaps, the unchanged successful Provider/Attempt/check/review/cleanup facts, and `remoteCi=PENDING`. The corrected source passed `npm run verify` locally with 31 test files / 230 tests plus lint, typecheck, strict compiler, build, format, package smoke, clean-install smoke, and the provider-independent Pi probe; that probe correctly reports `RealProvider=NOT_PROVEN`. A second real request has not run. No Agent byte count was inferred or fabricated. A new real request requires separate owner authorization, and real user repositories remain prohibited until Task 7 proves worktree, lease, process-containment, and cleanup gates.
