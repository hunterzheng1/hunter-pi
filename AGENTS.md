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

- Tasks 0–4 are merged. Task 4 implementation `8efe194a1c5f6256e68f1e8c20d0e59848376f2b` and merge `00f0d0d7d702779706e2a5aefac3d67ed0a49699` passed exact Windows/Ubuntu CI plus cross-platform Evidence identity comparison. Task 5 is the next bounded task; no real Provider, interactive TUI, or usable product has been proven yet.
- Do not claim that `hpi`, a Windows installer, a Pi Host, plugin compatibility, or qualified updates exist until implementation and evidence are committed.
- The current code proves provider-neutral Hunter Pi contracts and bounded public Pi Extension/JSON/RPC/SDK behavior with deterministic fixtures. It does not prove a real Provider interaction, interactive TUI, or usable product.
- Implementation proceeds task by task from the active plan; do not silently expand to a Pi or Oh My Pi fork.

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
