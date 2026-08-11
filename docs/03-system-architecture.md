# System architecture

## Architectural objective

Hunter Pi must feel like one coherent Agent while keeping three independently changing concerns separate:

1. Hunter workflow semantics;
2. upstream Pi behavior and lifecycle;
3. third-party plugin code.

The design therefore places one narrow seam between the Workflow Kernel and Pi. The Kernel owns business truth; a Pi Host adapter translates public Pi events and operations without leaking Pi-private types into the domain.

## Context view

```text
┌──────────────────────────────── Hunter Pi ────────────────────────────────┐
│                                                                           │
│  Product Shell                                                            │
│  CLI/TUI · onboarding · commands · settings · update UX                   │
│          │                                                                │
│          ▼                                                                │
│  Workflow Kernel ───────────────► Verification                            │
│  Change · Plan · Run · Attempt      checks · receipts · human decisions   │
│          │                             │                                  │
│          ├──────────────► Evidence & Knowledge                            │
│          │                events · artifacts · checkpoints · summaries    │
│          │                                                                │
│          ▼                                                                │
│  Engine Host Interface                                                    │
│          │                                                                │
│          ▼                                                                │
│  Pi Host Adapter ───────► Core Extension ───────► Plugin Host              │
│  Extension/JSON/RPC/SDK    Hunter behavior          standard Pi packages  │
│          │                                                                │
└──────────┼────────────────────────────────────────────────────────────────┘
           ▼
      Qualified upstream Pi
           ▼
      Model providers and local tools
```

## Dependency direction

```text
domain/contracts
      ↑
workflow-kernel
      ↑
verification · evidence · plugin-policy
      ↑
pi-host · filesystem · git · process adapters
      ↑
cli/tui · installer · updater
```

Arrows point from a consumer to what it may depend on. Domain and Workflow Kernel packages never import Pi, OMP, a model provider, terminal UI, installer, or operating-system-specific implementation.

## Modules

### Domain and contracts

Owns branded identities, strict runtime schemas, state transitions, error taxonomy, and portable receipts. Its Interface contains no Pi/OMP/private model fields.

### Workflow Kernel

A deep module that accepts commands and facts, validates invariants, appends events, and returns deterministic next actions. Callers should not orchestrate workflow states themselves.

Task 2 minimal Interface:

```typescript
interface WorkflowKernel {
  dispatch(command: WorkflowCommand): Promise<WorkflowDecision>;
  project(runId: RunId): Promise<RunProjection>;
  recover(checkpointId: CheckpointId): Promise<RecoveryDecision>;
}
```

Every public `WorkflowCommand`, `WorkflowDecision`, and `RecoveryDecision` is a strict, schema-versioned runtime envelope. Unknown fields are rejected at the Kernel boundary, including Provider-private session or UI state. The small surface is intentional: a collection of `startPlan`, `markAgentDone`, `retryTest`, and provider-specific convenience methods would leak the state machine to callers and is rejected.

### Engine Host Interface

The seam through which any qualified coding engine is controlled and observed. The first adapter is Pi; a Fake Host proves the contract before real integration.

Proposed capabilities:

```typescript
interface EngineHost {
  probe(request: ProbeRequest): Promise<CapabilityReceipt>;
  start(request: StartAttemptRequest): Promise<EngineHandle>;
  send(
    handle: EngineHandle,
    input: EngineInput,
    boundary?: EngineExternalOperationBoundary,
  ): Promise<OperationReceipt>;
  observe(handle: EngineHandle, cursor?: EventCursor): AsyncIterable<EngineObservation>;
  interrupt(handle: EngineHandle, reason: InterruptReason): Promise<OperationReceipt>;
  checkpoint(handle: EngineHandle): Promise<EngineCheckpointReceipt>;
  close(handle: EngineHandle): Promise<OperationReceipt>;
}
```

