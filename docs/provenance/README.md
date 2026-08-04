# Provenance records

This directory holds source-level provenance records for externally derived code or assets incorporated into Hunter Pi. Dependency lockfiles and generated license reports remain necessary but do not replace these records.

## Entry format

Create one dated Markdown file per independently reviewed source unit:

```yaml
---
status: accepted | blocked | removed
reviewed_at: YYYY-MM-DD
reviewer: <stable non-secret reference>
upstream_project: <name>
upstream_repository: <canonical URL>
upstream_revision: <immutable commit/tag/package version>
upstream_path: <path or package>
license: <SPDX identifier or exact file reference>
hunter_paths:
  - <repository-relative path>
release_scope: <first consuming release or NOT_SHIPPED>
---
```

The body explains what was copied or adapted, material modifications, retained notices, dependency/runtime implications, and the license-compatibility conclusion. `accepted` means the provenance review passed; it does not prove runtime compatibility or security.

## Current state

Task 5 bundles the exact Zod dependency into the generated CLI artifact; its accepted dependency provenance is recorded in [2026-08-03-task5-zod-bundle.md](2026-08-03-task5-zod-bundle.md). Task 7's independently written Windows Job Object adapter records the exact external sequencing reference in [2026-08-04-task7-windows-job-object-reference.md](2026-08-04-task7-windows-job-object-reference.md). Other upstream projects used only for research are listed in the root [`NOTICE.md`](../../NOTICE.md).
