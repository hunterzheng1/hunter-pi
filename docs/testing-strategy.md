# Testing strategy

## Objective

Tests must prove Hunter Pi's own contracts while clearly separating Fake proof, fixed-version local integration, platform proof, and user-value evidence.

## Test layers

### 1. Domain unit tests

Pure tests for branded identities, strict schemas, transition invariants, budgets, status vocabulary, redaction decisions, and deterministic projections. They run without Pi, Git, network, provider login, or global configuration.

### 2. Workflow Kernel tests

Command/event scenario tests drive the same Interface used by the CLI. Required cases include invalid transitions, one fixed Plan Revision per Run, plan supersession creating a new Run, append-only Attempts, separate outcome/archive status, verification gating, finite loop/resource budgets, repeated-failure stop, Checkpoint recovery, and predeclared human receipts that cannot replace automated checks.

### 3. Engine Host contract suite

A shared suite runs first against a deterministic Fake Host, then the Pi Host:

- capability receipts derive support from probes;
- same operation ID/fingerprint is idempotent;
- same ID/different fingerprint is rejected;
- event cursor resumes without duplication/loss;
- interruption and unknown outcomes reconcile;
- Agent return/process exit/idle do not mean Step success;
- checkpoint/close report only proven effects;
- private engine fields do not leak into domain events.

Fake passing proves the Hunter Interface, not real Pi.

### 4. Pi public-interface spike tests

Fixed Pi candidate tests in temporary Git fixtures cover:

- Core Extension load and lifecycle events;
- tool call/result interception and effective-tool inventory;
- TUI launch smoke without automating visual pixels as a success oracle;
- JSONL framing and event parsing;
- RPC request/response correlation and cancellation;
- SDK session creation, prompt, event stream, persistence, and resume;
- isolated configuration/session roots;
- provider-independent operation without paid model calls where possible;
- one explicitly authorized real login/model smoke when required later.

Official support remains `NOT_PROVEN` until these receipts pass.

### 5. Plugin fixtures

Fixtures include:

- valid standard package with extension/skill/prompt/theme;
- package with runtime dependency;
- exact npm and Git source identities;
- broken import and throwing initialization;
- reserved command collision;
- built-in tool override;
- lifecycle event mutation;
- oversized output;
- soft/hard storage limit and disk-pressure behavior;
- secret/path leakage attempt;
- mutable/unpinned source;
- plugin that works only on one platform.

Safe Mode tests start without evaluating broken/malicious user fixtures.

Compatibility, Trust, and Isolation are asserted independently. A fixture can be Compatibility `VERIFIED` while remaining `USER_APPROVED` and `PROCESS_AUTHORITY`; no compatibility test produces a general safety claim.

### 6. Git/process integration tests

All mutating tests create disposable fixtures. Cases include:

- Unicode and spaced repository paths;
- dirty/untracked/staged files;
- independent worktrees and writer leases;
- unique commits and unpushed branches;
- symlink/junction/reparse-point cleanup traps;
- nested child processes, timeouts, cancellation, and log handles;
- command arguments containing spaces and Unicode;
- crash at every durable write boundary;
- exhausted output/cache quotas and simulated disk-full while the critical-state reserve remains available.

Tests never point recursive cleanup at a workspace root, home directory, unresolved environment variable, or real user project.

### 7. Packaging and update tests

Build exact artifacts, then verify them outside the checkout with a clean npm/cache/config root. Cover install, first run, version identity, raw Pi coexistence, update, failed update, rollback, uninstall, and preserved project data.

Provider-onboarding tests use a recording fake endpoint to verify disclosure, versioned acknowledgement, destination allowlisting, payload-category accounting, cancellation before send, and credential exclusion. Real provider requests require separate authorization and never substitute for these deterministic privacy checks.

### 8. Daily-use acceptance

A bounded real repository pilot includes:

- ten representative tasks of different sizes;
- at least one deliberate Agent failure and successful fixback;
- forced process termination and recovery;
- two representative standard Pi packages;
- one upstream candidate update and rollback;
- measured setup time, interactive latency, verification duration, resource peaks, user interventions, and false completion prevention.

The pilot freezes machine/task/comparator identities and applies the exact sample counts, p95 method, zero-tolerance conditions, and GO/REVISE/STOP thresholds in the execution plan. It records failures and friction; it is not rewritten into a marketing PASS.

## Test-first change policy

Behavioral work follows RED → GREEN → REFACTOR:

1. Add the smallest failing test for the intended contract.
2. Run the exact test and retain real failure output.
3. Implement the minimum behavior.
4. Run the focused test to GREEN.
5. Refactor without widening scope.
6. Rerun invalidated contract/integration tests.

Configuration/docs-only changes use schema/link/static checks instead of manufacturing a fake RED.

## CI matrix

Initial CI target:

| Job | Platform | Required content |
|---|---|---|
| `core` | Ubuntu | lint, typecheck, domain/kernel/Fake/plugin fixture tests, build |
| `windows` | Windows | same plus Git/process/path integration |
| `package-smoke` | Windows and Ubuntu | pack/install external fixture, version and Safe Mode smoke |
| `pi-contract` | Windows and Ubuntu | fixed free/provider-independent Pi surfaces; paid/login cases explicitly skipped and reported |

A configured but unrun job is `PENDING`. A skipped provider-dependent test is not a platform PASS for that capability.

## Result and evidence requirements

Every recorded command includes exact argv fingerprint, cwd/workspace identity, source commit, environment/tool versions, exit/timing, bounded output digest, and status. Credentials and complete environment values are excluded.

Result history distinguishes:

- local vs CI;
- Fake vs real Pi;
- fixture vs real repository;
- provider-independent vs authenticated/model-dependent;
- executed vs skipped vs not collected;
- current attempt vs prior failures.

## Completion gates by milestone

- **Contract baseline**: domain/kernel/Fake suites pass on both CI platforms.
- **Pi host proven**: fixed-version public-interface receipts pass; unsupported capabilities remain explicit.
- **Managed fixture slice**: real Pi drives a two-Attempt Change in a disposable representative Git fixture and independent Verification passes.
- **Managed repository safety**: worktree/process containment and recovery gates pass before any real user repository is mutated by Managed Change.
- **Plugin preview**: standard package fixtures and representative packages have exact receipts; Safe Mode passes.
- **Daily-use preview**: clean Windows install, pilot, update/rollback, privacy, full local gates, and actual Windows/Ubuntu CI pass for the exact artifact.
