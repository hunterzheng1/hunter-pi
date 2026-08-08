# Workflow semantics

## Two modes, one honest state model

Hunter Pi supports Quick Session and Managed Change without pretending they provide the same delivery claim.

- Quick Session optimizes for conversation and may stop without a delivery conclusion.
- Managed Change optimizes for a bounded, independently verified repository outcome.

A Quick Session can be promoted into a Managed Change, but only after capturing a baseline and declaring acceptance conditions. Past unstructured conversation becomes context, not retroactive Evidence.

## Managed Change lifecycle

```text
DRAFT
  → PLANNED
  → RUNNING
  → VERIFYING
  → REVIEWING
  → READY

Terminal alternatives from active states:
  BLOCKED · FAILED · CANCELLED · INCOMPLETE

Independent archive status for any ended Run:
  UNARCHIVED → ARCHIVED
```

Meanings:

| State | Meaning |
|---|---|
| `DRAFT` | Goal, scope, or acceptance conditions are still being resolved |
| `PLANNED` | An immutable Plan Revision and workspace strategy exist |
| `RUNNING` | At least one Step is executing in an Attempt |
| `VERIFYING` | Declared independent checks are running or being reconciled |
| `REVIEWING` | Verified output is being assessed for defects, risks, and scope |
| `READY` | Every required automated Verification passed, every predeclared human gate has an exact Receipt, and no blocking review finding remains |
| `BLOCKED` | A named prerequisite prevents progress; no success claim is possible |
| `FAILED` | A required check or terminal policy failed and no permitted next Attempt remains |
| `CANCELLED` | A user or policy intentionally stopped the Change |
| `INCOMPLETE` | Execution ended without enough reconciled evidence for another terminal outcome |

`READY`, `BLOCKED`, `FAILED`, `CANCELLED`, and `INCOMPLETE` are terminal Run outcomes. The Kernel never reopens one by appending another Attempt or late Receipt; renewed work requires a linked replacement Run. `ArchiveStatus` is a separate dimension: any ended Run moves from `UNARCHIVED` to `ARCHIVED` after its immutable manifest is written. Archiving preserves an outcome; it never changes that outcome into success.

`READY` does not mean committed, pushed, merged, published, released, or deployed. Those are separate operations with separate receipts.

## Plan Revision

A Plan Revision fixes:

- goal and non-goals;
- target repository/workspace identity;
- ordered or dependency-linked Steps;
- declared Verification checks;
- required human decisions;
- iteration, time, token/cost, and command budgets;
- plugin and permission requirements;
- deterministic stop conditions.

Once a Run starts, its Plan Revision is immutable. A material scope or check change creates a new Plan Revision, ends the current Run as `CANCELLED` with reason `PLAN_SUPERSEDED`, and starts a new Run linked to the predecessor. Attempts never cross a Plan Revision boundary. The model may suggest a revision; the Workflow Kernel owns its identity and validity.

## Run and Attempt

A Run is the logical execution of one Managed Change against one Plan Revision. An Attempt is an append-only record of one actual try.

Each Attempt separates two dimensions:

```text
Execution status:
PENDING → STARTING → RUNNING → WAITING_INPUT → RETURNED
                                    ↘ INTERRUPTED / INCOMPLETE

Verification status:
NOT_READY → PENDING → RUNNING → PASSED / FAILED / BLOCKED / NOT_PROVEN
```

The canonical schema distinguishes:

- `VerificationStatus`: `NOT_READY`, `PENDING`, `RUNNING`, `PASSED`, `FAILED`, `BLOCKED`, or `NOT_PROVEN`;
- terminal `VerificationOutcome` in a Receipt: `PASS`, `FAIL`, `BLOCKED`, or `NOT_PROVEN`;
- `NOT_RUN`: a projection fact for a declared check with no Receipt, never a Receipt outcome.

The following are never equivalent to `PASSED`:

- the Agent says it is done;
- Pi emits a turn-completed event;
- the terminal becomes idle;
- the child process exits zero;
- a window closes;
- a Plugin reports success;
- the diff is non-empty;
- a Fake Host test passes.

## Steps

Version one uses a small workflow vocabulary rather than arbitrary BPMN:

| Step kind | Purpose |
|---|---|
| `context` | Resolve bounded project rules and relevant prior knowledge |
| `plan` | Produce or revise a Plan Revision |
| `agent` | Ask Pi to reason, edit, or run tools for a declared objective |
| `command` | Execute an exact non-Agent command under the process host |
| `verify` | Produce an independent Verification Receipt |
| `human_gate` | Record an exact user decision or required input |
| `review` | Produce structured findings and recommended fixback |

