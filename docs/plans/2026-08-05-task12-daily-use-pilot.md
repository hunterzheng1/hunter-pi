# Task 12 — Windows daily-use pilot

- Scope: a real Windows acceptance run, not a deterministic fixture suite
- Frozen inputs: machine profile, two repository identities, ten task/oracle pairs, raw-Pi comparator configuration, acceptance checks, plugin fixtures, update candidates, and the exact Hunter/Engine release identities
- Safety boundary: no user repository is selected implicitly; no Provider or paid request is made without an explicit target and credentials owned by the operator

## Evidence contract

`@hunter-pi/pilot` contains the strict `hpi-pilot-evidence.v4` schema and evaluator. It requires an explicit PASS fresh-install receipt bound to the tested source, release artifact, and clean profile; exact Windows/Ubuntu CI receipts bound to source, artifact, Engine, and run identities; comparator/task-result binding for both identities and numeric observations; and an explicit receipt that recovery or rollback required no manual Hunter state-file editing. It retains raw counts and calculates nearest-rank p95 for the required warm-start, acknowledgement, and memory samples. Its `PilotPlanCompiler` freezes the machine profile, comparator/check fingerprints, five plugin fixtures, two update candidates, ten tasks, three paired tasks, two distinct repository identities, and the Provider authorization policy into a path-free, fingerprint-bound execution plan. Evidence must carry the exact plan fingerprint and authorization scope, and the evaluator rejects task, paired-comparator, Plugin, update, or machine identities that do not match that plan. A false `READY` is a zero-tolerance `STOP`, not a 9-of-10 quantitative miss. `hpi pilot compile --input <file> --json` emits only a strict, path-free execution plan or the same redacted blocked preflight receipt; `hpi pilot preflight --plan <file> --json` exposes only a redacted `READY`/`BLOCKED` receipt with fixed actionable reason codes; and `hpi pilot evaluate --plan <file> --evidence <file> --json` emits the strict decision, returning exit code 0 only for `GO` and never starting Pi or sending a Provider request. It returns `GO`, `REVISE`, `STOP`, or `NOT_PROVEN`; missing CI, missing Provider-latency separation, identity mismatches, and incomplete pilot observations cannot become `GO`.

## Required run

- fresh supported Windows x64 portable installation;
- ten real tasks across at least two explicitly selected repositories;
- three paired raw-Pi/Hunter tasks with identical source and acceptance checks;
- Quick and Managed modes, deliberate failure/fixback, and three forced interruptions;
- five frozen broken/malicious plugin fixtures, two qualified update/rollback cycles, and the privacy/storage gates;
- exact Windows and Ubuntu CI for the final source/artifact identity.

## Current disposition

The evaluator, explicit plan compiler, safe compile/preflight/evaluate CLI, and policy tests are implemented and pass. The disposable-fixture entry point now fails closed unless `--allow-provider-request` is supplied and the operator confirms the declared Provider scope. PR #32's exact head `7cc85b5b190c44ebc3eb737b08dd4078ded8e7b2` passed run [`31082027466`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31082027466), and merge `e886b48a617d6df8f63bbaae9cadcc0ea0f66dba` passed exact main run [`31083253052`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31083253052) across Windows, Ubuntu, containment, and Pi Evidence jobs. Documentation merge `8324ca74604472468bc2c42c5e924663e57a61a4` retained the first Task 7 containment failures in main run [`31085901324`](https://github.com/hunterzheng1/hunter-pi/actions/runs/31085901324); the failed Windows/Ubuntu jobs were rerun without source changes and passed, followed by the Task 7 Evidence aggregation. The real ten-task pilot is still **NOT_RUN** because no repository targets, Provider credentials, or operator authorization for a real request were supplied or safely inferable. This is an evidence boundary, not a product pass. The product must remain `NOT_PROVEN` for daily-use acceptance until a dated pilot Archive and its real-use observations exist.
