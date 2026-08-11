# Task 11 — Qualified updates, portable packaging, and rollback

- Scope: a Windows x64 portable distribution with a pinned Node 24 runtime and the exact CLI dependency tree.
- Update boundary: Hunter Pi owns the active release pointer, staging, health check, migration journal, rollback, and crash reconciliation. Pi's independent self-update path remains disabled for managed launches.
- Signing/publisher: not selected. Every artifact produced by this task is explicitly unsigned and `developer-preview`; no Stable promotion is implied.

## Implemented contract

- The portable bundle is a strict, deterministic `tar.gz` payload with a versioned manifest, exact file lengths and SHA-256 fingerprints, safe relative paths, no symlinks, and bounded extraction.
- The Windows adapter installs side-by-side under `versions/<release-id>/`, publishes an atomic `.hpi-update/active.json` pointer, and keeps activation intent, migration, and append-only history available for recovery.
- `UpdateManager.check` is read-only and verifies the candidate schema, channel/qualification policy, artifact length, artifact digest, engine identity, and Pi self-update policy before activation.
- `apply`, `rollback`, `qualify`, and `reconcile` use staged verification, bounded external operations, durable activation/qualification/migration markers, post-mutation identity verification, and fail-closed recovery. Failed history is retained; it is never rewritten as success.
- A CI-qualified portable directory has an explicit metadata-only `QUALIFY` operation. The operator supplies only the installation root and exact main CI run ID. The built-in authority generates `PASS` after one live run query and one hosted artifact download prove the exact repository, main push, source commit, six successful job identities, bundle bytes, and non-qualification candidate identity. Both calls share one elapsed timeout budget. The operation atomically retains immutable Evidence, keeps its intent through Receipt acknowledgement, and preserves both artifact copies unchanged.
- Rollback may recover an installed candidate absent from historical `APPLY` candidates only when an append-only `APPLY` receipt independently proves it was the previous active release. Merely staging a qualified version never makes it rollback-eligible.
- That fallback also requires the latest exact `QUALIFY/APPLIED` candidate entry that precedes the prior-active APPLY proof; the installed candidate must match it completely, so reuse of the same release ID cannot substitute another qualification identity.
- Journaled rollback targets are not trusted by history alone: when the adapter exposes installed-candidate verification, the manager re-reads the installed candidate, requires an exact journal identity match, and revalidates retained qualification Evidence before restore.
- The supported portable entry point is the root `hpi.cmd`/launcher. It selects the active version and exposes `hpi update status|check|apply|rollback --json` without echoing local paths or sensitive input.
- The builder refuses a dirty source tree, emits source/runtime/engine/license/provenance identities, and runs an isolated launcher/version/update-status probe before accepting the output directory.

## Acceptance commands

Run these on a clean Windows x64 checkout with Node 24:

```powershell
npx vitest run test/task11-updater.test.ts test/task11-portable-adapter.test.ts test/task11-github-actions-qualification.test.ts test/task11-promotion-script.test.ts --reporter=verbose
npm run test:ci
npm run lint
npm run typecheck
npm run strict:check
npm run build
npm run format:check
npm run package-smoke
npm run clean-install-smoke
npm run pack:windows-portable
# After the exact hosted main CI run has completed successfully:
npm run promote:windows-portable:compiled -- --root <portable-directory> --run <main-ci-run-id>
```

The GitHub Actions quality job reuses its existing locked install and build, then runs the compiled Windows packer only on Windows and uploads the exact directory as a 14-day artifact. Qualification requires that named artifact before its retention expires. The operator command never polls, never downloads logs, and exact-operation replay or an already-qualified same-source invocation is served from local hash-chained state. The portable status path uses a lightweight active-pointer/artifact check when no recovery transaction is pending; activation, qualification reconciliation, health, and rollback retain full bundle/tree and qualification-Evidence verification. Ubuntu remains a required quality and Evidence platform; it does not claim to produce a Windows artifact.

## Evidence boundary

Local tests prove the provider-neutral updater contracts and the Windows adapter's deterministic fixture behavior. A clean local pack proves the artifact can start and report its active release, but it remains an unsigned developer preview. The exact source commit passed Windows and Ubuntu hosted CI in PR run [`31270421168`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31270421168) and exact merged-head main run [`31272146162`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31272146162), with the portable artifact and Evidence jobs successful. This closes Task 11 hosted Evidence within the declared unsigned developer-preview boundary.

## Stop conditions

- Do not publish npm artifacts, an installer, signing metadata, or a Stable update channel without a separately authorized release gate.
- Do not call a dirty checkout, an unsigned artifact, or a local-only result a qualified release.
- Do not infer real-user repository safety, provider reliability/recovery, third-party plugin compatibility, or daily-use acceptance from updater tests or CI alone; those remain Task 12 evidence gates.
- Remote Windows/Ubuntu CI for the exact release source is now satisfied by the recorded PR and merged-head runs; future release candidates still require their own exact source Evidence.
