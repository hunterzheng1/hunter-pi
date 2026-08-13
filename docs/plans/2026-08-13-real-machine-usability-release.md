# 2026-08-13 — Real-machine usability release

## Outcome

Prepare Hunter Pi `0.1.0-dev.2` to address the seven confirmed findings in `docs/13-real-machine-test-findings.md` without weakening update qualification, Provider-request scoping, credential handling, plugin authority boundaries, or the unsigned developer-preview label.

## In scope

- one-copy, exact-version Windows installation instructions and actionable TLS diagnostics;
- readable default output for `version`, `doctor`, and `update status`, with stable JSON retained for automation;
- default first-run configuration, a non-blocking privacy notice, direct Provider login, `hpi config`, and `hpi privacy`;
- `hpi update` official-channel discovery, bounded download, strict candidate validation, existing transactional apply, and rollback preservation;
- standalone candidate, bundle, and qualification Evidence assets from one promoted Windows release snapshot;
- product, security, acceptance, release, user-guide, and findings documentation updated in the same change.

## Non-goals

- no Stable, signed installer, WinGet, non-Windows installer, or broad plugin-compatibility claim;
- no real Provider request or real-user-repository mutation;
- no silent cross-channel update, downgrade, certificate bypass, qualification bypass, or automatic authorization of Managed Change/Pilot requests;
- no claim that the original feedback machine has passed until the owner reruns the published release there.

## Implementation order

1. Preserve a clean baseline and add failing CLI/update/installer contract tests.
2. Implement human output and first-run/config/privacy behavior.
3. Add official GitHub Release discovery and reuse the qualified update manager.
4. Improve installer download diagnostics and publish the three bound standalone update assets after promotion.
5. Update product/security contracts and bump the preview version.
6. Run focused tests, full verification, diff review, and exact-source packaging checks before merge.

## Acceptance

- `hpi version`, `hpi doctor`, and `hpi update status` are readable; their JSON forms remain parseable and path-safe.
- a fresh `hpi` needs no separate `setup` confirmation, sends no prompt during login, and reaches Quick Session only after login readiness.
- `hpi config` preserves strict destination validation; `hpi privacy` does not mutate an empty profile.
- `hpi update` handles available/current/network-failure paths and cannot apply bytes that fail the existing candidate digest and qualification gates.
- promoted Windows release output includes ZIP, checksum, installer, strict candidate, update bundle, and qualification Evidence from one frozen snapshot.
- `npm run verify` passes from the exact source intended for merge.

## Stop conditions

Stop rather than weaken a boundary if implementation would require disabling TLS verification, accepting an unqualified candidate, changing Provider-request authorization for automation, publishing from dirty or unverified source, or overwriting user state outside the existing update transaction.
