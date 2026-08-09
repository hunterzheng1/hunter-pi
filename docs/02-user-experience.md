# User experience

Task 5 implements the bounded developer-preview subset: `hpi`, `setup`, `doctor`, `login`, `smoke tui`, Safe Mode, Quick Session start/continue/resume, and plugin doctor/disable. Task 12 adds an explicitly scoped JSON-plan Managed Change entry point; conversational planning, full plugin management, installer/update UI, and other commands remain target designs unless a dated validation record says otherwise.

## Installation experience

The delivery path has two stages:

1. **Developer preview** — an exact npm package invoked with `npx` or installed globally.
2. **Daily-use preview** — a downloadable Windows installer or portable package that carries its required JavaScript runtime and exposes `hpi` on `PATH`.

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

The plan must be `hpi-managed-change-request.v2` and declare the goal, non-goals, constraints, exact relative `allowedPaths`, one independent command check, and a path-free frozen target identity (`targetId`, repository/source/target-reference fingerprints) obtained from `hpi pilot target`. `--repo` is mandatory; Hunter Pi never silently selects the current directory. The command requires setup, Provider auth metadata, a clean physical Git root, explicit Provider-request authorization, and an operator acknowledgement of the target and plan. Before the Agent starts, the runner recomputes the canonical Git snapshot and blocks `TARGET_IDENTITY_MISMATCH`; its current `hpi-managed-change.v3` Evidence repeats the exact target binding. It runs one or at most two bounded Agent Attempts through the Task 7 qualified local process host and a durable writer lease, verifies with the declared command in `workspace-root`, reviews every changed path against `allowedPaths`, and leaves the selected working tree uncommitted for explicit operator review. Each qualified Agent Attempt runs from a one-use Pi configuration snapshot with Provider transport retry, Agent auto-retry, and automatic compaction disabled, so final assistant events can account for every Provider send exactly. Usage totals must match both token and cost components. Missing or inconsistent usage blocks a fixback request and returns `STOP`; a fixback also requires a predeclared token and cost reserve, while measured token or cost over the finite per-change budget returns `STOP`. The historical v2 parser remains available for replay, but new executions emit v3. It never commits, pushes, publishes, deploys, or treats Agent return as success.

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
hpi change --repo D:\Pilot\sample --plan .\task-01.json --run-archive-id archive-task-01 --json --allow-provider-request
hpi pilot capture managed-task --session-id pilot-2026-08 --operation-id capture-task-01 --task-id task-01 --archive-ids archive-task-01 --metrics .\task-01-metrics.json --json
```

The first command writes the Workflow Kernel history and strict product task receipt into the canonical Task 9 Archive. The second replays that Archive and derives the repository, source, target reference, checks, outcome, Provider usage, Run identity, and Archive fingerprint; the metrics file may provide only the predeclared fact-coverage and intervention counts. A replacement chain lists Archive identities in order, separated by commas. The generic `capture record` command is reserved for explicit operator/runtime receipts such as installation or performance and refuses caller-authored task chains or raw-Pi comparator results; those product facts require an internal capability that is not exported from the package entry. `capture finalize` remains blocked until status reports every frozen observation present, and it runs only on the pilot Windows machine.

These commands are an acceptance harness, not a shortcut to a product claim. Quick-task and raw-Pi comparator results require their own product-derived capture paths; until those paths and the complete real Archive exist, status remains `NOT_PROVEN`.

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

Target commands:

```powershell
hpi plugin search <term>
hpi plugin install npm:example-package
hpi plugin install git:github.com/owner/repo@tag
hpi plugin list
hpi plugin doctor
hpi plugin disable <id>
hpi plugin import-from-pi
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

Hunter Pi does not automatically reuse raw Pi's configuration directory. `import-from-pi` imports selected package declarations and preferences, never credentials by copying opaque files.

## Update experience

Target commands:

```powershell
hpi update check
hpi update apply
hpi update rollback
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
