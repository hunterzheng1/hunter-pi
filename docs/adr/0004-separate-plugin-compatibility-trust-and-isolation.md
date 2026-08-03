---
status: accepted
date: 2026-08-03
---

# Separate plugin compatibility, trust, and isolation

Pi extensions execute code in the Agent process, while Hunter permission profiles can mediate only Hunter-owned tools and Pi calls that the Core Extension observes. Hunter Pi will therefore never present a permission profile or compatibility test as an operating-system sandbox. Every executable Plugin is evaluated along three independent dimensions: Compatibility (`VERIFIED`, `UNVERIFIED`, `INCOMPATIBLE`), Trust (`BUNDLED`, `USER_APPROVED`, `QUARANTINED`), and Isolation (`CONTAINED`, `PROCESS_AUTHORITY`, `NOT_PROVEN`).

## Consequences

- Activating an ordinary Plugin explicitly grants it the Agent process's effective filesystem, process, network, and credential-access authority.
- Compatibility `VERIFIED` proves only the exact behavior contract; it cannot imply code safety, provenance trust, or containment.
- Managed policy may block or downgrade a Run with `PROCESS_AUTHORITY` or `NOT_PROVEN` Plugins. A verified containment claim requires Core-only execution or an independently proven isolation adapter.
- Safe Mode starts without evaluating user Plugin code.
- A future sandbox/container is an adapter with its own receipts, not a relabeling of a permission profile.
