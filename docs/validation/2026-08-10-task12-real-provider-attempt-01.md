# Task 12 — real Provider attempt 01 (2026-08-10)

## Disposition

`ATTEMPTED / BLOCKED / PROVIDER_USAGE_RECONCILIATION_REQUIRED / DAILY_USE_NOT_PROVEN`.

This is an append-only failure record. It does not constitute a completed pilot task and must not be replaced by a later successful result.

## Frozen identity and scope

- Product source: `81f7a956bfe24687671340946c1e2d593277aa6a`.
- Portable artifact fingerprint: `sha256:be6cabaf905c09c949b77dc3fc6832bfd41bc1c573ce669dc1631b40f9979a60`.
- Pilot plan fingerprint: `sha256:0b751cd3b0da441282df36250239f363ee6ea3ae580f65a38e649ecd28cf1ec3`.
- Capture session: `pilot-session-20260810-81f7a956`.
- Task and operation: `pilot-task-01` / `pilot-op-task-01`.
- Target: the explicitly selected disposable `repository-alpha` fixture; no user repository was in scope.

## Retained observations

1. The capture coordinator durably wrote Provider intent `sha256:2630670574318bf1da82b3d85254f97f2f84d5742ba54f669e12dca03ec0e3ce` immediately before the external operation. Its pre-operation usage was zero and it reserved the original session's complete remaining allowance of 20 requests, 500,000 tokens, and 5,000 minor cost units.
2. The operation crossed the Provider boundary and created only the allowed `result-01.txt` disposable-repository change with the expected `pilot-task-01-ok` content.
3. The runtime returned `OBSERVATION_INVALID`: bundled Pi 0.83 emitted the documented terminal `agent_end` then `agent_settled` sequence, while Hunter Pi incorrectly required the final event to be exactly `agent_end`.
4. No task event or exact Provider usage receipt was published after the durable intent. Exact request, token, and cost use are therefore unknown; none may be inferred as zero.
5. A repeat invocation was correctly rejected as `PROVIDER_USAGE_RECONCILIATION_REQUIRED`. No second Provider send was made from this session.

## Safety and continuation rule

- Keep the original intent, session, and failed repository observation immutable.
- Do not retry, finalize, or guess usage in `pilot-session-20260810-81f7a956`.
- Repair the live Pi 0.83 terminal predicate test-first, require the exact `agent_end` then `agent_settled` tail, and fail closed for missing, reversed, duplicated, or followed settlement events.
- Any continuation must bind a new merged source, exact portable artifact, qualified main CI, plan, session, archive, and operation identities. Its finite Provider authorization must explicitly remain separate from this unknown historical use.
- Reset the disposable fixture only after exact canonical-path and clean-target checks; never apply that cleanup rule to a user repository.

Daily-use `GO` remains prohibited until a later complete ten-task Archive passes the exact evaluator and retains this failed attempt as prior history.
