# Security and trust

## Security objective

Hunter Pi deliberately executes an Agent and third-party code against valuable source repositories. It cannot make arbitrary local code inherently safe. Its job is to make authority, provenance, effects, uncertainty, and recovery visible and enforceable.

## Trust zones

```text
User decisions and project policy
             │
             ▼
Hunter Workflow Kernel and integrity-identified release
             │
      ┌──────┴─────────┐
      ▼                ▼
Qualified Pi       Independent verifier
      │
      ├─ model provider network
      ├─ built-in tools
      └─ third-party plugins (least trusted executable zone)
```

No model output, plugin result, network response, or external process is trusted solely because it arrived through Pi.

## Primary threats

| Threat | Example | Required control |
|---|---|---|
| Prompt/tool abuse | model requests destructive or unrelated operation | permission profile, scope checks, visible approval, bounded tools |
| Plugin compromise | package reads credentials or changes tool semantics | provenance, explicit install, separate compatibility/trust/isolation results, Safe Mode, isolation roadmap |
| Supply-chain replacement | mutable dependency changes between qualification and install | exact versions/refs, integrity, lockfile, artifact verification |
| Evidence forgery | Agent claims tests passed or edits its own report | independent verifier, append-only events, hash-bound receipts |
| Secret leakage | logs capture token, Cookie, env, private prompt, home path | structured capture, allowlisted fields, redaction tests, bounded output |
| Workspace loss | cleanup follows junction/symlink or wrong worktree | resolved-target validation, leases, recoverable cleanup, exact identity |
| Process escape | timed-out child continues changing files | process-tree isolation, cancellation receipts, no silent downgrade |
| Replay ambiguity | interrupted operation executes twice with different payload | operation ID + fingerprint idempotency |
| Update regression | new Pi breaks extensions or recovery | candidate qualification, staged channels, rollback |
| State corruption | crash during event/checkpoint write | atomic append/write, checksums, replay and repair receipts |

## Credentials

- Authentication uses provider-supported flows exposed through the qualified Pi engine.
- Hunter Pi stores references or status, not raw tokens in workflow state.
- If Hunter Pi must own a credential store later, it uses the operating-system protected store behind a dedicated Interface and ADR.
- Environment variables are never dumped. Individual names may be checked for presence without recording values.
- Doctor reports `DETECTED`, `BLOCKED`, or `NOT_PROVEN` and redacts usernames, home paths, URLs with embedded credentials, and private command payloads.
- Import from raw Pi never copies opaque credential files.

## Model-provider data egress

Local-first describes ownership of canonical workflow state; it does not mean model interaction is offline. Unless a local model is selected, Pi may transmit selected prompts, conversation context, repository snippets, tool results, and metadata needed for a request to the configured model provider.

Before the first model request, Hunter Pi must:

- identify the selected provider and resolved endpoint category without exposing credentials;
- enumerate the data categories that may be sent and whether complete files can enter context;
- reference the provider/account retention and training controls while stating that Hunter Pi cannot enforce an external provider's policy;
- show Hunter-controlled network and telemetry settings, including any update, crash-report, or usage-analytics endpoints;
- obtain an explicit, versioned acknowledgement and allow cancellation as `BLOCKED`;
- keep credentials, complete private prompts, and raw transmitted content out of normal Evidence.

Changing provider, endpoint category, or material disclosure version requires acknowledgement again. Network integration tests use a recording fake endpoint and prove destination allowlisting, cancellation before send, payload-category accounting, and zero credential leakage. Any real provider test is separately authorized and records metadata only.

## Permission profiles

Permission decisions apply to Hunter-owned tools and Pi tool calls that the Core Extension can observe, after all plugins load. They do not mediate arbitrary JavaScript or native code executed directly by an extension and are not an operating-system sandbox.

### Safe

- repository reads and explicitly safe inspection;
- no writes or shell mutation without confirmation;
- intended for review, diagnosis, and plugin recovery.

### Balanced

- repository-local edits and declared build/test commands may proceed;
- writes outside the workspace, destructive operations, credentials, remote writes, publishing, deployment, purchases, and privilege escalation require separate confirmation;
- proposed first-run default.

### Full Access

- broader local development actions are permitted after explicit opt-in;
- each remote write, publication, deployment, paid operation, credential access, privilege escalation, and destructive broad filesystem action still requires a separate explicit workflow decision and Receipt; selecting the profile cannot pre-authorize them;
- active status is continuously visible and included in Attempt identity.

No profile allows silent secret recording or evidence falsification.

Activating an ordinary Pi extension grants it the Agent process's filesystem, process, network, and credential-access authority. A permission prompt can govern a registered tool call but cannot prove that the extension did not perform the same effect directly. A Managed Change requiring verified containment therefore runs Core-only or with plugins whose independent Isolation result is `CONTAINED`; otherwise the UI records `PROCESS_AUTHORITY` or `NOT_PROVEN` and blocks or downgrades the applicable safety claim.

