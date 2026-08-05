# Task 8 — Verification adequacy and review/fixback

- Preregistered: 2026-08-05
- Baseline: `ec850c3d3853547a70f425cfd25bfdc83cb7af1e`
- Implementation commit: `5f4e1f493eb82eb2edeaec89d7f39b582c7dcf1d`
- Formatting correction: `24671c586477547fb33ce6e997379134b1efc3c9`
- Merge commit: `bbb409c282741431b75e7303b27154755c86ffd1`
- Branch: `codex/task8-verification-adequacy`
- Pull request: [#18](https://github.com/hunterzheng1/hunter-pi/pull/18)
- Provider requests: `NOT_RUN`
- Real user repositories: `NOT_RUN`
- Result: **COMPLETE WITHIN PROVIDER-NEUTRAL RECEIPT-FIXTURE BOUNDS / LOCAL PASS / PR CI PASS / MAIN CI PASS / TASK 9 NOT_STARTED**

## Boundary

Task 8 adds an independent adequacy validator to `@hunter-pi/verification`. It accepts a strict Plan Revision, an explicit verification DAG, resource-lock assignments, selected checks, Verification Receipts, exact Human Receipt expectations, Review Receipts, and an optional fixback batch. It does not launch a process, call Pi, send a Provider request, open a real repository, or infer success from Agent text, process exit, terminal idle, or a window state.

The validator emits a versioned `VerificationAdequacyReceipt`. `READY` is possible only when every selected check has exactly one current receipt with matching Run/Attempt/check/source/configuration/workspace/environment identities, a non-truncated and explicitly redacted output, a PASS result, every required gate and review is bound, no P0/P1 review finding remains, the DAG is acyclic, resource locks are deterministically ordered, and accounting reconciles. Any missing, duplicate, filtered, skipped, timed-out, truncated, stale, unredacted, or structurally invalid input prevents `READY`.

## RED → GREEN → REFACTOR

The focused contract file `test/verification-adequacy.test.ts` first failed because the new validator export did not exist. The minimum implementation then passed the six focused scenarios. Refactor tightened full identity matching (including check version, definition, and configuration) and preserved non-blocking Review P2/P3 findings instead of dropping them. Formatting was corrected in a separate commit after the first remote run exposed the exact formatting gate failure.

The six scenarios cover:

1. complete DAG, ordered shared lock, two passing checks, exact Human Receipt, and clean Review → `READY`;
2. missing/filtered/skipped/duplicate checks → no `READY` and explicit accounting/findings;
3. reused receipt across Attempt, source, and environment → `CHECK_STALE_REUSE`;
4. timeout, output truncation, missing redaction, and P1 Review finding → no `READY`;
5. Human Receipt result mismatch and invalid same-Attempt fixback → no `READY`;
6. cyclic DAG and unordered resource-lock conflict → no `READY`.

## Stop conditions and limits

- No Provider, real repository, credential, or external model request was used.
- This task proves Hunter's adequacy contract and deterministic receipt accounting only; it does not prove a Provider, plugin, desktop, installer, recovery, archive, or daily-use workflow.
- Task 9 remains gated until its checkpoint/recovery/archive scope is explicitly started.

The dated local and remote results are recorded in [Task 8 verification adequacy validation](../validation/2026-08-05-task8-verification-adequacy.md).
