# Hunter-Harness mechanism disposition

## Purpose and source baseline

Hunter Pi reuses the engineering lessons of Hunter-Harness without depending on its runtime, server, registry, installed Skills, or `.harness` state layout.

This disposition was prepared against:

- Hunter-Harness source commit [`b73db2a23d0ed671c228640a37386b5c0dbef1e7`](https://github.com/hunterzheng1/Hunter-Harness/commit/b73db2a23d0ed671c228640a37386b5c0dbef1e7), observed 2026-08-03;
- CLI package version [`hunter-harness@0.2.47`](https://github.com/hunterzheng1/Hunter-Harness/blob/b73db2a23d0ed671c228640a37386b5c0dbef1e7/packages/cli/package.json#L3), observed from the frozen source and used only as context, not as a Hunter Pi dependency or verification result;
- the archived Hunter Platform domain invariants, used as historical design input rather than an active implementation plan.

`MIGRATE` below means reimplement a mechanism and its essential tests in Hunter Pi terms. It does not mean copy every file or retain Harness-private schemas.

## Disposition matrix

| Hunter-Harness mechanism | Disposition | Hunter Pi destination | Rationale |
|---|---|---|---|
| Plan → Run → Test → Review → Submit → Archive phase discipline | `MIGRATE_AND_SIMPLIFY` | Workflow Kernel | Keep explicit delivery stages; combine them into conversational Managed Change UX; Git submit remains separate from `READY` |
| Test scenarios before implementation | `MIGRATE` | Plan Revision / testing strategy | Prevent post-hoc coverage claims and drive RED → GREEN clusters |
| Append-only `events.ndjson` and generated projections | `MIGRATE` | Evidence event store | Preserve facts, repeated Attempts, and deterministic views; use new provider-neutral schemas |
| Execution/verification status separation | `MIGRATE` | Attempt state machine | Central Hunter invariant; Pi return never becomes success |
| Verification ledger with diff/config identity | `MIGRATE` | Verification Receipt | Reuse only when exact source, check, config, environment, and result identities match |
| Scenario selected/executed/passed/skipped accounting | `MIGRATE` | Verification adequacy | Prevent filtered, skipped, or uncollected tests from masquerading as full coverage |
| Worktree decision and isolated writer | `MIGRATE` | Git workspace adapter and lease | Managed Change requires isolation; Quick Session may use current workspace with reduced guarantees |
| Managed execution sessions, incremental logs, heartbeat, cancellation | `MIGRATE` | Process host | Required for long Pi and verifier commands, recovery, and terminal independence |
| Windows Job Object containment | `MIGRATE_AFTER_SPIKE` | Windows process adapter | Critical for daily use; prove with child-tree fixtures before real runs |
| Resource locks and bounded verification DAG | `MIGRATE` | Verification scheduler | Avoid machine saturation and conflicting databases/ports/workspaces |
| Environment session identity and canary | `DEFER_TO_NEED` | Environment adapter | Add when a real vertical slice needs reusable DB/container state; not a Task 1 prerequisite |
| Fixback batches with RED/GREEN evidence | `MIGRATE` | Attempt/finding workflow | Keep failure evidence and rerun invalidated gates |
| Build profile detection | `MIGRATE_AND_SIMPLIFY` | Project check configuration | Start with Node/Python/generic command discovery plus explicit overrides; do not port all profile machinery immediately |
| Evidence-based status vocabulary | `MIGRATE` | All projections and CLI | Preserve PASS/FAIL/BLOCKED/NOT_PROVEN/NOT_RUN/PENDING distinctions |
| Sensitive information protocol | `MIGRATE_AND_STRENGTHEN` | Evidence/redaction | Use allowlisted schemas, adversarial corpus, path privacy, and truncation metadata |
| Archive manifest, checksums, replay, rendered summary | `MIGRATE_MINIMAL_FIRST` | Archive projection | First archive freezes exact Run facts and readable summary; advanced HTML/report work waits for value proof |
| Knowledge ingest, provenance, collision and promotion rules | `MIGRATE_LATER` | Knowledge module | Preserve provenance and fail-closed identity; start only after real archives exist |
| Recovery mirror and partial-state fail-closed | `MIGRATE` | Checkpoint/recovery | A crash or local state loss must not be treated as clean success |
| Skill distribution to Claude/Codex/Cursor | `DO_NOT_MIGRATE_AS_RUNTIME` | Core Extension resources | Extract useful prompts/rules, but Hunter Pi controls one Pi-based product and does not install Harness Skills at runtime |
| Server-governed registry, push/sync conflict workflow | `DO_NOT_MIGRATE_V1` | None | Hunter Pi keeps canonical workflow state local and is single-user; disclosed model-provider data egress is separate, while a hosted registry remains outside the first value slice |
| Web application and workflow dashboards | `DO_NOT_MIGRATE_V1` | CLI/TUI projections | No desktop/web product before terminal daily-use proof |
| Multi-Agent adapter projection matrix | `DO_NOT_MIGRATE_V1` | None | Pi is the only first engine; retain provider-neutral Host Interface without speculative adapters |
| Release artifact smoke and clean external install | `MIGRATE` | Release pipeline | Prevent workspace links/global packages from hiding broken distributions |
| Topic worktree/branch cleanup discipline | `MIGRATE` | Contributor/release workflow | Preserve unique work and clean merged/abandoned resources safely |

## Semantic translations

| Harness term | Hunter Pi term | Translation rule |
|---|---|---|
| Change directory | Managed Change state | New schema and storage; no `.harness` runtime dependency |
| Phase attempt | Attempt | Every retry/recovery remains append-only |
| Verification ledger item | Verification Receipt | Strengthen exact check/config/environment identity |
| Execution session | Managed operation/process session | Pi and verifier processes use the same containment principles |
| Skill result | Step/Verification result | Skill execution status is not a separate Hunter Pi domain |
| Archive | Archive | Preserve outcome and replayability; redesign physical layout |
| Knowledge entry | Knowledge candidate/entry | Preserve source and promotion distinction |
| Harness Installation | Not applicable in version one | Hunter Pi installation is a Distribution Release installation |

## Parity scenarios

The following scenarios must pass in Hunter Pi before claiming a mechanism migrated:

1. Agent returns success text while a required test fails; Change remains not ready.
2. Attempt 1 fails and Attempt 2 passes; both remain visible and hash-bound.
3. An identical check on an unchanged identity is reused with an explicit Receipt; a changed diff invalidates it.
4. A selected test is filtered or skipped; adequacy rejects “all required tests passed”.
5. A long command outlives the launching terminal process; status and logs can reconnect.
6. Cancellation leaves no verified matching child process and releases resource locks before terminal status.
7. A worktree has unique dirty work; cleanup preserves it and reports the blocker.
8. A checkpoint write is interrupted; replay chooses a complete prior/new state or fails closed.
9. A secret/path corpus passes through tool output; portable Evidence contains no raw match.
10. An Archive replay reproduces its projection and checksum without executing Pi.

These scenarios prove Hunter Pi behavior only. Old Harness results are source evidence, not transferred PASS status.

## Source reuse rules

- Prefer reimplementing against a Hunter Pi Interface and parity test over copying a large Harness script.
- Any copied implementation records repository, source commit, original path, license, and material changes.
- Preserve copyright and license notices.
- Do not copy `.harness` state, private archives, credentials, or generated project artifacts.
- Do not make Hunter Pi tests execute Hunter-Harness binaries.
- A genuinely reusable shared package is considered only after both repositories have independent real consumers; premature extraction would recreate the runtime binding this project rejects.