## Plugin security

Pi package installation is code installation. Before activation Hunter Pi records:

- requested and resolved source;
- exact version/tag/commit and integrity when available;
- license metadata where available;
- declared extensions, skills, prompts, and themes;
- dependency installation behavior;
- newly registered or overridden tools/commands/hooks;
- Compatibility Receipt, Trust decision, and Isolation result;
- configuration scope: user or project.

Managed Change may block an unverified, untrusted, uncontained, or critical-hook plugin even if Quick Session allows it. Safe Mode must work without evaluating user plugin code.

Future sandboxing is an adapter choice and must not be overstated. Until an isolation implementation is verified, plugins are reported as having the user's process authority.

## Workspace and filesystem

- Managed Change writes are scoped to an exact leased worktree.
- Broad, unresolved, home, root, or workspace-root destructive targets are rejected.
- Symlinks, junctions, reparse points, and resolved paths are checked before recursive removal or move.
- Temporary mutation probes create their own Git fixture and never use a real project.
- Cleanup is separate from success and has its own Receipt.
- Unique uncommitted or unpushed work is preserved rather than automatically deleted.

## Process execution

- Commands use argument arrays instead of shell-built strings whenever possible.
- The process host records executable identity, argument fingerprint, cwd identity, start time, timeout, and bounded outputs.
- Raw secret-bearing command text is not persisted.
- Windows process-tree containment is required for managed long-running commands.
- An uncertain process identity is not killed by PID alone and is not called cleaned up.
- Non-zero exit, timeout, cancellation, and launcher failure remain distinct outcomes.

## Evidence privacy

Evidence schemas use allowlisted fields rather than collecting and then redacting arbitrary objects. Redaction is defense in depth, not the primary collection strategy.

Forbidden portable content includes:

- tokens, cookies, passwords, API keys, authorization headers;
- complete environment dumps;
- provider credential files;
- complete private prompts or transcripts unless the user explicitly exports them outside normal Evidence;
- device-local absolute paths, including home, temporary, project, and tool paths;
- raw file content unrelated to a declared artifact;
- remote URLs containing credentials or private query parameters.

Task 3 uses strict content classes. `PRIVATE_PROMPT`, `ENVIRONMENT_DUMP`, and `CREDENTIAL_MATERIAL` are always digest-only placeholders in normal portable Evidence. `LOG` and `SUMMARY` pass through `hunter-redaction/1`, which removes configured sensitive values and encoded variants plus credential headers, Cookies, credential URLs/query fields, Prompt fields, and device-local absolute paths. Capture is limited to a valid UTF-8 prefix of at most 8 MiB; the digest binds the complete redacted stream, while byte counts, cursor, retention status, and truncation flags make omitted content explicit.

New local Evidence is accepted through `FileEvidenceStore.capture`, so persistence invokes that policy rather than accepting a caller-authored envelope. Capacity pressure converts noncritical retained content to explicit `DIGEST_ONLY` metadata while preserving its redacted-stream digest. Noncritical digest metadata still counts toward the Run stop and never consumes the emergency reserve; only critical Receipt/checkpoint/summary metadata may use that reserve. The reserve is filled with fresh random bytes and accepted only when its regular-file identity, single link, exact size, and allocated filesystem blocks all match; a sparse, linked, symlinked, or undersized file is not reclaimable capacity. A committed critical write that cannot restore the reserve is reported as `RESERVE_REQUIRED`. A new mutating Run also requires minimum capacity headroom and a successful atomic no-replace write probe, and remains blocked until all three admission conditions hold. These controls are deterministic local proof, not a claim that every future Provider or Plugin output is already covered.

## Update security

- Direct dependencies and upstream engine artifacts are exact and locked.
- Candidate metadata is fetched without executing package lifecycle scripts where supported.
- Build and qualification occur in isolated fixtures.
- Published artifacts are compared to the qualified candidate by digest.
- Stable promotion requires actual Windows and Ubuntu CI for the exact source commit.
- Updater changes are atomic and retain a known-good rollback version.
- Schema migration creates backups or reversible journals and never deletes old state before validation.
- Signing strategy and Windows publisher identity remain open decisions; no unsigned preview is described as a production-trusted installer.

## Security verification gates

Before daily-use preview:

1. secret/redaction corpus tests pass;
2. malicious and malformed plugin fixtures fail safely;
3. critical tool override is detected;
4. Safe Mode starts with a broken user plugin set;
5. worktree cleanup adversarial tests cover symlink/junction and unique work;
6. process timeout leaves no matching child tree;
7. replay with mismatched payload is rejected;
8. corrupted checkpoint fails without overwriting state;
9. update rollback preserves project and credential references;
10. fake-endpoint tests prove provider disclosure, destination control, cancellation-before-send, and credential exclusion;
11. dependency and license inventories are published for the exact release.

Passing these gates reduces known risk; it does not establish a general sandbox or guarantee that arbitrary plugins are safe.
