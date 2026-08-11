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
    "version": "0.83.0",
    "qualification": "NOT_PROVEN"
  }
}
```

The example is not a shipped manifest. Pi `0.83.0` is the initial research candidate, not yet qualified.

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

Provide a Windows x64 installer or portable artifact. The current Task 11 implementation selects a portable directory as the first usable shape; installer technology remains an open decision. The artifact must:

- expose `hpi` predictably;
- preserve the operator's current working directory when the portable launcher starts the packaged CLI, including after the complete installation directory is copied outside the source repository;
- pin the Node 24 runtime and exact CLI dependency tree;
- select one active release through a Hunter-owned atomic pointer;
- keep releases side-by-side so a failed update can return to the previous one;
- preserve side-by-side raw Pi/OMP installs;
- identify publisher/signing status honestly;
- verify integrity before update;
- verify the active identity after activation and after rollback;
- reconcile interrupted activation or migration on the next launch;
- uninstall without deleting projects or user-selected archives;
- support rollback.

Task 11's portable artifact is intentionally unsigned `developer-preview` with `qualification=NOT_PROVEN`. It is suitable for bounded local evaluation of the Hunter-owned launcher/update path; it is not a Stable or publisher-qualified release. The supported update commands are `hpi update status --json`, `hpi update check`, `hpi update apply`, and `hpi update rollback`. The Windows CI job builds this artifact from the already completed quality build and retains it for 14 days; Ubuntu validates the provider-neutral and cross-platform contracts but does not emit a Windows package.

After the exact artifact's required main CI has passed, the release operator may run `npm run promote:windows-portable:compiled -- --root <portable-directory> --run <main-ci-run-id>`. The command does not accept caller-authored `PASS` metadata. It performs one `gh run view` and one `gh run download`, with no polling or log download, then requires an exact `push` to `main` in repository `hunterzheng1/hunter-pi`, workflow `CI`, the artifact's source commit, and the six declared Windows/Ubuntu quality, containment, and Evidence jobs all completed successfully. It also requires the downloaded `hpi-windows-x64-portable` bundle bytes and every non-qualification field in its packaged candidate to match the local installation exactly.

Qualification is a first-class `QUALIFY` update operation. Its request binds `operationId`, canonical request fingerprint, path-free expected target, GitHub run identity, deadline, and fail-closed timeout; the operator derives the operation ID from that complete request rather than a calendar date. The two fixed `gh` calls consume one shared elapsed timeout budget. The manager journals exact replay; the Windows adapter writes an intent before the first metadata mutation, syncs and atomically publishes the strict run/artifact receipt under `.hpi-update/qualification-evidence/` without replacement, and keeps the intent until the hash-chained APPLIED Receipt is durable and acknowledged. Promotion changes only `portable-release-candidate.json` and the matching version directory's `.hpi-candidate.json`; the bundle and executable payload retain their original fingerprint. Same-operation replay and later already-qualified same-source invocations do not query GitHub again. A later first rollback may consult that installed candidate only after the update journal independently proves that release was previously active and the candidate still binds its exact retained Evidence. Missing Evidence, run/job drift, metadata drift, artifact drift, symlinks, or damage fail closed.

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
