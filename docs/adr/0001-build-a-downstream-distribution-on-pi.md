---
status: accepted
date: 2026-08-03
---

# Build a downstream distribution on public Pi interfaces

Hunter Pi will be an independently branded and installed downstream distribution built first on an exact official Pi release through its public Extension, Pi Package, JSON, RPC, and SDK interfaces. Directly Forking Pi would increase upstream merge cost before a missing interface is proven; Forking Oh My Pi would also inherit its larger task, tool, native-runtime, and compatibility systems. A source patch or fork therefore requires a reproduced blocker and a new accepted ADR.

## Consequences

- Hunter Pi can preserve the most direct standard Pi package compatibility path and qualify upstream releases by changing a pinned dependency rather than merging a full codebase.
- The Pi Host adapter and qualification suite become mandatory product modules.
- Some deep customization may remain unavailable until public interfaces improve; the product must report that honestly rather than silently reach into Pi private state.
- Oh My Pi remains a source of individually reviewed ideas or code with license/provenance, not a base dependency.
