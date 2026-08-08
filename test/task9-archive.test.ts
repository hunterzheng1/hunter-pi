import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  attemptIdSchema,
  observationIdSchema,
  planRevisionSchema,
  runSchema,
  verificationReceiptSchema,
} from "@hunter-pi/domain";
import {
  archivePackageSchema,
  assertPortableArchive,
  createPortableEvidenceEnvelope,
  FileRunArchiveStore,
  LocalStorageController,
  PortableDeviceImporter,
} from "@hunter-pi/evidence";
import {
  DurableWorkflowKernel,
  InMemoryWorkflowKernel,
  type RunProjection,
} from "@hunter-pi/workflow-kernel";
import { FileWorkflowEventStore } from "@hunter-pi/evidence";

import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

async function createTerminalProjection(
  root: string,
  outcome: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN" | "CANCELLED" = "NOT_PROVEN",
): Promise<{
  readonly projection: RunProjection;
  readonly events: Awaited<ReturnType<FileWorkflowEventStore["read"]>>;
  readonly evidence: readonly ReturnType<typeof createPortableEvidenceEnvelope>[];
}> {
  const fixture = createWorkflowDomainFixture({ suffix: "archive" });
  const planRevision = planRevisionSchema.parse({
    ...fixture.planRevision,
    loopPolicy: { ...fixture.planRevision.loopPolicy, maxIterations: 1 },
  });
  const run = runSchema.parse({ ...fixture.run });
  const eventStore = new FileWorkflowEventStore({ stateRoot: join(root, "workflow") });
  const kernel = new DurableWorkflowKernel(eventStore);
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "CREATE_RUN",
    change: fixture.change,
    planRevision,
    run,
  });
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "START_ATTEMPT",
    runId: run.runId,
    attemptId: attemptIdSchema.parse("att_archive-original"),
    startedAt: fixtureTimestamp,
  });
  if (outcome === "CANCELLED") {
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_archive-cancelled-exit"),
        runId: run.runId,
        attemptId: attemptIdSchema.parse("att_archive-original"),
        kind: "PROCESS_EXITED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      },
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CANCEL_RUN",
      runId: run.runId,
      reason: "ARCHIVE_FIXTURE_CANCELLED",
      endedAt: fixtureTimestamp,
    });
    return {
      projection: await kernel.project(run.runId),
      events: await eventStore.read(run.runId),
      evidence: [],
    };
  }
  const verification = verificationReceiptSchema.parse({
    schemaVersion: "1.0.0",
    verificationReceiptId: "verify_archive",
    runId: run.runId,
    attemptId: "att_archive-original",
    checkId:
      planRevision.checks.at(0)?.checkId ??
      (() => {
        throw new Error("archive fixture has no declared checks");
      })(),
    checkVersion: 1,
    checkDefinitionFingerprint: fixtureFingerprint,
    resultFingerprint: fixtureFingerprint,
    outcome,
    startedAt: fixtureTimestamp,
    endedAt: fixtureTimestamp,
    observedAt: fixtureTimestamp,
    inputFingerprint: fixtureFingerprint,
    configFingerprint: fixtureFingerprint,
    workspaceFingerprint: planRevision.workspaceFingerprint,
    sourceFingerprint: planRevision.sourceFingerprint,
    environmentFingerprint: fixtureFingerprint,
    resultStatus: { kind: "EXIT_CODE", exitCode: outcome === "PASS" ? 0 : 1, timedOut: false },
    output: {
      stdoutDigest: fixtureFingerprint,
      stderrDigest: fixtureFingerprint,
      artifactDigests: [],
      capturedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      redaction: { applied: false, fieldsRemoved: 0 },
    },
    evidenceIds: ["evidence_archive-verification"],
  });
  const evidence = createPortableEvidenceEnvelope({
    schemaVersion: "1.0.0",
    evidenceId: "evidence_archive-verification",
    kind: "verification",
    scope: {
      runId: run.runId,
      attemptId: "att_archive-original",
      verificationReceiptId: verification.verificationReceiptId,
    },
    createdAt: fixtureTimestamp,
    sourceFingerprint: fixtureFingerprint,
    summary: `Archive fixture verification outcome: ${outcome}.`,
    contentClass: "LOG",
    content: `The bounded archive fixture recorded the ${outcome} verification outcome.`,
  });
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "RECORD_OBSERVATION",
    observation: {
      schemaVersion: "1.0.0",
      observationId: observationIdSchema.parse("obs_archive-exit"),
      runId: run.runId,
      attemptId: attemptIdSchema.parse("att_archive-original"),
      kind: "PROCESS_EXITED",
      observedAt: fixtureTimestamp,
      evidenceIds: [evidence.evidenceId],
    },
  });
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "RECORD_VERIFICATION",
    receipt: verification,
  });
  return {
    projection: await kernel.project(run.runId),
    events: await eventStore.read(run.runId),
    evidence: [evidence],
  };
}

