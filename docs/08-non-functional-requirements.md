# Non-functional requirements

These requirements are target acceptance contracts. Thresholds may be revised only with an explicit reason and evidence; until tested they are `NOT_PROVEN`.

Task 3 implements provider-neutral local fixtures for append-only structural/semantic event replay, checksum/cursor validation, the HP-NFR-PERF-03 constants and retention projection, a physical emergency-reserve file, simulated disk-full behavior, noncritical metadata accounting, mutating-Run admission, and the adversarial Evidence corpus. Exact implementation and merge commits passed Windows/Ubuntu CI. This remains partial contract evidence only: real power loss, production filesystem behavior, cache pruning, real Pi/Plugin output, and daily-use thresholds remain `NOT_PROVEN`.

Task 5 implements a single developer-preview artifact with an exact Pi 0.83.0 dependency, source identity, product-shell/Core SHA-256 verification, clean install smoke, and tamper rejection. Its exact code-bearing implementation and smoke-clarity commits passed Windows/Ubuntu CI, and a dual-SHA-bound real Windows TUI smoke is `DETECTED` within the recorded startup, Core, command-display, clean-exit, and manual-acknowledgement bounds. Real Provider use, stable promotion, signing, and updater behavior remain `NOT_PROVEN` or not implemented as stated in its validation record.

Task 7's earlier local receipts are preserved but superseded after independent review reproduced source-loss, lease-race, process-escape, and verifier-binding gaps. Workspace remediation now covers executable Git integrations, ignored files, byte-level source snapshots, post-create compensation, and mismatch receipts; replacement lease/platform/Evidence proof and remote CI remain `PENDING` as recorded in the Task 7 validation report.

## Reliability

### HP-NFR-REL-01 — Append-only history

Run, Attempt, Verification, decision, and failure facts are append-only. Crash and migration tests must prove that a later success cannot overwrite an earlier failure.

### HP-NFR-REL-02 — Atomic durable writes

Immutable workflow events and Checkpoints use atomic no-replace publication with checksum validation; mutable configuration, manifest, and update-state formats must define an explicit atomic replacement protocol before implementation. Fault injection at every durable write boundary must yield either the prior valid state or the new valid state, never an accepted partial state or a replaced immutable identity.

### HP-NFR-REL-03 — Managed process finality

An operation reaches terminal state only after its owned process tree, output handles, resource locks, and leases are reconciled. Timeout and cancellation tests must find no matching live child tree before a cleanup receipt is issued.

### HP-NFR-REL-04 — Recoverability

For supported interruption points, a user can obtain an actionable recovery decision within five minutes without editing state files manually. Unsupported or ambiguous recovery fails closed and preserves source/workspace data.

### HP-NFR-REL-05 — Idempotency

All external mutations obey operation ID and payload-fingerprint rules. The shared suite covers replay success, mismatched replay rejection, unknown-outcome reconciliation, and concurrent duplicate requests.

## Performance and resource use

### HP-NFR-PERF-01 — Interactive startup

After installation and with update checks off the critical path, warm `hpi` startup should present an interactive prompt within three seconds at p95 on the defined Windows acceptance machine. Doctor and first-time package resolution are measured separately.

Task 12 freezes the acceptance machine before measurement: Windows build, CPU model/core count, RAM, storage type, terminal, Git, security-software state, power mode, and Hunter Pi/Pi versions. After five discarded warm-ups, at least 20 warm starts are measured with a monotonic clock; p95 is the nearest-rank 19th ordered sample. Raw samples and environment identity are retained in redacted Evidence.

### HP-NFR-PERF-02 — Streaming responsiveness

User cancellation, steering, and status updates should be acknowledged within 250 ms p95 while Hunter-owned code is not blocked in an upstream call. Long tool output is streamed or paged and must not freeze the TUI.

Task 12 records at least 30 locally generated acknowledgement samples across cancellation, steering, and status. Provider/model latency is excluded only when the timing boundary and upstream-wait interval are separately observed; otherwise the result is `NOT_PROVEN`. p95 uses the nearest-rank 29th ordered sample.

### HP-NFR-PERF-03 — Bounded local storage

Logs, events, sessions, package caches, and archives expose size/retention status. Initial defaults are measurable and configuration changes are receipt-bound:

- each stdout or stderr stream retains at most 8 MiB of content plus full-stream digest, byte count, and truncation metadata;
- noncritical logs are warned at 100 MiB and stopped at 250 MiB per Run;
- disposable package/build cache is pruned at 2 GiB and refuses growth at 5 GiB per user profile;
- the state root maintains a physically allocated, single-link 64 MiB emergency reserve that noncritical output/cache cannot consume, so terminal/checkpoint receipts can be attempted under disk pressure;
- event facts, terminal receipts, Checkpoints, and Archive manifests are never automatically deleted; referenced large artifacts may be omitted only with digest and explicit retention status;
- a new mutating Run is `BLOCKED` when the reserve, minimum capacity headroom, or an atomic no-replace write probe cannot be guaranteed.

Disk-full injection must leave the prior state replayable. Explicit export/delete operations identify exact targets, preserve manifests and failure history, and never describe a pruned or truncated artifact as complete.

### HP-NFR-PERF-04 — Bounded concurrency

Verification concurrency is derived from dependency and resource-lock graphs. Unknown heavy commands default to serialized execution rather than saturating the machine.

### HP-NFR-PERF-05 — Interactive memory

During the Task 12 representative interactive workload, Hunter-owned processes remain at or below 1.5 GB working set at p95, excluding separately identified build/test/model-provider subprocesses. At least 30 samples are taken at one-minute intervals; p95 is the nearest-rank 29th ordered sample and raw samples retain the process/release identity.

