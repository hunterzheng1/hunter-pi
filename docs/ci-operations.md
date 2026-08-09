# CI operations and GitHub control-plane budget

This runbook keeps CI verification reproducible without turning GitHub status
inspection into a high-frequency API poller.

## Workflow policy

- `quality` is the first hosted stage. The host-sensitive Task 7 matrix starts
  only after quality passes and runs one platform at a time; it is the sole
  hosted execution of the managed-process platform suite and emits the bound
  Task 7 receipts.
- Locked installs use npm's offline-preferred mode and disable audit/fund
  network work. Compiled checks reuse the build already produced by the same
  job instead of rebuilding before each smoke.
- The Windows `quality` job has a 55-minute bound because hosted filesystem
  variance affects the two isolated npm installation smokes and the exact
  portable artifact assembly. The portable artifact is still built once, only
  on Windows, after the shared quality build; the wider bound prevents a
  passing artifact from consuming the old 40-minute margin.
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

## Operator policy

1. Before status operations, run one read-only quota check:

   ```powershell
   gh api rate_limit --jq '.resources | {core,search,graphql}'
   ```

   The `/rate_limit` endpoint does not consume REST quota.

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
