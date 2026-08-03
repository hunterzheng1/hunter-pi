# Hunter Pi Context

Hunter Pi is an independent personal coding Agent distribution. This glossary defines the product-specific language used across its interactive shell, workflow, engine integration, plugin ecosystem, and evidence model.

## Product and engine

**Hunter Pi**:
The complete user-facing coding Agent distribution, including its workflow, defaults, extensions, compatibility policy, and updater.
_Avoid_: Pi plugin, Hunter-Harness frontend, Pi skin

**Upstream Pi**:
The external Pi project and exact engine release embedded or launched by a Hunter Pi release.
_Avoid_: Hunter core, automatically trusted latest Pi

**Distribution Release**:
An immutable Hunter Pi version that binds a Workflow Kernel version, an Engine Release, bundled resources, compatibility policy, and integrity metadata.
_Avoid_: latest files, mutable installation

**Engine Release**:
An exact upstream Pi artifact selected for compatibility qualification.
_Avoid_: whatever `pi update` installs

**Engine Host**:
The provider-neutral Interface through which the Workflow Kernel starts, observes, steers, interrupts, resumes, and closes an Agent engine.
_Avoid_: Pi-private event object, provider API

**Pi Host**:
The adapter that implements Engine Host for one exact qualified Pi release.
_Avoid_: Workflow Kernel, public domain type

**Workflow Kernel**:
The Hunter-owned command/event module that validates invariants, appends facts, and determines deterministic workflow transitions without depending on Pi-private types.
_Avoid_: Agent loop, Pi session manager, UI orchestrator

## Work and execution

**Quick Session**:
An interactive coding conversation optimized for low ceremony; it may produce observations and artifacts but makes no verified delivery claim by default.
_Avoid_: successful Change, implicit Managed Change

**Managed Change**:
A bounded, independently verifiable unit of intended repository change with explicit goals, non-goals, constraints, and acceptance conditions.
_Avoid_: prompt, chat, unbounded project

**Plan Revision**:
An immutable snapshot of the Steps, checks, budgets, and stop conditions selected for a Managed Change.
_Avoid_: mutable checklist, model scratchpad

**Run**:
One logical execution of a Managed Change against a fixed Plan Revision and workspace identity.
_Avoid_: Pi session, terminal process

**Step**:
A typed unit in a Plan Revision whose validated output and policy determine the next workflow transition.
_Avoid_: arbitrary chat turn, untyped model instruction

**Attempt**:
One actual try within a Run; retry, recovery, or loop continuation creates a new Attempt.
_Avoid_: overwritten retry, edited failure

**Observation**:
A fact reported by Pi, a process, a tool, or the operating system that may inform workflow state but cannot prove success by itself.
_Avoid_: completion receipt, verification

**Verification**:
An independent evaluation of exact inputs, outputs, configuration, and workspace identity against declared acceptance conditions.
_Avoid_: Agent confidence, process exit zero without a declared check

**Verification Receipt**:
An immutable result with outcome `PASS`, `FAIL`, `BLOCKED`, or `NOT_PROVEN`, bound to one declared check and exact Attempt/workspace/configuration identity.
_Avoid_: `NOT_RUN`, free-form test summary

**Human Receipt**:
An immutable record of a predeclared human gate, bound to the exact decision, actor reference, Attempt, content hash, and time.
_Avoid_: generic approval, replacement for an automated check

**Evidence**:
A redacted, hash-bound fact supporting an execution or Verification conclusion.
_Avoid_: raw transcript dump, unsupported claim

**Checkpoint**:
An immutable recovery reference that identifies restorable workflow and engine state without declaring the Run successful.
_Avoid_: success snapshot, mutable current state

**Archive**:
An immutable manifest and Evidence set for an ended Run, independent of whether its outcome was ready, failed, blocked, cancelled, or incomplete.
_Avoid_: success state, mutable backup

**Archive Status**:
The independent `UNARCHIVED` or `ARCHIVED` state of an ended Run; it never replaces the Run outcome.
_Avoid_: Run result, success flag

**Knowledge Candidate**:
A provenance-bearing fact or lesson extracted from an Archive that is not trusted for reuse until scope, conflict, status, and confidence are evaluated.
_Avoid_: automatic memory, generated instruction

## Extension ecosystem

**Core Extension**:
A Hunter Pi-owned extension required to preserve workflow semantics, structured observations, and product behavior.
_Avoid_: optional plugin, user override

**Plugin**:
A user-selected Pi-compatible package or resource loaded in addition to Hunter Pi's Core Extension.
_Avoid_: automatically trusted code, Core Extension

**Permission Profile**:
A policy for Hunter-owned tools and observable Pi tool calls. It is not an operating-system sandbox for executable Plugin code.
_Avoid_: Plugin Isolation, general safety boundary

**Plugin Compatibility**:
The evidence-backed result `VERIFIED`, `UNVERIFIED`, or `INCOMPATIBLE` for an exact release, engine, platform, plugin, and configuration tuple.
_Avoid_: popularity score, general safety claim

**Plugin Trust**:
The activation policy classification `BUNDLED`, `USER_APPROVED`, or `QUARANTINED`, based on provenance and an explicit local decision.
_Avoid_: compatibility result, permanent trust

**Plugin Isolation**:
The observed authority boundary `CONTAINED`, `PROCESS_AUTHORITY`, or `NOT_PROVEN` for executable plugin code.
_Avoid_: permission profile, assumed sandbox

**Plugin Assurance Receipt**:
An immutable combined view of Plugin Compatibility, Plugin Trust, and Plugin Isolation for an exact tuple. It never means arbitrary plugin code is generally safe.
_Avoid_: single safety grade, ecosystem-wide certification

**Compatibility Receipt**:
An immutable result binding an Engine Release or Plugin version to the contract suite, platforms, configuration, and outcome that were actually tested.
_Avoid_: upstream claim, version-range guess

**Operation Receipt**:
An immutable record of an external operation's identity, canonical payload fingerprint, observed effects, and reconciled outcome.
_Avoid_: Agent claim, assumed effect