## Platform and portability

### HP-NFR-PORT-01 — Windows acceptance

Windows x64 is the first hard acceptance platform. Paths with spaces, non-ASCII characters, long output, Git worktrees, process-tree cancellation, OAuth browser flows, and representative plugins are included in real tests.

### HP-NFR-PORT-02 — Ubuntu CI

Provider-neutral domain, kernel, Fake Host, schema, redaction, plugin-fixture, and build tests run on Ubuntu CI. Ubuntu CI is not by itself a Linux daily-use product claim.

### HP-NFR-PORT-03 — Path-independent portable data

Portable project policy and Archives use repository-relative paths and stable identities. Device-local absolute paths are stored only in local bindings and redacted from portable Evidence.

## Security and privacy

### HP-NFR-SEC-01 — Secret exclusion

A maintained adversarial corpus of tokens, Cookies, authorization URLs, env values, private prompts, Unicode paths, and encoded variants must produce zero raw matches in normal logs, Evidence, archives, crash reports, and update receipts.

### HP-NFR-SEC-02 — Plugin transparency

Before executable plugin code runs, the user can see source, resolved version/ref, scope, and executable-code warning. Safe Mode must start without user plugins.

### HP-NFR-SEC-03 — No hidden authority expansion

Permission profiles cannot be presented as an OS sandbox. Plugin activation explicitly reports that executable code may have process authority. At Hunter-owned mediation points, each remote write, destructive filesystem action, credential access, publication, deployment, paid operation, or privilege escalation requires a separate explicit decision even under `Full Access`. Unobservable direct plugin effects make containment `NOT_PROVEN`, not silently safe.

### HP-NFR-SEC-04 — Supply-chain identity

Every released CLI/installer, bundled Engine Release, Core Extension, and direct dependency lock has an integrity identity traceable to the qualified source commit. Readiness receipts that depend on executable product-shell/Core behavior bind both exact integrities and invalidate after either drifts. Stable promotion requires artifact-to-candidate comparison.

### HP-NFR-SEC-05 — Provider data-egress consent

Before the first model request and after a material provider, endpoint, or disclosure change, the product shows data categories, destination category, provider-policy limits, and Hunter-controlled telemetry/network settings and obtains a versioned acknowledgement. Fake-endpoint tests prove cancellation-before-send, destination allowlisting, payload-category accounting, and credential exclusion.

## Compatibility

### HP-NFR-COMP-01 — Public Pi seam

Workflow Kernel and domain packages compile and pass without Pi installed. Pi changes are localized to the Pi Host and Core Extension packages.

### HP-NFR-COMP-02 — Exact qualification

Compatibility claims bind exact Hunter Pi, Pi, platform, plugin, and configuration identities. Version ranges may select candidates but cannot create Compatibility `VERIFIED`; Compatibility never implies Trust or Isolation.

### HP-NFR-COMP-03 — Safe degradation

An incompatible or missing extension event, RPC field, plugin, or engine capability produces an actionable blocked/incompatible result. Unknown fields are not silently interpreted as equivalent behavior.

## Observability and honesty

### HP-NFR-OBS-01 — Reproducible receipts

Receipts are versioned, strict-schema, time-bounded, redacted, and hash-bound. They contain enough non-secret identity to reproduce the conclusion or explain why reproduction is impossible.

### HP-NFR-OBS-02 — Status fidelity

Every UI and report preserves `PASS`, `FAIL`, `BLOCKED`, `NOT_PROVEN`, `NOT_RUN`, and `PENDING` distinctions. Remote jobs not actually observed cannot be shown as passed.

### HP-NFR-OBS-03 — Bounded output

Captured stdout/stderr and artifacts have explicit byte limits, cursors, truncation flags, and digests. Truncated output is never described as complete.

## Maintainability

### HP-NFR-MAINT-01 — Small public Interfaces

The Workflow Kernel and Engine Host each expose one cohesive Interface used by callers and contract tests. Provider convenience methods and private event shapes remain inside adapters.

### HP-NFR-MAINT-02 — Contract change discipline

Every public schema or state-transition change updates tests, migrations, compatibility notes, and documentation in the same focused change.

### HP-NFR-MAINT-03 — Upstream update effort

An upstream Pi candidate that preserves public contracts should require a dependency/manifest update and qualification, not manual source merging. If repeated updates require core patches, the architecture decision is revisited.

### HP-NFR-MAINT-04 — Build reproducibility

Clean checkout installation, build, test, pack, and smoke verification use committed lockfiles and succeed without ambient globally installed Pi or Hunter-Harness.

### HP-NFR-MAINT-05 — License and provenance gate

No executable Hunter Pi code or externally derived implementation is committed until the owner selects a repository license and the repository defines NOTICE/provenance rules. No artifact is published unless dependency, Pi, and any ported-code licenses are compatible and represented in the exact release inventory.

## Usability

### HP-NFR-UX-01 — One command and visible mode

The normal entry is `hpi`. The current mode, repository, model, permission profile, Attempt, and degraded Compatibility/Trust/Isolation dimensions are visible without opening internal files.

### HP-NFR-UX-02 — Actionable failures

Every user-facing failure includes a stable reason code, concise explanation, affected identity, preserved-state statement, and smallest safe next action.

### HP-NFR-UX-03 — No workflow lock-in for quick work

Quick Session remains usable without creating a Managed Change. Conversely, any verified delivery claim requires explicit promotion or direct Managed Change creation.
