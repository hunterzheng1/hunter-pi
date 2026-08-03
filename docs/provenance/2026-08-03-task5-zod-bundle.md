---
status: accepted
reviewed_at: 2026-08-03
reviewer: codex
upstream_project: Zod
upstream_repository: https://github.com/colinhacks/zod
upstream_revision: npm package 4.4.3 / sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==
upstream_path: npm package zod@4.4.3
license: MIT / apps/cli/third-party/zod-LICENSE
hunter_paths:
  - apps/cli/dist/hpi.js (generated, ignored)
  - apps/cli/third-party/zod-LICENSE
  - apps/cli/THIRD_PARTY_NOTICES.md
release_scope: 0.1.0-dev.0 developer preview
---

Hunter Pi uses Zod runtime parsing in the product shell and internal contracts. Task 5's esbuild step bundles the exact locked Zod 4.4.3 implementation into the generated `hpi.js`; no Zod source is manually modified in the repository.

The upstream MIT license is compatible with Hunter Pi's MIT license. The developer-preview tarball carries the upstream copyright and full license text. This record establishes source and license provenance only; it does not claim security or correctness beyond the repository's tests.
