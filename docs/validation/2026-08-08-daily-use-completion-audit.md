# Daily-use completion audit (2026-08-08)

## Disposition

`NOT_PROVEN` for Windows-first daily use.

Tasks 9–11 contain useful provider-neutral implementations, but their previous local `PASS`
labels were broader than the behavior proved by their adapters and fixtures. Task 12 remains
`NOT_RUN`; its current evaluator is a policy calculator, not an authoritative real-use GO
oracle. Exact Windows/Ubuntu CI proves the checked-in source at its tested scope and does not
close these gaps.

This audit does not discard earlier passing tests or CI receipts. It narrows the claims those
receipts support and keeps every prior failure and `NOT_PROVEN` result append-only.

## Task 9 — Checkpoint, recovery, and Archive

Status: `COMPLETE` within provider-neutral automatic-fixture and hosted v2 Evidence bounds.

The completed scope proves:

- exact process-final and Writer Lease release receipts are bound into one immutable Attempt
  Finality Receipt and replay identically after reopen;
- mutation-lock recovery uses signed process liveness, elects one reconciler at a canonical
  physical path, and survives forced termination at all claim/receipt/removal boundaries;
- import/export/delete replay and clean-profile second-device projection use immutable intents,
  exact archive/operation identities, v3 policy reconciliation, structured credential rejection,
  interrupted-import resume, and fail-closed foreign-remnant handling;
- exact PR run [`31254320490`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31254320490)
  and merged-head main run
  [`31255040766`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31255040766) pass Windows,
  Ubuntu, Task 9 cross-platform Evidence, Task 7 containment, and Task 7 Evidence aggregation.

The merged-head receipts bind source `7d8039358a0e3ac6cf2ead8cee7eba25c47f8f0b`, the fixed 90-test
contract matrix (Windows 90 pass; Ubuntu 89 pass plus the one Windows-only alias assertion), six
direct finality/privacy checks per platform, and one passing cross-platform comparator. Every earlier
failed hosted run remains append-only in the detailed Task 9 validation record.

The Archive boundary now independently rescans retained Evidence summary and capture text. A
caller cannot bypass credential/private-text rejection merely by setting `contentClass=LOG`,
`credentialMaterial=false`, and forged redaction metadata. Real OS power loss, an arbitrary user
repository, a physically separate operator device, and Provider recovery remain `NOT_PROVEN` and
are not inferred from the automatic fixtures.

Relevant implementation: [`archive.ts`](../../packages/evidence/src/archive.ts),
[`portable-device.ts`](../../packages/evidence/src/portable-device.ts),
[`atomic-write.ts`](../../packages/evidence/src/atomic-write.ts),
[`recovery.ts`](../../packages/workflow-kernel/src/recovery.ts), and
[`in-memory-workflow-kernel.ts`](../../packages/workflow-kernel/src/in-memory-workflow-kernel.ts).

## Task 10 — standard Pi Packages (snapshot before merged-head evidence)

Status at snapshot: `IMPLEMENTATION COMPLETE / HOSTED EVIDENCE PENDING` within the exact resource-only package
boundary; arbitrary executable Plugin compatibility and OS containment remain `NOT_PROVEN`.

The replacement implementation now proves within its current local/contract boundary:

- real public PackageManager metadata resolution for exact LOCAL and explicitly selected Pi-import
  fixtures, plus exact NPM-SRI and Git-commit/tree adapter contracts; a bounded public npm install
  also passed through the installed single-artifact CLI on the current Windows development machine,
  including quarantine and managed removal, but real public Git and lifecycle attack-package
  installation remain `NOT_RUN` in platform Evidence. One post-hardening rerun first exposed a
  transient compile-cache enumeration race; its failure is retained in the Task 10 plan, the
  regression is fixed, and the exact local observation subsequently passed;
- no extension evaluation during metadata resolution, qualification, inventory, startup, or Safe
  Mode, including two locked external Pi examples and five frozen malicious fixture classes;