describe("Task 9 Run Archive", () => {
  it.each([
    ["READY", "PASS"],
    ["BLOCKED", "BLOCKED"],
    ["FAILED", "FAIL"],
    ["CANCELLED", "CANCELLED"],
    ["INCOMPLETE", "NOT_PROVEN"],
  ] as const)("freezes the %s terminal outcome without relabeling it", async (expected, input) => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      `hunter-pi-task9-archive-${expected.toLowerCase()}-`,
    );
    const fixture = await createTerminalProjection(root, input);
    const store = new FileRunArchiveStore({
      stateRoot: join(root, "archives"),
      kernel: new InMemoryWorkflowKernel([fixture.events]),
    });
    const suffix = expected.toLowerCase();
    const manifest = await store.finalize({
      schemaVersion: "hpi-archive-finalize.v1",
      operationId: `op_archive-${suffix}`,
      operationFingerprint: fixtureFingerprint,
      archiveId: `archive_task9-${suffix}`,
      distributionReleaseId: "release_task9",
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    });

    expect(manifest.outcome).toBe(expected);
    await expect(store.read(manifest.archiveId)).resolves.toEqual(manifest);
  });

  it("finalizes a terminal Run and replays the exact finalization idempotently", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-archive-");
    const fixture = await createTerminalProjection(root);
    expect(fixture.projection.run.lifecycle).toBe("INCOMPLETE");

    const kernel = new InMemoryWorkflowKernel([fixture.events]);
    const store = new FileRunArchiveStore({
      stateRoot: join(root, "archives"),
      kernel,
    });
    const request = {
      schemaVersion: "hpi-archive-finalize.v1" as const,
      operationId: "op_archive-finalize" as const,
      operationFingerprint: fixtureFingerprint,
      archiveId: "archive_task9" as const,
      distributionReleaseId: "release_task9" as const,
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    };

    const manifest = await store.finalize(request);
    await expect(kernel.project(fixture.projection.run.runId)).resolves.toMatchObject({
      run: { archiveStatus: "ARCHIVED", archiveId: request.archiveId },
    });
    expect(manifest).toMatchObject({
      archiveId: request.archiveId,
      runId: fixture.projection.run.runId,
      outcome: "INCOMPLETE",
      eventCursor: fixture.projection.eventCursor,
    });
    await expect(store.finalize(request)).resolves.toEqual(manifest);
    await expect(
      store.finalize({ ...request, operationFingerprint: `sha256:${"b".repeat(64)}` }),
    ).rejects.toThrow(/immutable|identity|fingerprint/u);
  });

  it("exports, imports, and deletes only the exact artifact while preserving the Archive", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-archive-portable-");
    const fixture = await createTerminalProjection(root);
    const sourceKernel = new InMemoryWorkflowKernel([fixture.events]);
    const source = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      kernel: sourceKernel,
    });
    const manifest = await source.finalize({
      schemaVersion: "hpi-archive-finalize.v1",
      operationId: "op_archive-finalize-portable",
      operationFingerprint: fixtureFingerprint,
      archiveId: "archive_task9-portable",
      distributionReleaseId: "release_task9",
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    });
    const packageOnlySource = new FileRunArchiveStore({ stateRoot: join(root, "source") });
    await expect(packageOnlySource.read(manifest.archiveId)).rejects.toThrow(
      /canonical Workflow Kernel binding/u,
    );
    const staleCanonicalSource = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      kernel: new InMemoryWorkflowKernel([fixture.events]),
    });
    await expect(staleCanonicalSource.read(manifest.archiveId)).rejects.toThrow(
      /archived canonical|Archive identity/u,
    );
    await expect(
      packageOnlySource.export({
        schemaVersion: "hpi-archive-export.v1",
        operationId: "op_archive-export-unbound",
        operationFingerprint: `sha256:${"2".repeat(64)}`,
        archiveId: manifest.archiveId,
        targetReference: "task9-export-unbound",
      }),
    ).rejects.toThrow(/canonical Workflow Kernel binding/u);
    const archive = archivePackageSchema.parse({
      schemaVersion: "hpi-archive-package.v1",
      manifest,
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      portability: {
        activeAttemptIds: [],
        activeOperationReceiptIds: [],
        unknownOperationIds: [],
        heldWriterLeaseIds: [],
        processReferences: [],
        deviceLocalPaths: [],
        credentialMaterial: false,
      },
    });
    const exported = await source.export({
      schemaVersion: "hpi-archive-export.v1",
      operationId: "op_archive-export",
      operationFingerprint: `sha256:${"c".repeat(64)}`,
      archiveId: manifest.archiveId,
      targetReference: "task9-export",
    });
    expect(exported.outcome).toBe("APPLIED");
    const destination = new FileRunArchiveStore({ stateRoot: join(root, "destination") });
    const importReceipt = await destination.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_archive-import",
      operationFingerprint: `sha256:${"d".repeat(64)}`,
      archive,
    });
    expect(importReceipt).toMatchObject({ outcome: "APPLIED", archiveId: manifest.archiveId });
    const importRequest = {
      schemaVersion: "hpi-archive-import.v1" as const,
      operationId: "op_archive-import" as const,
      operationFingerprint: `sha256:${"d".repeat(64)}`,
      archive,
    };
    await expect(destination.import(importRequest)).resolves.toMatchObject({ outcome: "NOOP" });
    await expect(
      destination.import({
        ...importRequest,
        operationId: "op_archive-import-different-operation",
        operationFingerprint: `sha256:${"e".repeat(64)}`,
      }),
    ).rejects.toThrow(/identity|operation/u);
    await writeFile(
      join(root, "destination", ".operation-receipts", "imports", `${manifest.archiveId}.json`),
      `${JSON.stringify({ ...importReceipt, archiveId: "archive_task9-tampered-receipt" })}\n`,
    );
    await expect(destination.import(importRequest)).rejects.toThrow(/identity|archive/u);
    await expect(
      destination.import({
        schemaVersion: "hpi-archive-import.v1",
        operationId: "op_archive-import-live",
        operationFingerprint: `sha256:${"e".repeat(64)}`,
        archive: {
          ...archive,
          portability: {
            ...archive.portability,
            activeAttemptIds: ["att_archive-live"],
          },
        },
      }),
    ).rejects.toThrow(/live Attempts|portable Archive/u);
    await expect(
      destination.import({
        schemaVersion: "hpi-archive-import.v1",
        operationId: "op_archive-import-tampered",
        operationFingerprint: `sha256:${"1".repeat(64)}`,
        archive: archivePackageSchema.parse({
          ...archive,
          manifest: {
            ...archive.manifest,
            archiveId: "archive_task9-tampered",
            eventDigest: `sha256:${"2".repeat(64)}`,
          },
        }),
      }),
    ).rejects.toThrow(/digest|identity|replay/u);
    const deleteRequest = {
      schemaVersion: "hpi-archive-delete-export.v1" as const,
      operationId: "op_archive-delete" as const,
      operationFingerprint: `sha256:${"f".repeat(64)}`,
      targetReference: "task9-export" as const,
    };
    await writeFile(join(root, "source", ".critical-reserve"), "corrupt\n");
    const reserveGuardedSource = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      storage: new LocalStorageController({ stateRoot: join(root, "source") }),
    });
    await expect(reserveGuardedSource.deleteExport(deleteRequest)).rejects.toThrow(
      /reserve|corrupt/u,
    );
    const retainedTarget = await lstat(join(root, "source", "exports", "task9-export.json"));
    expect(retainedTarget.isFile()).toBe(true);
    await rm(join(root, "source", ".critical-reserve"), { force: true });
    const deleteReceipt = await source.deleteExport(deleteRequest);
    expect(deleteReceipt).toMatchObject({
      outcome: "APPLIED",
      artifactFingerprint: exported.artifactFingerprint,
      archiveId: manifest.archiveId,
    });
    await expect(source.read(manifest.archiveId)).resolves.toEqual(manifest);
    await expect(source.deleteExport(deleteRequest)).resolves.toMatchObject({
      outcome: "NOOP",
      artifactFingerprint: exported.artifactFingerprint,
      archiveId: manifest.archiveId,
    });
    await expect(
      source.deleteExport({
        ...deleteRequest,
        operationId: "op_archive-delete-again",
        operationFingerprint: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow(/identity|operation|exact/u);
    await writeFile(
      join(root, "source", ".operation-receipts", "deletes", "task9-export.json"),
      `${JSON.stringify({ ...deleteReceipt, targetReference: "task9-other" })}\n`,
    );
    await expect(source.deleteExport(deleteRequest)).rejects.toThrow(/identity|target/u);
    const pendingDeleteRequest = {
      ...deleteRequest,
      operationId: "op_archive-delete-pending-missing" as const,
      operationFingerprint: `sha256:${"2".repeat(64)}`,
      targetReference: "task9-pending-missing" as const,
    };
    await writeFile(
      join(root, "source", ".operation-receipts", "deletes", "task9-pending-missing.pending.json"),
      `${JSON.stringify({
        schemaVersion: "hpi-archive-delete-pending.v1",
        operationId: pendingDeleteRequest.operationId,
        operationFingerprint: pendingDeleteRequest.operationFingerprint,
        targetReference: pendingDeleteRequest.targetReference,
        archiveId: manifest.archiveId,
        artifactFingerprint: exported.artifactFingerprint,
      })}\n`,
    );
    await expect(source.deleteExport(pendingDeleteRequest)).resolves.toMatchObject({
      outcome: "NOOP",
      archiveId: manifest.archiveId,
      artifactFingerprint: exported.artifactFingerprint,
    });
    await writeFile(join(root, "source", "exports", "task9-invalid.json"), '{"not":"an export"}\n');
    await expect(
      source.deleteExport({
        ...deleteRequest,
        operationId: "op_archive-delete-invalid",
        operationFingerprint: `sha256:${"b".repeat(64)}`,
        targetReference: "task9-invalid",
      }),
    ).rejects.toThrow(/corrupt|export|invalid|unreadable/u);
    await mkdir(join(root, "source", "exports", "task9-directory.json"));
    const blockedDelete = {
      ...deleteRequest,
      operationId: "op_archive-delete-directory" as const,
      operationFingerprint: `sha256:${"c".repeat(64)}`,
      targetReference: "task9-directory" as const,
    };
    await expect(source.deleteExport(blockedDelete)).resolves.toMatchObject({ outcome: "BLOCKED" });
    await expect(source.deleteExport(blockedDelete)).resolves.toMatchObject({ outcome: "BLOCKED" });
    await expect(
      source.deleteExport({
        ...blockedDelete,
        operationId: "op_archive-delete-directory-conflict",
        operationFingerprint: `sha256:${"d".repeat(64)}`,
      }),
    ).rejects.toThrow(/identity|operation/u);
  }, 30_000);

  it("rejects file URLs and non-home POSIX paths from portable Archives", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-archive-paths-");
    const fixture = await createTerminalProjection(root);
    const source = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      kernel: new InMemoryWorkflowKernel([fixture.events]),
    });
    const manifest = await source.finalize({
      schemaVersion: "hpi-archive-finalize.v1",
      operationId: "op_archive-paths-finalize",
      operationFingerprint: fixtureFingerprint,
      archiveId: "archive_task9-paths",
      distributionReleaseId: "release_task9",
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    });
    const archive = archivePackageSchema.parse({
      schemaVersion: "hpi-archive-package.v1",
      manifest,
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      portability: {
        activeAttemptIds: [],
        activeOperationReceiptIds: [],
        unknownOperationIds: [],
        heldWriterLeaseIds: [],
        processReferences: [],
        deviceLocalPaths: [],
        credentialMaterial: false,
      },
    });
    for (const path of [
      "file:///home/alice/private.json",
      "FILE:///C:/Users/alice/private.json",
      "File:///var/lib/hunter/private.json",
      "/var/lib/hunter/private.json",
      "//server/share/private.json",
    ]) {
      expect(() => {
        assertPortableArchive({
          ...archive,
          evidence: archive.evidence.map((evidence, index) =>
            index === 0 ? { ...evidence, content: path } : evidence,
          ),
        });
      }).toThrow(/device-local path/u);
    }
  });

  it("rejects credential-shaped text even when portable Evidence metadata is forged safe", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-archive-credential-scan-",
    );
    const fixture = await createTerminalProjection(root);
    const source = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      kernel: new InMemoryWorkflowKernel([fixture.events]),
    });
    const manifest = await source.finalize({
      schemaVersion: "hpi-archive-finalize.v1",
      operationId: "op_archive-credential-finalize",
      operationFingerprint: fixtureFingerprint,
      archiveId: "archive_task9-credential-scan",
      distributionReleaseId: "release_task9",
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    });
    const archive = archivePackageSchema.parse({
      schemaVersion: "hpi-archive-package.v1",
      manifest,
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      portability: {
        activeAttemptIds: [],
        activeOperationReceiptIds: [],
        unknownOperationIds: [],
        heldWriterLeaseIds: [],
        processReferences: [],
        deviceLocalPaths: [],
        credentialMaterial: false,
      },
    });
    const evidence = archive.evidence[0];
    if (evidence === undefined) throw new Error("archive fixture has no Evidence");

    for (const poisonedEvidence of [
      {
        ...evidence,
        summary: "verification token=super-secret-value",
        redaction: {
          version: "hunter-redaction/1" as const,
          applied: false,
          fieldsRemoved: 0,
          categories: [],
        },
      },
      {
        ...evidence,
        capture: {
          ...evidence.capture,
          capturedText: "Cookie: session=super-secret-value",
          capturedBytes: 41,
          totalBytes: 41,
        },
        redaction: {
          version: "hunter-redaction/1" as const,
          applied: false,
          fieldsRemoved: 0,
          categories: [],
        },
      },
    ]) {
      expect(() => {
        assertPortableArchive({ ...archive, evidence: [poisonedEvidence] });
      }).toThrow(/credential|sensitive|portable Archive/u);
    }
  });

  it("imports only a portable terminal Archive into a clean device profile", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-");
    const fixture = await createTerminalProjection(root);
    const source = new FileRunArchiveStore({
      stateRoot: join(root, "source"),
      kernel: new InMemoryWorkflowKernel([fixture.events]),
    });
    const manifest = await source.finalize({
      schemaVersion: "hpi-archive-finalize.v1",
      operationId: "op_archive-device-finalize",
      operationFingerprint: fixtureFingerprint,
      archiveId: "archive_task9-device",
      distributionReleaseId: "release_task9",
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
      archivedAt: fixtureTimestamp,
    });
    const archive = archivePackageSchema.parse({
      schemaVersion: "hpi-archive-package.v1",
      manifest,
      projection: fixture.projection,
      events: [...fixture.events],
      evidence: [...fixture.evidence],
      portability: {
        activeAttemptIds: [],
        activeOperationReceiptIds: [],
        unknownOperationIds: [],
        heldWriterLeaseIds: [],
        processReferences: [],
        deviceLocalPaths: [],
        credentialMaterial: false,
      },
    });
    const destination = new FileRunArchiveStore({ stateRoot: join(root, "destination") });
    const clonePolicy = vi.fn(() =>
      Promise.resolve({ status: "PASS" as const, policyFingerprint: fixtureFingerprint }),
    );
    const doctor = vi.fn(() => Promise.resolve("PASS" as const));
    const loginReadiness = vi.fn(() => Promise.resolve("BLOCKED" as const));
    const importer = new PortableDeviceImporter({
      archiveStore: destination,
      clonePolicy: { clone: clonePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });

    await expect(
      importer.import({
        schemaVersion: "hpi-device-import.v1",
        operationId: "op_device-import",
        operationFingerprint: `sha256:${"a".repeat(64)}`,
        profileId: "device-profile-clean",
        projectPolicy: {
          schemaVersion: "hpi-project-policy.v1",
          policyFingerprint: fixtureFingerprint,
        },
        archive,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      outcome: "BLOCKED",
      archiveOutcome: "APPLIED",
      policyOutcome: "PASS",
      doctorStatus: "PASS",
      loginReadiness: "BLOCKED",
    });
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(doctor).toHaveBeenCalledOnce();
    expect(loginReadiness).toHaveBeenCalledOnce();

    await expect(
      importer.import({
        schemaVersion: "hpi-device-import.v1",
        operationId: "op_device-import-live",
        operationFingerprint: `sha256:${"b".repeat(64)}`,
        profileId: "device-profile-clean",
        projectPolicy: {
          schemaVersion: "hpi-project-policy.v1",
          policyFingerprint: fixtureFingerprint,
        },
        archive: archivePackageSchema.parse({
          ...archive,
          portability: { ...archive.portability, activeAttemptIds: ["att_archive-live"] },
        }),
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/live Attempts|portable Archive/u);
    expect(clonePolicy).toHaveBeenCalledOnce();

    const legacyImporter = new PortableDeviceImporter({
      archiveStore: destination,
      clonePolicy: { clone: () => Promise.resolve("PASS" as never) },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });
    await expect(
      legacyImporter.import({
        schemaVersion: "hpi-device-import.v1",
        operationId: "op_device-import-legacy-result",
        operationFingerprint: `sha256:${"c".repeat(64)}`,
        profileId: "device-profile-clean",
        projectPolicy: {
          schemaVersion: "hpi-project-policy.v1",
          policyFingerprint: fixtureFingerprint,
        },
        archive,
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/policy clone result|policy fingerprint/u);
  });
});
