# Task 10 — Standard Pi Package manager

- Scope branch: `codex/daily-use`
- Baseline: Task 8 merged main, provider-neutral fixtures only
- Boundary: metadata resolution is injected; this task does not execute arbitrary third-party code

## RED → GREEN targets

- Reject non-strict manifests and private/credential-bearing source references.
- Bind the exact LOCAL, NPM, GIT, or PI source to the resolved manifest and package fingerprint.
- Keep Compatibility, Trust, and Isolation as separate receipts.
- Detect reserved and duplicate tool/hook resources before activation.
- Start in Safe Mode for quarantined packages, journal corruption, or resource collisions.
- Make disable, remove, Pi import, and operation replay append-only and identity-bound.

## Acceptance commands

```powershell
npx vitest run test/task10-plugin-manager.test.ts --reporter=verbose
npm run lint
npm run typecheck
npm run package-smoke
npm run clean-install-smoke
```

## Non-goals

- No general third-party compatibility claim.
- No OS sandbox claim for `PROCESS_AUTHORITY` or permission profiles.
- No execution of an unqualified plugin during install, inventory, startup, or Safe Mode.