- portable v2 Manifests and qualification receipts separated from exact device-local runtime path
  bindings, with private/credential-shaped metadata rejected and v1 journal parsing frozen to its
  historical contract;
- append-only install/disable/remove replay, reserved Hunter/Pi built-in collision rejection, and
  serialized cross-process lifecycle mutations, plus automatic Safe Mode for quarantine,
  corruption, collision, missing/tampered bindings, or changed package resources;
- exact startup activation for metadata-qualified resource-only skills/prompts/themes from a
  Hunter-owned, content-addressed, read-only snapshot; installation has finite time/output/tree/free
  space budgets, private empty npm/Git credential configuration, single-artifact worker routing,
  and failed generations are removed.

Executable extensions remain `UNVERIFIED` and quarantined in the standard path. Ordinary extension
code would retain `PROCESS_AUTHORITY`; no permission profile is presented as an OS sandbox, and a
same-authority attacker changing a snapshot after final revalidation is not claimed contained.
Registry removal deletes the validated Hunter-owned runtime snapshot/binding while preserving
append-only journal/qualification history; LOCAL and selected PI source directories are untouched.
Package-tree hashing excludes `.git` and `node_modules`, so this audit does not infer extension
dependency-closure qualification from the resource-only result.

The 18-test Task 10 contract matrix, platform probe, and exact Windows/Ubuntu comparator are checked
in. A clean Windows local probe on commit `b46e67acd81812db6d8cb1dad52c9639f8a022df` passed with
source identity equal to that commit, 18/18 contract tests, all nine checks, and privacy `PASS`;
the platform receipt correctly keeps public npm `NOT_RUN` because the separate installed-artifact
observation is not promoted to hosted Evidence. Clean-commit hosted Windows/Ubuntu receipts remain
`PENDING` until CI runs. Relevant implementation:
[`pi-package-resolver.ts`](../../packages/pi-host/src/pi-package-resolver.ts),
[`plugin-activation.ts`](../../packages/pi-host/src/plugin-activation.ts),
[`plugin-qualification.ts`](../../packages/pi-host/src/plugin-qualification.ts),
[`contracts.ts`](../../packages/plugin-manager/src/contracts.ts), and
[`manager.ts`](../../packages/plugin-manager/src/manager.ts).

## Task 11 — portable release and updates (snapshot before hosted closure)

Status at snapshot: `PARTIAL`; unsigned developer preview only.

The updater kernel validates candidate metadata, artifact bytes, health checks, journals, and
fixture rollback. The portable builder can assemble a Windows x64 directory. Daily-use release
gates remain open because:

- there is no production Windows version-directory activation adapter or user-facing
  `check/apply/rollback` command;
- activation-before-journal crash reconciliation and rollback-byte re-verification are not
  implemented on a real filesystem;
- state migration/backup/reversal is an injected callback rather than a persisted release
  contract;
- Stable trusts declared signature metadata instead of verifying a publisher signature;
- CI does not yet build one frozen Windows portable archive and bind a machine-readable Task 11
  receipt to that exact digest.

No retained ignored `.artifacts` directory is release Evidence. Publication, signing, Stable
promotion, and migration of existing user state remain `NOT_PROVEN`.

Relevant implementation: [`manager.ts`](../../packages/updater/src/manager.ts) and
[`pack-windows-portable.mjs`](../../scripts/pack-windows-portable.mjs).

## Task 12 — real pilot and GO authority

Status: `NOT_RUN / NOT_PROVEN`.

The existing strict plan and evidence schemas are valuable negative-policy tests, but a caller
can author fixture-shaped JSON that returns the same `hpi-pilot-decision.v2` `GO` shape and exit
code as a future real pilot. Product GO therefore remains blocked until the evaluator resolves
immutable Archive/Receipt digests from a trusted local store and rejects fixture provenance.
The evaluator must also count only genuinely successful interruption outcomes, aggregate linked
replacement Runs, and bind the Provider authorization to the maximum possible request count.

