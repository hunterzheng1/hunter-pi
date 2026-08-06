# Foundation to daily-use execution plan

- Created: 2026-08-03
- Product baseline: `docs/11-decision-summary.md`
- Current repository phase: `TASK_9_11_LOCAL_PASS / TASK_12_REAL_PILOT_NOT_PROVEN`
- Active evidence gate: `TASK_12_WINDOWS_DAILY_USE_PILOT`
- First engine research candidate: Pi `0.83.0` / **PROVIDER_INDEPENDENT_SURFACES_SUPPORTED; EXACT_TASK_6_REQUEST_DETECTED; BROADER_PROVIDER_RELIABILITY_NOT_PROVEN**
- Delivery style: one task, one focused branch/PR, explicit local and remote results. Exception recorded 2026-08-06: Tasks 9–12 share the sequential `codex/daily-use` branch and PR #21 so their contract changes can be reviewed together; each task remains separately bounded and documented, and no release claim is inferred from the grouping.

## Outcome

Deliver a Windows-first Hunter Pi daily-use preview that installs as one product, launches a qualified Pi interaction, supports Quick Session and one complete Managed Change with failure/recovery/independent verification, loads standard Pi packages with honest Compatibility/Trust/Isolation results, and updates/rolls back without losing state.

## Global constraints

- Do not modify or reactivate archived Hunter Platform.
- Do not add a Hunter-Harness runtime dependency.
- Do not Fork Pi or OMP without a new accepted ADR and reproduced public-interface blocker.
- Do not implement desktop/mobile/team/cloud products in this plan.
- Do not store or print credentials, full environment dumps, private prompts, or absolute user paths in Evidence.
- Do not use real repositories for mutating probes.
- Do not commit executable product code, port external code, or publish artifacts until the owner selects a repository license and NOTICE/provenance policy.
- Do not call Fake proof, upstream documentation, installation, login, process exit, or pending CI a product PASS.
- Do not publish npm/installer artifacts until the owning task explicitly authorizes it.

## Task 0 — Documentation and repository baseline

**Goal:** create the independent repository and freeze product, architecture, domain language, upstream facts, stories, risks, decisions, testing, and this plan.

Deliverables:

- root contributor/product documents;
- product/architecture/workflow/security/release documents;
- Hunter-Harness mechanism disposition;
- dated Pi/OMP primary-source research;
- accepted initial ADRs;
- clean initial commit pushed to `main`.

Verification:

- Markdown links and relative paths resolve;
- no credential/private path content;
- after staging the intended initial tree, `git diff --cached --check` (plain `git diff --check` does not inspect untracked files);
- only intended documentation/repository metadata;
- remote branch points to exact local commit.

Completion means documentation exists; it does not mean any product capability is implemented.

Task 0 was pushed before a code license was selected. The owner subsequently selected MIT in ADR-0006 and added the root `LICENSE`, `NOTICE.md`, and provenance rules before Task 1 executable code.

## Task 1 — Shared engineering skeleton and dual-platform gate

**Goal:** establish one Node/TypeScript monorepo foundation for all later tasks.

Prerequisite: satisfied by ADR-0006 plus the committed root `LICENSE`, `NOTICE.md`, and `docs/provenance/` policy. Every later external code port still requires its own provenance record.

Deliverables:

- Node 24 and npm workspace policy;
- strict ESM TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and isolated modules;
- lint, typecheck, unit test, build, format/check, and package-smoke scripts;
- lockfile and dependency policy;
- Windows and Ubuntu GitHub Actions;
- initial packages only for `domain`, `engine-contracts`, `workflow-kernel`, and `testkit` when exercised;
- repository Doctor that reports local prerequisites without probing providers yet.

RED/GREEN:

- RED: workspace/package smoke and strict compiler fixtures fail before configuration;
- GREEN: clean install and minimal package import pass locally;
- REFACTOR: remove duplicate configs and make root scripts authoritative.

Gates:

- clean external `npm ci`;
- lint/typecheck/test/build/package smoke locally;
- actual Windows/Ubuntu CI for exact commit;
- no global Pi/Harness dependency.

Stop if Node/npm/Pi runtime requirements cannot coexist without a bounded packaging strategy.

## Task 2 — Domain, Workflow Kernel contracts, and deterministic Fake Host

**Goal:** prove core semantics without Pi.

Deliverables:

- branded IDs and strict schemas for Managed Change, Plan Revision, Run, Attempt, Step, Observation, Verification, Evidence, Checkpoint, Plugin Compatibility, Plugin Trust, Plugin Isolation, the combined Plugin Assurance Receipt, separate Compatibility Receipts, and Operation Receipts;
- command/event-driven Workflow Kernel Interface and deterministic in-memory implementation;
- provider-neutral Engine Host Interface;
- Fake Host and shared contract suite;
- state-transition and status projection tests;
- idempotent external-operation receipts.

Required RED cases:

- Agent return cannot make a Change ready;
- same operation ID/different payload is rejected;
- retry cannot overwrite failed Attempt;
- missing Verification cannot become PASS;
- unbounded loop schema is rejected;
- Pi/OMP/private provider fields are rejected from public schemas.

Gates: focused suites, full local gate, dual-platform CI.

## Task 3 — Durable events, Evidence, redaction, and replay

**Goal:** make workflow truth crash-safe and privacy-safe before real Agent execution.

Completion snapshot: implementation `1c90395a2fd1d2df8f8b69270e28fd8a7da2d1f2` passed local and Windows/Ubuntu PR gates, then merge `62b46cbc179bb8bb3c7a3195f4924d5b0c6c9524` passed Windows/Ubuntu main gates. The superseded `e1b06c523084a34c8b32a852848c906fa9877236` candidate retains its Ubuntu PASS / Windows FAIL history. Real power-loss behavior, real Pi, and a product entry point remain `NOT_PROVEN`.

Deliverables:

- append-only versioned event store with atomic writes;
- rebuildable projections;
- Evidence envelopes, content digests, bounded logs/cursors, and redaction metadata;
- HP-NFR-PERF-03 stream/Run/cache limits, retention projections, emergency reserve, and disk-full fault fixtures;
- Checkpoint schema and replay;
- adversarial secret/path/private-prompt corpus;
- fault injection around every durable write boundary;
- minimal human-readable Run summary.

Stop if partial state can be accepted as a valid terminal result or forbidden corpus values reach portable Evidence.

## Task 4 — Fixed-version Pi public-interface spike

**Goal:** determine whether official Pi interfaces can support the required Engine Host contract before building product UX.

Frozen candidate begins at Pi `0.83.0`; Task start rechecks current upstream and intentionally keeps or revises the candidate.

Deliverables:

- isolated `PI_CODING_AGENT_DIR` fixture;
- minimal Core Extension probe;
- Extension lifecycle/tool inventory receipt;
- JSON and RPC framing/cancel probes;
- SDK session/event/persistence/resume probes;
- exact capability receipts mapped from behavior, not product name;
- Windows and Ubuntu fixed-artifact evidence;
- documented interface gaps and recommendation: continue, change approach, or propose fork ADR.

All mutating probes use temporary Git fixtures. Provider login or paid model calls require explicit owner action and are not prerequisites for provider-independent contracts.

Hard Stop:

- required start/observe/interrupt/checkpoint/close semantics cannot be expressed through public surfaces;
- Core Extension cannot prove its active identity/effective tool graph;
- exact child/workspace cleanup cannot be reconciled.

Tasks 5+ do not start after a Stop without an owner decision.

## Task 5 — `hpi` Product Shell and first-run Doctor

**Goal:** create the first usable interactive developer preview around the qualified Pi candidate.

Deliverables:

- `hpi`, `version`, `doctor`, configuration, and Safe Mode commands;
- first-run wizard and isolated configuration root;
- Pi TUI launch through the Pi Host;
- provider data-egress disclosure and versioned acknowledgement before first send;
- documented provider login launch, cancellation, retry, and readiness status without credential extraction;
- visible mode/model/permission and plugin Compatibility/Trust/Isolation header;
- raw Pi coexistence test;
- Quick Session start/resume/exit smoke.

Gates include a clean external package install, fake-endpoint disclosure/cancel/privacy tests, and real interactive Windows smoke. Any real login or paid call requires explicit owner action and is reported separately. This task does not claim Managed Change.

Automation snapshot: implementation `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` passed the PR Windows/Ubuntu and cross-platform Evidence gates, then merge `8573b1f62d154275bb81c3c07b432a3db40632bb` passed the same gates on `main`. A tarball built from that clean merge installed successfully for the current Windows user and reported the expected product, Engine, source, product-shell, and Core identities. After preserving a real 20-minute Windows job cancellation and raising the measured scheduling ceiling, code-bearing `main` `160080eddde80d98ada58c8c78f3ccbe6754cc1a` passed Windows, Ubuntu, and aggregate Evidence CI, and its exact clean artifact replaced the earlier local installation; documentation baseline `99935827419d55834284da016b39bfcc80c180d7` also passed those gates. Smoke-clarity implementation `2a357795a2ae61c9db935ff11a922bbfe05ec892` then passed PR run `30870673783`, and exact installed code-bearing merge `0e58f539b713edb35f46fcbb55a63063dbbfa328` passed main run `30871449955`. Its 112119-byte tarball has SHA-256 `570d3eaf660f353717e0ab6b1f3da8b14ed6dc24cd99a22fe71850dc5ac3f3f8`; `hpi version --json` reported clean source `0e58f539b713edb35f46fcbb55a63063dbbfa328`, Pi `0.83.0`, product-shell SHA-256 `83880409f7e568c40438a7d162b65de94ecf4064e49d7ef59c250e445bc4fccf`, and Core SHA-256 `e431d4bd026984737a3e23b560f67a3f80076da5b1e4f403481b8850ab54858c`. On 2026-08-04 a real Windows terminal displayed the explicit `/hunter-status` marker, returned cleanly, and recorded the owner's affirmative exact-artifact acknowledgement. Doctor then reported `interactive_tui=DETECTED` while `provider_auth=BLOCKED`; real Provider login/request remains separately `NOT_PROVEN`.

## Task 6 — Managed Change vertical slice

**Goal:** run one small representative change in an automatically created disposable Git fixture through Define → Plan → Execute → Verify → Review → Ready, before real-repository safety is claimed.

Deliverables:

- Managed Change commands and projections;
- immutable Plan Revision;
- Quick Session promotion with captured Git/dirty-state identity and explicit inclusion/exclusion of existing fixture changes;
- focused project-check configuration;
- one Agent Step through real Pi;
- independent command verifier;
- deliberate failing Attempt and bounded fixback Attempt;
- review findings and final summary;
- no commit/push automation required.

Acceptance:

- failure history remains visible;
- Pi return does not complete the Change;
- exact source/config/check identities bind Verification;
- the fixture and all mutation targets are disposable and independently validated;
- total workflow meets the preregistered value scorecard below.

Preregistered Task 6 scorecard:

- zero false `READY`, source loss, secret leak, or overwritten failed Attempt;
- the deliberate failed Attempt remains visible and a new fixback Attempt passes every invalidated required check;
- no more than two unplanned user interventions after Plan approval;
- Hunter workflow overhead, excluding Agent and declared-check runtime, is at most ten minutes;
- the final summary identifies every required check, Attempt, blocking finding, and unresolved risk.

Outcome is deterministic: **GO** only if every item passes; **REVISE** if all zero-tolerance and correctness conditions pass but the intervention or overhead target misses; **STOP** on any zero-tolerance failure or a required public-interface blocker. Real user repositories remain prohibited until Task 7 passes its containment gates.

