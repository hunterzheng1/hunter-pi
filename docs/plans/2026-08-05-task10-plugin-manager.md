# Task 10 — Standard Pi Package manager

- Scope branch: `codex/task10-reference-privacy`
- Baseline: Task 8 merged main, provider-neutral fixtures only
- Boundary: package metadata is resolved through the fixed public Pi Package interface; this task
  never evaluates arbitrary third-party extension code during install, qualification, inventory,
  startup, or Safe Mode

## RED → GREEN targets

- Reject non-strict manifests and private/credential-bearing source references.
- Bind each observed LOCAL, NPM, GIT, or PI source to the resolved manifest and package fingerprint,
  without treating adapter-only NPM/Git tests as real public-manager installation Evidence.
- Keep Compatibility, Trust, and Isolation as separate receipts.
- Detect reserved and duplicate tool/hook resources before activation.
- Start in Safe Mode for quarantined packages, journal corruption, or resource collisions.
- Make disable, remove, Pi import, and operation replay append-only and identity-bound.
- Keep portable Manifest/qualification Evidence path-free while storing the exact runtime path
  binding only in device-local state.
- Activate qualified skill/prompt/theme resources only after exact package and resource
  revalidation; automatically fall back to Safe Mode if that revalidation fails.
- Copy qualified content into a Hunter-owned, content-addressed, read-only snapshot so later source
  changes cannot alter what Pi loads. Same-authority concurrent attackers remain outside the OS
  containment claim.
- Bound remote installation by elapsed time, captured output, entry count, total staged bytes, and a
  free-space floor; kill the isolated installer process and remove its generation on failure.
- Resolve two locked external Pi package examples through the real public PackageManager on both
  Windows and Ubuntu.

## Acceptance commands

```powershell
npx vitest run test/task10-plugin-manager.test.ts --reporter=verbose
npx vitest run test/task10-pi-package-adapter.test.ts test/task10-plugin-activation.test.ts
npx vitest run test/task10-platform-evidence.test.ts
npm run lint
npm run typecheck
npm run package-smoke
npm run clean-install-smoke
npm run probe:task10 -- --output .artifacts/task10-platform/Windows.json
```

## Non-goals

- No general third-party compatibility claim.
- No OS sandbox claim for `PROCESS_AUTHORITY` or permission profiles.
- No execution of an unqualified plugin during install, inventory, startup, or Safe Mode.

## Implemented exact boundary

- `hpi plugin install local|npm|git`, `import-pi`, `list`, `doctor`, `disable`, and `remove` are
  wired to the Hunter-owned append-only registry. Lifecycle mutations are serialized under one
  durable cross-process transaction so failed-install cleanup cannot race another install/remove.
- NPM and Git staging uses Pi `DefaultPackageManager` from the locked
  `@earendil-works/pi-coding-agent@0.83.0` release. The configured npm command disables lifecycle
  scripts, development dependencies, audit, and funding traffic. NPM uses an exact registry SRI;
  Git uses an exact 40-character commit plus package-tree fingerprint. Installation runs in a
  sanitized child process with finite time/output/tree/free-space budgets; a failed generation is
  removed instead of becoming a reusable cache. Global npm/Git credential configuration and
  credential-bearing proxy URLs do not cross the child boundary. The installed single-artifact CLI
  routes this worker through its integrity-stamped product shell, and package smoke checks that
  silent internal entrypoint.
- Portable v2 Manifests carry normalized relative resources and content fingerprints. Absolute
  paths point only at a Hunter-owned, content-addressed snapshot in a separate local binding store
  and never enter CLI output or portable qualification Evidence. Source files and snapshot files
  with aliases, symbolic links, or multiple hard links fail closed.
- Packages with no executable extension surface can receive metadata Compatibility `VERIFIED` and
  activate exact skill/prompt/theme resources. Packages containing executable extensions remain
  `UNVERIFIED` and quarantined in the standard path; no general extension verifier is claimed.
- Reserved Hunter tools and Pi built-ins, duplicate tool/hook declarations, quarantined records,
  corrupt journals, missing bindings, and post-qualification changes all fail closed. Startup uses
  Safe Mode without evaluating package code.
- Every Pi launch disables ambient extension, skill, prompt-template, theme, and context-file
  discovery. An enabled v2 record is accepted only when its Compatibility Receipt and exact physical
  qualification receipt still bind the current distribution, Engine, platform, configuration, and
  verifier tuple. Historical v1 records stay replay-compatible but CLI list/doctor output presents
  only fixed redacted summaries.
- Remove appends the registry removal, deletes only the exactly validated Hunter-owned snapshot and
  runtime binding, and retains append-only journal/qualification history. A filename/payload mismatch
  or current snapshot drift blocks deletion. LOCAL and explicitly selected PI source directories are
  never deleted.
- Package-tree qualification excludes `.git` and `node_modules`. This is sufficient for the
  resource-only activation path proved here; executable extensions and their dependency closure
  remain unqualified.

## Evidence status

The exact three-file Task 10 contract matrix contains 18 tests. The platform probe additionally
checks two external packages, five frozen malicious fixtures, no pre-activation evaluation,
resource activation/tamper rejection, append-only lifecycle replay, privacy, and explicit
non-claims. It records real public-manager LOCAL/PI observations separately from NPM/Git adapter
contracts; real public Git installation and a lifecycle-attack package remain `NOT_RUN`. A bounded
real public npm install passed on the current Windows development machine, but is not promoted to
clean-commit platform Evidence. During the 2026-08-08 post-hardening rerun, one attempt first failed
because a transient Node compile-cache entry disappeared between directory enumeration and metadata
inspection. That failure is retained here; a deterministic regression now permits only nested
`ENOENT` churn while root loss and other filesystem errors still fail closed, and the same exact npm
resolver observation then passed. Windows/Ubuntu hosted receipts and their exact-identity comparator
remain `PENDING` until CI actually runs. The optional installed-artifact smoke also completed the
same exact public npm install on Windows, confirmed `UNKNOWN_NOT_EXECUTED` quarantine, removed the
validated managed snapshot/binding, and retained journal history. That networked local observation
is deliberately not run or promoted as hosted platform Evidence.