A real pilot still additionally requires two explicitly selected operator-owned repositories,
exact allowed paths and checks, Provider/model/endpoint/account scope, bounded request/token/cost
authorization, forced-interruption/plugin/update risk authorization, a fresh Windows profile,
ten task observations, three raw-Pi comparators, performance/privacy/storage samples, exact final
Windows/Ubuntu CI, and one dated immutable aggregate Archive. None is inferred from local
credentials, the Hunter Pi repository, or disposable fixtures.

## Required order before daily-use GO (snapshot)

1. Close Task 9 process/lease finality, crash recovery, immutable receipt, and platform Evidence
   gates.
2. Run and compare the exact Task 10 Windows/Ubuntu receipts before treating its resource-only
   package path as closed; keep executable extensions quarantined.
3. Implement and verify the Task 11 Windows activation, migration, rollback, exact portable
   artifact, signing/promotion, and machine Evidence path.
4. Bind Task 12 evaluation to immutable non-fixture Archives and exact Provider authorization.
5. Run the separately authorized real Windows pilot. Only its complete Archive can support
   `GO`.

## Addendum (2026-08-09)

The earlier sections are the 2026-08-08 boundary snapshot and remain preserved as historical
reasoning. Task 10's hosted resource-only Evidence is recorded by exact main run
[`31265986035`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31265986035). Since then,
Task 11's implementation and hosted Evidence gates completed without
expanding the real-use scope: PR #53 run [`31270421168`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31270421168)
and exact merged-head main run [`31272146162`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31272146162)
passed Windows/Ubuntu quality, the exact Windows x64 portable artifact, clean installation,
containment, and all Pi/Task 7/Task 9/Task 10 Evidence comparators.

The current Task 11 disposition is therefore `COMPLETE WITHIN UNSIGNED DEVELOPER-PREVIEW BOUNDS`.
The artifact remains unsigned and `qualification=NOT_PROVEN`; publication, signing, Stable
promotion, existing-user state migration, real-repository safety, broad Provider reliability,
and the Task 12 real-use Archive remain unproven. The overall daily-use disposition remains
`NOT_PROVEN`.

## Addendum (2026-08-09) — Task 12 Archive authority hardening

The earlier Task 12 section is retained as the pre-hardening boundary snapshot. The provider-neutral
implementation now closes the specific authority gaps identified there:

- plan-input/execution-plan v2 and `hpi-pilot-evidence.v5` require explicit capture provenance;
- `FilePilotArchiveStore` accepts only an opaque capture authority, so caller-authored JSON cannot relabel
  itself as a live capture. It resolves an append-only Archive package from an exact local directory and
  regular file, verifies immutable facts, the Evidence digest, observed time, and a local store proof,
  and returns a trusted handle only for `REAL_WINDOWS_PILOT` / `LIVE_WINDOWS_PILOT` data;
- an HMAC-bound identity reservation survives package deletion; a separate immutable commit receipt
  distinguishes an interrupted reservation that may be completed from a committed Archive whose package
  disappeared. The reservation, package, and commit receipt are flushed before publication through
  non-overwriting hard links; the trusted handle itself is frozen;
- the evaluator and CLI require the trusted Archive and exact frozen plan before a decision can be
  considered complete, and its runtime private-field brand rejects structurally forged handles, so
  fixture-shaped JSON or a plain Evidence file cannot yield daily-use `GO`;
- linked Run Archive receipts require one reachable root and one terminal Run per task, aggregate
  replacement Runs without rewriting history, reject duplicate predecessor/replacement references, require
  an interrupted predecessor to be terminal `INCOMPLETE`/`CANCELLED`, and bind successful interruption
  counts to READY replacement outcomes and matching Archive fingerprints;
- explicit Provider authorization now binds finite maximum request, token, and cost budgets, with
  over-budget usage as a zero-tolerance STOP. The CLI requires
  `hpi pilot evaluate --plan <file> --evidence <file> --archive <file> --json`.

