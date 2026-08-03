---
status: accepted
date: 2026-08-03
---

# Qualify upstream updates before promotion

Hunter Pi will bind every Distribution Release to an exact Pi Engine Release and promote an upstream update only after local contracts, real-host fixtures, Windows/Ubuntu CI, representative plugin checks, packaging, migration, and rollback pass. Users update Hunter Pi as one product; the embedded Pi may not independently drift to upstream `latest` because upstream releases can contain extension breaking changes.

## Consequences

- Updates can feel routine to users while remaining evidence-driven internally.
- Stable may intentionally lag upstream Pi.
- Compatibility claims are exact to release/platform/plugin/configuration tuples.
- Failed candidates and CI attempts remain recorded; they are not rewritten when a later candidate passes.
