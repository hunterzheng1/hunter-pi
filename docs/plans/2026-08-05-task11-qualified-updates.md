# Task 11 — Qualified updates, portable packaging, and rollback

- Scope branch: `codex/daily-use`
- Baseline: Task 8 merged main plus Task 9/10 local implementation
- Selected package shape: Windows x64 portable directory containing a pinned Node 24 runtime and the exact CLI dependency tree
- Signing/publisher: unresolved; every local portable artifact remains explicitly unsigned and developer-preview

## RED → GREEN targets

- A release candidate is created only from the exact declared qualification checks.
- Stable rejects preview, non-PASS, digest-mismatched, or Pi-self-updating candidates.
- Apply stages, health-checks, atomically activates, records failure, and preserves the previous release.
- Rollback restores a known qualified candidate and records the result.
- Artifact, Engine, license, source, and runtime identities are visible in a portable manifest.
- Clean external install and package import do not depend on workspace links or ambient Hunter-Harness/Pi installs.

## Acceptance commands

```powershell
npx vitest run test/task11-updater.test.ts --reporter=verbose
npm run build
npm run package-smoke
npm run clean-install-smoke
npm run pack:windows-portable
```

## Stop conditions

- Do not publish npm artifacts or an installer without a separately authorized release gate.
- Do not call a dirty local portable directory a qualified release.
- Remote Windows/Ubuntu CI for the exact release source remains mandatory and is not inferred from local tests.
