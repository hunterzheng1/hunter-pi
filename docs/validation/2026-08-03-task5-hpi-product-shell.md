# Task 5 — `hpi` product-shell validation

- Validation date: 2026-08-03; real-terminal update: 2026-08-04
- Product artifact: `@hunter-pi/cli@0.1.0-dev.0`
- Engine Release: `@earendil-works/pi-coding-agent@0.83.0`
- Local platform: Windows / Node.js 24
- Implementation commit: `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b`; smoke-clarity commit: `2a357795a2ae61c9db935ff11a922bbfe05ec892`
- Merge commits: `8573b1f62d154275bb81c3c07b432a3db40632bb`, `0e58f539b713edb35f46fcbb55a63063dbbfa328`
- Pull requests: [#9](https://github.com/hunterzheng1/hunter-pi/pull/9), [#13](https://github.com/hunterzheng1/hunter-pi/pull/13)
- Remote Windows/Ubuntu CI: **PASS for the implementation and exact merge commits**
- Automated product result: **PASS within the scope below**
- Clean-main Windows user installation: **PASS**
- Real Windows interactive TUI: **DETECTED within startup/Core/command-display/clean-exit/manual-acknowledgement bounds**
- Bundled Core compatibility in the real TUI: **UNVERIFIED**
- Real Provider login/request: **NOT_PROVEN**
- Managed Change: **NOT_IMPLEMENTED**

## Proven boundary

The Task 5 automated suite proves that the developer preview can:

- build one npm tarball with `hpi`, a bundled Hunter product shell/Core Extension, source-commit stamp, separate SHA-256 identities for `hpi.js` and Core, and exact Pi 0.83.0 dependency;
- install that tarball in clean local and isolated global npm profiles;
- orchestrate an empty-profile seven-step first run through prerequisite Doctor, default Provider/model/permission disclosure, explicit login handoff, Core-only plugin state, and final Doctor without automatically authenticating or sending a model request;
- preserve an existing raw `pi` command sentinel during the isolated global installation;
- report product/Engine/source/update-channel identity with `hpi version --json`;
- keep Hunter configuration and Pi auth/session roots outside raw `~/.pi`;
- reject symlink/junction entries and multi-link files anywhere in the isolated Pi runtime or Session tree before reading or launching it;
- require a matching versioned disclosure before Provider-capable launch and record cancellation as `BLOCKED` without prompt or credential content;
- resolve and display the exact Provider origin before consent, bind it plus `ExternalRetention=NOT_PROVEN`, `TrainingUse=NOT_PROVEN`, and `AccountControls=PROVIDER_OWNED` into disclosure v2026-08-03.2, and require re-acknowledgement after origin/status drift;
- make Doctor freshly resolve that current destination offline and block stale disclosure readiness before launch;
- ask Pi's public `ModelRuntime.getProviderAuthStatus()` for readiness metadata while discarding labels; Pi Engine parses its credential storage, while the Hunter host receives and persists no credential value;
- run every mutating Git Doctor probe in an automatically created temporary Git fixture and redact portable Doctor output;
- plan a Safe Mode launch with only the bundled Core Extension path and no skills, prompt templates, themes, or context files, even when a configured user extension would throw on import; the 2026-08-04 exact-artifact real TUI rendered the bundled Core and its explicit command receipt before a clean exit and affirmative acknowledgement;
- reject all enabled user plugins in Task 5 before execution; plugin source/version/ref/scope approval remains a later plugin-manager task;
- execute fixed Pi against a recording loopback fake endpoint and prove cancellation-before-send, exact-origin preflight, Provider-managed override rejection, Provider/model/origin pinning, one expected request, exact payload-category accounting, and credential-free Evidence surfaces;
- execute fixed Pi RPC in a temporary Git fixture and prove Safe Mode intercepts a direct user bash command without creating its marker file; prove a context-file sentinel is absent from the real request payload;
- detect exact packaged product-shell/Core SHA-256 values and fail closed before a readiness claim when either executable surface changes;
- inspect or disable plugin metadata without executing or deleting plugin code;
- show repository/model/Provider/permission and separate Compatibility/Trust/Isolation dimensions in the CLI and Core TUI widget;
- ask before recognized credential-like file paths in Balanced and Full Access, block them in Safe Mode, and visibly state that this is a named-path guard whose arbitrary content detection is `NOT_PROVEN`;
- treat a Pi process exit as `PROCESS_EXIT` with `VerifiedChange=NOT_CLAIMED`;
- require exact packaged product-shell/Core SHA values plus explicit post-run manual confirmation before recording mutable local TUI readiness as `DETECTED`; changing either executable surface invalidates it, and it is not a canonical Human Receipt.

The default disclosure references current OpenAI documentation that says privacy/data commitments vary by workspace plan, configuration, surface, feature, and region, and that connected systems have their own controls. Hunter Pi presents the reference and explicitly says it cannot enforce the Provider's external policy: [OpenAI ChatGPT Work privacy and data commitments](https://learn.chatgpt.com/docs/enterprise/work-admin-faq#how-does-chatgpt-work-support-enterprise-privacy-and-data-commitments).

## Local automated results

| Command or test | Result | Bound claim |
|---|---|---|
| `npm test` | PASS — 26 files / 212 tests | domain, workflow, Evidence, Pi spike, and Task 5 unit/integration behavior |
| focused Task 5 tests | PASS — 5 files / 51 tests | configuration, Doctor, launcher/Core/Safe Mode, CLI, fake-endpoint egress, and negative cases |
| `npm run typecheck` | PASS | strict public and product-shell TypeScript boundary |
| focused ESLint | PASS | changed source/tests/scripts |
| `npm run build` | PASS | project references plus bundled `hpi.js` and Core Extension |
| `npm run package-smoke` | PASS | clean package imports; one-artifact local/global install; Pi 0.83.0; product-shell/Core SHA plus tamper rejection; Doctor expected `BLOCKED`; raw Pi unchanged |
| `npm run clean-install-smoke` | PASS | clean locked npm install |
| `npm run probe:pi` | `ProviderIndependentProbe=SUPPORTED; RealProvider=NOT_PROVEN` | fixed Pi public interfaces only |
| `npm run verify` | PASS | lint, typecheck, 212 tests, strict fixture, build, format, package smoke, clean install, and Pi probe |
| `hpi version --json` from the installed artifact | PASS | product, Engine, source stamp state, update channel |
| installed `hpi doctor --json` without setup/login | expected exit 2 / `BLOCKED` | missing setup/login is not reported as success; Engine is actually detected |
| focused smoke-clarity tests | PASS — 2 files / 35 tests | explicit `/hunter-status` receipt marker, strict model pinning without unauthenticated model-cycle scoping, and exact operator instruction |
| installed `hpi doctor --json` after the acknowledged TUI smoke | expected exit 2 / `BLOCKED` | `interactive_tui=DETECTED`; Provider authentication alone remains `BLOCKED` |

The final private-path scan and `git diff --check` passed. The pre-commit path review found only Task 5 product-shell, validation, build, dependency, and contributor-status files. Focused commit `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` was created from a clean worktree, pushed, and merged without rewriting its failure history.

## Remote and installed-artifact results

| Exact source | Result | Evidence |
|---|---|---|
| PR commit `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` | PASS — Ubuntu 2m24s; Windows 11m50s; cross-platform Evidence 29s | [GitHub Actions run 30852408933](https://github.com/hunterzheng1/hunter-pi/actions/runs/30852408933) |
| merge commit `8573b1f62d154275bb81c3c07b432a3db40632bb` | PASS — Ubuntu 2m20s; Windows 13m10s; cross-platform Evidence 38s | [GitHub Actions run 30853360439](https://github.com/hunterzheng1/hunter-pi/actions/runs/30853360439) |
| clean-main tarball `@hunter-pi/cli@0.1.0-dev.0` | PASS — 112076 bytes; SHA-256 `962c4b25cb97911cdc727721b96ed91c0afc8a646d44f30ff4a06cf96ec8ade6` | built after the merge CI passed; installed for the current Windows user without creating or replacing a raw `pi` command |
| installed `hpi version --json` | PASS — source `8573b1f62d154275bb81c3c07b432a3db40632bb`, `sourceState=CLEAN`, Pi `0.83.0` | product shell `sha256:fc7230b9388c715eca3a37b5bd4f70e8583f50cba54c6c35145534620a2d42a3`; Core `sha256:60555863b914f53945eb0889044a594a65f161d67a6eb0b587132b3f8a6e15c7` |
| installed `hpi doctor --json` before setup/login/TUI smoke | expected exit 2 / `BLOCKED` | Node, temporary Git fixture, Pi Engine, and Core were `DETECTED`; configuration/disclosure/auth remained `BLOCKED`, interactive TUI remained `NOT_PROVEN` |
| smoke-clarity PR commit `2a357795a2ae61c9db935ff11a922bbfe05ec892` | PASS — Ubuntu 2m10s; Windows 13m50s; cross-platform Evidence 38s | [GitHub Actions run 30870673783](https://github.com/hunterzheng1/hunter-pi/actions/runs/30870673783) |
| exact code-bearing merge `0e58f539b713edb35f46fcbb55a63063dbbfa328` | PASS — Ubuntu 2m23s; Windows 21m39s; cross-platform Evidence 35s | [GitHub Actions run 30871449955](https://github.com/hunterzheng1/hunter-pi/actions/runs/30871449955) |
| exact installed tarball `@hunter-pi/cli@0.1.0-dev.0` | PASS — 112119 bytes; SHA-256 `570d3eaf660f353717e0ab6b1f3da8b14ed6dc24cd99a22fe71850dc5ac3f3f8` | built from clean source `0e58f539b713edb35f46fcbb55a63063dbbfa328`; product shell `sha256:83880409f7e568c40438a7d162b65de94ecf4064e49d7ef59c250e445bc4fccf`; Core `sha256:e431d4bd026984737a3e23b560f67a3f80076da5b1e4f403481b8850ab54858c` |
| installed `hpi doctor --json` after the acknowledged smoke | expected exit 2 / `BLOCKED` at `2026-08-04T02:56:49.585Z` | Node, temporary Git fixture, Pi Engine, configuration, disclosure, Core, and interactive TUI were `DETECTED`; Provider authentication remained `BLOCKED` |

The global command resolves for the current user, but its absolute installation path is intentionally not committed. The installation and manual-smoke results are not an npm publication, installer, signature, authentication, Provider, Compatibility, containment, or Managed Change proof. A later documentation-only commit does not become a new executable artifact and does not invalidate or replace the exact `0e58f539b713edb35f46fcbb55a63063dbbfa328` receipt.

## Preserved RED and failure history

Task 5 did not erase the following real failures:

1. Configuration, Doctor, launcher, and CLI tests first failed because their product APIs did not exist; each cluster then moved to GREEN.
2. A direct TypeScript import of Pi `ModelRuntime` expanded incompatible third-party declarations under TypeScript 6. The adapter was changed to a computed runtime import with a narrow local interface; strict checking remained enabled.
3. The first standalone CLI tarball failed installation with npm `E404` because it referenced unpublished Hunter workspaces.
4. The first internal-dependency bundle installed `hpi version` but left Pi 0.83.0 unmet. The exact Pi dependency was promoted to the product manifest and Doctor was changed to inspect actual installation metadata.
5. CommonJS `createRequire().resolve()` could not select Pi's import-only package export in the external artifact. Both launcher and Doctor now use `import.meta.resolve()` and have regression tests.
6. npm `bundledDependencies` passed a local install but produced empty/invalid public-dependency directories in an isolated Windows global install. Hunter-owned runtime code and Zod are now built into `hpi.js`; only exact Pi 0.83.0 remains a normal runtime dependency. The same local/global smoke then passed.
7. The strict CLI/resource/origin cluster first failed five focused cases: an unknown `quik` command fell through to Quick, Safe Mode still loaded context files, custom origins could bypass the configured destination, and model/origin drift was not terminated. Strict parsing, `--no-context-files`, exact destination preflight, and runtime pinning then moved the cluster to GREEN.
8. Requiring every launch to inspect the complete Session tree initially failed four fixture expectations. The fixtures were corrected to express the new precondition; linked and multi-link runtime/session trees now fail closed.
9. Binding consent to the actual resolved destination first failed two launcher expectations that still expected the prior error code. They now require `DISCLOSURE_REQUIRED` before any later destination/auth decision.
10. A late negative-test cluster produced three failures showing `secrets.json`, `.envrc`, `token.json`, and `service-account.json` could be read under Full Access without confirmation and the limitation was absent from the UI. The named-path policy now asks or blocks across profiles, while the header and documentation explicitly keep arbitrary content detection `NOT_PROVEN`.
11. The first final `npm run verify` after those fixes reached the last Pi probe and failed because a concurrent review fixture command accidentally ran `npm init`/`npm install` in the checkout, changing the root package identity to a review-only name. The original `hunter-pi` manifest was restored, `npm install` reconciled the lockfile and install tree, and the failure remains recorded here rather than being presented as a product PASS.
12. Replacing Node's deprecated `shell: true` Windows shim smoke with an explicit non-shell spawn first failed check-mode TypeScript `TS4111` on dot access to an indexed environment. Bracket access fixed the exact boundary; typecheck and the warning-free package smoke then passed.
13. Final review reproduced a stale TUI acknowledgement across two dirty artifacts with the same commit but different Core bytes, and a Doctor disclosure result that did not refresh the current Provider origin. Five new negative cases first failed. The receipt now requires the packaged Core SHA, unstamped source cannot record it, and Doctor shares the launch destination classifier; the focused cluster then passed 50 tests.
14. A second review reproduced the same stale acknowledgement when only `hpi.js` changed and Core stayed byte-identical. The new negative test first failed because no product-shell identity existed. Packaging and `hpi version` now stamp and verify the product-shell SHA separately, the receipt binds both executable digests, and installed package smoke tampers each surface independently.
15. The first post-closeout `main` run, [GitHub Actions 30855728356](https://github.com/hunterzheng1/hunter-pi/actions/runs/30855728356), preserved an Ubuntu PASS but GitHub cancelled Windows at the quality job's exact 20-minute limit. Every completed Windows assertion had passed; `package-smoke` alone took 14m31s under that run's network conditions, and `clean-install-smoke` was cancelled after 3m37s before repository Doctor or Pi Evidence could run. This remains a real CI FAIL, not a product PASS. The quality-job ceiling was raised from 20 to 40 minutes; replacement commit `315d82359401d287f2b5637d2dda78730c435a7e` then passed [PR Windows/Ubuntu and aggregate Evidence CI](https://github.com/hunterzheng1/hunter-pi/actions/runs/30857307594), and merge `160080eddde80d98ada58c8c78f3ccbe6754cc1a` passed the same [main gates](https://github.com/hunterzheng1/hunter-pi/actions/runs/30858230199).

## Manual Windows TUI gate

### 2026-08-04 real-terminal attempt

The owner ran the installed product from an external Windows PowerShell after accepting disclosure `2026-08-03.2`. Pi `0.83.0` rendered, listed the exact bundled `core-extension.js`, displayed the Hunter header, and printed the Core identity and claim-boundary payload registered by `/hunter-status`. No credential, environment dump, private prompt, or absolute user path was captured in this Evidence.

The payload began directly with `Core=hunter-pi/core@0.1.0-dev.0` and visually resembled startup diagnostics, so the owner reported that `/hunter-status` had no response. Source-path tracing confirmed that this exact payload can only be emitted by the registered command handler; the command executed, but its result was not recognizable. Pi also printed `No models match pattern` because the smoke plan passed the selected model through `--models`, whose scope resolver considers only authenticated models, even though the separate strict `--model` selection succeeded and the footer displayed the intended model. The unrelated missing-`fd` offline warning did not prevent Core or command execution.

This attempt remains `NOT_PROVEN`: the user-observed ambiguity is a real usability failure, and no clean-exit acknowledgement was recorded. The corrective cluster adds the explicit prefix `HunterStatus=DETECTED Command=/hunter-status`, keeps strict `--model` pinning, omits unauthenticated model-cycle scoping, and requires a new exact-artifact Windows rerun after merge and installation. It does not prove Provider authentication or a Provider request.

The corrective cluster preserved its RED history: the first focused run failed because the unauthenticated Safe plan still contained `--models` and the command payload still began directly with `Core=`; the CLI-instruction test then failed because it did not tell the user which receipt marker to find. After the minimal changes, the two focused files passed 35 tests. The complete local `npm run verify` passed 26 files / 212 tests plus lint, typecheck, strict ESM compilation, build, formatting, external package smoke, single-artifact smoke, clean npm install, and the fixed-Pi public-interface probe. That probe still reported `ProviderIndependentProbe=SUPPORTED; RealProvider=NOT_PROVEN`. At that point remote CI and the replacement exact-artifact Windows smoke remained pending; both were subsequently completed as recorded below.

### 2026-08-04 exact-artifact replacement attempt

After PR #13 and its exact merge passed all remote gates, the owner installed the 112119-byte tarball bound to clean source `0e58f539b713edb35f46fcbb55a63063dbbfa328` and reran `hpi smoke tui` from an external Windows PowerShell in a Git repository. No model request was sent. Pi rendered, loaded the bundled Core, showed the Hunter header, and `/hunter-status` began with `HunterStatus=DETECTED Command=/hunter-status`; the prior unauthenticated model-cycle warning was absent. The missing-`fd` offline notice remained visible but did not block any required observation.

The owner exited cleanly and answered the final acknowledgement `y`. The CLI returned `TuiSmoke=DETECTED Acknowledgement=MANUAL Provider=NOT_PROVEN CoreCompatibility=UNVERIFIED`. A subsequent `hpi doctor --json` at `2026-08-04T02:56:49.585Z` reported Node, the automatic temporary Git fixture, Pi Engine, configuration, disclosure, bundled Core, and interactive TUI as `DETECTED`; `provider_auth` remained `BLOCKED`, so Doctor honestly remained overall `BLOCKED`. No credential, environment dump, private prompt, model request, or absolute user path was captured.

This closes Task 5's real Windows TUI gate for the exact installed artifact. Process exit by itself still proves nothing: the result depends on the explicit acknowledgement and both executable SHA-256 identities. It does not prove Provider authentication, a Provider request, Core Compatibility, global mediation, OS containment, a Managed Change, or production readiness.

Real `hpi login`, OAuth/browser authorization, API-key entry, and any paid Provider request are deliberately outside this automated receipt. Hunter does not need the user to paste credentials into its CLI or Evidence.

## Non-claims

- `DETECTED` auth metadata is not proof that a Provider request succeeds.
- The manual TUI smoke acknowledgement is mutable local readiness state, not a canonical Human Receipt and not Provider, security, containment, or Managed Change verification.
- Safe Mode tool mediation is not an operating-system sandbox; the bundled Core and any normal-mode extension have process authority. Pi built-in slash commands run outside the Task 5 global mediation claim, all-provider-request blocking is `NOT_PROVEN`, and `/share` remote-write mediation is explicitly `NOT_PROVEN`.
- Credential guarding is conservative but incomplete: recognized names and known stores are mediated, while credential content in an arbitrary innocently named file remains `NOT_PROVEN`.
- Core and third-party plugin Compatibility remain `UNVERIFIED` in Task 5; neither Trust nor process authority may promote them to `VERIFIED`.
- Quick Session edits are not a verified Change.
- No npm publication, Windows installer, signature, updater, production release, or real remote write occurred.