Implementation status on 2026-08-04: **MERGED / MAIN CI PASS**. The first real disposable-fixture run preserved the required execution, verification, review, and cleanup history, but did not retain Pi captured-output bytes and assigned the full 262144-byte Run limit independently to Pi and each verifier; its premature `GO` was superseded without erasing the run. The correction partitions the same frozen total into 229376 bytes for Pi and 16384 bytes for each verifier, records provider-neutral output usage, sums every component, and makes failed or missing reconciliation blocking. A separately authorized corrected request from clean source `e36ee52764065cea02982962e2f84ff9ed3d0034` then passed with 90476 Pi bytes plus 17 and 13 verifier bytes, 90506 total, zero findings, and successful cleanup. Product/Evidence commit `502011b8a34e9773e415643b01a838c04d5582c5` and documentation commit `3c4d5e5200f29a70a607fa6d40be63a6c99b92c9` passed their PR gates; PR #15 merged as `b77937f689bca859a29c7df22025ce12e875bda4`, and exact main run `30886919708` passed Windows, Ubuntu, and aggregate Evidence identity.

## Task 7 — Git worktree, leases, and managed process host

**Goal:** make Managed Change safe for normal repositories and long commands.

Deliverables:

- isolated worktree create/validate/preserve/cleanup;
- writer and resource leases;
- managed process sessions, heartbeats, incremental logs, timeout, cancel, and terminal finality;
- Windows process-tree isolation and Unicode/space path fixtures;
- symlink/junction and unique-work adversarial cleanup tests;
- branch-hygiene receipts.

Stop on any reproducible source-loss, escaped process tree, or ambiguous cleanup result.

Implementation status on 2026-08-06: **ATTEMPT #15 FULL LOCAL PASS / INDEPENDENT EXACT-HEAD REREVIEW PASS / PR CI PASS / MAIN CI PASS**. Owner-authorized test-infrastructure scope made real Git/process fixtures run one file at a time under a per-run contained Temp root, with bounded retry cleanup and child-close reconciliation. PR run `30966180228` later reproduced a non-atomic Linux `/proc` scan that could publish an empty tree before a detached orphan was reparented. Source `faaaabdf01e2aa8d4766f9f0dc5495b2e479a672` serializes termination/reconciliation and resets empty candidates on active scans and control boundaries. Independent rereview retained the post-Evidence mixed-stress timeout but closed it as non-reproducible host/test-scheduling history after exact clean and pressured reproductions. Attempts #13/#14 remain historical after successive exact-verifier identity findings. Replacement source `0580778b260c944da06fdac2d809a0db7e5f7df5` and append-only v4/v5 attempt #15 receipts bind the closed 29-path verifier set and pass the exact Windows/Ubuntu, consistency, privacy, and full 302/302 local gates. PR #16 and exact main run `30979052589` passed within the recorded disposable-fixture bounds. Task 8 is complete within its recorded receipt-fixture bounds.

Detailed execution: [2026-08-04 — Task 7 worktree, leases, and process host](2026-08-04-task7-worktree-leases-process-host.md).

## Task 8 — Verification adequacy and review/fixback

**Goal:** prevent partial test execution or review text from becoming a false completion claim.

Deliverables:

- verification DAG and resource locks;
- selected/collected/executed/passed/skipped accounting;
- reuse invalidation by source/config/environment identity;
- structured P0–P3 findings;
- RED/GREEN fixback batches;
- exact Human Receipt;
- adequacy validator gating `READY`.

Gates include missing, duplicate, filtered, skipped, timeout, truncated, and stale-reuse negative fixtures.

Implementation status on 2026-08-05: **COMPLETE WITHIN PROVIDER-NEUTRAL RECEIPT-FIXTURE BOUNDS / LOCAL PASS / PR CI PASS / MAIN CI PASS / TASKS 9–11 LOCAL PASS / TASK 12 REAL PILOT NOT_PROVEN**. Merge `bbb409c282741431b75e7303b27154755c86ffd1` adds the strict adequacy schemas and validator, and exact main run `30984969665` passes Windows/Ubuntu quality, Task 7 containment, Task 7 Evidence, and Pi Evidence. Detailed scope, RED/GREEN history, and the retained initial CI failures are recorded in [2026-08-05 — Task 8 verification adequacy](2026-08-05-task8-verification-adequacy.md). Provider requests and real user repositories remain `NOT_RUN` for the new daily-use pilot.

