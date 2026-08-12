# User experience

The current Windows developer preview implements `hpi`, `setup`, `doctor`, `login`, `smoke tui`, Safe Mode, Quick Session start/continue/resume, an explicitly scoped JSON-plan Managed Change entry point, resource-oriented Plugin management, and qualified portable update/rollback commands. Task 12's real Windows pilot evaluates the historical Pi 0.83 Distribution Release as `GO` within its unsigned developer-preview boundary. Hunter Pi `0.1.0-dev.1` uses Pi 0.84.1 and must retain its separate `NOT_PROVEN` daily-use disposition until new acceptance exists. A signed installer, Stable publication, broad executable-Plugin qualification, physical power-loss proof, and non-Windows daily-use acceptance remain unproven. For executable instructions, use the [Windows user guide](user-guide.md); this document retains the product interaction model and detailed behavior.

## Installation experience

The delivery path has two stages:

1. **Developer preview package** — an exact local npm tarball built from source and installed with Node.js 24.
2. **Windows release preview** — one unsigned Windows x64 ZIP carrying Node.js 24, the versioned portable root, a stable `hpi` launcher, and the same `install.ps1` published as a standalone asset. End users do not need ambient Node.js, npm, or Pi.

The user should not separately install, update, or configure raw Pi. Hunter Pi owns the qualified Engine Release. Git remains an explicit prerequisite until the installer decision proves that safely bundling it is worthwhile.

## First run

Running `hpi` for the first time opens a bounded setup wizard:

```text
Hunter Pi — First Run

1. Environment      Node/runtime, Git, terminal, writable config path
2. Provider         Select a supported model provider
3. Data disclosure  Review what context may be sent, endpoint, and provider policy
4. Authentication   Open the provider's official login flow
5. Defaults         Model, thinking level, permission profile
6. Plugins          Core-only initially; import is optional
7. Verification     Confirm a temporary Git fixture can be created and cleaned
```

Task 5 uses the qualified default Provider/model and `Balanced` permission when `hpi` starts from an empty profile; an alternative target is selected first with explicit `hpi setup` flags. Steps 1 and 7 execute the product Doctor, including an automatically created temporary Git fixture and a fresh offline resolution of the current Provider destination. Step 4 asks before opening the Provider-owned Pi login TUI. Cancellation leaves setup recoverable and returns `BLOCKED`; the wizard never logs in or sends a model request automatically. A configured result still reports interactive TUI readiness `NOT_PROVEN` until the separate `hpi smoke tui` acknowledgement succeeds from an exact packaged artifact. That acknowledgement binds both `hpi.js` and Core SHA-256 values and becomes `NOT_PROVEN` after either executable surface drifts.

Before any model request, the wizard requires an explicit acknowledgement that selected prompts, repository content, tool results, and conversation context may be transmitted to the configured provider. It resolves the exact origin offline from the fixed Pi catalog/configuration, shows the endpoint category and configured telemetry/network controls, and links or references the provider policy without claiming it matches the user's account. Unless separately proven, it displays `ExternalRetention=NOT_PROVEN`, `TrainingUse=NOT_PROVEN`, and `AccountControls=PROVIDER_OWNED` instead of guessing account facts. The acknowledgement binds the exact resolved origin and these statuses; launch recomputes the origin and requires acknowledgement again after drift.

The wizard records capability, disclosure, consent, and configuration receipts, never tokens, cookies, complete environment variables, or private prompt content. A missing or cancelled provider login is `BLOCKED`, not a failed product installation.

## Opening a repository

From a terminal:

```powershell
cd D:\Projects\sample
hpi
```

Hunter Pi displays:

- repository and branch identity;
- uncommitted-change status;
- selected model and permission profile;
- enabled plugins and their separate Compatibility, Trust, and Isolation results;
- whether the session is Quick or Managed;
- current cost/time/token budgets when available;
- explicit warnings naming which verification, provenance, isolation, or recovery claim becomes `NOT_PROVEN`.

Absolute home paths must be abbreviated in user-visible logs and removed from portable Evidence.

## Quick Session

