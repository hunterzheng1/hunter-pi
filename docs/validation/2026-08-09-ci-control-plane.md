# 2026-08-09 — CI control-plane and rate-limit validation

## Scope

This record covers the exact merged main head `b9fd45c5b70659550ebb16b0d49c40a06c7784aa`.
It records hosted scheduling history and the local GitHub control-plane guard. It does
not relabel a failed job, and it does not expand the Task 12 real-repository or Provider
authorization boundary.

## Hosted CI

Main run [`31308598610`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31308598610)
first retained one Windows quality timeout in
`test/real-managed-change-cli.test.ts`, while the assertion suite was otherwise passing.
The failed job was rerun once, without a source change, under the existing transient-host
policy. The same run then completed with all six required jobs successful:

- Windows quality;
- Ubuntu quality;
- Pi + Task 9 + Task 10 Evidence consistency;
- Task 7 containment on Windows and Ubuntu;
- Task 7 Evidence consistency.

The initial timeout remains part of the run history. It was not a GitHub API rate-limit
response and was not converted into a product failure or silently discarded.

## Rate-limit snapshot

At `2026-08-09T19:22:48+08:00`, the read-only `rate_limit` check reported:

```text
core:    4996 / 5000 remaining
graphql: 4993 / 5000 remaining
search:    30 / 30 remaining
```

The current control-plane quota is therefore available; a quota reset is not being used
as evidence that the product or CI passed.

## Preventive control

`npm run ci:observe -- <RUN_ID> --head <EXACT_HEAD_SHA>` now provides one guarded observer.
It performs one quota preflight before each status query, uses a 120-second default interval
with a 60-second floor and one-hour ceiling, serializes observers per run ID, waits at least one
minute after a rate-limit response, honors the reported reset time when available, applies bounded
exponential backoff, and never downloads logs. A successful exit additionally requires a completed
run, the matching optional head SHA, and every returned job to have a successful completed
conclusion. `--once` is suitable for a single read-only snapshot and returns a non-success status
while the run is pending or the quota is unavailable.

The observer's no-network argument checks passed locally, and a live one-shot observation
of run `31308598610` returned the exact successful head and all six successful jobs. This
is an operator safety improvement only; the required CI Evidence remains the hosted run
itself.

## Product disposition

Task 9–11 remain complete only within their recorded provider-neutral and unsigned
developer-preview bounds. Task 12 still has no explicitly selected pair of real
repositories, bounded Provider authorization, ten-task observation set, or immutable
aggregate Archive, so Windows-first daily-use acceptance remains `NOT_PROVEN`.

## Follow-up after the observer fix

PR #66 first exercised the observer against a pending run whose GitHub CLI JSON represented
pending conclusions as an empty string. The observer failed closed with
`CI_RUN_RESPONSE_INVALID`; it did not report a false pass. The parser was then tightened to
normalize only the documented pending representations (`null` and empty string), while
continuing to reject unknown conclusions. The focused observer suite passed 7/7 locally.

The replacement PR run
[`31312884636`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31312884636), bound to
`2a6922ecd836f10095b9d504265f4cecf6365766`, passed all six required jobs. PR #66 was merged
as `f1c03b6b5ffd3c181bbe541bcc33c18064496995`; the exact merged-head main run
[`31313952000`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31313952000) then passed
Windows and Ubuntu quality, Pi + Task 9 + Task 10 Evidence, Task 7 containment, and Task 7
Evidence. The earlier cancelled/failed observations remain preserved as history.

The final read-only quota snapshot was:

```text
core:    4939 / 5000 remaining
graphql: 4984 / 5000 remaining
search:    30 / 30 remaining
```

This confirms that the GitHub API limit is currently clear. The guard remains necessary because
quota availability is operational state, not proof of product readiness.

## Windows managed-process test budget hardening

The documentation-only PR #67 run
[`31315672694`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31315672694) retained one
Windows failure: 447 tests passed, while
`real-managed-change-cli.test.ts` reached its exact 30-second test timeout. The failed Windows job
was rerun once without a source change; the same run then passed all six required jobs. PR #67 was
merged as `67a5d5692e107acdd685ff595f8b2e720889f216`, and exact merged-head main run
[`31317016233`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31317016233) passed all six
Windows/Ubuntu quality, containment, and Evidence jobs without a rerun.

This was the second retained hosted timeout for the same integration test. Its outer 30-second
Vitest budget equalled the Windows Job Object helper's own 30-second containment-start ceiling,
leaving no budget for the Git fixture, durable leases, verification, and cleanup. The test now uses
a dedicated 60-second integration budget from the shared Vitest resource policy. Product process
timeouts and the repository-wide 30-second default are unchanged, and a policy regression test
requires the dedicated budget to remain both explicit and larger than the default.

The focused policy and real-change suites passed 9/9 locally. The first full `test:ci` retained an
unrelated 30-second Pi child-probe timeout after 50 files and 444 tests passed; the exact focused Pi
probe then passed 5/5, and a second complete `test:ci` passed 51 files and 449 tests. The initial
local child-probe timeout remains part of this validation history and is not relabeled as a pass.
