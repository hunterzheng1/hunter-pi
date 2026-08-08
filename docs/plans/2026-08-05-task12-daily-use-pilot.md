# Task 12 — Windows daily-use pilot

- Scope: a real Windows acceptance run, not a deterministic fixture suite
- Frozen inputs: machine profile, two repository identities, ten task/oracle pairs, raw-Pi comparator configuration, acceptance checks, plugin fixtures, update candidates, and the exact Hunter/Engine release identities
- Safety boundary: no user repository is selected implicitly; no Provider or paid request is made without an explicit target and credentials owned by the operator

## Evidence contract

`@hunter-pi/pilot` contains the strict `hpi-pilot-evidence.v5` schema and evaluator. It requires an explicit PASS fresh-install receipt bound to the tested source, release artifact, and clean profile; exact Windows/Ubuntu CI receipts bound to source, artifact, Engine, and run identities; comparator/task-result binding for both identities and numeric observations; and an explicit receipt that recovery or rollback required no manual Hunter state-file editing. It retains raw counts and calculates nearest-rank p95 for the required warm-start, acknowledgement, and memory samples. Its `PilotPlanCompiler` freezes the machine profile, comparator/check fingerprints, five plugin fixtures, two update candidates, ten tasks, three paired tasks, two distinct repository identities, and the Provider authorization policy into a path-free, fingerprint-bound execution plan. Evidence must carry the exact plan fingerprint and authorization scope, and the evaluator rejects task, paired-comparator, Plugin, update, or machine identities that do not match that plan. A false `READY` is a zero-tolerance `STOP`, not a 9-of-10 quantitative miss. `hpi pilot compile --input <file> --json` emits only a strict, path-free execution plan or the same redacted blocked preflight receipt; `hpi pilot preflight --plan <file> --json` exposes only a redacted `READY`/`BLOCKED` receipt with fixed actionable reason codes; and `hpi pilot evaluate --plan <file> --evidence <file> --archive <file> --json` emits the strict decision, returning exit code 0 only for `GO` and never starting Pi or sending a Provider request. It returns `GO`, `REVISE`, `STOP`, or `NOT_PROVEN`; missing CI, missing Provider-latency separation, identity mismatches, and incomplete pilot observations cannot become `GO`.

## Required run

- fresh supported Windows x64 portable installation;
- ten real tasks across at least two explicitly selected repositories;
- three paired raw-Pi/Hunter tasks with identical source and acceptance checks;
- Quick and Managed modes, deliberate failure/fixback, and three forced interruptions;
- five frozen broken/malicious plugin fixtures, two qualified update/rollback cycles, and the privacy/storage gates;
- exact Windows and Ubuntu CI for the final source/artifact identity.

## Current disposition

The evaluator, explicit plan compiler, safe compile/preflight/evaluate CLI, and policy tests are implemented and pass. The disposable-fixture entry point now fails closed unless `--allow-provider-request` is supplied and the operator confirms the declared Provider scope. PR #32's exact head `7cc85b5b190c44ebc3eb737b08dd4078ded8e7b2` passed run [`31082027466`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31082027466), and merge `e886b48a617d6df8f63bbaae9cadcc0ea0f66dba` passed exact main run [`31083253052`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31083253052) across Windows, Ubuntu, containment, and Pi Evidence jobs. Documentation merge `8324ca74604472468bc2c42c5e924663e57a61a4` retained the first Task 7 containment failures in main run [`31085901324`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31085901324); the failed Windows/Ubuntu jobs were rerun without source changes and passed, followed by the Task 7 Evidence aggregation. The real ten-task pilot is still **NOT_RUN** because no repository targets, Provider credentials, or operator authorization for a real request were supplied or safely inferable. This is an evidence boundary, not a product pass. The product must remain `NOT_PROVEN` for daily-use acceptance until a dated pilot Archive and its real-use observations exist.

PR #35's first exact-head run [`31097883371`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31097883371) retained a Windows hosted-runner timeout in the qualified CLI fixture and a Task 7 Windows probe failure; the CLI test budget was made explicit in `370277f`. Its second run [`31098601322`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31098601322) passed both main jobs but retained non-diagnostic Task 7 `TEST_EXECUTION` failures on both platforms. The platform fixture's two remaining default Vitest budgets were made explicit in `a08eb30`; exact PR run [`31100253395`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31100253395) then passed Windows/Ubuntu main CI, both Task 7 containment jobs, and both Evidence aggregation jobs. These receipts establish hosted-runner verification for the changed head; they do not replace the real ten-task pilot.

The documentation head `cc8b2b6` initially retained an Ubuntu Task 7 `TEST_EXECUTION` failure in run [`31101712125`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31101712125); its failed-job-only rerun passed without source changes, including the Task 7 Evidence aggregation. The merge commit `d97d591d3069e2d9a3dfb65a833118583014d119` then passed exact main run [`31103202175`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31103202175) across Windows/Ubuntu main CI, Task 7 containment, Task 7 Evidence, and Pi Evidence.