Each Step declares input and output contracts. Step and check identities are unique, dependencies must reference the same Plan Revision and form a DAG. A `human_gate` freezes the expected content hash and allowed decisions; a `review` freezes its input, definition, and configuration fingerprints. The Kernel routes from validated outputs and policies, not free-form model claims.

## Verification

A Verification Receipt binds:

- Verification and Attempt identities;
- declared check identity and version;
- exact command or human-decision definition;
- workspace, source, configuration, and environment fingerprints;
- start/end time and exit/result status;
- bounded stdout/stderr or artifact digests;
- redaction and truncation metadata;
- result: `PASS`, `FAIL`, `BLOCKED`, or `NOT_PROVEN`.

Required checks that were not attempted remain `NOT_RUN` in projections. `NOT_RUN` is not automatically converted to `BLOCKED` or `NOT_PROVEN` because each status answers a different question.

Human confirmation is valid only for a predeclared `human_gate` and only when it binds the exact Attempt, frozen content hash, allowed decision, actor reference, result fingerprint, and time. A Review Receipt likewise binds the predeclared review input/definition/configuration and active workspace/source identity. Rejected/blocked Human Receipts and failed/blocked/not-proven Reviews must carry failure Evidence so a required gate can enter an evidence-bound fixback Attempt; optional gates never authorize retry or block `READY`. A generic “looks good” chat message is not a Human Receipt. A Human Receipt cannot waive, replace, or relabel a required automated Verification. Changing the required check or gate definition creates a new Plan Revision and therefore a new Run.

When the final permitted Attempt has passing automated Verification but an exact required gate Receipt records failure, the Kernel must end the Run instead of leaving an impossible retry in `REVIEWING`: a blocked gate becomes `BLOCKED`, a rejected Human Receipt or failed/blocking Review finding becomes `FAILED`, and a not-proven Review becomes `INCOMPLETE`. A gate that has not yet produced a Receipt remains `REVIEWING` because the declared decision or review can still arrive.

## Retry, fixback, and loops

Retry never mutates an Attempt and cannot begin while the preceding Attempt execution is still active. It creates a new Attempt with links to:

- the preceding Attempt;
- the failure Evidence;
- the reason for retry;
- remaining budgets.

The retry event also freezes the admission-time `userInputRequired` and `workspaceDriftDetected` determinations. When `stopOnUserInput` is active, either a true determination or an earlier `INPUT_REQUESTED` Observation blocks retry; a caller cannot bypass the stop by reporting `false`. When `stopOnWorkspaceDrift` is active, a true durable determination blocks retry. Replay applies the same rules and never invents a workspace-drift check that was not recorded.

Cancellation and interruption recovery have a stronger boundary than ordinary same-owner fixback. Neither `AGENT_RETURNED` nor `PROCESS_EXITED` is terminal finality. Before cancellation can end a Run, and before recovery can create a replacement Attempt, the Kernel requires one immutable Attempt Finality Receipt bound to the preceding Attempt's latest Checkpoint. Its process references and released Writer Lease identities must match the Checkpoint exactly, and its supporting Evidence is retained by Archive finalization.

Every Attempt in a Run uses the same Plan Revision. If remediation requires a plan change, the existing Run ends with outcome `CANCELLED` and reason `PLAN_SUPERSEDED`; the replacement Run links back to its Evidence.

A fixback loop follows:

```text
Verification or Review finding
  → freeze structured finding or rejected gate and RED evidence
  → create a new Attempt
  → perform bounded fix
  → run focused GREEN check
  → rerun every invalidated required check
```

Every loop declares:

- `maxIterations`;
- `maxElapsed`;
- at least one finite resource budget: token, cost, Agent turn, external-operation, command, or captured-output byte limit;
- repeated-failure fingerprint limit;
- stop-on-user-input conditions;
- stop-on-workspace-drift conditions.

Iteration and elapsed limits are always finite. Elapsed time and resource usage are cumulative and monotonic across Attempts; a caller cannot restore budget by reporting a smaller value on retry. Per-process capture ceilings must fit within the declared cumulative `maxOutputBytes`, and the final gate sums every measured Agent and verifier output component. Missing or over-budget output accounting blocks readiness. When a provider cannot expose reliable token or cost accounting, the Run uses locally measurable resource budgets such as `maxAgentTurns`, `maxExternalOperations`, or `maxOutputBytes` and records token/cost metering as `NOT_PROVEN`; unavailable metering never makes a loop unbounded.

