# Task 8 — Verification adequacy validation

- Observed: 2026-08-05
- Baseline: `ec850c3d3853547a70f425cfd25bfdc83cb7af1e`
- Selected merge: `bbb409c282741431b75e7303b27154755c86ffd1`
- Implementation commits: `5f4e1f493eb82eb2edeaec89d7f39b582c7dcf1d`, `24671c586477547fb33ce6e997379134b1efc3c9`
- Pull request: [#18](https://github.com/hunterzheng1/hunter-pi/pull/18)
- Fixture policy: `AUTOMATIC_DETERMINISTIC_RECEIPT_FIXTURES_ONLY`
- Provider requests: `NOT_RUN`
- Real user repositories: `NOT_RUN`
- Task result: **COMPLETE WITHIN PROVIDER-NEUTRAL BOUNDS / LOCAL PASS / PR CI PASS / MAIN CI PASS / TASK 9 NOT_STARTED**

## Contract surface

`packages/verification/src/adequacy.ts` exports strict Zod schemas and `validateVerificationAdequacy`:

| Surface | Proof boundary |
| --- | --- |
| Verification DAG | CHECK, HUMAN_GATE, and REVIEW nodes bind declared checks/Steps; unknown dependencies, duplicate nodes, kind/required mismatches, and cycles are findings. |
| Resource locks | A lock may be shared only when the DAG gives one deterministic dependency order; unordered holders are a P1 conflict. |
| Accounting | `selected`, `collected`, `executed`, `passed`, `skipped`, `notRun`, `duplicates`, `filtered`, `staleReuse`, `timedOut`, and `truncated` are computed from parsed inputs. |
| Reuse invalidation | Run, Attempt, check version/definition/configuration, workspace, source, and environment identities must match exactly. |
| Output safety | Timeout, stdout/stderr truncation, and an unapplied redaction result prevent readiness. |
| Review and Human Receipt | Required gates bind the frozen content/result fingerprints; required reviews bind input/definition/configuration/source/workspace and retain P0–P3 findings. |
| Fixback | A batch links a distinct previous Attempt and failure Evidence to the active Attempt and selected invalidated checks. |
| Readiness | Only a clean, fully reconciled receipt returns `status=READY`; P0 findings return `BLOCKED`, and other incomplete proof returns `NOT_PROVEN`. |

The public contract contains no Pi, Oh My Pi, Codex, CodeBuddy, Cursor, Orca, model, GUI, or terminal-private fields.

## Focused and local verification

| Command | Result |
| --- | --- |
| `npm ci` | passed in the isolated worktree |
| `npx vitest run test/verification-adequacy.test.ts --reporter=verbose` | 6/6 passed after the RED implementation gap was closed |
| `npm run lint` | passed |
| `npm run typecheck` | passed |
| `npm test` | 39 files, 308 tests passed |
| `npm run build` | passed |
| `git diff --check` | passed |

No raw prompts, credentials, complete environment dumps, or private filesystem paths were written to the contract or Evidence.

## Remote CI history

The first PR run [`30983551241`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30983551241) is retained as failure history. Ubuntu quality reached `format:check` and failed because the two new files were not yet Prettier-formatted. The same run's Ubuntu Task 7 containment emitted a structured `hpi-task7-platform-failure.v5` with `stage=TEST_EXECUTION`, `code=TASK7_PLATFORM_PROBE_DID_NOT_COMPLETE`, and `observedBytes=79`; its artifact was uploaded and is not relabelled. No source change was made to Task 7.

After the formatting-only commit `24671c5`, PR run [`30983778626`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30983778626) passed every actual gate:

- `windows-latest / Node 24`;
- `ubuntu-latest / Node 24`;
- `Task 7 containment / windows-latest`;
- `Task 7 containment / ubuntu-latest`;
- `Task 7 Evidence / Windows + Ubuntu identity`;
- `Pi Evidence / Windows + Ubuntu identity`.

Exact merge-head main run [`30984969665`](https://github.com/hunterzheng1/hunter-pi/actions/runs/30984969665) also passed all six jobs. The committed adequacy contract and local fixtures are therefore covered by actual Windows and Ubuntu CI, while the CI runs remain evidence of the tested merge artifact rather than a claim about any Provider or real repository.

## Frozen outcome and next gate

Task 8 is complete within the deterministic receipt-fixture boundary. It prevents partial execution or review text from becoming a false `READY`, but it does not implement checkpoint recovery, archive finalization, device migration, or process reconciliation after interruption. Those are Task 9 deliverables and remain `NOT_STARTED`.
