# User stories and acceptance

## Personas

**Daily developer** — wants one terminal Agent that is productive immediately but can turn important work into a verifiable delivery.

**Power user** — installs Pi packages, changes models and permission profiles, and accepts responsibility for advanced local capabilities.

**Hunter Pi maintainer** — qualifies upstream Pi, packages releases, investigates compatibility, and preserves reproducible Evidence.

## Priority language

- `P0`: required before daily-use preview.
- `P1`: required before stable 1.0, but may follow the first preview.
- `P2`: useful later; not part of the current execution plan unless promoted.

All stories below are **DESIGNED**, not implemented.

## Installation and onboarding

### HP-US-001 — One-product installation (`P0`)

As a daily developer, I want to install Hunter Pi without separately managing raw Pi so that the qualified engine and core workflow stay consistent.

Acceptance:

- a fresh supported Windows fixture installs one exact Hunter Pi artifact;
- `hpi version --json` identifies Hunter Pi, Engine Release, source commit, and update channel;
- raw global `pi` is neither required nor overwritten;
- uninstall leaves project repositories untouched.

### HP-US-002 — Honest Doctor (`P0`)

As a user, I want setup problems reported precisely so that missing Git, login, or engine compatibility is not mistaken for product success.

Acceptance:

- Doctor reports each capability as `DETECTED`, `BLOCKED`, `NOT_PROVEN`, or `INCOMPATIBLE`;
- mutating probes run only in an automatically created temporary Git fixture;
- Provider disclosure readiness is checked against the currently offline-resolved destination, not stored acknowledgement alone;
- a local TUI smoke acknowledgement is `DETECTED` only for the same exact product-shell SHA-256, Core SHA-256, and packaged product identity;
- output contains no credential values, complete environment dump, private prompt, or absolute home/temp path;
- a failed check returns a non-zero exit and a smallest-next-action message.

### HP-US-003 — Provider login (`P0`)

As a user, I want to use Pi-supported provider login while the Hunter host receives only readiness metadata so that credential parsing and storage remain with the Pi Engine/provider boundary.

Acceptance:

- login uses a documented qualified Pi/provider flow;
- Hunter records only provider identity, status, and timestamp needed for readiness;
- copied/exported Evidence contains no token, Cookie, authorization header, or credential-store bytes;
- a cancelled login is `BLOCKED` and does not corrupt setup.

### HP-US-004 — Configuration isolation (`P0`)

As a user of both raw Pi and Hunter Pi, I want their settings and packages isolated so that experiments in one do not silently change the other.

Acceptance:

- Hunter Pi uses a distinct user configuration root;
- raw Pi settings remain byte-identical after Hunter Pi setup;
- importing preferences or packages previews every selected change;
- opaque credentials are not copied.

### HP-US-005 — Provider data disclosure (`P0`)

As a user, I want to know what leaves my computer before a model request so that local-first is not mistaken for offline processing.

Acceptance:

- first run identifies the provider/endpoint category, exact offline-resolved origin, and the prompt, repository-context, tool-result, and metadata categories that may be sent;
- provider retention/training controls and Hunter-controlled telemetry/network settings are visible without claiming Hunter can enforce external policy; unknown account facts are explicitly `NOT_PROVEN` rather than inferred from a policy URL;
- an explicit versioned acknowledgement is required before the first send and again after a material provider/endpoint/disclosure change;
- cancellation prevents the request and records `BLOCKED` without storing the prompt or credential in Evidence.

## Interactive use

### HP-US-010 — Quick Session (`P0`)

As a developer, I want to open a repository and chat with Hunter Pi immediately so that small questions and edits remain low ceremony.

Acceptance:

- `hpi` opens the qualified Pi interaction in the current repository;
- the header shows repository state, model, permission profile, and each plugin's Compatibility, Trust, and Isolation;
- the Task 5 header says credential guarding is named-path-only and content detection is `NOT_PROVEN`; recognized credential-like paths cannot be pre-authorized by Full Access;
- standard steering, cancellation, tool output, and session resume work for the qualified engine;
- ending the session does not claim a verified Change.

### HP-US-011 — Promote to Managed Change (`P1`)

As a developer, I want to promote useful exploratory work into a managed delivery without losing context.

Acceptance:

- promotion captures exact Git and dirty-state identity;
- the user explicitly assigns or excludes existing changes;
- conversation is referenced as context, not fabricated as past Evidence;
- an immutable Plan Revision is created before managed execution continues.

### HP-US-012 — Model and thinking selection (`P0`)

As a developer, I want to use qualified Pi-supported models so that Hunter Pi does not lock me to one provider.

Acceptance:

- model selection is delegated through a qualified Pi surface;
- unavailable login/model is `BLOCKED`, not silently substituted unless a configured fallback is shown;
- selected model and fallback decision are recorded without credentials;
- workflow domain types do not contain provider-private fields.