A Quick Session behaves like a normal terminal coding Agent:

```text
> Explain how authentication works in this repository.
> Rename this local variable and run the focused test.
```

Properties:

- starts in the current workspace;
- supports normal Pi interaction and compatible plugins;
- records a local session and tool observations when enabled;
- may run commands according to the selected permission profile;
- does not claim a verified Change unless promoted to Managed Change;
- can be discarded without creating an archive.

Promotion is explicit:

```text
/manage
```

Before promotion, Hunter Pi captures the current Git identity and asks whether existing modifications belong to the new Managed Change.

## Managed Change

A user can start an explicitly scoped local Managed Change directly:

```powershell
hpi change --repo D:\Projects\sample --plan .\hpi-change.json --json --allow-provider-request
```

The plan must be `hpi-managed-change-request.v2` and declare the goal, non-goals, constraints, exact relative `allowedPaths`, one independent command check, and a path-free frozen target identity (`targetId`, repository/source/target-reference fingerprints) obtained from `hpi pilot target`. `--repo` is mandatory; Hunter Pi never silently selects the current directory. The command requires setup, Provider auth metadata, a clean Git-visible working tree, explicit Provider-request authorization, and an operator acknowledgement of the target and plan. Before the Agent starts, the runner recomputes the canonical Git snapshot and blocks `TARGET_IDENTITY_MISMATCH`; its current `hpi-managed-change.v3` Evidence repeats the exact target binding. It runs one or at most two bounded Agent Attempts through the Task 7 qualified local process host and a durable writer lease, verifies with the declared command in `workspace-root`, reviews every Git-visible or ignored changed file against `allowedPaths`, and leaves the selected working tree uncommitted for explicit operator review. Final review compares both the frozen branch and the exact target-reference fingerprint; switching to another branch at the same commit is a P0 target-reference drift and cannot reach `READY` or `GO`. Existing ignored regular files and symbolic-link targets are content-fingerprinted with an in-process stat-safe digest cache. Every snapshot accounts all newly hashed content against one aggregate limit of 8 GiB and one 120-second elapsed limit; product callers may only tighten those ceilings. Exceeding either limit fails closed as `WORKING_TREE_INSPECTION_BUDGET_EXCEEDED` instead of skipping content, while unchanged files reuse a digest only when their exact stat signature still matches. Independent Verification is frozen before and after execution, so a mutating check cannot manufacture readiness. Recovery and fixback also bind the exact working-tree content before another Attempt starts. Each qualified Agent Attempt runs from a one-use Pi configuration snapshot containing only the selected Provider auth/model records, with credential-bearing proxy URLs removed and Provider transport retry, Agent auto-retry, and automatic compaction disabled, so final assistant events can account for every Provider send exactly. Usage totals must match both token and cost components. Missing or inconsistent usage blocks a fixback request and returns `STOP`; a fixback also requires a predeclared token and cost reserve, while measured token or cost over the finite per-change budget returns `STOP`. The historical v2 parser remains available for replay, but new executions emit v3. It never commits, pushes, publishes, deploys, or treats Agent return as success. Pi and its tools still run with the Agent process's operating-system authority; these checks detect bounded repository drift but are not an OS sandbox.

The interaction is conversational, but the workflow has visible stages:

```text
DEFINE → PLAN → EXECUTE → VERIFY → REVIEW → READY
                    ↘ FIXBACK ↗
```

The user sees:

- goal, non-goals, constraints, and acceptance checks;
- current Plan Revision and why it changed;
- selected repository/branch identity and relative changed paths;
- active Attempt and prior failed Attempts;
- commands currently running and their time limits;
- independent Verification results;
- plugin or permission conditions that make a named verification, provenance, or containment claim `NOT_PROVEN`;
- next deterministic action.

`READY` means the change met its declared local acceptance checks. It does not mean pushed, merged, released, deployed, or accepted by another person.

## Daily-use pilot capture

The Task 12 operator first opens one durable session against an already compiled and preflighted execution plan:

```powershell
hpi pilot capture open --plan .\pilot-plan.json --session-id pilot-2026-08 --archive-id pilot-archive-2026-08 --json
hpi pilot capture status --session-id pilot-2026-08 --json
```

