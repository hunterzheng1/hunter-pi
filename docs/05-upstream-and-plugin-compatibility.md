# Upstream and plugin compatibility

## Baseline

Hunter Pi is a downstream distribution of official Pi, not a source fork in the initial architecture. The detailed dated upstream record is maintained in [the research baseline](research/2026-08-03-pi-and-omp-upstream-baseline.md).

Pi officially exposes TypeScript Extensions, Skills, prompt templates, themes, Pi Packages, JSON mode, RPC, and an SDK. Pi Packages may be installed from npm, Git, or local paths. These are suitable public seams, but official documentation is a capability claim rather than Hunter Pi local proof:

- [Pi coding-agent README](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/README.md)
- [Pi extensions](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/packages.md)
- [Pi RPC](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/rpc.md)
- [Pi SDK](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/docs/sdk.md)

## Engine qualification

Every Distribution Release binds one exact Engine Release in a machine-readable compatibility manifest. A version range alone is insufficient.

Proposed manifest facts:

- Hunter Pi release and source commit;
- Pi package name, version, source, integrity, and license snapshot;
- required JavaScript runtime and supported platforms;
- enabled public integration surfaces;
- Extension event and command contract version;
- RPC/JSON protocol probes;
- session resume behavior;
- package loading behavior;
- representative provider-independent fixtures;
- contract suite result per platform;
- known incompatibilities and rollback target.

Qualification states:

| State | Meaning |
|---|---|
| `CANDIDATE` | selected for evaluation; not shipped to stable |
| `QUALIFIED` | all required local and CI contracts passed for exact artifacts |
| `BLOCKED` | environment or prerequisite prevented required proof |
| `INCOMPATIBLE` | a required contract reproduced a mismatch |
| `RETIRED` | no longer offered for new installations; retained for rollback/history |

### Task 4 candidate result

The dated [public-interface recheck](research/2026-08-03-pi-public-interface-recheck.md) intentionally retains `@earendil-works/pi-coding-agent@0.83.0`, registry `gitHead` `845d6ff1f6643aba440341cce877ce1c43ebbc39`, and the exact npm integrity recorded in the lockfile. The local Windows [Task 4 validation](validation/2026-08-03-task4-pi-public-interface.md) exercises only public package exports and CLI modes in an automatically created temporary Git fixture with isolated configuration, isolated Sessions, Pi's documented offline startup/package mode, and a deterministic faux provider. Operating-system network isolation was not established and remains `NOT_PROVEN`.

That receipt supports continuing without a Pi fork, but it is deliberately narrower than a `QUALIFIED` production Engine Release:

- RPC abort is accepted only under one in-flight mutating Agent operation; it is not request-scoped cancellation.
- Pi Session persistence and fresh-process reopen are engine external-reference inputs, not Hunter's canonical durable Checkpoint.
- root Pi RPC exit after stdin EOF is observed only in a fixture with no tool descendants; complete descendant process-tree cleanup remains `NOT_PROVEN` and belongs to the later process-host acceptance task.
- `agent_end`, `session_shutdown`, SDK completion, and process exit remain Observations, never Hunter Step success.
- real Provider login/calls, interactive TUI usability, third-party packages, operating-system network isolation, and remote Windows/Ubuntu results are not inferred from the provider-independent receipt.

## Upstream update pipeline

```text
Discover upstream release
  → fetch metadata without executing package code
  → verify source/integrity/license delta
  → build isolated candidate
  → run Fake and real-host contract suites
  → run Windows and Ubuntu matrices
  → run representative plugin suite
  → publish preview
  → bounded daily-use soak
  → promote to stable or reject
```

Hunter Pi owns updates. The bundled Pi must not run an independent self-update that changes the Engine Release behind the compatibility manifest.

“Seamless update” means the user updates Hunter Pi once and receives a qualified engine. It never means blindly following upstream `latest`.

## Plugin compatibility target

Hunter Pi targets standard Pi package resources:

- extensions;
- skills;
- prompts;
- themes.

Supported sources are introduced in order:

1. exact local fixture packages;
2. exact npm versions with integrity;
3. Git tags or commits;
4. unpinned mutable sources only in explicit preview/development mode.

Hunter Pi uses an isolated configuration root. Existing raw Pi packages are not silently loaded; the user can explicitly import package declarations after previewing differences.