`EngineExternalOperationBoundary` is an in-process callback, not a persisted workflow fact. Every process runner, including the default adapter, invokes it at most once for a new `send`, only after local validation and immediately before the external operation can begin. The Host installs the pending operation identity before any adapter or callback code runs, so concurrent and callback-reentrant identical sends share one authorization and one execution; exact operation replay does not invoke either again. Once authorization succeeds, any later exception before a final receipt stores an immutable `UNKNOWN` tombstone and requires reconciliation instead of permitting replay. This lets a caller durably reserve a finite external-operation budget without turning local lease, configuration-snapshot, or launch-plan failures into false post-send reconciliation locks. Each qualified process-runner instance includes its opaque owner identity in lease and process operation IDs. A clean pre-boundary rejection therefore releases its lease and a later CLI invocation reaches authorization with fresh IDs, while an unreleased lease still conflicts on the shared workspace resource. Current v4 pilot tasks bind exactly one acceptance check, and the path-free `targetId` is carried through the Engine-bound runtime, Managed receipt, resolved task Oracle, capture validation, and v7 Evidence rather than being inferred from matching fingerprints. A pilot Managed Run may resume only the exact observation-free state containing its first started Attempt and only after the durable capture session proves that no Provider intent exists for that operation; portable Plan Evidence fingerprints the retained projection. An equivalent-looking non-pilot state or a pilot state with unknown post-boundary usage fails closed because missing workflow observations do not prove that no Provider send occurred. A planned one-shot interruption remains armed when authorization rejects and is consumed only after that boundary succeeds.

Interface rules:

- Every mutating operation has an operation ID and payload fingerprint.
- Replaying the same ID and fingerprint returns the same Receipt.
- Replaying the same ID with a different fingerprint is rejected.
- Expected target validation compares the complete namespace/reference identity and expired operations fail closed.
- Capability is calculated from probe receipts, never product names.
- Process, terminal, model, and session facts are Observations.
- Provider-neutral `resourceUsage` may accompany an Observation; captured-output Observations report locally measured byte deltas so the Workflow can reconcile one cumulative Run budget. Missing measurements remain `NOT_PROVEN` and cannot complete a gated Change.
- Pi-private identifiers live only in adapter-owned external-reference payloads.

### Pi Host adapter

Uses only qualified public surfaces:

- Pi Extension events for tools, commands, context, UI, and persistence;
- JSON mode for structured one-shot output where appropriate;
- RPC for process-isolated control;
- SDK only when in-process control materially simplifies a proven requirement.

The adapter sets an isolated Hunter Pi configuration root, selects the exact Engine Release, loads the Core Extension explicitly, translates events, and prevents raw Pi self-update from bypassing Hunter qualification.

The first implementation should prefer launching the upstream CLI plus the Core Extension because that preserves Pi's own TUI and package behavior. SDK embedding is an escalation, not the default assumption.

### Core Extension

Provides Hunter Pi-specific behavior inside the Pi lifecycle:

- structured tool and Agent Observations;
- commands for workflow status and user decisions;
- context injection bounded by the active Plan Revision;
- tool metadata needed for permission and Evidence policies;
- session entries that help correlate Pi state with a Hunter Attempt;
- UI status without owning canonical workflow state.

If the extension is absent, incompatible, or shadowed, Managed Change fails closed. Quick Session may continue only with an explicit `CORE_EXTENSION_INACTIVE` warning and makes no Hunter verification or containment claim.

### Plugin Host and policy

Uses standard Pi package discovery and loading while maintaining a Hunter-owned registry of resolved sources, versions, integrity, resources, conflicts, Compatibility Receipts, Trust decisions, and Isolation results.

Core Extension names and workflow event channels are reserved. A Plugin that overrides critical tools or lifecycle hooks is `INCOMPATIBLE` with the affected Managed policy unless the exact compatibility suite proves the resulting behavior. Even then, Compatibility `VERIFIED` does not imply safety: ordinary Pi extensions share the Agent process and remain `PROCESS_AUTHORITY` unless a separately verified isolation adapter contains them.

The fixed Pi Host adapter resolves LOCAL, NPM, Git, and explicitly selected Pi-import sources through
Pi's public `DefaultPackageManager`. NPM/Git installation runs in a sanitized child process with
finite elapsed, output, file-count, byte, and free-space budgets; lifecycle scripts are disabled
before Hunter qualification. npm/Git global credential configuration is replaced by private empty
configuration and credential-bearing proxy URLs are not inherited. The installed single-artifact
CLI routes the child through its integrity-stamped product shell, so packaging cannot omit an
untracked companion executable. The portable v2 Manifest stores only normalized package-relative
resource paths and fingerprints. Qualified bytes are copied to a Hunter-owned, content-addressed,
read-only snapshot, while its absolute runtime paths remain in a separate device-local binding
store. Every normal startup revalidates the snapshot tree, each selected resource, and the binding
before passing an explicit `--extension`, `--skill`, `--prompt-template`, or `--theme` path to Pi.
Hunter Pi disables Pi's ambient extension, skill, prompt-template, theme, and context-file discovery
on every launch, including Managed Change, so only those explicitly qualified paths can enter the
runtime. Activation also rebinds the stored Compatibility Receipt to the current Hunter Pi release,
Pi Engine release/fingerprint, platform, resource-configuration fingerprint, verifier, and the exact
physical qualification Evidence file. Historical v1 journal records remain replayable, but CLI list
and doctor views replace their legacy references and descriptions with fixed redaction markers.