## Task 9 — Checkpoint recovery and archive

**Goal:** resume safely after terminal/process interruption and freeze every outcome.

Deliverables:

- periodic durable Checkpoints;
- process/operation/workspace/session reconciliation;
- new recovery Attempt semantics;
- forced-kill matrix;
- idempotent post-Run Archive finalizer, manifest/checksum/replay, and readable outcome summary;
- successful, failed, blocked, cancelled, and incomplete archives.
- a portable second-device fixture: clone versioned project policy into a clean device profile, import a redacted Archive, rerun Doctor/login readiness, reject device-local paths/leases/processes, and prove that a live Attempt is not falsely migrated.
- explicit Archive/artifact export and exact-target deletion receipts; no automatic deletion of event facts, terminal receipts, Checkpoints, or Archive manifests.

No knowledge auto-promotion yet. Stop if recovery requires manual state editing or rewrites incomplete history.

Implementation status on 2026-08-06: **LOCAL PASS / REVIEW-HARDENED PR AND MAIN CI PASS WITHIN PROVIDER-NEUTRAL DURABLE-FIXTURE BOUNDS** — periodic Checkpointing, exact operation-identity recovery replay, reconciliation-driven recovery Attempts, cancellation finality, five terminal Archive outcomes, canonical archive binding, durable import/export/delete receipts, strict export-envelope deletion, clean-profile second-device import/rejection, and cross-process durable mutation locks are implemented and locally verified. The focused Task 9 set is 7 files / 67 tests; the sharded repository set is 46 files / 362 tests. Earlier PR CI run `31032218373` covers the pre-hardening source; hardened replacement PR CI `31042109585` and exact merged-head main CI `31044936543` pass Windows/Ubuntu quality, containment, and Evidence jobs. The retained hosted Linux process-tree timeout history and its fix are recorded in [Linux process-tree validation](../validation/2026-08-05-linux-process-tree-hosted.md). Real power loss, arbitrary user repositories, and Provider recovery remain `NOT_PROVEN`.

## Task 10 — Standard Pi Package manager and compatibility/trust/isolation

**Goal:** let users install Pi ecosystem packages without hiding compatibility and authority.

Deliverables:

- list/install/disable/remove/import-from-pi flows for exact local/npm/Git sources;
- resource and effective tool/hook inventory;
- separate Compatibility (`VERIFIED`/`UNVERIFIED`/`INCOMPATIBLE`), Trust (`BUNDLED`/`USER_APPROVED`/`QUARANTINED`), and Isolation (`CONTAINED`/`PROCESS_AUTHORITY`/`NOT_PROVEN`) receipts;
- Safe Mode recovery;
- compatibility fixtures and at least two representative external packages;
- license/provenance inventory.

Stop if user plugin code must execute before Safe Mode or provenance display, if critical Core Extension shadowing cannot be detected, or if Compatibility would have to be presented as a general safety/containment claim.

Implementation status on 2026-08-05: **LOCAL PASS WITHIN METADATA-ONLY PACKAGE BOUNDS** — exact source binding, verifier-fingerprint- and Evidence-bound Compatibility/Isolation receipts, separate Trust receipts, Safe Mode, provenance/privacy rejection, durable replay locks, and append-only lifecycle operations pass. No general third-party package compatibility or OS containment claim is made.

## Task 11 — Qualified update, packaging, and rollback

**Goal:** make Hunter Pi one maintainable install instead of two manually coordinated products.

Deliverables:

- compatibility manifest and candidate qualification runner;
- stable/preview channels;
- disabled/uncontrolled Pi self-update;
- exact npm artifact and clean install smoke;
- Windows x64 portable/installer decision and implementation;
- atomic apply, health check, migration, failed-update recovery, and rollback;
- artifact digests, dependency/license inventory, and release evidence template.

