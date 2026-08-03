# Hunter Pi documentation

This directory is the canonical product and delivery baseline for Hunter Pi.

## Status

- Baseline date: 2026-08-03
- Product status: **DESIGNED / TASK_1_IN_PROGRESS**
- Active implementation: Task 1 engineering skeleton; no usable product yet
- Active plan: [Foundation to daily use](plans/2026-08-03-foundation-to-daily-use.md)
- Remote CI: **NOT_CONFIGURED**
- Real Pi integration: **NOT_PROVEN**
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
