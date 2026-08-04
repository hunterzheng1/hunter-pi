# Task 6 — Managed Change vertical-slice validation

- Preregistered: 2026-08-04
- Implementation baseline: `d766823af8841ada77a9afc864642255395e67a2`
- Branch: `codex/task6-managed-change`
- Local platform: Windows / Node.js 24
- Engine Release: `@earendil-works/pi-coding-agent@0.83.0`
- Provider authentication metadata: **DETECTED**
- Real Provider request: **AUTHORIZED / NOT_RUN**
- Task result: **PENDING**

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

Result is **GO** only if every item passes; **REVISE** if correctness and all zero-tolerance items pass but intervention or overhead misses; **STOP** for a zero-tolerance failure or required public-interface blocker. Until this artifact is populated from the real run and all gates pass, Task 6 remains `PENDING` and real repositories remain prohibited.
