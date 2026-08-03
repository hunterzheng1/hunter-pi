# Risk register

Likelihood and impact are initial qualitative estimates. A risk closes only with dated Evidence, not by deleting it from this table.

| ID | Risk | Likelihood | Impact | Detection / trigger | Mitigation and stop condition |
|---|---|---:|---:|---|---|
| HP-R01 | Pi public events or SDK cannot express a required workflow/recovery fact | Medium | High | Task 4 contract spike lacks a required observation or control | preserve minimal reproduction; try Extension/JSON/RPC/SDK alternatives; stop vertical slice; fork only through new ADR |
| HP-R02 | Upstream Pi breaking change invalidates Core Extension | High | High | typecheck, event-order, session, or package contract fails | exact pin; qualification pipeline; stable stays on prior engine; rollback |
| HP-R03 | Hunter Pi becomes a shallow wrapper and does not add daily value | Medium | High | ten-task pilot shows no meaningful reliability/time benefit over configured raw Pi | measure setup, recovery, failure detection, and user effort; stop scope expansion if value gate fails |
| HP-R04 | Workflow copied from Harness is too heavy for interactive use | Medium | High | users avoid Managed Change or abandon it before plan completion | preserve Quick Session; migrate mechanisms selectively; progressive disclosure; daily-use acceptance |
| HP-R05 | Reimplementation diverges from proven Harness invariants | Medium | High | parity scenarios produce different failure/history outcomes | disposition matrix; port schemas/tests where appropriate; contract examples; provenance links |
| HP-R06 | Plugin executes malicious or unexpected local code | High | Critical | install/load behavior, integrity mismatch, tool graph change, incident report | explicit source/version; warning; separate Compatibility/Trust/Isolation; Safe Mode; containment research; quarantine; no general safety claim |
| HP-R07 | Plugin overrides critical tools and falsifies Evidence | Medium | Critical | effective tool graph differs or Core Extension event coverage disappears | reserved IDs; post-load inventory; managed-mode blocking/downgrade; independent verifier |
| HP-R08 | Standard Pi package is source-compatible but behavior-incompatible | High | Medium | representative fixture loads but lifecycle/session tests fail | exact compatibility receipt; platform/config tuple; never claim ecosystem-wide support |
| HP-R09 | OMP feature ports import hidden architecture or native complexity | Medium | High | port requires OMP-private types, Bun/Rust stack, or duplicated task semantics | solve user problem first; isolate module; license/provenance review; reject broad copy |
| HP-R10 | Windows process tree or path behavior loses source data | Medium | Critical | timeout leaves child; junction cleanup escapes target; Unicode/space fixture fails | native containment; exact target resolution; adversarial fixtures; fail closed; no preview promotion |
| HP-R11 | Git worktree cleanup deletes unique work | Low | Critical | dirty/unpushed/unmerged commit or open PR detected | preserve worktree; require explicit disposition; cleanup receipt; branch hygiene checks |
| HP-R12 | Crash produces partial or contradictory workflow state | Medium | High | fault injection cannot replay to one valid projection | append-only log; atomic writes; checksums; checkpoint replay; recovery stop |
| HP-R13 | Unknown external operation is repeated and causes duplicate effect | Medium | High | interruption between effect and receipt | idempotency key/fingerprint; effect reconciliation; human gate when unknown |
| HP-R14 | Credentials or private prompt leak into logs/Evidence | Medium | Critical | adversarial redaction corpus match | allowlisted schemas; bounded capture; redaction version; block release on any raw match |
| HP-R15 | A permission profile is mistaken for plugin containment | High | High | UI/report implies plugin code is sandboxed or omits process authority | state mediation boundary; activating code grants process authority; separate Compatibility/Trust/Isolation; Core-only or verified containment for containment claims |
| HP-R16 | Installer or updater becomes a supply-chain vector | Medium | Critical | artifact digest/provenance mismatch or unsigned replacement | exact artifacts; checksums/signing decision; clean install smoke; atomic update; rollback |
| HP-R17 | Automatic update corrupts state or breaks plugins | Medium | High | migration/compatibility/rollback suite fails | staged channels; backup/journal; stable promotion block; keep known-good release |
| HP-R18 | Provider authentication flow changes | Medium | Medium | Doctor/login smoke blocked on fixed engine | delegate to qualified Pi; no credential copying; actionable blocked status; engine update evaluation |
| HP-R19 | Model or provider-specific fields leak into domain | Medium | High | public schema or Kernel test references provider-private names | provider-neutral review gate; adapter-only external refs; compile Kernel without Pi |
| HP-R20 | Verification is incomplete but shown as PASS | Medium | Critical | required scenario/command missing, skipped, filtered, or truncated | exact check manifest; selected/executed/passed accounting; `NOT_RUN`/`NOT_PROVEN`; adequacy validator |
| HP-R21 | Resource-intensive verification harms daily usability | Medium | Medium | CPU/memory/elapsed budgets exceeded | DAG/resource locks; focused-first checks; bounded workers; user-visible budgets; no false reuse |
| HP-R22 | Project configuration and runtime state are mixed in Git | Medium | High | credential/session/cache appears in status or archive | separate paths; `.gitignore`; secret scan; portable-data schema tests |
| HP-R23 | New repository duplicates Hunter Platform/Harness indefinitely | Medium | Medium | identical mechanisms fixed independently or ownership unclear | explicit mechanism disposition; Hunter Pi owns personal-Agent semantics; no runtime dependency; revisit shared specs only after two real consumers |
| HP-R24 | License/attribution is lost when porting Pi/OMP code | Medium | High | copied implementation has no source commit/notice | provenance manifest, file-level notice where needed, license inventory, release gate |
| HP-R25 | Scope expands to desktop/team/cloud before CLI value is proven | High | High | new UI/server work before vertical slice acceptance | plan non-goals; owner decision required; stop after bounded daily-use gate |
| HP-R26 | “Local-first” hides model-provider data egress or retention | Medium | Critical | request is sent before disclosure, destination differs, or Evidence contains raw payload/credential | first-send consent; endpoint/data-category display; fake recording endpoint; network/telemetry controls; provider-policy disclaimer; block on mismatch |

## Highest-priority gates

The first implementation stops rather than expands if any of these remain unresolved after the bounded spike/task that owns them:

1. Pi cannot provide the observations and controls required for one real Managed Change.
2. Core Extension cannot remain distinguishable from user plugin overrides.
3. Windows process/worktree isolation cannot cleanly contain and recover a real attempt.
4. Independent Verification cannot bind exact source and configuration identity.
5. Evidence cannot exclude credentials and private paths.
6. The daily-use value pilot shows no practical benefit over a curated raw Pi setup.