Publishing requires explicit owner authorization after all candidate gates and actual remote CI pass. Unsigned artifacts are labeled accordingly.

Implementation status on 2026-08-06: **LOCAL PASS / REVIEW-HARDENED PR AND MAIN CI PASS WITHIN UNSIGNED DEVELOPER-PREVIEW BOUNDS** — qualification runner, Evidence-bound checks, Stable/Preview/self-update gates, request-fingerprint replay, exact artifact digest/health/apply/rollback journal, fail-closed portable redaction for failure receipts, Windows x64 portable directory with embedded Node 24, external package smoke, clean install smoke, and Pi probe pass. Earlier PR CI run `31032218373` covers the pre-hardening source; hardened replacement PR CI `31042109585` and exact merged-head main CI `31044936543` pass all Windows/Ubuntu quality, containment, and Evidence jobs. The clean portable manifest binds source `31034a4`, uses `updateChannel=developer-preview`, and is unsigned. Publication, signing, state migration, and stable promotion remain `NOT_PROVEN`.

## Task 12 — Windows daily-use pilot

**Goal:** determine whether Hunter Pi is genuinely ready for regular personal use.

Before execution, freeze the acceptance machine profile: Windows build, CPU model/core count, RAM, storage type, terminal, Git, security-software state, power mode, network condition, Hunter Pi release, and Engine Release. Freeze the ten task definitions, raw-Pi comparator configuration, expected terminal oracle, and applicable workflow-fact checklist before observing results. Checklist score is `captured applicable facts / total applicable facts` with raw counts retained; a manual intervention is a user action needed only to maintain delivery bookkeeping, verification certainty, or recovery state rather than to clarify the task itself.

Pilot:

- fresh supported Windows installation;
- ten real tasks across at least two repositories;
- at least three paired tasks run once through configured raw Pi and once through Hunter Pi, with identical starting source and declared acceptance checks;
- Quick and Managed modes;
- deliberate failure/fixback;
- forced interruption/recovery;
- representative plugins;
- qualified update and rollback;
- privacy/hash/full gate;
- actual Windows/Ubuntu CI for final commit.

Collect setup time, startup/steering latency, verification time, resource peaks, interventions, false completion prevention, recovery success, plugin conflicts, and user friction.

Required quantitative gates:

- zero false `READY`, source loss, raw secret leakage, or unacknowledged provider send;
- at least 9 of 10 tasks end in the correct actionable terminal outcome against the frozen oracle;
- all three forced interruptions preserve history and source; at least two resume successfully, and any unsupported resume is accurately `BLOCKED` or `NOT_PROVEN` rather than guessed;
- 20 measured warm starts meet HP-NFR-PERF-01 p95 ≤ 3 seconds after five discarded warm-ups;
- 30 local cancellation/steering/status acknowledgements meet HP-NFR-PERF-02 p95 ≤ 250 ms with upstream wait excluded only when separately observed;
- both of two qualified update-and-rollback cycles preserve state and restore a usable known-good version;
- all five frozen broken/malicious plugin fixture sets (throwing initialization, reserved collision, built-in override, secret/path leakage, and oversized output) start in Safe Mode without evaluating user plugin code;
- no recovery or rollback requires manual editing of Hunter state files;
- no unresolved P0/P1 review finding remains;
- Hunter-owned process memory meets HP-NFR-PERF-05;
- HP-NFR-PERF-03 limits are observed during the pilot; soft/hard-limit and disk-pressure fixtures prove bounded output/cache, a usable 64 MiB critical reserve, replayable prior state, blocked unsafe new Runs, and no automatic critical-record deletion;
- across the three paired comparator tasks, Hunter captures at least 95% of the preregistered applicable workflow-fact checklist and never scores below raw Pi; it also either reduces aggregate manual bookkeeping/recovery interventions by at least 30% or detects/contains at least one injected false-completion or recovery ambiguity left manual in raw Pi, while median additional Hunter-only overhead remains ≤ 10 minutes.