## Managed workflow

### HP-US-020 — Define a bounded Change (`P0`)

As a developer, I want goals, non-goals, constraints, and checks captured before coding so that the Agent cannot silently expand scope.

Acceptance:

- all four categories are visible and editable while Draft;
- starting a Run freezes a Plan Revision;
- material later edits create a new Plan Revision, end the prior Run with outcome `CANCELLED` and reason `PLAN_SUPERSEDED`, and start a linked new Run;
- no Attempt belongs to more than one Plan Revision;
- a vague success condition blocks managed execution until resolved or explicitly human-gated.

### HP-US-021 — Isolated writer (`P0`)

As a developer, I want managed writes isolated from my current checkout so that concurrent work cannot overwrite it.

Acceptance:

- a clean, exact Git worktree is created from the declared base;
- the Run holds an exclusive writer lease;
- pre-existing dirty work is never silently moved or deleted;
- cleanup refuses unique uncommitted/unpushed work and unsafe junction/symlink targets.

### HP-US-022 — Test-first change clusters (`P0`)

As a developer, I want behavioral work executed RED → GREEN → REFACTOR so that passing tests demonstrate the intended change rather than only the final state.

Acceptance:

- each behavioral cluster captures a failing test or explicit justified test gap before implementation;
- GREEN runs the smallest relevant test;
- refactor reruns invalidated checks;
- failed RED/GREEN attempts remain in history.

### HP-US-023 — Independent completion (`P0`)

As a developer, I want Hunter Pi to verify results after the Agent returns so that confident text cannot masquerade as success.

Acceptance:

- Agent return changes only execution status;
- required checks run outside the Agent's success assertion;
- every result binds workspace/config/input identity;
- `READY` is impossible while a required Verification is failed, blocked, not proven, or not run;
- a Human Receipt can satisfy only a predeclared human gate; changing required checks creates a new Plan Revision and a new Run.

### HP-US-024 — Deliberate failure and fixback (`P0`)

As a developer, I want a failed check fed into a bounded new Attempt so that Hunter Pi can repair problems without erasing them.

Acceptance:

- failure produces structured Evidence;
- fixback creates a new Attempt linked to the failure;
- identical repeated failure reaches a deterministic stop threshold;
- final summary lists all Attempts and outcomes.

### HP-US-025 — Review findings (`P0`)

As a developer, I want review execution and finding severity separated so that a successful review can still block risky code.

Acceptance:

- review execution result and P0–P3 findings are separate fields;
- every blocking finding has file/scope, rationale, Evidence, and confidence;
- fixback reruns affected verification;
- unresolved P0/P1 policy prevents `READY`.

### HP-US-026 — Human decision receipt (`P1`)

As a developer, I want explicit human gates for subjective or externally constrained decisions.

Acceptance:

- the prompt states exact decision, content hash, consequences, and allowed answers;
- response binds actor reference, Attempt, time, and selected decision;
- generic chat approval is not auto-converted;
- a Human Receipt cannot assert that an unrun automated check passed.

### HP-US-027 — Ready summary (`P0`)

As a developer, I want a concise report that tells me what changed and what is still uncertain.

Acceptance:

- summary includes goal, diff identity, Attempts, checks, review findings, plugins, permissions, budgets, and known risks;
- status language distinguishes `PASS`, `FAIL`, `BLOCKED`, `NOT_PROVEN`, and `NOT_RUN`;
- commit/push/merge/release status is separate;
- report is derived from structured facts and passes redaction validation.

## Recovery and continuity

### HP-US-030 — Resume a normal session (`P0`)

As a developer, I want to resume a qualified Pi session after closing the terminal.

Acceptance:

- Hunter Pi lists only sessions belonging to the current project identity;
- engine resume is attempted only when its capability receipt permits it;
- incompatible Engine Release is explained and does not corrupt the session;
- resume itself does not claim workflow recovery or success.

### HP-US-031 — Recover an interrupted Managed Change (`P0`)

As a developer, I want a crash-safe Checkpoint so that long work does not disappear.

Acceptance:

- event log and Checkpoint survive forced termination at tested write points;
- restart reconciles workspace, process, engine, and operation identities;
- recovery creates a new Attempt and preserves `INCOMPLETE` history;
- ambiguous external effects stop for reconciliation.

### HP-US-032 — Move to another computer (`P1`)

As a developer, I want committed project policy and portable archives to work on another supported device.

Acceptance:

- cloning the repository restores versioned Hunter Pi project configuration;
- device paths, credentials, live processes, and local leases are not treated as portable identities;
- the new device reruns Doctor and provider login;
- a live local Attempt is not presented as migrated unless an explicit export/import protocol proves it.

### HP-US-033 — Archive every outcome (`P1`)

