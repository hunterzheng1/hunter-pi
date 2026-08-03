# Contributing

Hunter Pi currently follows a documentation-first delivery plan. Read `AGENTS.md`, `CONTEXT.md`, the accepted ADRs, and the active task before changing the repository.

## Change workflow

1. Select one task from `docs/plans/2026-08-03-foundation-to-daily-use.md`.
2. Before executable code, confirm the repository license and NOTICE/provenance policy are committed.
3. Create an isolated `codex/*` or other contributor topic branch/worktree.
4. Freeze the task's acceptance criteria and non-goals.
5. For behavior, write the smallest failing test first.
6. Implement only enough to make the test pass, then refactor.
7. Run the exact tests, then the task-level gates.
8. Update contracts and documentation in the same change.
9. Commit one coherent outcome; open a PR; wait for actual Windows and Ubuntu results.
10. After merge, verify no unique work remains before cleaning the worktree and branch.

## Engineering commands

Use the repository-pinned Node.js 24/npm 11 line and install only from the committed lockfile on CI or a clean checkout:

```powershell
npm ci
npm run doctor
npm run lint
npm run typecheck
npm test
npm run strict:check
npm run build
npm run format:check
npm run package-smoke
npm run clean-install-smoke
```

The root configuration and scripts are authoritative for every workspace. Do not create a second package manager, TypeScript baseline, or task-specific CI skeleton. The Task 1 Doctor checks repository prerequisites only; provider and Pi qualification belong to later explicit tasks.

## Documentation rules

- Distinguish `implemented`, `verified`, `planned`, `blocked`, and `not proven`.
- Link volatile upstream statements to primary sources and include the observation date.
- Do not copy external text or code without license and provenance review.
- Do not include credentials, private prompts, raw environment dumps, or absolute user paths.
- Keep `CONTEXT.md` a glossary; implementation details belong in architecture or plans.

## Decision rules

Add an ADR only for a hard-to-reverse choice with real alternatives and meaningful consequences. In particular, any Pi/OMP fork, persistent storage replacement, plugin trust change, or distribution signing model requires an explicit decision.