The isolated Windows worktree passes 60 test files / 541 tests, the focused Task 12 suites (72/72),
typecheck, lint, format, strict compiler smoke, build, external package smoke, clean-install smoke, and
the compiled Pi public-interface probe. Hosted PR/main verification is pending for this new head. The
source-level test capture helper is not a package export, and the current product has no production
capture finalizer. This hardening is not a real pilot: no external repository, credential, or Provider
request was inferred or touched. The daily-use disposition therefore remains `NOT_RUN / NOT_PROVEN`
until the separately authorized Windows pilot produces its complete Archive, exact Windows/Ubuntu
receipts, and real observations.

## Addendum (2026-08-09) — Task 12 hosted closure

The authority-hardening head passed the complete hosted verification scope. PR #55 run
[`31279969974`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31279969974) passed Windows/Ubuntu
quality, packed-package and developer-preview artifact smoke, clean locked installation, Pi/Task 9/Task 10
platform probes, Task 7 containment on both platforms, and all cross-platform Evidence comparators. The
merge commit is `dc2ec35b16c0cdbf3f8eb49a31bfb03226311ef3`; its exact main run
[`31280957140`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31280957140) passed the same required
Windows/Ubuntu and Evidence gates.

The final isolated-worktree local verification ran 60 test files / 544 tests, focused Task 12 archive and
pilot suites, lint, typecheck, format, strict compiler smoke, build, external package smoke, clean-install
smoke, and the compiled Pi public-interface probe. These results close the provider-neutral implementation
and hosted CI boundary only. No real repository, Provider credential, or Provider request was used, and the
product still has no production capture finalizer; the real Windows daily-use pilot and its immutable
aggregate Archive therefore remain `NOT_RUN / NOT_PROVEN`.

## Addendum (2026-08-09) — Production capture finalizer

The provider-neutral production boundary is now implemented in `packages/pilot/src/capture.ts`. The exported
`PilotEvidenceCaptureFinalizer` accepts only a module-private runtime capability issued by the product runtime,
requires the actual process to be Windows,
consumes the collector exactly once, adds `LIVE_WINDOWS_PILOT` itself, and verifies the exact frozen Plan
fingerprint, Operator scope, and machine profile before issuing the opaque `TrustedPilotEvidenceCapture`.
Unknown fields, caller-selected provenance, invalid schema data, plan drift, and credential/path-shaped extras
fail closed with fixed non-sensitive errors. The returned authority is accepted by the existing append-only
`FilePilotArchiveStore`; a focused integration test proves that hand-off and the focused suite is 9/9.

The finalizer does not manufacture observations or authorize a repository/Provider request. Its runtime
collector must still be connected to the separately authorized real Windows pilot. No real repository,
credential, Provider request, or daily-use GO was inferred or touched; the pilot disposition remains
`NOT_RUN / NOT_PROVEN` pending the full dated Archive and exact Windows/Ubuntu receipts.

## Addendum (2026-08-09) — Current merged-head continuation audit

This addendum uses the last code-bearing merged baseline `9bce51d0fcd51dacff4487893ed05f11f40304a2`. Exact merged-head CI
run [`31296506169`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31296506169) completed with
all six required jobs successful: Windows and Ubuntu quality, Task 7 containment on both platforms,
Pi/Task 9/Task 10 Evidence consistency, and Task 7 Evidence consistency.

The current checkout independently passed `npm run verify`: 61 test files and 553 tests, lint,
typecheck, strict compiler smoke, build, formatting, external package smoke, clean-install smoke,
and the compiled Pi probe. The current Windows Task 9 platform probe passed 6/6 checks with
credential-free/path-free privacy PASS; the current Windows Task 10 platform probe passed 9/9 checks
with the same privacy PASS. The current Windows x64 portable package reports `sourceState=CLEAN`,
`updateChannel=developer-preview`, `signed=false`, and its launcher reports `update status=READY`.

These results close the current provider-neutral implementation and hosted-verification boundary.
They do not supply the missing real-use observations: no two explicitly selected operator-owned
repositories, Provider/model/endpoint/account authorization, bounded credential scope, ten-task
observation set, or immutable aggregate pilot Archive is available. The real Windows daily-use pilot
therefore remains `NOT_RUN / NOT_PROVEN`, and no production or daily-use GO is claimed.
