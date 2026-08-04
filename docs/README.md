# Hunter Pi documentation

This directory is the canonical product and delivery baseline for Hunter Pi.

## Status

- Baseline date: 2026-08-04
- Product status: **TASK_6_PR_CI_PASS / MERGE_PENDING / TASK_7_NOT_STARTED**
- Current implementation: Tasks 1–5 are merged through the bounded interactive developer-preview milestone; Task 6 branch adds the disposable-fixture Managed Change runner, independent command verifier, deterministic review, provider-neutral Pi Host, strict Evidence, and the post-review cumulative resource-accounting correction
- Next gate: merge PR #15 only after the documentation closeout HEAD passes the same gates, then verify the exact main merge; real repositories remain prohibited meanwhile
- Active plan: [Foundation to daily use](plans/2026-08-03-foundation-to-daily-use.md)
- Task 1 remote CI: **PASS** — exact merge commit `cf0a4fb817f5052ca7683338510dd78f71938ccb` passed [Windows and Ubuntu CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30795095555)
- Task 2 remote CI: **PASS** — exact implementation commit `71542e91d5f92cb62cc6002cf64456fe3d7d8248` passed [Windows and Ubuntu PR CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30807281376), and exact merge commit `fb162bf2126b356750dd327cef7b8e2fb26cde09` passed [Windows and Ubuntu main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30807557882)
- Task 3 remote CI: **PASS** — exact implementation `1c90395a2fd1d2df8f8b69270e28fd8a7da2d1f2` passed [Windows and Ubuntu PR CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30818956056), and merge `62b46cbc179bb8bb3c7a3195f4924d5b0c6c9524` passed [Windows and Ubuntu main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30819181475). The superseded `e1b06c523084a34c8b32a852848c906fa9877236` run remains recorded as [Ubuntu PASS / Windows FAIL](https://github.com/hunterzheng1/hunter-pi/actions/runs/30818314313).
- Task 4 remote CI: **PASS within recorded provider-independent bounds** — exact implementation `8efe194a1c5f6256e68f1e8c20d0e59848376f2b` passed [Windows, Ubuntu, and aggregate identity PR CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30831361499), and merge `00f0d0d7d702779706e2a5aefac3d67ed0a49699` passed the same [main CI gates](https://github.com/hunterzheng1/hunter-pi/actions/runs/30832264845)
- Task 4 local Windows Evidence: **SUPPORTED within recorded bounds** — fixed Pi artifact Extension/JSON/RPC/SDK probe
- Task 5 local automated gates: **PASS** — single tarball local/global isolated install, fixed Pi resolution/shrinkwrap, product-shell/Core tamper rejection, Doctor privacy/current-origin freshness, raw Pi coexistence sentinel, recording fake-endpoint disclosure/cancellation, Safe Mode planning, Quick Session process observation, and dual-SHA-bound manual-smoke acknowledgement semantics
- Task 5 remote Windows/Ubuntu CI: **PASS** — implementation `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` passed [PR CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30852408933), product merge `8573b1f62d154275bb81c3c07b432a3db40632bb` passed [main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30853360439), and code-bearing merge `160080eddde80d98ada58c8c78f3ccbe6754cc1a` passed [Windows, Ubuntu, and aggregate Evidence gates](https://github.com/hunterzheng1/hunter-pi/actions/runs/30858230199). The smoke-clarity implementation `2a357795a2ae61c9db935ff11a922bbfe05ec892` passed [PR CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30870673783), and exact installed code-bearing merge `0e58f539b713edb35f46fcbb55a63063dbbfa328` passed [main CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30871449955). The intervening Windows timeout remains recorded as a real cancelled run rather than being overwritten.
- Task 5 real Windows TUI smoke: **DETECTED within the recorded manual-smoke bounds** — on 2026-08-04 the exact installed artifact rendered Pi, the bundled Core, the Hunter header, and the explicit `/hunter-status` receipt marker, then returned cleanly to PowerShell and received the owner's affirmative acknowledgement
- Task 6 local Managed Change: **GO within the exact disposable-fixture bounds** — after the first run's resource-accounting gap was preserved and corrected, one separately authorized request from clean source `e36ee52764065cea02982962e2f84ff9ed3d0034` changed only `result.txt`; Agent return remained an Observation, the deliberate first failure remained visible, the second independent check, deterministic review, cumulative 90506 / 262144-byte resource accounting, and cleanup all passed. The committed Evidence SHA-256 is `573800451fc04de3aa251b75be19e7d28b010cb27aae7abd1443ec3428527092`
- Task 6 remote PR CI: **PASS for product/Evidence commit `502011b8a34e9773e415643b01a838c04d5582c5`** — run `30884876277` passed Ubuntu in 2m42s, Windows in 15m13s, and the Windows/Ubuntu Pi/Hunter identity comparator in 33s. The Evidence envelope itself retains `remoteCi=PENDING` because that was true when the local real-run artifact was emitted; later CI disposition is append-only documentation, not a rewrite of the envelope.
- Real interactive Pi TUI: **DETECTED within startup, Core loading, command-display, and clean-exit acknowledgement bounds**
- Real Provider: **DETECTED for the exact Task 6 disposable-fixture request; broader reliability, recovery, real-repository safety, and production readiness remain NOT_PROVEN**
- Third-party plugin compatibility: **NOT_PROVEN**
- Windows installer and signing: **NOT_PROVEN**

## Product and architecture

| Document | Purpose |
|---|---|
| [01 — Product vision](01-product-vision.md) | Product identity, audience, value, scope, and success definition |
| [02 — User experience](02-user-experience.md) | Installation, first run, interaction modes, commands, and daily journeys |
| [03 — System architecture](03-system-architecture.md) | Modules, dependency direction, Pi seam, storage, and deployment topology |
| [04 — Workflow semantics](04-workflow-semantics.md) | Managed Change lifecycle, Run/Attempt behavior, verification, loops, and recovery |
| [05 — Upstream and plugin compatibility](05-upstream-and-plugin-compatibility.md) | Pi qualification, plugin Compatibility/Trust/Isolation, and fork threshold |
| [06 — Security and trust](06-security-and-trust.md) | Threat model, permissions, credentials, plugin risk, evidence redaction, and updates |
| [07 — User stories and acceptance](07-user-stories-and-acceptance.md) | Personas, concrete stories, negative cases, and acceptance criteria |
| [08 — Non-functional requirements](08-non-functional-requirements.md) | Reliability, performance, portability, privacy, recoverability, and operability |
| [09 — Release and update strategy](09-release-and-update-strategy.md) | Versioning, stable/preview channels, rollback, packaging, and support |
| [10 — Risk register](10-risk-register.md) | Product, upstream, plugin, security, and maintenance risks |
| [11 — Decision summary](11-decision-summary.md) | Compact list of approved baseline decisions and open owner choices |
| [12 — Requirements traceability](12-requirements-traceability.md) | User-story and NFR ownership across delivery tasks and evidence gates |

## Migration, research, and planning

- [Hunter-Harness mechanism disposition](migration/2026-08-03-hunter-harness-mechanism-disposition.md)
- [Pi and Oh My Pi upstream baseline](research/2026-08-03-pi-and-omp-upstream-baseline.md)
- [Pi public-interface recheck](research/2026-08-03-pi-public-interface-recheck.md)
- [Task 4 Pi public-interface validation](validation/2026-08-03-task4-pi-public-interface.md)
- [Task 5 hpi product-shell validation](validation/2026-08-03-task5-hpi-product-shell.md)
- [Testing strategy](testing-strategy.md)
- [Plan index](plans/README.md)
- [Foundation-to-daily-use execution plan](plans/2026-08-03-foundation-to-daily-use.md)

## Architecture decisions

- [ADR-0001 — Build a downstream distribution on public Pi interfaces](adr/0001-build-a-downstream-distribution-on-pi.md)
- [ADR-0002 — Own an independent workflow kernel](adr/0002-own-an-independent-workflow-kernel.md)
- [ADR-0003 — Qualify upstream updates before promotion](adr/0003-qualify-upstream-updates-before-promotion.md)
- [ADR-0004 — Separate plugin compatibility, trust, and isolation](adr/0004-separate-plugin-compatibility-trust-and-isolation.md)
- [ADR-0005 — Bind one Plan Revision per Run](adr/0005-bind-one-plan-revision-per-run.md)
- [ADR-0006 — License original work under MIT](adr/0006-license-original-work-under-mit.md)

## Status language

- **DESIGNED**: documented target behavior; no implementation claim.
- **IMPLEMENTED**: code exists and passed its local automated tests.
- **VERIFIED**: a dated receipt proves the exact artifact and environment performed the behavior.
- **NOT_PROVEN**: plausible or officially documented, but not reproduced by Hunter Pi.
- **BLOCKED**: attempted with evidence and prevented by a named external or technical condition.
- **INCOMPATIBLE**: a fixed-version contract test reproduced a mismatch.
- **PENDING**: scheduled or configured but not yet run.

Official documentation, installation, login, process exit, model text, old Harness evidence, and Fake tests are never treated as Hunter Pi production verification.