For a pilot Managed task, the change command is given a unique Run Archive identity:

```powershell
hpi change --repo D:\Pilot\sample --plan .\task-01.json --run-archive-id archive-task-01 --pilot-plan .\pilot-plan.json --pilot-task-id task-01 --pilot-session-id pilot-2026-08 --pilot-operation-id capture-task-01 --json --allow-provider-request
hpi pilot capture managed-task --session-id pilot-2026-08 --operation-id capture-task-01 --task-id task-01 --archive-ids archive-task-01 --json
```

The current v4 pilot plan also names one paired Managed task as the deliberate fixback task and requires exactly one executable acceptance check per task. That task must preserve two linked Attempts and exact independent Verification history in the canonical Archive: first `FAIL`, then `PASS`. It cannot double as one of the three interruption tasks. Open the capture session before `hpi change`, and use the same session and operation identities for the later `capture managed-task` command. Provider-backed tasks run only on the frozen Windows x64 host. The confirmation identifies the plan's complete frozen Provider request, token, and cost allowance rather than treating Agent Attempts as Provider requests. Immediately before the first external operation—after repository, target, Writer Lease, Engine, process lease, launch-plan, and private runtime-snapshot preflight—the Engine adapter writes an immutable full-remaining-budget intent to that session. It binds the frozen task, exact path-free `targetId`, canonical check ID, target fingerprints, portable artifact, product source, Engine release, Provider endpoint/model, credential scope, workflow checklist, and interruption declaration. The same target identity is repeated in the v4 task receipt, resolved Oracle, capture validation, and v7 Evidence. The Host registers an in-flight identity before adapter or authorization callback code, so even callback-reentrant exact sends share one execution. A crash or exception after authorization stores an `UNKNOWN` Host tombstone and leaves the session reconciliation-locked; an earlier local failure leaves no intent and remains retryable. A clean pre-send rejection also releases its qualified process lease. Retrying from a later CLI invocation uses fresh runner-bound operation IDs, reaches the authorization boundary again, and cannot collide with the released request history; an unreleased workspace lease still blocks concurrent execution. If the durable pilot Run and first Attempt were already recorded before such a failure, an exact rerun resumes only when the capture session first proves that this is still an observation-free pre-send state with no Provider intent. Its portable Plan fingerprint is derived from the retained canonical projection. Non-pilot durable state and unknown post-boundary pilot state never infer “unsent” from missing workflow observations and fail closed instead. A planned interruption remains armed if authorization rejects and is consumed only after authorization succeeds. The v4 product task receipt records those bindings and the named workflow facts; `capture managed-task` derives counts from those names rather than accepting a numeric claim.

For the three predeclared recovery exercises, add exactly one controlled injection to a durable Managed run:

```powershell
hpi change --repo D:\Pilot\sample --plan .\task-02.json --run-archive-id archive-task-02 --pilot-plan .\pilot-plan.json --pilot-task-id task-02 --pilot-session-id pilot-2026-08 --pilot-operation-id capture-task-02 --pilot-interruption FORCED_PROCESS_KILL --json --allow-provider-request
hpi change --repo D:\Pilot\sample --plan .\task-06.json --run-archive-id archive-task-06 --pilot-plan .\pilot-plan.json --pilot-task-id task-06 --pilot-session-id pilot-2026-08 --pilot-operation-id capture-task-06 --pilot-interruption TERMINAL_CLOSE_SIMULATION --json --allow-provider-request
hpi change --repo D:\Pilot\sample --plan .\task-10.json --run-archive-id archive-task-10 --pilot-plan .\pilot-plan.json --pilot-task-id task-10 --pilot-session-id pilot-2026-08 --pilot-operation-id capture-task-10 --pilot-interruption POWER_LOSS_SIMULATION --json --allow-provider-request
```

The latter two names are deliberately simulations at the contained Pi-process boundary. They exercise
distinct user-request and timeout cancellation paths after a trusted Agent-end marker; they do not claim
that the terminal application or whole Windows machine was physically terminated. Each injection is
one-shot, preserves the interrupted Attempt and Checkpoint, and must recover through a new Attempt in the
same canonical Run before the Archive can be accepted.