Raw samples, task oracles, interventions, comparator differences, environment identity, and every failure remain in the Evidence set. Provider/model latency is reported separately from Hunter-owned latency; if it cannot be separated, the relevant performance claim is `NOT_PROVEN`.

Terminal outcomes:

- **GO** — every required gate passes; publish a daily-use preview only after the separately authorized publication gate and begin bounded backlog prioritization;
- **REVISE** — every zero-tolerance gate passes, but one or more noncritical quantitative gates miss; preserve Evidence and execute only named fixes in at most two linked replacement pilot Runs, each bound to one new immutable Plan Revision;
- **STOP** — any zero-tolerance or comparator-value gate fails, a core invariant remains blocked, or the same required noncritical gate still misses after two replacement pilot Runs.

The terminal pilot decision is an aggregate projection over the original and replacement Run Archives. It lists every miss and predecessor/successor link; a later passing Run never erases an earlier pilot failure.

Implementation status on 2026-08-06: **PLAN/PREFLIGHT IMPLEMENTED / LOCAL PASS / PR CI PASS / MAIN CI PASS / REAL PILOT NOT_RUN** — the strict v3 Evidence schema, explicit PASS fresh-install receipt, source-bound and platform/run-distinct Windows/Ubuntu CI run receipts, frozen machine/comparator/check/plugin/update inputs, target-reference and acceptance-definition binding, two-distinct-repository/source-identity comparator, exact-plan Evidence binding, fingerprint-bound ten-task plan compiler, explicit Provider-request authorization gate, safe `hpi pilot preflight` CLI with redacted actionable reason codes, and GO/REVISE/STOP/NOT_PROVEN evaluator policy tests. The sharded local repository set is 47 files / 382 tests. The policy now requires either at least 30% aggregate manual-intervention reduction or a contained false completion, while median Hunter-only overhead remains an independent ≤10-minute gate. PR #26 gate head `b79bb2d9388970790db6759a25d2456667ede22c` passed [PR CI `31060711208`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31060711208); merge `c2f585273fdcdf6fe08dbe08e8af8a2cb77e8d14` passed [exact main CI `31062028819`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31062028819) across Windows, Ubuntu, containment, and Pi Evidence jobs after one retained Ubuntu hosted-test timeout and a failed-job rerun without source changes. No repository targets, Provider credentials, or ten-task observations were safely inferable; daily-use acceptance remains `NOT_PROVEN` until the real pilot produces its required Archive.

## Task 13 — Stable 1.0 decision, not automatic work

Task 13 is a decision checkpoint, not implied authorization. It evaluates support platforms, signing, default permissions, knowledge promotion, optional Harness protocol, additional OMP-inspired modules, and whether any Pi patch/fork is justified by accumulated evidence. The repository license is deliberately resolved before Task 1 and is not deferred to this checkpoint.

## Milestones

| Milestone | Tasks | User-visible claim |
|---|---|---|
| M0 Documentation | 0 | design exists; no product |
| M1 Contract foundation | 1–3 | Hunter workflow contracts proven with Fake Host |
| M2 Interactive developer preview | 4–5 | fixed Pi interaction works on tested fixtures |
| M3 Managed delivery preview | 6–9 | one real verified/recoverable Change works |
| M4 Extensible distributable preview | 10–11 | packages and qualified updates work on tested artifacts |
| M5 Daily-use decision | 12 | bounded real-use Evidence supports GO/REVISE/STOP |

## Per-task handoff report

Every task reports:

- branch, commit, PR, and exact source identity;
- files and public contracts changed;
- RED/GREEN/REFACTOR evidence by cluster;
- local commands and actual results;
- Windows/Ubuntu CI links and actual/pending state;
- real vs Fake/provider-independent results;
- credentials/privacy scan result;
- known risks, skips, and NOT_PROVEN capabilities;
- worktree/branch cleanup disposition;
- next task recommendation or Stop condition.