The standard metadata verifier marks only packages with no executable extension surface as
Compatibility `VERIFIED`. Such packages may contribute exact skill, prompt, and theme resources.
Executable extensions remain `UNVERIFIED` and quarantined unless a later independent verifier proves
the exact release/Engine/platform/configuration tuple. Quarantine, journal corruption, reserved or
duplicate resources, a missing binding, or post-qualification drift causes fail-closed Safe Mode;
none of those checks imply an OS sandbox or protection from a same-authority attacker that changes
the snapshot after the final revalidation. Registry removal deletes only validated Hunter-owned
snapshots/bindings and never deletes LOCAL or explicitly selected PI source directories.
Removal first validates the binding filename and payload plus the current snapshot fingerprint; a
drifted binding or snapshot is retained and fails closed instead of authorizing deletion.

### Verification

Runs declared checks outside the Agent's success assertion. It binds the command definition, workspace identity, environment identity, inputs, outputs, timestamps, and result digest into an immutable receipt.

The first verifier implementations are local process checks plus exact Human Receipts for separately predeclared human gates. A Human Receipt cannot replace an automated check. Provider/model self-assessment may be attached as an Observation but never substitutes for either required evidence source.

### Evidence and Knowledge

Stores an append-only event stream as the fact source and rebuildable projections for user views. Evidence is versioned, redacted, content-addressed, and scoped to a Run/Attempt/Verification.

Task 3 implements this behind two small local Interfaces: a `WorkflowEventStore` appends immutable, checksum-bound event segments, while `FileEvidenceStore.capture` accepts raw allowlisted capture requests and always applies the versioned portable-redaction policy before persistence. Callers do not construct mutable event heads or bypass Evidence capture with arbitrary envelopes.

Knowledge promotion is separate from archival: every outcome may be archived, but only selected, source-bound conclusions become reusable guidance.

### Git and workspace

Managed Change defaults to a Hunter-owned isolated Git worktree and a single writer lease. Quick Session may use the current directory after showing dirty-state and concurrency risks.

Mutating probes run only in automatically created temporary Git fixtures. Cleanup verifies exact resolved targets and never follows unverified junctions or symlinks.

### Process host

Runs Pi and verification commands with explicit argv, bounded output, timeouts, identity, and process-tree isolation. Windows requires native process-tree containment; an unavailable isolation mechanism is not silently downgraded for Managed Change.

Task 7 implements this behind one provider-neutral host. Windows atomically creates the target inside a kill-on-close Job Object with a restricted inherited-handle list and checks kernel signaled state before accepting any literal exit code. Ubuntu launches a system-Python shim that establishes a child subreaper before executing an identity-checked Node session/group leader; the helper follows `/proc` parentage, including descendants that create a new session or close inherited output handles. Both adapters keep process exit, timeout, and cancellation separate from terminal finality and from Verification. The Task 7 result is limited to disposable fixtures until exact remote CI and later real-repository acceptance run.

Bounded product adapters that invoke an external CLI reuse the same local platform driver rather than reconstructing process ownership after launch. The execution package exposes that driver factory for adapter composition. Task 12 GitHub qualification starts a monotonic absolute deadline before platform-driver setup, actively cancels at that deadline, applies one shared raw-byte output ceiling across stdout and stderr, and accepts a CLI observation only before the deadline and after the identity still matches, the complete process tree is empty, both output streams are closed, and the driver reports an unterminated exit code. Timeout, cancellation, output overflow, or unreconciled containment returns unavailable with empty output.

