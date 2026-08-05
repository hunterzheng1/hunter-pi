# Task 12 — Windows daily-use pilot disposition

## Evidence state

The provider-neutral `@hunter-pi/pilot` `hpi-pilot-evidence.v2` schema/evaluator and its policy tests pass. The evidence contract now requires an explicit PASS fresh-install receipt bound to the tested source, release artifact, and clean profile; exact Windows/Ubuntu CI receipts bound to source, artifact, Engine, and run identities; and comparator/task-result binding for repository/source/mode/acceptance identities plus numeric observations. The complete synthetic evaluator fixture reaches `GO` only to prove the aggregation rules; it is not pilot Evidence and is not a product readiness claim. The current local verification covers all 46 test files in passing shards (362 tests); the affected Pi/Provider/Git fixture files also pass independently.

The actual ten-task Windows run has not been executed on this branch. There is no frozen pair of operator-selected repositories, no raw-Pi/Hunter paired run set, no real Provider readiness/request receipt for this run, no 20 warm-start/30 acknowledgement/30 memory sample set, and no exact main CI receipt for the current source. Earlier PR CI run `31032218373` is recorded separately and covers the pre-hardening source; replacement PR CI and main CI for the reviewed source are still pending and do not substitute for the real pilot.

## Terminal disposition

`NOT_PROVEN` — the evidence contract is ready, but the required real-use observations and exact remote CI are absent. The correct next action is a separately recorded pilot run with explicit repository/credential scope, not a claim of daily-use readiness.
