# Task 12 — trusted runtime capture coordination

- Status: **IN PROGRESS / ALL PRODUCT TASK PATHS COMPLETE LOCAL VERIFY PASS / REAL PILOT NOT_RUN**
- Source baseline: merged main `94b8c4a88d17ddd7c4deb76b12c64755a05a9846`
- Product outcome: the real Windows pilot must be assembled from product-observed, plan-bound facts and written through the existing opaque capture/final Archive authority; caller-authored complete Evidence JSON must remain unable to promote itself to a live pilot.

## Deep module and seam

The production seam is one durable pilot capture module. Its eventual external interface starts or resumes one plan-bound capture session, accepts only validated product or explicit operator receipts, reports a path-free next action/status, and finalizes one immutable Archive when the complete frozen plan is satisfied. Sequencing, duplicate detection, cumulative budgets, interruption recovery, projection, privacy checks, and one-shot capture authority remain implementation details behind that interface.

The first prerequisite slice makes Provider accounting trustworthy before the session can consume real task results:

- the qualified Pi JSON adapter counts only assistant `message_end` records from a normal stream that terminates in `agent_end`; a controlled interruption instead requires the one-use Core nonce marker plus exact contained-process finality, while the unqualified historical Task 6 process path reports `NOT_PROVEN` because its hidden-retry boundary is not controlled;
- repeated messages inside `agent_end` are not counted again;
- each qualified run uses a one-use Pi configuration snapshot that accepts only exact regular configuration/auth/model files, disables Provider transport retry, Agent auto-retry, and automatic compaction, and removes the snapshot before returning;
- each request must carry a valid Pi usage object whose token and cost totals equal their components;
- request count, total tokens, and Provider-reported cost are retained as provider-neutral `EngineObservation.resourceUsage`;
- cost is conservatively rounded up to integer minor units after aggregation;
- truncated, incomplete, missing, malformed, inconsistent, or overflowing usage is `NOT_PROVEN`, never inferred as zero;
- `hpi-managed-change.v3` requires exact usage for every Agent Attempt, cross-checks its Provider and resource-accounting totals, adds finite per-change token and cost budgets, blocks an unaccounted or unreserved fixback request, and returns `STOP` when usage is missing or over budget. The strict v2 parser remains available for historical replay.
- `hpi-pilot-evidence.v7` separates non-Run Quick receipts from canonical Managed Run Archives and accounts the three required raw-Pi comparator requests, tokens, and Provider-reported cost in the same frozen pilot authorization budget; the earlier v5/v6 hosted receipts remain historical rather than being relabeled.

The second slice connects those facts to a durable production path:

- `FilePilotCaptureCoordinator` opens or resumes one immutable plan-bound session, writes append-only HMAC-linked observations, rejects operation/fact rewrites, serializes the Quick/raw budget-check, Provider execution, and fact publication under one recoverable operation lock, enforces cumulative Provider budgets, reports only path-free status and next actions, and recovers an interrupted final publication without reusing a committed missing Archive;
- `hpi change --run-archive-id <id>` uses the durable Workflow Kernel and Task 9 Archive store, and embeds one strict product task receipt in the canonical Archive instead of relying on terminal output;
- `hpi change --pilot-interruption <kind>` is available only with that durable Archive path. The frozen kinds are `FORCED_PROCESS_KILL`, `TERMINAL_CLOSE_SIMULATION`, and `POWER_LOSS_SIMULATION`; they map to distinct process-policy, user-request, and timeout cancellation receipts after the trusted Agent-end marker. The two simulation labels intentionally do not claim a physical terminal or whole-machine outage. All three preserve one Checkpoint and recover through a new Attempt in the same Run;
- `hpi pilot capture managed-task` reads that exact canonical package, replays its kernel history, binds repository/source/reference/check/mode/outcome/Provider-use facts to the frozen task oracle, and derives its Run chain, Archive fingerprint, workflow-fact coverage, and automatic-intervention count. The live v2 path accepts no caller-authored metrics;
- Managed review now fingerprints Git-visible changed content and existing ignored content, freezes the exact interrupted/fixback workspace across recovery, compares the workspace before and after every independent Verification command, and rebinds the final branch plus target-reference fingerprint even when another branch points to the same commit. An ignored-file mutation, verification side effect, recovery-window drift, or final target-reference drift blocks readiness;
- each full working-tree snapshot uses one cumulative content-inspection budget: at most 8 GiB of newly hashed regular-file or symbolic-link-target bytes and 120 seconds elapsed, with product callers permitted only to tighten those ceilings. Exceeding either budget fails closed with `WORKING_TREE_INSPECTION_BUDGET_EXCEEDED`; no ignored content is silently omitted, and unchanged content is reused only through the exact stat-safe digest cache;
- the exported generic record schema and capture CLI reject caller-authored `TASK_CHAIN` and `RAW_PI_COMPARATOR` JSON. Product observations require a module-private runtime capability, while Managed tasks additionally require canonical Archive replay. A complete Evidence object, a path to an Archive, or an untrusted task/comparator summary cannot promote itself to live Evidence;
- finalization still requires the complete frozen observation set and runs only on Windows through the existing private runtime capability and append-only pilot Archive store.

## Remaining capture work

1. Bind installation, performance, Plugin, update, privacy/storage, review, and exact hosted CI receipts to their real product/operator sources. The packaged runtime now exposes a path-free memory sample, and Quick/Managed overhead excludes Provider runtime.
2. Finalize through `PilotEvidenceCaptureFinalizer` and `FilePilotArchiveStore`, then evaluate the exact trusted Archive.
3. Run the frozen ten-task Windows pilot in disposable worktrees for two explicitly selected repositories under one finite Provider request/token/cost scope, including the three product-derived raw comparators and distinct interruption paths.

## Verification policy

- RED → GREEN tests cover exact accounting, inconsistent totals, duplicate avoidance, propagation through the Engine Host, missing-accounting STOP, finite-budget STOP, and no unaccounted retry.
- Public contract changes update the Task 12 plan and user workflow documentation in the same commit.
- Focused suites, lint, typecheck, formatting, full local tests, package/clean-install smokes, compiled Pi probe, PR CI, and exact merged-head main CI must pass before this slice is treated as complete.
- No test or synthetic receipt changes the daily-use disposition. Only a complete real Windows Archive can produce Task 12 `GO`.

The first full local verification of the durable-capture slice passed 64 test files / 589 tests, strict compilation, build, and formatting, then retained a package-smoke `E404`: the hand-maintained tarball list omitted the newly required `@hunter-pi/managed-change` workspace and npm correctly attempted a public lookup. Package and clean-install smokes now discover the complete workspace set automatically. The current product-path verification first retained one post-review formatting-only failure after 66 files / 639 tests and build had passed. After formatting that exact Archive change, a fresh complete `npm run verify` passed 66 test files / 639 tests, lint, typecheck, strict compilation, build, formatting, all 13 internal package tarballs, the single CLI artifact, every `apps/*` and `packages/*` clean-install manifest, and the compiled provider-independent Pi probe. PR run `31343355260` then retained a deterministic Windows/Ubuntu lint failure: a new cross-workspace import omitted its TypeScript project reference, while stale local declaration output had hidden the omission. The repaired gate starts by cleaning all build output and has a policy test requiring every internal workspace dependency to have a direct project reference; the complete repaired tree passes 66 test files / 640 tests and the same strict build, package, clean-install, and Pi-probe gates. All earlier failures remain part of the record; a replacement hosted PR run and exact merged-head CI are still required for this slice.
