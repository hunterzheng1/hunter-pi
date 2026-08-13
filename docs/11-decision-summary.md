# Decision summary

Date: 2026-08-03

The following decisions form the initial owner-approved Hunter Pi baseline.

1. Hunter Pi is a new, independently installable personal coding Agent product.
2. Its user-facing terminal command is provisionally `hpi`; final package/name availability is verified before publication.
3. Hunter Pi is not a runtime skin for Hunter-Harness and does not require Hunter-Harness to run.
4. Selected Hunter-Harness mechanisms are reimplemented as a Hunter Pi-owned Workflow Kernel: planning, Attempts, independent verification, Evidence, bounded fixback, recovery, and knowledge provenance.
5. Hunter Pi initially uses official Pi as its underlying interactive engine through public Extension, Pi Package, JSON, RPC, and SDK surfaces.
6. Pi is pinned to an exact qualified Engine Release. The research candidate is Pi `0.83.0`; it is not yet locally qualified.
7. Hunter Pi does not initially Fork Pi. A fork requires a reproduced public-interface blocker and a new accepted ADR.
8. Oh My Pi is a high-value feature and implementation reference, not the base repository or runtime dependency.
9. OMP-derived behavior is evaluated and ported one module at a time with license and source provenance; OMP-private types do not enter the Workflow Kernel.
10. Standard Pi Packages are the primary third-party extension format.
11. Package installation or upstream popularity proves neither compatibility nor safety. Hunter Pi reports Plugin Compatibility, Trust, and Isolation as independent dimensions bound to an exact release, engine, platform, source, version/ref, and configuration.
12. Hunter Pi uses an isolated configuration root and does not silently load or mutate raw Pi settings, sessions, packages, or credentials.
13. Users receive qualified upstream Pi updates through Hunter Pi's updater; the bundled engine does not independently drift to `latest`.
14. Quick Session provides low-ceremony interaction and no verified delivery claim by default.
15. Managed Change provides immutable Plan Revisions, isolated workspace ownership, append-only Attempts, independent Verification, review, and Evidence. A Run binds exactly one Plan Revision; a changed plan supersedes and cancels that Run and starts a linked new Run.
16. Agent return, model text, terminal idle, process exit, and plugin success are Observations only.
17. Retry, recovery, and loop continuation create new Attempts and preserve failure history.
18. Managed loops are bounded by iteration, elapsed time, budget, repeated-failure, and deterministic stop policies.
19. Windows x64 is the first hard acceptance platform; Ubuntu is required for provider-neutral CI. Other platform support remains unclaimed until tested.
20. The first product is CLI/TUI only. Desktop, mobile, team governance, hosted source, and multi-tenant services are deferred.
21. The first-run permission default is proposed as `Balanced`; `Safe` and explicit `Full Access` are supported product profiles. These profiles mediate observable Hunter/Pi tool calls and are not an OS sandbox; ordinary executable plugins have process authority unless independent isolation proves otherwise. Even `Full Access` cannot pre-authorize credential access, remote writes, publishing, deployment, paid operations, privilege escalation, or broad irreversible filesystem actions. Task 5 only supplies a named-path credential guard and explicitly marks arbitrary content detection `NOT_PROVEN`; it does not yet satisfy the complete product guarantee.
22. A downloadable Windows artifact follows, rather than precedes, a passing npm/CLI vertical slice.
23. The initial repository is `hunterzheng1/hunter-pi`; the archived Hunter Platform and active Hunter-Harness repositories remain unchanged.
24. Run outcome and Archive status are separate. Any ready, failed, blocked, cancelled, or incomplete Run may be archived without rewriting its outcome.
25. Local-first means local canonical state, not zero network egress. First run shows a non-blocking summary of the default model-provider destination and data categories, with full privacy details available on demand. Interactive requests begin only when the user submits a prompt; custom destinations, Managed Change, Pilot, automation and other higher-risk capabilities keep explicit scoped authorization.
26. Hunter Pi original source and documentation use the MIT License. Third-party material retains its own terms and requires an immutable NOTICE/provenance record before incorporation or publication.
27. The standard Pi Package path may metadata-qualify and activate exact non-executable resources,
    but executable extensions remain quarantined until an independent exact compatibility verifier
    exists. Runtime path bindings stay device-local; portable Manifest and qualification Evidence
    remain path-free. A failed startup revalidation selects Safe Mode rather than evaluating the
    package. Qualified runtime bytes come from a Hunter-owned read-only content snapshot rather than
    the mutable source; bounded child-process installation and exact managed-snapshot cleanup are
    required. This is not an OS-containment claim against same-authority concurrent mutation.

## 2026-08-13 release addendum

28. Hunter Pi `0.1.0-dev.1` selects exact Engine Release `@earendil-works/pi-coding-agent@0.84.1`; npm integrity, Git commit, installed tree, JSON/RPC delta-only streaming, Extension, and SDK are independently probed.
29. The Windows preview distribution is one checksummed `hpi-windows-x64.zip` plus one maintained `scripts/install.ps1`, published both inside the ZIP and as a standalone GitHub Release asset. The script depends only on Windows PowerShell and the bundled runtime.
30. The default installation root is `%LOCALAPPDATA%\HunterPi`; the stable command is `bin\hpi.cmd`. PATH mutation is user-scoped and idempotent. Other `hpi` commands are reported but never overwritten or uninstalled.
31. The installer owns bootstrap only. A different active release must flow through the existing qualified update manager; the installer cannot bypass its Evidence, journal, side-by-side activation, or rollback rules.
32. Checksums and local CI establish integrity, not code-signing identity. The artifact remains unsigned `developer-preview`.
33. Task 12 Evidence from the 0.83 Distribution Release remains historical and cannot establish 0.84.1 Provider reliability, real-repository safety, production readiness, or daily-use acceptance.

## Open owner decisions

These choices are intentionally not frozen by this baseline:

- final npm package and executable names after registry/name checks;
- Windows signing/publisher arrangement and any future installer technology beyond the preview PowerShell/ZIP shape;
- whether Stable 1.0 defaults to `Balanced` or another permission profile after usability/security evidence;
- optional cloud synchronization or Hunter-Harness interoperability protocol;
- whether a future interface blocker justifies a Pi patch or fork;
- which OMP-inspired capabilities, if any, enter version one after the core vertical slice.

ADR-0006 resolves the public-license prerequisite for Task 1. External code still cannot be incorporated without its required NOTICE/provenance record, and artifact publication remains separately unauthorized. The remaining open decisions do not block Tasks 1–4 unless a task explicitly names them as prerequisites.
