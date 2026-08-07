# Task 12 — safe target preparation (2026-08-07)

## Disposition

`IMPLEMENTED` within the target-preparation contract; the Task 12 real Windows pilot remains `NOT_RUN` / `NOT_PROVEN`.

## What this closes

The pilot plan requires two explicitly selected repository identities, exact source identities, and exact target-reference identities, but hand-copying those fingerprints was error-prone. The new read-only command:

```text
hpi pilot target --repo <directory> --target-id <id> --json
```

checks the selected directory as one canonical physical Git repository root, reads the current branch, `HEAD`, tree, and porcelain status, and emits either:

- a `READY` `hpi-pilot-repository-target.v1` receipt containing path-free repository/source/reference fingerprints; or
- a `BLOCKED` receipt with null fingerprints and one fixed reason for a non-root path, non-canonical path, dirty worktree, detached `HEAD`, or inspection failure.

The canonical repository identity is hashed before it enters the receipt. No path, branch text, Git error text, credential, Provider metadata, Pi launch, network request, worktree creation, or repository mutation is emitted or initiated by this command.

## Local proof

- Contract tests prove stable path-free fingerprints, dirty-target null identity, and strict READY/BLOCKED receipt invariants.
- Windows temporary-Git tests prove clean-root detection, dirty-root blocking, detached-HEAD blocking, and non-root blocking without path leakage.
- CLI tests prove explicit `--repo`/`--target-id` routing and that target inspection does not launch Pi or check Provider authentication.
- This record uses only temporary test repositories. It is not a real-project pilot Archive and does not change the daily-use disposition.

## Safety boundary

No user repository was selected or modified, and no Provider or paid request was made. A later real pilot still requires explicit operator-owned repository targets, Provider endpoint/credential authorization scope, the frozen ten-task observations, fresh-install receipt, and the complete dated Archive before `GO` is possible.