The real-project entry point is now implemented as `hpi change --repo <directory> --plan <file> --json --allow-provider-request`. It requires a clean physical Git root, a strict path-free `hpi-managed-change-request.v2` plan with exact relative `allowedPaths`, a target binding produced from explicit target preparation, Provider auth metadata, and explicit target/request acknowledgement; it rechecks the canonical Git snapshot before Agent start and blocks `TARGET_IDENTITY_MISMATCH`, runs bounded Pi JSON work in the selected repository, independently verifies `workspace-root`, reviews every changed path, emits path-free `hpi-managed-change.v2` Evidence carrying the same target binding, and never commits, pushes, publishes, or deploys. Its local contract tests use temporary Git repositories only; they do not change the real-pilot disposition.
The default real-project adapter now routes Pi JSON through the qualified Task 7 local process host (Windows Job Object or Linux process-tree containment), holds a durable repository writer lease across the whole Managed Change, rechecks the clean source after acquiring that lease, and releases the lease before emitting GO/STOP Evidence. Its local contract tests use temporary Git repositories only; they do not change the real-pilot disposition.

## Safe target preparation

The CLI command `hpi pilot target --repo <directory> --target-id <id> --json` is a read-only preparation step for an explicitly selected operator repository. It requires the exact physical Git root, rejects symlink/junction or non-root paths, rejects dirty worktrees and detached `HEAD`, and emits only a path-free `hpi-pilot-repository-target.v1` receipt containing repository, source, and target-reference fingerprints. It never starts Pi, checks Provider authentication, sends a request, creates a worktree, or modifies the selected repository. A `READY` target receipt supplies the three identity fields needed to construct a later frozen plan; it is not pilot Evidence and cannot produce daily-use `GO` by itself.

## Current dated boundary (2026-08-06)

The merged Task 12 product/evidence baseline is `b37f8fb`; its exact main CI run [`31109317291`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31109317291) passed the recorded Windows, Ubuntu, containment, Task 7 Evidence, and Pi Evidence jobs. The real pilot remains `NOT_RUN` / `NOT_PROVEN`: no pair of explicitly selected operator-owned repositories, Provider credential/endpoint scope, real-request authorization, or ten-task observation Archive is available. No external repository or Provider request was inferred or touched. The append-only validation record [2026-08-06 — Task 12 real-pilot boundary](../validation/2026-08-06-task12-real-pilot-boundary.md) records the exact safety boundary and unblocking evidence.

## Provider-scope evaluator hardening (2026-08-07)

The pilot evaluator now emits a zero-tolerance `STOP` when Evidence claims a Provider send under a frozen `NO_PROVIDER_REQUESTS` operator scope, using the frozen plan policy even if Evidence forges another scope. `NO_PROVIDER_REQUESTS` is reserved for preflight/negative fixtures and cannot produce daily-use `GO`; a real daily-use run requires the explicit operator-authorized scope. This closes a contradictory-Evidence path without initiating any Provider request or changing the explicit-authorization path. The regression tests first reproduced the incorrect `GO` and `NOT_PROVEN` outcomes, then passed after the minimal evaluator gate; the real-pilot disposition remains `NOT_RUN` / `NOT_PROVEN`.

The hardening commit `386abba` merged as PR #47 (`c3aa454`); exact main CI [`31176158257`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31176158257) passed all six required jobs. Windows Task 7 attempt-1 `TEST_EXECUTION` failure was retained and its one allowed retry passed; the run did not rewrite that history. One local `npm run verify` invocation also retained an npm `ECONNRESET` during package smoke; the independent package smoke rerun passed, and the failure is classified as external npm registry transport variance rather than a product/test assertion failure.

## Trusted Archive and Provider accounting hardening (2026-08-09)

Task 12 now uses plan-input/execution-plan v2 and Evidence v5. Live pilot Evidence carries an explicit
`LIVE_WINDOWS_PILOT` capture provenance. A `FilePilotArchiveStore` writes an append-only, path-free
Archive package whose immutable facts, Evidence fingerprint, observed time, and local store receipt
are verified before a `TrustedPilotArchive` handle is returned. The persistence boundary accepts only an
opaque capture authority issued by the capture runtime; raw JSON cannot promote itself to live Evidence.
An HMAC-bound identity reservation remains after package deletion; a separate immutable commit receipt
distinguishes a recoverable interrupted reservation from a committed Archive whose package disappeared.
The package, reservation, and commit receipt each publish through flushed temporary files and
non-overwriting hard links. Fixture/test provenance, plain Evidence files, modified packages, store
aliases, and mismatched observation times fail closed. The evaluator and CLI require that trusted Archive
for any decision that could otherwise resemble `GO`; the CLI form is `hpi pilot evaluate --plan <file>
--evidence <file> --archive <file> --json`.

Each Evidence task result now records Provider request/token/cost counts, and the linked Run Archive
chain must have one reachable root and one terminal Run. Replacement Runs are aggregated for both
Provider authorization and task outcomes; only a READY replacement whose linked Run and Archive
fingerprint match an interruption counts as a successful recovery, and its interrupted predecessor must
be terminal `INCOMPLETE` or `CANCELLED`; interruption receipts cannot reuse a predecessor or replacement
Run. Explicit Provider scopes require finite maximum request, token, and cost budgets, and over-budget
usage is a zero-tolerance STOP.

These gates harden the authority boundary but do not create a real pilot. No external repository,
credential, or Provider request was inferred or touched. The source-level test capture helper is not a
package export, and the current product has no production capture finalizer; daily-use acceptance remains
`NOT_RUN / NOT_PROVEN` until a separately authorized Windows pilot produces its complete immutable
Archive and exact hosted Windows/Ubuntu receipts.
