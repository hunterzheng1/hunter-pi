# CI operations and GitHub control-plane budget

This runbook keeps CI verification reproducible without turning GitHub status
inspection into a high-frequency API poller.

## Workflow policy

- `scope` classifies the exact push or pull-request range. Documentation-only
  changes run `docs-quality`; source, test, dependency, script, CI, deletion,
  rename, unknown, and manually dispatched changes run the complete path.
  Classification errors fail closed. The stable `CI gate` requires every job
  selected for that path to pass.
- The complete path starts Windows/Ubuntu tests, quality and platform Evidence,
  the Task 7 matrix, Windows portable assembly, Windows package smoke, and
  Windows clean-install smoke in parallel. Task 7 runs both platforms in
  parallel and remains the sole hosted execution of the managed-process
  platform suite.
- Locked installs use npm's offline-preferred mode and disable audit/fund
  network work. Compiled checks reuse the build already produced by the same
  job instead of rebuilding before each smoke.
- Package and clean-install smokes discover every regular `packages/*` and
  `apps/*` workspace manifest from the checkout. They do not use a manually
  maintained internal-package allowlist. Adding a workspace dependency must
  therefore exercise its packed tarball and locked clean-install closure in
  the same CI run; an npm `E404` for `@hunter-pi/*` is a local closure defect,
  not a registry error to retry.
- Ubuntu `quality` retains external package and clean-install smokes. Windows
  runs the same two checks in separate parallel jobs so hosted filesystem
  variance does not serialize the complete path. The Windows portable artifact
  is built once in its own parallel job. The measured critical-path target is
  approximately 10 minutes; hosted-runner queueing and load can exceed it.
- Task 9 and Task 10 contract matrices are excluded from the generic unit-test
  invocation and run exactly once inside their source-bound platform probes.
  Task 10 reuses the existing Windows/Ubuntu `quality` jobs and the existing
  aggregate Evidence job; it does not add another checkout or `npm ci` job.
  Its small receipts use 14-day artifact retention.
- The compiled Task 10 platform probe accepts either an explicit `--output
  <approved-path.json>` argument or no arguments. With no argument it writes a
  unique receipt below `.artifacts/task10-platform`; both forms still require a
  clean worktree before the source identity is emitted.
- Workflow concurrency cancels stale runs for the same ref. A cancelled run is
  retained as history; it is not relabelled as a pass.
- Real-project `hpi change` checks run with structured argv and `shell: false`.
  On Windows, the standard `npm` command shim is resolved through the active
  Node executable so a declared `npm test` check is actually runnable. If a
  declared check remains unavailable or fails, the Run ends as a structured
  `STOP`/`BLOCKED` result and does not append a Review Receipt after the
  terminal Run state.

## Operator policy

1. Before status operations, run one read-only quota check:

   ```powershell
   gh api rate_limit --jq '.resources | {core,search,graphql}'
   ```

   The `/rate_limit` endpoint does not consume REST quota.

   For a completed or in-progress run, prefer the repository observer:

   ```powershell
   npm run ci:observe -- <RUN_ID> --head <EXACT_HEAD_SHA>
   npm run ci:observe -- <RUN_ID> --head <EXACT_HEAD_SHA> --once
   ```

   It performs the quota check before each single `gh run view`, defaults to a
   120-second interval, rejects intervals below 60 seconds or above one hour, refuses a second
   observer for the same run, and never downloads logs. A normal observer waits
   at least one minute after a rate-limit response, honors the reported reset
   time when available, and applies bounded exponential backoff. `--once`
   returns `2` instead of waiting when a run is pending or the quota is
   unavailable. A successful exit also requires a completed run, a matching
   optional head SHA, and every returned job to have a successful completed
   conclusion.
   The observer is a local control-plane aid; it does not alter the workflow
   or rewrite any hosted receipt.

2. Observe one run ID at a time. Query `gh run view <RUN_ID> --json status,conclusion,jobs`
   no more frequently than once every 60–120 seconds.
   Do not use the default 3-second `gh run watch`; if watching is necessary,
   use `gh run watch <RUN_ID> --compact --interval 120` as the only observer.
   Never run `gh run list`, `gh run view`, a watcher, and log downloads in
   parallel for the same run.

3. If GitHub returns a rate-limit response, stop polling. Wait until the
   `Retry-After` or `X-RateLimit-Reset` time; if neither is usable, wait at
   least one minute and then use exponential backoff. Do not issue repeated
   rerun/cancel requests while the quota is exhausted.

4. After recovery, rerun only the failed jobs once when the failure is
   reproducible or the retained evidence identifies a transient hosted
   failure. Avoid no-op commits and repeated whole-workflow reruns.

5. Use `git ls-remote` for ref existence and commit identity when possible. A
   hosted-runner acquisition timeout is independent of REST API quota and must
   remain recorded as runner/control-plane history.

## Evidence rule

Remote CI is `PENDING` until the exact source commit's required jobs have
actually completed. Local tests, a public Actions page, or a rate-limit reset
cannot be substituted for the exact Evidence receipt.
