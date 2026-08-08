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

Status: `PARTIAL`.

The durable event, Checkpoint, Archive, export, import, and exact-target deletion modules are
real implementations. The following daily-use gates remain open:

- the platform Finality adapter now binds exact process-final and Writer Lease release receipts
  into an immutable Attempt Finality Receipt and replays it after reopen; the final hosted Windows
  and Ubuntu receipts still need to bind this exact source;
- mutation-lock recovery now uses signed process liveness rather than PID ownership, elects one
  reconciler at a canonical physical path, and recovers after forced termination at all three
  claim/receipt/removal boundaries. Windows-local Evidence passes; a first PR attempt passed Ubuntu
  on its predecessor source, while final-source Windows/Ubuntu receipts, exact aggregate comparison,
  and real OS power loss remain unproven;
- import/export/delete replay and clean-profile second-device projection now use immutable intents,
  exact archive/operation identities, v3 policy reconciliation, quoted-JSON credential rejection,
  and interrupted-import resume. Intent and final receipt publication recover from process death at
  every atomic boundary. Exact valid remnants are retained rather than deleted through a raceable
  pathname, while foreign remnants fail closed. A physically separate operator-device pilot remains
  unproven.

The Windows-local v2 receipt binds 90/90 fixed daily-use assertions and six direct finality/privacy
checks. It is provider-neutral local Evidence, not a hosted cross-platform or real-repository claim.

The Archive boundary now independently rescans retained Evidence summary and capture text. A
caller cannot bypass credential/private-text rejection merely by setting `contentClass=LOG`,
`credentialMaterial=false`, and forged redaction metadata. This closes one zero-tolerance
privacy path only; it does not close the remaining platform recovery gates.

Relevant implementation: [`archive.ts`](../../packages/evidence/src/archive.ts),
[`portable-device.ts`](../../packages/evidence/src/portable-device.ts),
[`atomic-write.ts`](../../packages/evidence/src/atomic-write.ts),
[`recovery.ts`](../../packages/workflow-kernel/src/recovery.ts), and
[`in-memory-workflow-kernel.ts`](../../packages/workflow-kernel/src/in-memory-workflow-kernel.ts).

## Task 10 — standard Pi Packages

Status: `PARTIAL`; user Plugin activation remains blocked.

The current module proves metadata parsing, an append-only lifecycle journal, and policy-shaped
Compatibility/Trust/Isolation values in fixtures. It does not yet prove standard Pi package
installation, effective post-load resource graphs, two representative external packages, or OS
containment. The completion audit also found that query/fragment credentials and `file:`
references can pass some manifest reference fields. Until those paths are closed and exact
release/Engine/platform/configuration/verifier identities are durable, no arbitrary package may
be called compatible, trusted, or isolated.

Relevant implementation: [`contracts.ts`](../../packages/plugin-manager/src/contracts.ts) and
[`manager.ts`](../../packages/plugin-manager/src/manager.ts).

## Task 11 — portable release and updates

Status: `PARTIAL`; unsigned developer preview only.

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

## Required order before daily-use GO

1. Close Task 9 process/lease finality, crash recovery, immutable receipt, and platform Evidence
   gates.
2. Close Task 10 reference privacy and exact Compatibility/Trust/Isolation identity gates before
   enabling any user package.
3. Implement and verify the Task 11 Windows activation, migration, rollback, exact portable
   artifact, signing/promotion, and machine Evidence path.
4. Bind Task 12 evaluation to immutable non-fixture Archives and exact Provider authorization.
5. Run the separately authorized real Windows pilot. Only its complete Archive can support
   `GO`.
