# Release and update strategy

## Release unit

A Hunter Pi Distribution Release is one qualified, immutable set:

- Hunter Pi CLI/Product Shell;
- Workflow Kernel and schema versions;
- Core Extension and bundled resources;
- exact upstream Pi Engine Release;
- direct dependency lock;
- plugin Compatibility/Trust/Isolation policy and catalog snapshot;
- migration logic;
- installer/package artifacts;
- compatibility and verification receipts;
- rollback target.

The user updates this unit, not raw Pi independently.

## Versioning

Hunter Pi uses semantic versions for its own public behavior. The Pi engine version remains separately visible:

```json
{
  "hunterPi": "0.x.y",
  "engine": {
    "product": "pi",
    "version": "0.84.1",
    "qualification": "NOT_PROVEN"
  }
}
```

The example describes the current `0.1.0-dev.1` candidate before its exact remote gates finish. Historical 0.83 Distribution Releases and Evidence retain their original identities.

Schema versions evolve independently and declare readable/migratable ranges. A Hunter Pi patch release may include a new qualified Pi version only if compatibility and rollback gates pass and the user-visible risk is documented.

## Channels

### Development

Local builds from source. No update, support, or compatibility promise.

### Preview

Signed or checksummed candidate artifacts for bounded real use. May include newly qualified Pi or plugin behavior; known risks and rollback are mandatory.

### Stable

Promoted only after preview Evidence satisfies release criteria. Stable prioritizes compatibility and recovery over immediate upstream features.

Channel changes are explicit. Stable users do not silently receive preview artifacts.

## Candidate pipeline

1. Verify the owner-selected repository license, NOTICE/provenance policy, dependency licenses, and publication authority; then freeze source commit, lockfiles, version, Engine Release, and build environment.
2. Run formatting/lint, strict typecheck, unit tests, contract suites, and production build locally.
3. Build exact npm/portable/installer artifacts from the frozen checkout.
4. Install each artifact into a clean external fixture; do not test through workspace links.
5. Run Pi Extension, package, JSON/RPC, SDK/session, Fake Host, real-host, redaction, recovery, update, and rollback suites.
6. Push the exact source commit.
7. Wait for actual Windows and Ubuntu CI for that commit.
8. Compare CI artifacts and release candidates by digest.
9. Publish to Preview; run bounded daily-use acceptance.
10. Promote the exact artifact to Stable or retain it as rejected history.

No step may rewrite an earlier failure. Reruns are new attempts with new receipts.

## Packaging progression

### Stage A — source/developer

Run from the monorepo with a committed lockfile. Used only to build contracts and spikes.

### Stage B — npm preview

Publish or pack an exact CLI artifact that depends on or bundles the qualified Pi engine without resolving ambient global Pi. Validate `npx` and global install from a clean directory.

### Stage C — Windows daily-use preview

Provide a Windows x64 installer or portable artifact. Hunter Pi `0.1.0-dev.1` packages the existing versioned portable layout as `hpi-windows-x64.zip` and publishes the single maintained `scripts/install.ps1` both inside the ZIP and as a standalone Release asset. The artifact must:

- expose `hpi` predictably;
- install under the current user's `%LOCALAPPDATA%\HunterPi` by default without requiring ambient Node.js, npm, or Pi;
- verify the outer ZIP SHA-256 and the inner per-file manifest before installation;
- keep one stable `bin\hpi.cmd` on user PATH and update that PATH entry idempotently;
- detect other `hpi` commands, report the conflict, and never overwrite or uninstall them;
- preserve the operator's current working directory when the portable launcher starts the packaged CLI, including after the complete installation directory is copied outside the source repository;
- pin one exact Node 24 patch runtime through `.node-version`, shared by local packaging and every hosted CI job, plus the exact CLI dependency tree;
- select one active release through a Hunter-owned atomic pointer;
- keep releases side-by-side so a failed update can return to the previous one;
- preserve side-by-side raw Pi/OMP installs;
- identify publisher/signing status honestly;
- verify integrity before update;
- verify the active identity after activation and after rollback;
- reconcile interrupted activation or migration on the next launch;
- uninstall without deleting projects or user-selected archives;
- support rollback.

Task 11's original portable directory remains historical. The `0.1.0-dev.1` ZIP and PowerShell entry point are still intentionally unsigned `developer-preview`; checksums prove integrity, not publisher identity. The supported update commands remain `hpi update status --json`, `hpi update check`, `hpi update apply`, and `hpi update rollback`. `install.ps1` performs only a first installation or exact-release idempotent replay. If another release is already active, it fails closed and directs the operator to the update manager rather than bypassing qualification history. Windows CI builds both the complete hidden-state portable artifact and the three release assets, then installs the ZIP in an isolated temporary root. Ubuntu validates provider-neutral and cross-platform contracts but does not emit a Windows package.

The fixed hosted script entry is `https://raw.githubusercontent.com/hunterzheng1/hunter-pi/main/scripts/install.ps1`. Operators should download and inspect it, then pass an exact `-ReleaseTag`. The immutable asset URLs are under `https://github.com/hunterzheng1/hunter-pi/releases/download/<tag>/`. The Release must contain exactly `install.ps1`, `hpi-windows-x64.zip`, and `hpi-windows-x64.zip.sha256` for this distribution shape.