As a developer, I want ready, failed, blocked, cancelled, and incomplete work preserved honestly so that archiving never rewrites the result.

Acceptance:

- Run outcome and `ArchiveStatus` are separate schema fields;
- any ended Run can move from `UNARCHIVED` to `ARCHIVED` exactly once by idempotent operation;
- the Archive binds the Run's one Plan Revision, every Attempt/check/finding/unresolved item, predecessor/successor Run links, and source/release identity;
- creating an Archive does not change the Run outcome or promote generated text into trusted knowledge.

## Plugins

### HP-US-040 — Install a standard Pi Package (`P0`)

As a power user, I want to install a standard package from npm or Git so that I can use the Pi ecosystem.

Acceptance:

- source resolves to an exact version/ref before activation;
- resources and executable-code warning are shown;
- installation writes only the selected user/project scope;
- load result, Compatibility, Trust, and Isolation are reported separately.

### HP-US-041 — Detect critical overrides (`P0`)

As a developer, I want to know when a plugin changes core tools so that Evidence is not silently invalidated.

Acceptance:

- effective tool/hook graph is inventoried after loading;
- reserved Core Extension identifiers cannot be silently shadowed;
- critical unverified overrides make the affected policy `INCOMPATIBLE` or block Managed Change;
- the Attempt records the effective plugin graph fingerprint.

### HP-US-042 — Safe Mode (`P0`)

As a developer with a broken plugin, I want Hunter Pi to start without evaluating it so that I can repair configuration.

Acceptance:

- Safe Mode loads no user plugins, skills, prompt templates, themes, or context files and explicitly loads only the bundled Core Extension;
- Safe Mode blocks observable Agent writes and direct `!` shell execution, while visibly declaring that Pi built-in slash commands are user-directed and not globally mediated in Task 5;
- it works when user plugin code throws during normal startup;
- it exposes plugin disable/doctor commands;
- it does not silently delete plugin files or settings.

### HP-US-043 — Plugin compatibility receipt (`P1`)

As a maintainer, I want exact compatibility results so that Compatibility `VERIFIED` remains reproducible without implying safety.

Acceptance:

- receipt binds release, engine, platform, package source/version, config, and tests;
- a changed tuple invalidates the prior projection;
- failing history remains accessible;
- absence of a receipt is Compatibility `UNVERIFIED`;
- Trust and Isolation are reported separately and never inferred from Compatibility.

## Updates and maintenance

### HP-US-050 — Qualified update (`P0`)

As a user, I want one Hunter Pi update to include the compatible Pi engine so that I do not coordinate two products.

Acceptance:

- update never delegates to uncontrolled Pi self-update;
- candidate passed required exact-artifact gates;
- migration, engine, plugin, and rollback changes are shown;
- failed installation leaves the previous release usable.

### HP-US-051 — Rollback (`P0`)

As a user, I want to return to the previous known-good release after a regression.

Acceptance:

- rollback verifies artifact integrity;
- project, session, and credential references are preserved or explicitly reported incompatible;
- irreversible schema migration is blocked from stable promotion;
- rollback creates a receipt.

### HP-US-052 — Upstream qualification (`P0`)

As a maintainer, I want each Pi candidate tested through the same contracts so that an official release is not mistaken for Hunter compatibility.

Acceptance:

- candidate version/integrity/source are frozen;
- Extension, package, JSON/RPC, SDK/session, Windows, Ubuntu, and rollback suites run;
- unrun remote jobs remain `PENDING`;
- promotion references exact passing receipts.

### HP-US-053 — Fork escalation (`P1`)

As the owner, I want a fork proposed only with concrete evidence so that short-term convenience does not create hidden permanent maintenance.

Acceptance:

- a minimal public-interface reproduction is preserved;
- Extension, JSON, RPC, SDK, and upstream-contribution alternatives are addressed;
- patch size, rebase strategy, compatibility impact, and exit plan are documented;
- implementation waits for a new accepted ADR.

## Negative acceptance scenarios

The first preview must also prove that Hunter Pi does **not**:

1. mark a Change ready when Pi exits zero before required tests;
2. overwrite a failed Attempt after a later pass;
3. load a user plugin in Safe Mode;
4. expose a fixture token, Cookie, home path, or private prompt in Evidence;
5. rerun an interrupted operation with the same ID and a different payload;
6. delete a dirty or uniquely committed worktree during cleanup;
7. call an official Pi Windows asset a Hunter Pi Windows PASS;
8. auto-promote an upstream version whose contract or remote CI is not complete;
9. claim every Pi package compatible after testing only representative fixtures;
10. copy raw Pi credentials during import;
11. send a first model request before provider data disclosure and acknowledgement;
12. describe a `PROCESS_AUTHORITY` plugin as sandboxed or safe merely because compatibility tests passed.
