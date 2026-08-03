---
status: accepted
date: 2026-08-03
---

# Own an independent workflow kernel

Hunter Pi will reimplement selected Hunter-Harness mechanisms in its own provider-neutral Workflow Kernel rather than invoking Hunter-Harness or sharing its runtime state. This preserves Hunter Pi as a standalone daily Agent, allows Quick Session and Managed Change semantics tailored to one product, and prevents Pi sessions or Harness installations from becoming canonical Change/Run/Attempt identities.

## Consequences

- Hunter Pi owns immutable Plan Revisions, append-only Attempts, Verification, Evidence, budgets, Checkpoints, and workflow projections.
- Hunter-Harness remains an engineering source and parity reference, not a build, install, server, or runtime dependency.
- Initial development costs more than a command wrapper, but workflow behavior remains testable without Pi and replaceable behind the Engine Host seam.
- A future shared package is considered only after independent real consumers prove that sharing reduces rather than creates coupling.
