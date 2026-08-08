# Task 11 — Qualified updates, portable packaging, and rollback

- Scope: a Windows x64 portable distribution with a pinned Node 24 runtime and the exact CLI dependency tree.
- Update boundary: Hunter Pi owns the active release pointer, staging, health check, migration journal, rollback, and crash reconciliation. Pi's independent self-update path remains disabled for managed launches.
- Signing/publisher: not selected. Every artifact produced by this task is explicitly unsigned and `developer-preview`; no Stable promotion is implied.

## Implemented contract

- The portable bundle is a strict, deterministic `tar.gz` payload with a versioned manifest, exact file lengths and SHA-256 fingerprints, safe relative paths, no symlinks, and bounded extraction.
- The Windows adapter installs side-by-side under `versions/<release-id>/`, publishes an atomic `.hpi-update/active.json` pointer, and keeps activation intent, migration, and append-only history available for recovery.
- `UpdateManager.check` is read-only and verifies the candidate schema, channel/qualification policy, artifact length, artifact digest, engine identity, and Pi self-update policy before activation.
- `apply`, `rollback`, and `reconcile` use staged verification, a bounded health probe, durable migration markers, post-activation identity verification, and fail-closed recovery. Failed history is retained; it is never rewritten as success.
- The supported portable entry point is the root `hpi.cmd`/launcher. It selects the active version and exposes `hpi update status|check|apply|rollback --json` without echoing local paths or sensitive input.
- The builder refuses a dirty source tree, emits source/runtime/engine/license/provenance identities, and runs an isolated launcher/version/update-status probe before accepting the output directory.

## Acceptance commands

Run these on a clean Windows x64 checkout with Node 24:

```powershell
npx vitest run test/task11-updater.test.ts test/task11-portable-adapter.test.ts --reporter=verbose
npm run test:ci
npm run lint
npm run typecheck
npm run strict:check
npm run build
npm run format:check
npm run package-smoke
npm run clean-install-smoke
npm run pack:windows-portable
```

The GitHub Actions quality job reuses its existing locked install and build, then runs the compiled Windows packer only on Windows and uploads the exact directory as a 14-day artifact. The portable status path uses a lightweight active-pointer/artifact check when no recovery transaction is pending; activation, health, and rollback retain full bundle/tree verification. Ubuntu remains a required quality and Evidence platform; it does not claim to produce a Windows artifact.

## Evidence boundary

Local tests prove the provider-neutral updater contracts and the Windows adapter's deterministic fixture behavior. A clean local pack proves the artifact can start and report its active release, but it remains an unsigned developer preview. The exact source commit must still pass Windows and Ubuntu hosted CI, and the resulting artifact must be retained with its source and digest before any qualification claim.

## Stop conditions

- Do not publish npm artifacts, an installer, signing metadata, or a Stable update channel without a separately authorized release gate.
- Do not call a dirty checkout, an unsigned artifact, or a local-only result a qualified release.
- Do not infer real-user repository safety, provider reliability/recovery, third-party plugin compatibility, or daily-use acceptance from updater tests or CI alone; those remain Task 12 evidence gates.
- Remote Windows/Ubuntu CI for the exact release source remains mandatory and is not inferred from local tests.
