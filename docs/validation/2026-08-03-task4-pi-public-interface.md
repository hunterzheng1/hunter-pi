# Task 4 fixed Pi public-interface validation

- Date: 2026-08-03
- Candidate: `@earendil-works/pi-coding-agent@0.83.0`
- Candidate registry `gitHead`: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- Decision: **CONTINUE after exact dual-platform CI; no fork proposal**
- Product status: **NO_USABLE_PRODUCT** until Task 5 supplies and validates `hpi`

## Evidence status

| Evidence | Status | Meaning |
|---|---|---|
| [Local Windows Node 24 receipt](evidence/pi/windows-node24.json) | `SUPPORTED` within its schema bounds | The fixed package exercised Extension, JSON, RPC, and SDK behavior with a deterministic faux provider and Pi offline startup/package mode in an isolated temporary Git fixture; OS network isolation remains `NOT_PROVEN` |
| GitHub Actions Windows receipt | `PENDING` | Workflow is configured but has not run for this change |
| GitHub Actions Ubuntu receipt | `PENDING` | Workflow is configured but has not run for this change |
| Cross-platform identity receipt | `PENDING` | The aggregate CI job has not yet compared actual Windows and Ubuntu artifacts |
| Interactive TUI | `NOT_PROVEN` | Deferred to Task 5 Windows acceptance |
| Real Provider/login/model call | `NOT_PROVEN` | No credentials, login, network Provider call, or paid request were used |
| Third-party Pi Package compatibility | `NOT_PROVEN` | No third-party package was activated |

The JSON receipt binds the exact npm version/integrity/registry `gitHead`, the complete installed package tree fingerprint/count/bytes, Pi CLI fingerprint, ordered Hunter Pi probe source pathspec/digest, the exact built-JavaScript execution pathspec/digest, Core Extension source fingerprint, sanitized environment category, surface receipts, and capability derivation. It contains no fixture path, home path, credential, environment dump, or private prompt. Its file SHA-256 is `574f9117350ea933554f11563e5c1e28abd8518be4db90345327c4389274aa3d`; its source digest is `sha256:529919240bf67dee8ac4335ac31cd642afbd4612f6118c65a13b1dae08607ecd`; its executed-adapter digest is `sha256:c3c0284294dc1d7944961bfc5587972ea423c46e545069d4b24efede16a7c892`.

## Provider-independent result

| Surface or capability | Result | Exact boundary |
|---|---|---|
| Core Extension | `SUPPORTED` | Exact Core identity, lifecycle, active tool list, effective source/scope/origin graph, and tool call/result interception were observed |
| JSON | `SUPPORTED` | Strict LF-only NDJSON with required lifecycle/tool events; exit or `agent_end` does not mean Hunter success |
| RPC interrupt | `SUPPORTED` | Two concurrent read requests were correlated by unique IDs independent of response order; active abort was observed with exactly one in-flight mutating Agent operation; abort is not request-scoped |
| SDK Session/resume | `SUPPORTED` | A contained single-link Session bound to the fixture cwd reopened in a separate Node process with the same Session ID, reloaded Core identity/tool graph, and recovered the custom entry |
| `CHECKPOINT` | `NOT_PROVEN` | Pi Session is only an external reference; Hunter canonical Checkpoint binding is not supplied by Pi |
| `RECONCILE` | `NOT_PROVEN` | Pi has no Hunter operation ID/fingerprint journal or unknown-outcome Receipt |
| `CLOSE` | `NOT_PROVEN` | root RPC child exit was observed without tool descendants; exact descendant process-tree cleanup was not tested |

These results show that the public Pi seams are sufficient to build the Task 5 shell and a later Hunter-owned adapter without a source fork. They do not qualify a production Engine Host or a real Provider.

## Local commands and actual outcomes

