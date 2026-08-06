# Task 12 — real Windows pilot boundary (2026-08-06)

## Disposition

`NOT_PROVEN` / `NOT_RUN`.

At the time this boundary record was authored, pre-merge `main` was `29d2ef2` (`docs: close Task 12 CI evidence`) and its exact main CI run [`31104828696`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31104828696) passed the recorded Windows, Ubuntu, containment, Task 7 Evidence, and Pi Evidence jobs. The merged Task 12 product/evidence baseline `b37f8fb` then passed exact main CI [`31109317291`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31109317291), and the follow-on documentation-only head `ac1d7ae` passed exact main CI [`31113254777`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31113254777). These receipts prove the checked-in implementation and its provider-neutral verification gates at their documented scope; they do not constitute a Task 12 real-use acceptance.

## Proven within the recorded bounds

- Tasks 9–11 are locally implemented and documented as passing within their provider-neutral durable-fixture, metadata-only package-manager, and unsigned developer-preview bounds.
- Task 12 plan compilation, redacted preflight, strict evaluation, identity binding, privacy checks, and the real-project entry-point contracts are implemented and locally verified.
- The evaluator keeps the synthetic `GO` fixture separate from product Evidence and rejects incomplete real-pilot observations as `NOT_PROVEN`.
- The required failure history and earlier CI attempts remain append-only in the existing plan and validation records.

## Missing real-pilot evidence

The required pilot cannot be truthfully compiled or executed because the current task has no:

1. pair of explicitly selected operator-owned Windows repositories;
2. Provider endpoint/credential scope and authorization for a real request;
3. frozen ten-task, raw-Pi/Hunter comparator, interruption, plugin, update/rollback, privacy, storage, and performance observation set;
4. fresh-install receipt and dated pilot Archive bound to the exact source and release artifact.

These are evidence-bound conditions, not assumptions that can be filled from the Hunter Pi repository, disposable fixtures, local credentials, or CI results. The broad request to make the product daily-use ready does not identify an external repository or authorize an unspecified Provider request, so none was inferred.

## Safety disposition

No user repository was selected or modified. No credential, token, cookie, private prompt, or unredacted path was read into Evidence. No Provider or paid request, publish, deploy, push, or irreversible production operation was initiated.

The next valid transition is a separately recorded pilot run whose plan names the two repositories and explicit authorization scope, followed by the complete Task 12 Evidence contract and exact source/artifact-bound Windows/Ubuntu receipts. Until that Archive exists, daily-use GO remains prohibited.

## Follow-on hosted CI history (2026-08-07)

The append-only PR #38 history after this boundary record retains the following exact-head results:

- PR run `31124466020` for head `0cd71c5` passed Windows quality, but its Windows Task 7 receipt failed at `TEST_EXECUTION`; Ubuntu quality and Task 7 were not acquired by hosted runners, so both Evidence aggregators were skipped.
- Manual run `31124251190` for the same head passed Windows quality and Windows Task 7, but Ubuntu quality and Task 7 were not acquired by hosted runners; its Evidence aggregators were skipped. This is a platform-run result, not a complete Windows/Ubuntu CI pass.
- Eight consecutive local Windows platform-suite repetitions on the clean head passed; the hosted Windows `TEST_EXECUTION` failure was not reproduced locally. These local repetitions do not replace the required remote Ubuntu and exact PR gates.

These results preserve the distinction between a product/test failure and a hosted-runner failure. They do not change the Task 12 disposition: the real pilot remains `NOT_PROVEN` / `NOT_RUN`.

## Source records

- [Task 12 plan](../plans/2026-08-05-task12-daily-use-pilot.md)
- [Task 12 validation disposition](2026-08-05-task12-daily-use-pilot.md)
- [Current documentation status](../README.md)