## Plugin compatibility, trust, and isolation

Every plugin result is exact to a tuple:

```text
(Hunter Pi release, Engine Release, platform, plugin source, plugin version/ref, configuration)
```

The product reports three independent dimensions:

| Dimension | Values | Meaning |
|---|---|---|
| Compatibility | `VERIFIED`, `UNVERIFIED`, `INCOMPATIBLE` | Whether the exact package tuple passed Hunter Pi behavior contracts |
| Trust | `BUNDLED`, `USER_APPROVED`, `QUARANTINED` | Whether provenance and local activation policy allow loading |
| Isolation | `CONTAINED`, `PROCESS_AUTHORITY`, `NOT_PROVEN` | What authority boundary was actually established for executable code |

Popularity, upstream stars, successful installation, or another user's report cannot produce Compatibility `VERIFIED`. Compatibility `VERIFIED` cannot produce Trust or Isolation. A normal Pi extension executes in the Agent process and is reported as `PROCESS_AUTHORITY` unless a separately tested container or sandbox receipt proves `CONTAINED`.

The combined Plugin Assurance Receipt embeds the exact immutable Compatibility Receipt instead of copying an independently mutable tuple. Its Compatibility value must equal that Receipt's outcome; Trust and Isolation remain separate assessments over the same exact plugin/release/platform/configuration identity.

Managed Change policy evaluates all three dimensions. A critical `INCOMPATIBLE` or `QUARANTINED` plugin is blocked. A `PROCESS_AUTHORITY` or `NOT_PROVEN` plugin may be allowed only with an explicit downgrade; it cannot participate in a claim of verified containment.

## Compatibility suite

The shared plugin suite verifies at least:

- package discovery and deterministic resource resolution;
- extension load/unload and error isolation;
- command and tool registration;
- lifecycle event ordering used by the Core Extension;
- UI behavior required by interactive mode;
- session entry persistence and reload;
- no collision with reserved Hunter identifiers;
- tool override detection;
- bounded output and redaction;
- Windows path and compiled/distributed artifact behavior;
- disable, Safe Mode, update, and rollback.

Representative plugins are selected by exercised capability, not popularity. Passing one representative does not prove the ecosystem.

## Critical collisions

Pi extensions may register or override tools. A plugin that changes file, command, context, compaction, session, or lifecycle behavior can affect Evidence integrity.

Hunter Pi therefore:

- reserves Core Extension command/event identifiers;
- inventories active tools and their source after loading;
- fingerprints the effective plugin/tool graph for each Attempt;
- fails closed if the Core Extension is missing or shadowed in Managed Change;
- invalidates prior compatibility receipts when relevant configuration changes;
- offers Safe Mode with only bundled resources;
- labels results `NOT_PROVEN` when complete observation cannot be guaranteed.

## Oh My Pi disposition

[Oh My Pi v17.2.4](https://github.com/can1357/oh-my-pi/blob/v17.2.4/README.md) is a feature-rich Pi fork with its own packages, native tools, task system, plugin surface, and release stream. Hunter Pi does not depend on or fork it initially.

OMP features are considered one at a time:

1. define the user problem independently;
2. check whether official Pi or a standard package already solves it;
3. evaluate the OMP implementation and license;
4. port the smallest isolated behavior behind a Hunter Interface;
5. record source provenance and add independent tests;
6. avoid OMP-private types in the Workflow Kernel.

Candidate areas include hash-anchored editing, LSP, browser reading, subagents, code evaluation, and native search. None is accepted merely because OMP ships it.

## Fork decision

A source fork is a fallback, not a milestone. The threshold in [system architecture](03-system-architecture.md#fork-threshold) applies. If accepted later, the fork must use a bounded patch queue, automated upstream merge tests, explicit provenance, and a user-visible engine identity.

## Compatibility non-claims

Until the plan executes:

- no Pi release is `QUALIFIED`;
- no third-party plugin has Compatibility `VERIFIED`, Trust beyond its explicit local decision, or Isolation `CONTAINED`;
- loading a `pi` manifest in another fork does not prove behavior compatibility;
- npm installation does not prove runtime compatibility;
- Pi or OMP documentation does not prove Windows behavior in Hunter Pi;
- a passing Fake Host proves only Hunter contracts.