```text
npm exec vitest run test/pi-public-interface-probe.test.ts test/pi-probe-cli.test.ts test/pi-ndjson.test.ts test/pi-fixture-and-output-safety.test.ts
  PASS — 4 files / 16 tests
npm run lint
  PASS
npm run typecheck
  PASS
npm run build
  PASS
node dist/tools/pi-public-interface-probe.js --output docs/validation/evidence/pi/windows-node24.json
  PASS — strict built-JavaScript receipt emitted; ProviderIndependentProbe=SUPPORTED; RealProvider=NOT_PROVEN
npm ci
  PASS — 286 packages installed from the committed lockfile
npm run verify
  PASS — 21 test files / 161 tests, strict compiler, build, formatting, external package install,
  clean locked install, and independent Pi probe
strict schema parse + SHA-256 + forbidden path/credential-pattern scan of windows-node24.json
  PASS
git diff --check
  PASS
```

The complete local repository gate passed. Exact remote CI remains `PENDING` until it actually runs.

## Preserved development history

- The first SDK attempt reached ordinary model validation before the probe Extension bound and failed with “No API key found.” The probe was corrected to bind the public Extension first and select its deterministic faux model; no credential was added or read.
- A subsequent SDK create/resume attempt reopened the Session but initially failed to recover the custom entry because the Extension had not been bound before the prompt. The fixed probe binds before execution and resumes in a fresh process; the failed observation was not rewritten as a pass.
- The first standalone CLI receipt was valid but the process remained alive for roughly 34 seconds because a completed timeout race retained its timer. The timer is now cleared deterministically; the repeated standalone run completed in roughly 7.8 seconds. The earlier timing is retained here rather than presented as a Pi performance result.

The local full-gate attempts were also preserved rather than collapsed into the final pass:

| Attempt | Actual result | Evidence-led correction |
|---|---|---|
| 1 | `FAIL` at lint: two unsafe asymmetric matcher assignments in the new test | Replaced them with typed field and exact source-pathspec assertions |
| 2 | lint/typecheck/151 tests/strict/build passed, then `FAIL` at format check for generated Evidence JSON | Made the generator emit the repository's Prettier-stable JSON format and added a focused test |
| 3 | `FAIL` at lint: an unnecessary `JSON.stringify` conditional introduced with the formatter | Removed the type-impossible branch after reading the exact lint diagnostic |
| 4 | `PASS`, later superseded | 20 files / 152 tests passed before independent review identified additional identity, correlation, resume, aggregate-CI, and failure-Evidence gaps |
| 5 | `FAIL` at format check after 21 files / 159 tests and build passed | Formatted the three exact review-fix files reported by Prettier |
| 6 | `PASS`, later superseded | 21 files / 159 tests passed before follow-up review reproduced an approved-root junction overwrite risk |
| 7 | `FAIL` at lint while typecheck and 4 files / 16 tests passed | Removed an unnecessary `async` marker from the stage wrapper callback |
| 8 | `PASS` | 21 files / 161 tests and every local gate passed on the source bound by the committed Windows receipt |

Independent review closed the original capability-derivation, installed-artifact identity, concurrent RPC correlation, NDJSON tail validation, fresh-process Session containment/resume, and aggregate-CI findings. Follow-up review then reproduced and closed a directory junction/symlink redirect: Evidence directories are now created and checked component by component, redirects are rejected, existing targets are never replaced, and both the probe and comparator use exclusive `wx` writes. Probe failures emit a strict path-free `NOT_PROVEN` receipt with an allowlisted stage and classification rather than raw exception content. Final review reported no remaining P0/P1 finding; this does not substitute for remote CI.

## Recommendation and remaining stop lines

Proceed to Task 5 only after the exact Task 4 commit passes both Windows and Ubuntu CI and their uploaded JSON receipts validate against the same artifact and source digest. Stop instead of proceeding if either platform cannot reproduce Core identity/tool graph, LF-only framing, active cancellation, fresh-process Session reopen, or root child cleanup. Task 5 may deliver Quick Session only; Managed Change still cannot claim canonical checkpoint, reconciliation, or process-tree finality until the later planned tasks prove them.