The first command writes the Workflow Kernel history and strict product task receipt into the canonical Task 9 Archive. The second replays that Archive and derives the repository, source, target reference, checks, outcome, Provider usage, Run identity, Archive fingerprint, workflow-fact coverage, and automatic-intervention count. The live v2 capture path accepts no metrics file; historical v1 input remains parseable for fixture replay only. A replacement chain lists Archive identities in order, separated by commas. The generic `capture record` command is reserved for explicit operator/runtime receipts such as installation or performance and refuses caller-authored task chains or raw-Pi comparator results; those product facts require product-derived commands. `capture finalize` remains blocked until status reports every frozen observation present, and it runs only on the pilot Windows machine.

Quick tasks run through `capture quick-task`; raw Pi pairs run through `capture raw-pi` in a clean equivalent-source comparator workspace. Both commands execute the qualified process and independent acceptance check themselves, recheck the exact changed-file state after acceptance (including newly ignored entries), and neither accepts a caller-authored PASS receipt. Their budget check, Provider operation, and append-only fact publication are serialized so concurrent capture commands cannot both pass the same remaining-budget check. These commands are an acceptance harness, not a shortcut to a product claim; until the complete real Archive exists, status remains `NOT_PROVEN`.

## Failure and recovery

If an Agent returns without satisfying output contracts:

```text
Attempt 1: ExecutionStatus=RETURNED / VerificationStatus=FAILED
Reason: unit test auth-refresh.test.ts failed

Choose:
1. Create fixback Attempt with failure evidence
2. Revise the plan
3. Ask for human input
4. Stop and preserve the checkpoint
```

After an abnormal exit, the next `hpi` invocation offers only identity-matching recovery candidates:

```text
Recover managed change refresh-token-loop?

Checkpoint: cp_...
Workspace: cleanly identified
Engine session: resumable / not proven
Last Attempt: incomplete
```

Recovery creates a new Attempt and preserves the interrupted one. If workspace, plan, engine, or Evidence identity cannot be reconciled, Hunter Pi stops with an actionable diagnosis rather than guessing.

## Verification experience

Verification commands come from detected project configuration or explicit project policy. The user can preview them before execution.

Possible outcomes:

- `PASS` — exact declared checks ran successfully against the current workspace identity;
- `FAIL` — at least one declared check ran and failed;
- `BLOCKED` — a prerequisite such as login, executable, or environment was unavailable;
- `NOT_PROVEN` — available evidence cannot establish the claim;
- `NOT_RUN` — the check was not attempted.

No output is summarized as “all tests passed” unless the exact required set is known and executed.

## Plugin experience

Implemented commands:

```powershell
hpi plugin list
hpi plugin doctor
hpi plugin disable <id>
hpi plugin remove <id>
hpi plugin install local <directory> --label <name> --acknowledge-provenance --allow-process-authority
hpi plugin install npm <name@version> --integrity <registry-SRI> --acknowledge-provenance --allow-process-authority
hpi plugin install git <https-url> --commit <sha> --tree-fingerprint <sha256> --acknowledge-provenance --allow-process-authority
hpi plugin import-pi <directory> --package <name@version> --integrity <sha256> --acknowledge-provenance --allow-process-authority
```

Before installation, Hunter Pi displays source, resolved version/ref, integrity when available, declared resources, and the fact that Pi extensions can execute local code.

The runtime header shows three independent dimensions:

- Compatibility: `VERIFIED`, `UNVERIFIED`, or `INCOMPATIBLE`;
- Trust: `BUNDLED`, `USER_APPROVED`, or `QUARANTINED`;
- Isolation: `CONTAINED`, `PROCESS_AUTHORITY`, or `NOT_PROVEN`.

`VERIFIED` means only that the exact compatibility suite passed. It is never displayed as proof that executable plugin code is safe.

A Safe Mode disables user extensions, skills, prompt templates, themes, and context files, then explicitly loads only the Core Extension:

```powershell
hpi --safe-mode
```

Task 5 Safe Mode mediates observable Agent tool calls, blocks direct `!` shell execution, and pins the acknowledged Provider/model/origin. It is not a globally read-only Pi or an operating-system sandbox. Fixed Pi dispatches some built-in slash commands (including share/import/export/compact/trust/settings flows) before Extension input hooks. Typing one is an explicit user-directed operation outside the Task 5 Hunter tool-policy claim; smoke sessions must not use them, and all-provider-request blocking remains `NOT_PROVEN`. Every Hunter-launched Pi TUI inspects the isolated Session tree before start, but an interactive `/import` source is not Hunter-qualified in this preview.

## Permission profiles

The proposed first-run default is `Balanced`:

- `Safe` — Hunter-mediated read-only and low-risk tools by default; mediated repository writes and external effects ask first. Direct Pi built-ins remain subject to the boundary above.
- `Balanced` — Hunter-mediated repository-local edits and declared verification commands are allowed; mediated destructive filesystem, credential, remote-write, publish, deployment, and paid operations ask first.
- `Full Access` — broad Hunter-mediated local development tools are allowed after explicit profile selection; each Hunter-managed credential access, remote write, publish, deployment, paid operation, privilege escalation, or broad/irreversible filesystem action still requires its own explicit workflow decision and Receipt.

Permission profiles mediate Hunter-owned tools and Pi tool calls that the Core Extension can observe. They are not an operating-system sandbox. A Pi extension runs as executable code in the Agent process and may directly access files, processes, network, or credentials without using a mediated tool; activating one therefore grants at least the authority shown by its Isolation result.

Task 5 implements only a conservative named-path credential guard at observable file-tool calls: recognized paths ask in Balanced and Full Access and block in Safe Mode. It cannot infer credential content in an arbitrary innocently named file, so the header and `/hunter-status` display `CredentialGuard=NAMED_PATHS_ONLY` and `ContentDetection=NOT_PROVEN`. The command response begins with `HunterStatus=DETECTED Command=/hunter-status` so it is distinguishable from startup text. Complete credential mediation remains a later owned-interaction/Managed Change requirement, not a Task 5 claim.

Task 5 does not prove these profile guarantees for Pi built-in slash commands. In particular, fixed Pi `/share` can invoke GitHub CLI to upload complete session HTML before the Core input hook, without a Hunter confirmation or Receipt. The preview visibly reports `ShareCommand=NOT_MEDIATED` and `RemoteWriteGuarantee=NOT_PROVEN`; users must not use `/share` until an owned interaction layer or upstream public interception point closes that gap.

A Managed Change that requires verified containment runs Core-only or with plugins whose Isolation is `CONTAINED`. If a `PROCESS_AUTHORITY` or `NOT_PROVEN` plugin is enabled, policy may block the Run or visibly downgrade its safety claim; passing project tests does not restore a containment claim.

## Configuration scopes

Target locations:

| Scope | Windows | Unix-like | Purpose |
|---|---|---|---|
| User | `%USERPROFILE%\.hunter-pi\` | `~/.hunter-pi/` | auth references, models, user plugins, update channel |
| Project | `<repo>/.hunter-pi/` | `<repo>/.hunter-pi/` | versioned project rules, workflows, check definitions |
| Runtime | local state under user/project roots | same | sessions, logs, locks, checkpoints; gitignored |

Hunter Pi does not automatically reuse raw Pi's configuration directory. `hpi plugin import-pi` imports one explicitly selected package directory with an exact package identity and integrity value; it does not copy raw Pi credentials or opaque configuration files.

## Update experience

Implemented portable commands:

```powershell
hpi update status --json
hpi update check --candidate <file> --artifact <file> --json
hpi update apply --candidate <file> --artifact <file> --json
hpi update rollback <release-id> --json
hpi version --json
```

An update summary must identify:

- Hunter Pi version;
- bundled Engine Release;
- schema migrations;
- plugin compatibility changes;
- required restart;
- rollback availability.

Hunter Pi should make qualified updates easy, but must never silently move to an untested upstream Pi `latest`.
