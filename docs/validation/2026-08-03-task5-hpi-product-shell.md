# Task 5 — `hpi` product-shell validation

- Validation date: 2026-08-03
- Product artifact: `@hunter-pi/cli@0.1.0-dev.0`
- Engine Release: `@earendil-works/pi-coding-agent@0.83.0`
- Local platform: Windows / Node.js 24
- Implementation commit: `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b`
- Merge commit: `8573b1f62d154275bb81c3c07b432a3db40632bb`
- Pull request: [#9](https://github.com/hunterzheng1/hunter-pi/pull/9)
- Remote Windows/Ubuntu CI: **PASS for the implementation and exact merge commits**
- Automated product result: **PASS within the scope below**
- Clean-main Windows user installation: **PASS**
- Real Windows interactive TUI: **PENDING manual smoke acknowledgement**
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
- plan a Safe Mode launch with only the bundled Core Extension path and no skills, prompt templates, themes, or context files, even when a configured user extension would throw on import; exact bundled-Core execution in a real TUI remains pending;
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

The final private-path scan and `git diff --check` passed. The pre-commit path review found only Task 5 product-shell, validation, build, dependency, and contributor-status files. Focused commit `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` was created from a clean worktree, pushed, and merged without rewriting its failure history.

## Remote and installed-artifact results

| Exact source | Result | Evidence |
|---|---|---|
| PR commit `a5bbd4d5ef7536377f573aebf76c1d3364da1e8b` | PASS — Ubuntu 2m24s; Windows 11m50s; cross-platform Evidence 29s | [GitHub Actions run 30852408933](https://github.com/hunterzheng1/hunter-pi/actions/runs/30852408933) |
| merge commit `8573b1f62d154275bb81c3c07b432a3db40632bb` | PASS — Ubuntu 2m20s; Windows 13m10s; cross-platform Evidence 38s | [GitHub Actions run 30853360439](https://github.com/hunterzheng1/hunter-pi/actions/runs/30853360439) |
| clean-main tarball `@hunter-pi/cli@0.1.0-dev.0` | PASS — 112076 bytes; SHA-256 `962c4b25cb97911cdc727721b96ed91c0afc8a646d44f30ff4a06cf96ec8ade6` | built after the merge CI passed; installed for the current Windows user without creating or replacing a raw `pi` command |
| installed `hpi version --json` | PASS — source `8573b1f62d154275bb81c3c07b432a3db40632bb`, `sourceState=CLEAN`, Pi `0.83.0` | product shell `sha256:fc7230b9388c715eca3a37b5bd4f70e8583f50cba54c6c35145534620a2d42a3`; Core `sha256:60555863b914f53945eb0889044a594a65f161d67a6eb0b587132b3f8a6e15c7` |
| installed `hpi doctor --json` before setup/login/TUI smoke | expected exit 2 / `BLOCKED` | Node, temporary Git fixture, Pi Engine, and Core were `DETECTED`; configuration/disclosure/auth remained `BLOCKED`, interactive TUI remained `NOT_PROVEN` |

The global command resolves for the current user, but its absolute installation path is intentionally not committed. This installation result is not an npm publication, installer, signature, real TUI, authentication, or Provider proof.

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
15. The first post-closeout `main` run, [GitHub Actions 30855728356](https://github.com/hunterzheng1/hunter-pi/actions/runs/30855728356), preserved an Ubuntu PASS but GitHub cancelled Windows at the quality job's exact 20-minute limit. Every completed Windows assertion had passed; `package-smoke` alone took 14m31s under that run's network conditions, and `clean-install-smoke` was cancelled after 3m37s before repository Doctor or Pi Evidence could run. This is a real CI FAIL, not a product PASS. The quality-job ceiling was raised from 20 to 40 minutes; only a subsequent exact-commit CI run can validate the scheduling fix.

## Manual Windows TUI gate

After installing the exact tarball in a real Windows terminal and running `hpi setup`, execute:

```powershell
cd D:\path\to\a\git-repository
hpi smoke tui
```

Do not send a model request. Confirm that the Pi prompt renders, the Hunter header is visible, `/hunter-status` reports Core identity, `Compatibility=UNVERIFIED`, and `Isolation=PROCESS_AUTHORITY`, and exit returns to the terminal. Process exit alone records nothing. Only the final explicit confirmation writes mutable local manual-acknowledgement state tied to Pi 0.83.0, product/source/platform/configuration, and the exact packaged `hpi.js` plus Core SHA-256 values; declining, using an unstamped workspace build, observing an error, or changing either executable surface keeps or returns `NOT_PROVEN`.

Real `hpi login`, OAuth/browser authorization, API-key entry, and any paid Provider request are deliberately outside this automated receipt. Hunter does not need the user to paste credentials into its CLI or Evidence.

## Non-claims

- `DETECTED` auth metadata is not proof that a Provider request succeeds.
- The manual TUI smoke acknowledgement is mutable local readiness state, not a canonical Human Receipt and not Provider, security, containment, or Managed Change verification.
- Safe Mode tool mediation is not an operating-system sandbox; the bundled Core and any normal-mode extension have process authority. Pi built-in slash commands run outside the Task 5 global mediation claim, all-provider-request blocking is `NOT_PROVEN`, and `/share` remote-write mediation is explicitly `NOT_PROVEN`.
- Credential guarding is conservative but incomplete: recognized names and known stores are mediated, while credential content in an arbitrary innocently named file remains `NOT_PROVEN`.
- Core and third-party plugin Compatibility remain `UNVERIFIED` in Task 5; neither Trust nor process authority may promote them to `VERIFIED`.
- Quick Session edits are not a verified Change.
- No npm publication, Windows installer, signature, updater, production release, or real remote write occurred.
