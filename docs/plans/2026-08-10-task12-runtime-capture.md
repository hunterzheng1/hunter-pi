# Task 12 — trusted runtime capture coordination

- Status: **IN PROGRESS / PROVIDER ACCOUNTING LOCAL PASS / REAL PILOT NOT_RUN**
- Source baseline: merged main `16bd5f4b129522bf97884576b84bb5fd88c05eab`
- Product outcome: the real Windows pilot must be assembled from product-observed, plan-bound facts and written through the existing opaque capture/final Archive authority; caller-authored complete Evidence JSON must remain unable to promote itself to a live pilot.

## Deep module and seam

The production seam is one durable pilot capture module. Its eventual external interface starts or resumes one plan-bound capture session, accepts only validated product or explicit operator receipts, reports a path-free next action/status, and finalizes one immutable Archive when the complete frozen plan is satisfied. Sequencing, duplicate detection, cumulative budgets, interruption recovery, projection, privacy checks, and one-shot capture authority remain implementation details behind that interface.

The first prerequisite slice makes Provider accounting trustworthy before the session can consume real task results:

- the qualified Pi JSON adapter counts only assistant `message_end` records from a stream that terminates in `agent_end`; the unqualified historical Task 6 process path reports `NOT_PROVEN` because its hidden-retry boundary is not controlled;
- repeated messages inside `agent_end` are not counted again;
- each qualified run uses a one-use Pi configuration snapshot that accepts only exact regular configuration/auth/model files, disables Provider transport retry, Agent auto-retry, and automatic compaction, and removes the snapshot before returning;
- each request must carry a valid Pi usage object whose token and cost totals equal their components;
- request count, total tokens, and Provider-reported cost are retained as provider-neutral `EngineObservation.resourceUsage`;
- cost is conservatively rounded up to integer minor units after aggregation;
- truncated, incomplete, missing, malformed, inconsistent, or overflowing usage is `NOT_PROVEN`, never inferred as zero;
- `hpi-managed-change.v3` requires exact usage for every Agent Attempt, cross-checks its Provider and resource-accounting totals, adds finite per-change token and cost budgets, blocks an unaccounted or unreserved fixback request, and returns `STOP` when usage is missing or over budget. The strict v2 parser remains available for historical replay.

## Remaining capture work

1. Add the append-only, plan-bound capture session and path-free status projection.
2. Derive task and Run receipts from real Managed Change and Task 9 stores rather than accepting caller-authored task summaries.
3. Bind raw-Pi comparator accounting, installation, performance, interruption, Plugin, update, privacy/storage, review, and exact hosted CI receipts.
4. Finalize through `PilotEvidenceCaptureFinalizer` and `FilePilotArchiveStore`, then evaluate the exact trusted Archive.
5. Run the frozen ten-task Windows pilot in disposable worktrees for two explicitly selected repositories under one finite Provider request/token/cost scope.

## Verification policy

- RED → GREEN tests cover exact accounting, inconsistent totals, duplicate avoidance, propagation through the Engine Host, missing-accounting STOP, finite-budget STOP, and no unaccounted retry.
- Public contract changes update the Task 12 plan and user workflow documentation in the same commit.
- Focused suites, lint, typecheck, formatting, full local tests, package/clean-install smokes, compiled Pi probe, PR CI, and exact merged-head main CI must pass before this slice is treated as complete.
- No test or synthetic receipt changes the daily-use disposition. Only a complete real Windows Archive can produce Task 12 `GO`.
