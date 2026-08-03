# User experience

All commands and screens in this document are target designs. They do not exist yet.

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

Before any model request, the wizard requires an explicit acknowledgement that selected prompts, repository content, tool results, and conversation context may be transmitted to the configured provider. It shows the resolved provider/endpoint category, configured telemetry/network controls, and links or references to the provider's retention policy without claiming to enforce that external policy.

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

A user can start directly:

```powershell
hpi change "修复刷新令牌过期后重复跳转"
```

The interaction is conversational, but the workflow has visible stages:

```text
DEFINE → PLAN → EXECUTE → VERIFY → REVIEW → READY
                    ↘ FIXBACK ↗
```

The user sees:

- goal, non-goals, constraints, and acceptance checks;
- current Plan Revision and why it changed;
- isolated worktree path in abbreviated form;
- active Attempt and prior failed Attempts;
- commands currently running and their time limits;
- independent Verification results;
- plugin or permission conditions that make a named verification, provenance, or containment claim `NOT_PROVEN`;
- next deterministic action.

`READY` means the change met its declared local acceptance checks. It does not mean pushed, merged, released, deployed, or accepted by another person.

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

A Safe Mode starts only the Core Extension:

```powershell
hpi --safe-mode
```

## Permission profiles

The proposed first-run default is `Balanced`:

- `Safe` — read-only and low-risk commands by default; repository writes and external effects ask first.
- `Balanced` — repository-local edits and declared verification commands are allowed; destructive filesystem, credential, remote-write, publish, deployment, and paid operations ask first.
- `Full Access` — broad local development tools are allowed after explicit profile selection; each credential access, remote write, publish, deployment, paid operation, privilege escalation, or broad/irreversible filesystem action still requires its own explicit workflow decision and Receipt.

Permission profiles mediate Hunter-owned tools and Pi tool calls that the Core Extension can observe. They are not an operating-system sandbox. A Pi extension runs as executable code in the Agent process and may directly access files, processes, network, or credentials without using a mediated tool; activating one therefore grants at least the authority shown by its Isolation result.

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
