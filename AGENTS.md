# Hunter Pi contributor instructions

Hunter Pi is a documentation-led, independent downstream distribution built on public Pi extension and process interfaces. It reimplements selected Hunter-Harness workflow mechanisms but must not acquire a runtime dependency on Hunter-Harness.

Before interpreting or changing the product, read:

1. `docs/README.md`
2. `docs/11-decision-summary.md`
3. `CONTEXT.md`
4. `docs/03-system-architecture.md`
5. `docs/04-workflow-semantics.md`
6. the accepted ADRs under `docs/adr/`
7. the active task in `docs/plans/`

## Current repository status

- Tasks 0–6 are complete within their recorded bounds. Task 6 product/Evidence commit `502011b8a34e9773e415643b01a838c04d5582c5` and documentation commit `3c4d5e5200f29a70a607fa6d40be63a6c99b92c9` passed their Windows/Ubuntu and aggregate Evidence gates; PR #15 merged as `b77937f689bca859a29c7df22025ce12e875bda4`, whose exact main CI passed the same gates.
- Task 6 proves one separately authorized real Provider request only in an automatically created disposable Git fixture. Broader Provider reliability, recovery, real-repository safety, production readiness, and daily-use acceptance remain `NOT_PROVEN`.
- Task 7 is complete within its recorded disposable-fixture bounds. Attempts #13/#14 and every earlier receipt, review failure, CI failure, and the v2 Ubuntu `NOT_PROVEN` parse attempt remain preserved. Replacement attempt #15 uses the append-only v4/v5 Evidence contracts, and the exact Windows/Ubuntu main CI passed after preserving the earlier hosted scheduling history. Tasks 9–10 are complete within their provider-neutral bounds; Task 11 PR #53 run `31270421168` and exact merged-head main CI `31272146162` passed Windows/Ubuntu quality, portable artifact, containment, Task 7 Evidence, and Pi Evidence. The current Task 12 real-use pilot remains `NOT_PROVEN`. Real user repositories and Provider requests remain prohibited unless a later task explicitly opens them with target and credential scope.
- Do not claim a Windows installer, general plugin compatibility, qualified updates, production readiness, or daily-use acceptance until their later tasks and Evidence are complete. Do not silently expand to a Pi or Oh My Pi fork.

## Product invariants

- Hunter Pi is a standalone product. Running it must not require Hunter-Harness, Hunter Platform, or a Hunter server.
- The Workflow Kernel owns canonical Change, PlanRevision, Run, Attempt, Verification, Evidence, and Checkpoint state.
- Pi-private session and tool identifiers are external references, never canonical workflow identities.
- Agent return, process exit, terminal idle, and model text are observations, not completion.
- A Managed Change reaches `READY` only when every required automated Verification passes and every predeclared human gate has an exact Human Receipt; a Human Receipt cannot replace an automated check.
- Retry and recovery create new Attempts or append new facts; never rewrite failed history.
- A Run binds exactly one immutable Plan Revision. A plan change cancels and supersedes that Run and starts a linked new Run.
- Loops are bounded by finite iteration and elapsed limits, at least one finite measurable resource budget, and a deterministic stop condition.
- The Pi Host is an adapter at a narrow seam. Workflow code must not import Pi internals.
- Prefer official Pi Extension, package, JSON, RPC, and SDK interfaces. A Pi source patch or fork requires a new accepted ADR backed by a reproduced interface blocker.
- Oh My Pi is a reference source, not a base dependency. Ported code requires license and provenance records.
- Standard Pi packages may run arbitrary local code with the Agent process's authority. Compatibility, Trust, and Isolation are separate; permission profiles are not an OS sandbox.
- Local-first does not mean offline: provider-bound data categories, endpoint, retention limits, and Hunter-controlled network/telemetry settings require disclosure and acknowledgement before first send.
- Credentials, tokens, cookies, complete environment dumps, private prompts, and unredacted user paths must never enter logs, Evidence, fixtures, or commits.

## Architecture and language

- Use the canonical terms in `CONTEXT.md`; update it when a domain term is resolved.
- Design deep modules: a small Interface with substantial behavior hidden behind it.
- Dependency direction is `domain/contracts ← workflow kernel ← adapters ← product shell`.
- Public workflow types remain provider-neutral; do not add Pi-, OMP-, model-, terminal-, or GUI-private fields to them.
- Versioned schemas are strict at runtime. Unknown or incompatible input fails closed with an actionable reason.

## Delivery

- Windows is the first acceptance platform; Ubuntu remains a required CI platform. Other platforms stay unclaimed until tested.
- Use test-first RED → GREEN → REFACTOR for behavior changes.
- Do not commit executable product code or port external code until the owner-selected repository license and NOTICE/provenance policy are committed.
- Every public contract change updates its contract tests and documentation in the same commit.
- Record upstream claims in dated research with primary-source links. Record local proof separately as Evidence.
- Remote CI that has not actually run is `PENDING`, never `PASS`.
- Preserve user-authored changes and keep commits focused.
- After merge or abandonment, remove topic worktrees and branches only after checking cleanliness, open PRs, unique commits, and remote state.