The Workspace adapter runs Git with an owned empty hooks directory, disables configured checkout filters and filesystem monitors, fingerprints the source checkout bytes plus index identity before and after mutation, treats ignored files as unique content, and compensates only an exact clean provisional worktree. Each workspace-generation fingerprint binds the unique prepare operation identity as well as its canonical source inputs, so disposal intent from an older generation cannot authorize deletion of a replacement generation. A physical/registration mismatch returns a blocked cleanup receipt instead of inferring deletion.

The file-backed Lease adapter commits an operation receipt and all resulting lease generations in one immutable transaction. Managed-process startup uses the canonical start operation identity itself as the durable reservation key, including when no resource lease is requested; callers cannot select an independent reservation identity. It atomically binds every declared lease to one session fingerprint before launch, and only that exact binding may release it, so an inspect/start race or a second Host cannot attach one operation or lease to two external processes.

## Event and decision flow

```text
User command
  → Product Shell validates input
  → Workflow Kernel appends intent and returns next action
  → Adapter performs exactly that external operation
  → Adapter returns Receipt or Observation
  → Workflow Kernel appends fact and computes next action
  → Verifier runs independently when required
  → Projection renders status and evidence-backed conclusion
```

External code never directly sets a Run to successful. It submits facts; the Kernel decides whether invariants permit a transition.

## State model and storage

The logical model is fixed before the physical store:

- append-only workflow events are authoritative;
- projections are rebuildable;
- large logs/artifacts are referenced by content digest and bounded readers;
- secrets are external references, not event data;
- portable project policy is readable and versionable;
- live sessions, locks, and credentials remain local and gitignored;
- migrations are explicit, resumable, and preserve old facts.

Task 3 uses local immutable files: each workflow append is one contiguous hash-chained segment written through temp-file creation, file sync, and an atomic no-replace publish; each Evidence record is identity-bound and content-addressed. Pending temp files are ignored, while an unexpected committed file, cursor fork/gap, identity mismatch, checksum mismatch, malformed schema, or Receipt that no longer binds the frozen Plan fails closed. If a fault is reported after publication, the store rereads and accepts only the exact immutable identity; an ENOSPC retry restores the emergency reserve even when no-replace publication reports that the exact target already exists. A fresh Kernel instance rebuilds its projection solely from structurally and semantically validated events. Atomic writer filenames are one contained path segment and cannot escape their declared directory. SQLite is considered only after measured concurrency or query needs justify it; it is not a version-one prerequisite.

The local store assumes the version-one single-writer rule. Its injected process/crash boundaries prove a prior or new complete file state, not physical power-loss durability on every filesystem; directory-sync and real power-loss behavior remain `NOT_PROVEN`.

## Proposed repository layout

```text
hunter-pi/
├─ apps/
│  └─ cli/                       # hpi command and terminal UX
├─ packages/
│  ├─ domain/                    # identities and schemas
│  ├─ workflow-kernel/           # canonical state machine
│  ├─ engine-contracts/          # provider-neutral Host interface
│  ├─ pi-host/                   # public Pi integration
│  ├─ core-extension/            # bundled Pi extension/resources
│  ├─ plugin-manager/            # compatibility, trust, and isolation policy
│  ├─ verification/              # independent checks and receipts
│  ├─ evidence/                  # event store, redaction, projections
│  └─ testkit/                   # Fake Host and shared suites
├─ docs/
└─ scripts/                      # build, qualification, packaging
```

This is a target layout, not authorization to generate every package in Task 1. Packages are created only when their Interface is exercised by a vertical slice.

## Deployment topology

Version one is a local process topology:

```text
User terminal
  └─ hpi process
      ├─ local Workflow Kernel and state
      ├─ qualified Pi child process or in-process host
      ├─ local verifier child processes
      └─ provider network calls initiated through Pi
```

No Hunter server is required. Optional future Harness integration uses a versioned process protocol (`capabilities`, structured events, interrupt, checkpoint), not shared private files or database access.

## Fork threshold

A Pi fork is considered only when all are true:

1. a required user story is blocked by a reproduced limitation in Extension, JSON, RPC, and SDK surfaces;
2. the limitation cannot be isolated in the Host adapter;
3. an upstream issue or contribution path has been attempted or documented as unsuitable;
4. the proposed patch is bounded and has an automated rebase/compatibility suite;
5. the owner accepts the ongoing merge and release cost in a new ADR.

Until then, `patches/pi/` remains absent or empty.
