# 2026-08-09 — bounded real-project attempts and failure hardening

## Scope

This record preserves two explicitly selected, disposable-worktree real-project
attempts. The original operator workspaces were not modified. The authorization
boundary allowed at most two actual Provider requests, one per target; no third
request was made.

The tested Hunter Pi source was the clean merged main commit
`2fa797f3f81fbc774acaa49018b614e5c3d6f953`. The target identities were frozen
before the requests and carried only fingerprints in the plan and runtime
Evidence.

| Target | Base commit | Allowed path | Independent check | Observed mutation |
| --- | --- | --- | --- | --- |
| `harness-test` | `d76e0964cf9ebc4ed7c82db428073ff4ab23e3b2` | `README.md` | `npm test` | `README.md` only |
| `skills-hub` | `dbe1ca7ae8557d85f0ef4e8a3a1c0e9ef1f73ae0` | `README.md` | `git diff --check` | `README.md` only |

No credential, complete prompt, private path, environment dump, Provider
response body, or unredacted user path was retained in this record.

## Attempt results

1. A confirmation input formatting mistake was rejected by the CLI as
   `PROVIDER_REQUEST_NOT_ACKNOWLEDGED`; it did not start a Provider request or
   change the target.
2. The `harness-test` request did start and changed only the declared
   `README.md`. The independent `npm test` check passed locally with 13/13
   tests, but the command returned generic `INCOMPATIBLE` instead of a
   structured Managed Change result.
3. The `skills-hub` request did start and changed only the declared `README.md`.
   `git diff --check` passed locally. The terminal capture for the final JSON
   response exceeded its display budget, so the exact Managed Change result
   was not retained; this attempt is not counted as a `GO`.

Both requests acquired and released their repository and Pi-process leases.
The disposable worktrees showed no out-of-scope changes.

## Root cause and hardening

The first failure was reproduced without another Provider request:

- Windows `spawn("npm", ..., shell: false)` returned `ENOENT` because `npm`
  is a command shim rather than a directly executable binary.
- The verifier correctly represented that as `BLOCKED`, but the real-project
  runner then attempted to append a Review Receipt after the Workflow Run had
  already reached terminal `BLOCKED`, causing a transition error and the
  generic CLI fallback.

The fix is now covered by focused regression tests:

- Windows resolves the npm CLI through the current Node executable while
  retaining structured argv and `shell: false`.
- A blocked or failed final independent check does not append an invalid Review
  Receipt; it returns a path-free `STOP` artifact with the exact check outcome
  and preserved changed worktree.
- The CLI emits that structured artifact instead of `CommandStatus=INCOMPATIBLE`.

## Disposition

This record proves bounded real-project mutation and the failure-handling fix,
but it does not prove the complete Task 12 daily-use pilot. The product remains
`NOT_PROVEN` for daily-use acceptance until the required ten-task, paired
comparator, interruption, plugin, update, archive, and exact hosted CI Evidence
set is produced under a fresh explicit authorization budget.
