# Task 12 — Windows daily-use pilot

- Scope: a real Windows acceptance run, not a deterministic fixture suite
- Frozen inputs: machine profile, two repository identities, ten task/oracle pairs, raw-Pi comparator configuration, acceptance checks, plugin fixtures, update candidates, and the exact Hunter/Engine release identities
- Safety boundary: no user repository is selected implicitly; no Provider or paid request is made without an explicit target and credentials owned by the operator

## Evidence contract

`@hunter-pi/pilot` contains the strict `hpi-pilot-evidence.v2` schema and evaluator. It requires an explicit PASS fresh-install receipt bound to the tested source, release artifact, and clean profile; exact Windows/Ubuntu CI receipts bound to source, artifact, Engine, and run identities; and comparator/task-result binding for both identities and numeric observations. It retains raw counts and calculates nearest-rank p95 for the required warm-start, acknowledgement, and memory samples. Its `PilotPlanCompiler` freezes ten tasks, three paired tasks, two explicitly selected repositories, and the Provider authorization policy into a path-free, fingerprint-bound execution plan; `hpi pilot preflight --plan <file> --json` exposes only a redacted `READY`/`BLOCKED` receipt. It returns `GO`, `REVISE`, `STOP`, or `NOT_PROVEN`; missing CI, missing Provider-latency separation, identity mismatches, and incomplete pilot observations cannot become `GO`.

## Required run

- fresh supported Windows x64 portable installation;
- ten real tasks across at least two explicitly selected repositories;
- three paired raw-Pi/Hunter tasks with identical source and acceptance checks;
- Quick and Managed modes, deliberate failure/fixback, and three forced interruptions;
- five frozen broken/malicious plugin fixtures, two qualified update/rollback cycles, and the privacy/storage gates;
- exact Windows and Ubuntu CI for the final source/artifact identity.

## Current disposition

The evaluator, explicit plan compiler, safe preflight CLI, and policy tests are implemented and pass. The real ten-task pilot is **NOT_RUN** on this branch because no repository targets, Provider credentials, or remote CI run were supplied or safely inferable. This is an evidence boundary, not a product pass. The product must remain `NOT_PROVEN` for daily-use acceptance until a dated pilot Archive and exact remote CI receipts exist.