After the exact artifact's required main CI has passed, the release operator may run `npm run promote:windows-portable:compiled -- --root <portable-directory> --run <main-ci-run-id>`. The command does not accept caller-authored `PASS` metadata. It performs one `gh run view` and one `gh run download`, with no polling or log download, then requires an exact `push` to `main` in repository `hunterzheng1/hunter-pi`, workflow `CI`, the artifact's source commit, and all twelve declared release jobs: both unit-test jobs, both quality/platform-Evidence jobs, the Windows portable build/install job, both additional Windows package/install jobs, both Evidence aggregators, both Task 7 platform jobs, and the final CI gate. Non-qualification jobs such as scope selection and the skipped documentation-only job are ignored rather than changing the exact release job set. The downloaded `hpi-windows-x64-portable` bundle bytes and every non-qualification field in its packaged candidate must match the local installation exactly. New promotions write strict qualification Evidence v2 for this twelve-job contract; the explicit strict v1 reader remains available for immutable historical six-job Evidence.

Qualification is a first-class `QUALIFY` update operation. Its request binds `operationId`, canonical request fingerprint, path-free expected target, GitHub run identity, deadline, and fail-closed timeout; the operator derives the operation ID from that complete request and the numerically canonical run ID rather than raw CLI text or a calendar date. Promotion and production CLI apply/rollback use the same installation-owned manager state at `.hpi-update/manager`. The complete hosted portable directory includes hidden update state, and the two fixed `gh` calls consume one shared elapsed timeout budget derived from that local upload tree's exact aggregate regular-file bytes: a three-minute floor, 60 seconds of setup allowance plus transfer time at 1 MiB/s, and an eight-minute hard cap beneath the ten-minute operation deadline. The sizing walk rejects links, non-files, more than 100,000 entries, or more than 2 GiB before GitHub access. At the start of each Windows observation, the bounded runner launches the exact system `where.exe` inside a Job Object with `$PATH:gh.exe`, accepts only an absolute matching native filename from a clean successful result, and reuses that resolved executable for both fixed GitHub calls. It never invokes a shell, accepts a script extension, or performs unbounded filesystem probing in the Agent process. Linux leaves executable lookup inside the subreaper-contained process launch. Each CLI starts inside its containment boundary; the monotonic absolute deadline starts before Windows resolution and platform setup, actively requests process-tree termination when reached, and rejects even a later successful settlement. Stdout plus stderr consume one shared raw-byte ceiling. A missing or invalid executable, timeout, cancellation, output overflow, identity mismatch, non-empty process tree, open output stream, or unreconciled driver returns an unavailable observation with empty output; qualification never polls or silently retries. The manager journals exact replay; the Windows adapter writes an intent before the first metadata mutation, syncs and atomically publishes the strict run/artifact receipt under `.hpi-update/qualification-evidence/` without replacement, and keeps the intent until the hash-chained APPLIED Receipt is durable and acknowledged. Promotion changes only `portable-release-candidate.json` and the matching version directory's `.hpi-candidate.json`; the bundle and executable payload retain their original fingerprint. Same-operation replay and later already-qualified same-source invocations do not query GitHub again. Every rollback target from APPLY history is re-read from the installed version and must exactly match its journal identity and retained Evidence. The initial-install fallback additionally requires both the APPLY Receipt proving the release was previously active and the latest exact `QUALIFY/APPLIED` candidate identity preceding that proof. Missing identity proof, Evidence, run/job drift, metadata drift, artifact drift, symlinks, or damage fail closed.

Windows ARM64, macOS, and Linux installers remain unclaimed until separately validated.

## Update behavior

Hunter Pi disables or bypasses the bundled engine's independent self-update path for managed installations. Update checks may be asynchronous and privacy-configurable.

Before apply, the user sees:

- current and target Distribution Releases;
- current and target Engine Releases;
- migrations and irreversible changes;
- plugin Compatibility, Trust, or Isolation changes;
- expected restart and disk use;
- rollback availability.

Apply uses staged files and atomic activation. A failed health check reactivates the prior release.

## State migration

- Migrations operate on a backup or journaled copy.
- Old events remain readable or have a deterministic migration Receipt.
- Preview may introduce a migration only with rollback or explicit one-way warning.
- Stable cannot ship a one-way migration until export/recovery is proven.
- A Distribution Release never edits project Git content merely because the executable updated.

## Rollback

Rollback restores the previous executable, engine, Core Extension, and compatible schema reader. It does not claim that sessions created by a newer incompatible engine can resume.

Rollback success requires:

- exact target artifact integrity;
- executable health check;
- project configuration readability;
- explicit disposition for newer sessions/plugins/state;
- a rollback Receipt.

The first rollback after a portable installation is not exempt from these rules. If the initial release has not been qualified with exact hosted Evidence, the applying update did not record it as the previous active release, or its installed candidate/tree cannot be re-verified, rollback is blocked or fails while the current active release remains selected.

## Release evidence

Each release publishes or retains:

- source commit and tree identity;
- repository license, NOTICE/provenance manifest, and dependency/license inventory;
- engine source/version/integrity;
- build provenance and artifact digests;
- Windows/Ubuntu CI links and results;
- local external-install smoke results;
- real-host qualification summary;
- redaction/privacy result;
- known incompatibilities;
- rollback target and test result.

Missing or pending remote results remain visible. A release note is not a verification receipt.
