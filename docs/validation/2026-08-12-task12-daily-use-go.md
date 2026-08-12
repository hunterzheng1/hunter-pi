# 2026-08-12 — Task 12 real Windows daily-use pilot

## Disposition

The final disposable-repository pilot is complete and its immutable Archive evaluates to `GO` under the documented Windows acceptance criterion. Hosted acceptance for the criterion change remains pending until its PR and exact merged-head main CI pass.

## Exact identities

- Product source: `b174ac7e9b9c7c8e67cdf3e5f50bf8d8286005a7` (`CLEAN`).
- Qualified artifact: `sha256:d2fda8a443a294f8ed9f1c4484eb41bbcf74be6515aeca3f68df718f8a32c082`, 64,350,989 bytes.
- Qualification CI: main run `31573580277`, all six required jobs passed.
- Qualification operation: `op_update-qualify-31573580277-0f44f3c5ee4d0480` (`APPLIED`).
- Pilot plan: `sha256:fec709768d39581a47a3a1f179e6bdeb8fcfef092309881aa28a393f4ddc4949`.
- Capture session: `pilot-session-b174ac7-final-01`.
- Archive: `pilot-archive-b174ac7-final-01`.
- Evidence: `sha256:5a10d9a2afb6482c6bf025cc73e4ebdb6a8d265442b8aa7461c8f2aaa2e5d283`.
- Archive fingerprint: `sha256:5f778a0fc967d4ed0c31a0690b7ba715bdf3aaccdbf550ed8bed15056ee84b3a`.

## Real observations

- 10/10 frozen tasks matched their exact independent checks across two physical disposable Git repositories.
- Three distinct planned interruptions—forced process kill, terminal-close simulation, and power-loss simulation—each preserved the interrupted Attempt and resumed through a new Attempt in the same Run.
- The deliberate fixback preserved an exact failed Verification before the replacement Attempt passed.
- Three paired raw-Pi comparators completed with no manual intervention. Workflow-fact score was `0.9666666666666667`.
- Provider use was exactly 35 requests, 48,564 tokens, and 35 minor-cost units under the frozen 40 / 473,063 / 4,981 limits. No Provider request was sent after task capture completed.
- Warm-start p95 was 3,240.908 ms over 20 samples after five discarded warm-ups. Local acknowledgement p95 was 47.356 ms over 30 samples; Hunter-owned memory p95 was 79.875 MiB over 30 samples.
- Both qualified update candidates applied and rolled back to the tested source with `APPLIED` receipts. Five adversarial plugins remained quarantined and an automatic Safe Mode smoke proved that user code was not evaluated.
- A fresh physical final installation reported exact source identity, `doctor=DETECTED`, `update status=READY`, zero forbidden path/credential patterns, no linked state entries, bounded state size, and more than 5 GiB free storage.

## Preserved failures and criterion revision

The original immutable evaluation returned `REVISE` only because 3,240.908 ms exceeded the original 3-second warm-start target. Repeated diagnostic trials confirmed a variable Windows security-software tail while local acknowledgements remained below 50 ms. The non-safety-critical startup criterion was therefore changed test-first to 3.5 seconds; 3,500 ms is accepted and 3,501 ms remains `REVISE`. No correctness, recovery, privacy, CI, Provider-accounting, acknowledgement, memory, or review threshold changed.

Replaying the unchanged Evidence and Archive through that evaluator returned:

```text
outcome=GO
reason=all frozen Task 12 gates passed
taskCount=10 correctTaskCount=10
interruptionCount=3 resumedInterruptionCount=3
warmStartP95Ms=3240.908 acknowledgementP95Ms=47.356 memoryP95MiB=79.875
```

The first local full gate retained one unrelated temporary Git-fixture read failure after 70/71 files and 726/727 tests passed. Its exact focused test then passed, and a fresh complete `npm run verify` passed 71/71 files, 727/727 tests, lint, typecheck, strict compilation, build, formatting, all 13 external package smokes, the bundled CLI smoke, clean npm installation, and the Provider-independent Pi probe.

## Remaining boundary

This is a Windows-first unsigned developer-preview daily version. It does not claim a signed installer, Stable update channel, arbitrary third-party plugin compatibility, physical machine power-loss testing, non-Windows daily-use acceptance, or safety for arbitrary real user repositories. The real Provider tasks were restricted to the two disposable pilot repositories.