Repeating the same failed operation without new evidence does not consume infinite retries; it triggers deterministic stop or human input.

## Idempotent external operations

Every operation capable of changing files, processes, sessions, plugins, or update state carries:

- `operationId`;
- canonical payload fingerprint;
- expected target identity, including both namespace and reference;
- deadline and cancellation policy.

Rules:

1. Same operation ID and fingerprint returns the existing Receipt.
2. Same operation ID with a different fingerprint is rejected.
3. An unknown result after interruption is reconciled before re-execution; reconciliation appends a separate Receipt and never rewrites the original `UNKNOWN` Receipt.
4. A Receipt reports observed effects; `UNKNOWN` cannot carry claimed effects and never invents success for effects it cannot prove.

## Workspace and writer rules

Managed Change defaults to a new Git worktree created and owned by Hunter Pi. The Run records repository, base commit, branch, worktree identity, and writer lease.

- One active writer owns a worktree.
- Concurrent managed writers use different worktrees.
- Dirty pre-existing work is never silently adopted.
- Non-Git projects are single-writer in version one and make no isolated-writer/worktree claim; that capability is `NOT_PROVEN`.
- Plugin or Agent writes outside the leased workspace trigger policy handling and Evidence.
- Worktree cleanup requires an exact target, clean/unique-work checks, and branch/PR checks.

## Checkpoint and recovery

A Checkpoint contains references sufficient to decide whether recovery is safe:

- Run, Attempt, Plan Revision, and Distribution Release identities;
- repository/worktree identity and current source fingerprint;
- last durable workflow event cursor;
- Pi session reference and whether resume is supported;
- active operation receipts and unknown outcomes;
- held leases and process identities;
- remaining budgets.

Recovery algorithm:

1. Load and validate the Checkpoint schema.
2. Verify repository, worktree, Distribution Release, and event-log continuity.
3. Reconcile running or unknown external operations.
4. Reconcile every recorded process to a final receipt and every recorded Writer Lease to release, then append the exact Attempt Finality Receipt.
5. Recover Pi only if the exact Engine Release and session reference support it.
6. Create a new recovery Attempt.
7. If any required identity cannot be established, stop as `BLOCKED` or `NOT_PROVEN`.

Recovery is successful when state is reconciled and work can continue. It does not imply that the Change is successful.

Task 3 durable replay validates every segment schema, checksum, Run binding, cursor boundary, previous-segment hash, Attempt sequence, retry stop determination, and Receipt-to-Plan binding before projection. A separate projection-integrity function recomputes Attempt execution/verification status, current check status, and Run/Change lifecycle from the exact facts; Evidence summaries cannot accept caller-authored READY/PASS fields or duplicate Receipts. A Checkpoint found in that replay proves only that the workflow reference was recorded. Until Distribution Release, workspace/source, operations, process/lease finality, and engine/session facts are independently reconciled, `recover` returns `NOT_PROVEN` with explicit reasons and does not create a recovery Attempt or claim resumed work. If the same Checkpoint identity is found in more than one Run, recovery returns `BLOCKED / CHECKPOINT_ID_AMBIGUOUS` rather than choosing one.

## Review semantics

Review execution success and review findings are different dimensions.

- Review execution: `PASS`, `FAIL`, `BLOCKED`, `NOT_PROVEN`.
- Finding severity: `P0`, `P1`, `P2`, `P3` with evidence and confidence.

A successfully executed review can return blocking P0/P1 findings. Required fixback policy determines whether `READY` is allowed.

## Archive and knowledge

Archiving is an idempotent post-Run finalizer, not a planned Step inside the Run. Successful, failed, blocked, cancelled, and incomplete Runs may all be archived after their terminal outcome is durable. A Run Archive freezes:

- immutable manifest and digests;
- the Run's one Plan Revision and all of its Attempts;
- predecessor/successor Run references without absorbing their Attempts;
- Verification and review receipts;
- artifacts and truncation metadata;
- decisions, risks, and unresolved items;
- source/release identities;
- recovery limits.

Archive ingestion does not automatically turn generated text into trusted instructions. Knowledge candidates retain provenance and require scope, status, conflict, and confidence evaluation before injection.

A later Managed Change aggregate view may index multiple Run Archives, but it is a projection over independently immutable archives rather than a multi-Run Archive that rewrites their identities.
