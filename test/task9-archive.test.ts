import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  attemptFinalityReceiptIdSchema,
  attemptIdSchema,
  checkpointIdSchema,
  checkpointSchema,
  observationIdSchema,
  planRevisionSchema,
  runSchema,
  verificationReceiptSchema,
} from "@hunter-pi/domain";
import {
  archivePackageSchema,
  assertPortableArchive,
  createPortableEvidenceEnvelope,
  FilePortableDeviceImportReceiptStore,
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
  fixtureSuffix = "archive",
): Promise<{
  readonly projection: RunProjection;
  readonly events: Awaited<ReturnType<FileWorkflowEventStore["read"]>>;
  readonly evidence: readonly ReturnType<typeof createPortableEvidenceEnvelope>[];
}> {
  const fixture = createWorkflowDomainFixture({ suffix: fixtureSuffix });
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
    const finalityEvidence = createPortableEvidenceEnvelope({
      schemaVersion: "1.0.0",
      evidenceId: "evidence_archive-cancelled-finality",
      kind: "observation",
      scope: { runId: run.runId, attemptId: "att_archive-original" },
      createdAt: fixtureTimestamp,
      sourceFingerprint: fixtureFingerprint,
      summary: "The cancelled Archive fixture has exact Attempt finality.",
      contentClass: "SUMMARY",
      content: "No managed process or Writer Lease remained after cancellation.",
    });
    const beforeCheckpoint = await kernel.project(run.runId);
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: checkpointIdSchema.parse("checkpoint_archive-cancelled"),
      runId: run.runId,
      attemptId: "att_archive-original",
      planRevisionId: planRevision.planRevisionId,
      distributionReleaseId: "release_archive-cancelled",
      workspaceId: planRevision.workspaceId,
      repositoryFingerprint: fixtureFingerprint,
      workspaceFingerprint: planRevision.workspaceFingerprint,
      sourceFingerprint: planRevision.sourceFingerprint,
      eventCursor: beforeCheckpoint.eventCursor,
      createdAt: fixtureTimestamp,
      engine: {
        engineReleaseId: "engine-release_archive-cancelled",
        engineReleaseFingerprint: fixtureFingerprint,
        resumeCapability: "UNSUPPORTED",
      },
      activeOperationReceiptIds: [],
      unknownOperationIds: [],
      heldWriterLeaseIds: [],
      processReferences: [],
      remainingResourceBudgets: planRevision.loopPolicy.resourceBudgets,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_CHECKPOINT",
      checkpoint,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_ATTEMPT_FINALITY",
      receipt: {
        schemaVersion: "1.0.0",
        attemptFinalityReceiptId: attemptFinalityReceiptIdSchema.parse(
          "finality_archive-cancelled",
        ),
        runId: run.runId,
        attemptId: attemptIdSchema.parse("att_archive-original"),
        checkpointId: checkpoint.checkpointId,
        workspaceId: planRevision.workspaceId,
        workspaceFingerprint: planRevision.workspaceFingerprint,
        sourceFingerprint: planRevision.sourceFingerprint,
        processFinalities: [],
        releasedWriterLeaseIds: [],
        terminalFinality: "FINAL",
        evidenceIds: [finalityEvidence.evidenceId],
        observedAt: fixtureTimestamp,
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
      evidence: [finalityEvidence],
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

async function createPortableArchiveFixture(
  root: string,
  archiveId: string,
  fixtureSuffix = "archive",
) {
  const fixture = await createTerminalProjection(
    join(root, "fixture"),
    "NOT_PROVEN",
    fixtureSuffix,
  );
  const source = new FileRunArchiveStore({
    stateRoot: join(root, "source"),
    kernel: new InMemoryWorkflowKernel([fixture.events]),
  });
  const manifest = await source.finalize({
    schemaVersion: "hpi-archive-finalize.v1",
    operationId: `op_archive-device-finalize-${fixtureSuffix}`,
    operationFingerprint: fixtureFingerprint,
    archiveId,
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
  return { archive, fixture, manifest };
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
    await expect(destination.import(importRequest)).rejects.toThrow(
      /identity|archive|invalid|unreadable/u,
    );
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

  it("rejects private paths and credentials embedded outside Evidence text", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-archive-projection-privacy-",
    );
    const { archive } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-projection-privacy",
    );

    for (const terminalReason of [
      "execution stopped with cwd=/home/alice/private-project",
      "execution stopped with token=super-secret-value",
    ]) {
      expect(() =>
        assertPortableArchive({
          ...archive,
          projection: {
            ...archive.projection,
            run: { ...archive.projection.run, terminalReason },
          },
        }),
      ).toThrow(/credential|private|path|portable Archive/u);
    }
  });

  it("reopens a clean-device import as an exact archive-bound READ_ONLY projection", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-project-");
    const { archive, fixture, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device",
    );
    const destinationRoot = join(root, "destination");
    const clonePolicy = vi.fn(() =>
      Promise.resolve({ status: "PASS" as const, policyFingerprint: fixtureFingerprint }),
    );
    const reconcilePolicy = vi.fn(() =>
      Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
    );
    const doctor = vi.fn(() => Promise.resolve("PASS" as const));
    const loginReadiness = vi.fn(() => Promise.resolve("BLOCKED" as const));
    const importer = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: destinationRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: { clone: clonePolicy, reconcile: reconcilePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });
    const request = {
      schemaVersion: "hpi-device-import.v1" as const,
      operationId: "op_device-import" as const,
      operationFingerprint: `sha256:${"a".repeat(64)}`,
      profileId: "device-profile-clean",
      projectPolicy: {
        schemaVersion: "hpi-project-policy.v1" as const,
        policyFingerprint: fixtureFingerprint,
      },
      archive,
      observedAt: fixtureTimestamp,
    };

    const receipt = await importer.import(request);
    expect(receipt).toMatchObject({
      schemaVersion: "hpi-device-import-receipt.v2",
      outcome: "BLOCKED",
      archiveOutcome: "APPLIED",
      recordedArchiveOutcome: "APPLIED",
      archiveId: manifest.archiveId,
      runId: fixture.projection.run.runId,
      planRevisionId: fixture.projection.planRevision.planRevisionId,
      sourceFingerprint: fixture.projection.run.sourceFingerprint,
      archivedRunOutcome: "INCOMPLETE",
      policyOutcome: "PASS",
      doctorStatus: "PASS",
      loginReadiness: "BLOCKED",
    });

    const reopened = new FileRunArchiveStore({ stateRoot: destinationRoot });
    const importedProjection = await reopened.projectImported({
      schemaVersion: "hpi-imported-archive-projection-request.v1",
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      archiveId: manifest.archiveId,
      artifactFingerprint: receipt.artifactFingerprint,
    });
    expect(importedProjection).toMatchObject({
      schemaVersion: "hpi-imported-archive-projection.v1",
      accessMode: "READ_ONLY",
      workflowAuthority: "NONE",
      archiveState: "IMPORTED_ARCHIVE",
      archiveId: manifest.archiveId,
      artifactFingerprint: receipt.artifactFingerprint,
      importOperationId: request.operationId,
      importOperationFingerprint: request.operationFingerprint,
      runId: fixture.projection.run.runId,
      planRevisionId: fixture.projection.planRevision.planRevisionId,
      sourceFingerprint: fixture.projection.run.sourceFingerprint,
      archiveOutcome: "INCOMPLETE",
      archiveProjection: fixture.projection,
      projectionFingerprint: receipt.readOnlyProjectionFingerprint,
    });
    expect(importedProjection.archiveProjection).toEqual(fixture.projection);
    expect(importedProjection).not.toHaveProperty("active");
    expect(importedProjection).not.toHaveProperty("success");
    expect(Object.isFrozen(importedProjection)).toBe(true);
    expect(Object.isFrozen(importedProjection.archiveProjection)).toBe(true);
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(reconcilePolicy).toHaveBeenCalledOnce();
    expect(doctor).toHaveBeenCalledOnce();
    expect(loginReadiness).toHaveBeenCalledOnce();
  });

  it("reads a clean-profile import as the same read-only projection after reopen", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-read-");
    const { archive, fixture, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-read",
      "archive-device-read",
    );
    const destinationRoot = join(root, "destination");
    const destination = new FileRunArchiveStore({ stateRoot: destinationRoot });
    const importReceipt = await destination.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-read",
      operationFingerprint: `sha256:${"8".repeat(64)}`,
      archive,
    });

    const imported = await new FileRunArchiveStore({ stateRoot: destinationRoot }).read(
      manifest.archiveId,
    );

    expect(imported).toMatchObject({
      schemaVersion: "hpi-imported-archive-projection.v1",
      accessMode: "READ_ONLY",
      workflowAuthority: "NONE",
      archiveState: "IMPORTED_ARCHIVE",
      archiveId: manifest.archiveId,
      artifactFingerprint: importReceipt.artifactFingerprint,
      importOperationId: importReceipt.operationId,
      importOperationFingerprint: importReceipt.operationFingerprint,
      runId: fixture.projection.run.runId,
      archiveOutcome: manifest.outcome,
      archiveProjection: fixture.projection,
    });
    if (imported.schemaVersion !== "hpi-imported-archive-projection.v1") {
      throw new Error("clean-profile Archive read did not return the imported projection");
    }
    expect(Object.isFrozen(imported)).toBe(true);
    expect(Object.isFrozen(imported.archiveProjection)).toBe(true);
    expect(
      imported.archiveProjection.attempts.filter((attempt) =>
        ["PENDING", "STARTING", "RUNNING", "WAITING_INPUT"].includes(attempt.executionStatus),
      ),
    ).toEqual([]);
    expect(
      imported.archiveProjection.checkpoints.flatMap((checkpoint) => [
        ...checkpoint.activeOperationReceiptIds,
        ...checkpoint.unknownOperationIds,
        ...checkpoint.heldWriterLeaseIds,
        ...checkpoint.processReferences,
        ...(checkpoint.engine.sessionReference === undefined
          ? []
          : [checkpoint.engine.sessionReference]),
      ]),
    ).toEqual([]);
  });

  it("binds the durable Archive import receipt to the exact read-only projection fingerprint", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-projection-binding-",
    );
    const { archive, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-projection-binding",
      "archive-device-projection-binding",
    );
    const destinationRoot = join(root, "destination");
    const store = new FileRunArchiveStore({ stateRoot: destinationRoot });
    const receipt = await store.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-projection-binding",
      operationFingerprint: `sha256:${"9".repeat(64)}`,
      archive,
    });
    const request = {
      schemaVersion: "hpi-imported-archive-projection-request.v1" as const,
      operationId: receipt.operationId,
      operationFingerprint: receipt.operationFingerprint,
      archiveId: receipt.archiveId,
      artifactFingerprint: receipt.artifactFingerprint,
    };
    const imported = await store.projectImported(request);

    expect(receipt.readOnlyProjectionFingerprint).toBe(imported.projectionFingerprint);

    await writeFile(
      join(destinationRoot, ".operation-receipts", "imports", `${manifest.archiveId}.json`),
      `${JSON.stringify({
        ...receipt,
        readOnlyProjectionFingerprint: `sha256:${"a".repeat(64)}`,
      })}\n`,
    );
    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot }).read(manifest.archiveId),
    ).rejects.toThrow(/corrupt|fingerprint|projection|receipt/u);
  });

  it("never records APPLIED before the Archive package exists and resumes the exact intent", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-import-order-",
    );
    const { archive, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-import-order",
    );
    const destinationRoot = join(root, "destination");
    const storage = new LocalStorageController({
      stateRoot: destinationRoot,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1024 * 1024),
    });
    let criticalWrite = 0;
    const writeSpy = vi.spyOn(storage, "writeCritical").mockImplementation(async (write) => {
      criticalWrite += 1;
      if (criticalWrite === 2) throw new Error("simulated package publication interruption");
      await write();
    });
    const request = {
      schemaVersion: "hpi-archive-import.v1" as const,
      operationId: "op_device-import-order" as const,
      operationFingerprint: `sha256:${"7".repeat(64)}`,
      archive,
    };
    const receiptPath = join(
      destinationRoot,
      ".operation-receipts",
      "imports",
      `${manifest.archiveId}.json`,
    );
    const packagePath = join(destinationRoot, "archives", manifest.archiveId, "package.json");

    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot, storage }).import(request),
    ).rejects.toThrow(/simulated package publication interruption/u);
    await expect(access(packagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });

    writeSpy.mockRestore();
    const recovered = await new FileRunArchiveStore({ stateRoot: destinationRoot, storage }).import(
      request,
    );
    expect(recovered).toMatchObject({ recordedOutcome: "APPLIED", outcome: "APPLIED" });
    await expect(access(packagePath)).resolves.toBeUndefined();
    await expect(access(receiptPath)).resolves.toBeUndefined();
    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot, storage }).import(request),
    ).resolves.toMatchObject({ recordedOutcome: "APPLIED", outcome: "NOOP" });
  });

  it("reconciles the immediately preceding v1 import receipt without manual state editing", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-receipt-version-",
    );
    const { archive, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-receipt-version",
      "archive-device-receipt-version",
    );
    const destinationRoot = join(root, "destination");
    const store = new FileRunArchiveStore({ stateRoot: destinationRoot });
    const receipt = await store.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-receipt-version",
      operationFingerprint: `sha256:${"1".repeat(64)}`,
      archive,
    });
    await writeFile(
      join(destinationRoot, ".operation-receipts", "imports", `${manifest.archiveId}.json`),
      `${JSON.stringify({
        schemaVersion: "hpi-archive-import-receipt.v1",
        operationId: receipt.operationId,
        operationFingerprint: receipt.operationFingerprint,
        archiveId: receipt.archiveId,
        artifactFingerprint: receipt.artifactFingerprint,
        outcome: receipt.recordedOutcome,
        observedAt: receipt.observedAt,
      })}\n`,
    );

    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot }).read(manifest.archiveId),
    ).resolves.toMatchObject({
      schemaVersion: "hpi-imported-archive-projection.v1",
      archiveId: manifest.archiveId,
      artifactFingerprint: receipt.artifactFingerprint,
      accessMode: "READ_ONLY",
    });
    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot }).import({
        schemaVersion: "hpi-archive-import.v1",
        operationId: receipt.operationId,
        operationFingerprint: receipt.operationFingerprint,
        archive,
      }),
    ).resolves.toMatchObject({
      schemaVersion: "hpi-archive-import-receipt.v2",
      recordedOutcome: "APPLIED",
      outcome: "NOOP",
    });
  });

  it("fails a clean-profile read closed for an incompatible Archive package schema version", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-package-version-",
    );
    const { archive, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-package-version",
      "archive-device-package-version",
    );
    const destinationRoot = join(root, "destination");
    const store = new FileRunArchiveStore({ stateRoot: destinationRoot });
    await store.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-package-version",
      operationFingerprint: `sha256:${"2".repeat(64)}`,
      archive,
    });
    await writeFile(
      join(destinationRoot, "archives", manifest.archiveId, "package.json"),
      `${JSON.stringify({ ...archive, schemaVersion: "hpi-archive-package.v0" })}\n`,
    );

    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot }).read(manifest.archiveId),
    ).rejects.toThrow(/Archive|package|schema|version|corrupt/u);
  });

  it("rejects a valid Archive package stored under a different Archive identity", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-package-identity-",
    );
    const target = await createPortableArchiveFixture(
      join(root, "portable-target"),
      "archive_task9-device-package-target",
      "archive-device-package-target",
    );
    const other = await createPortableArchiveFixture(
      join(root, "portable-other"),
      "archive_task9-device-package-other",
      "archive-device-package-other",
    );
    const destinationRoot = join(root, "destination");
    const store = new FileRunArchiveStore({ stateRoot: destinationRoot });
    await store.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-package-identity",
      operationFingerprint: `sha256:${"3".repeat(64)}`,
      archive: target.archive,
    });
    await writeFile(
      join(destinationRoot, "archives", target.manifest.archiveId, "package.json"),
      `${JSON.stringify(other.archive)}\n`,
    );

    await expect(
      new FileRunArchiveStore({ stateRoot: destinationRoot }).read(target.manifest.archiveId),
    ).rejects.toThrow(/different Archive identity than its directory/u);
  });

  it("fails imported projection reads closed for a missing or changed receipt, operation, or package", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-tamper-");
    const { archive, manifest } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-tamper",
    );
    const operationId = "op_device-import-tamper" as const;
    const operationFingerprint = `sha256:${"b".repeat(64)}`;

    async function importedStore(label: string) {
      const stateRoot = join(root, label);
      const store = new FileRunArchiveStore({ stateRoot });
      const receipt = await store.import({
        schemaVersion: "hpi-archive-import.v1",
        operationId,
        operationFingerprint,
        archive,
      });
      const request = {
        schemaVersion: "hpi-imported-archive-projection-request.v1" as const,
        operationId,
        operationFingerprint,
        archiveId: manifest.archiveId,
        artifactFingerprint: receipt.artifactFingerprint,
      };
      return { request, stateRoot, store, receipt };
    }

    const differentOperation = await importedStore("different-operation");
    await expect(
      differentOperation.store.projectImported({
        ...differentOperation.request,
        operationId: "op_device-import-other",
      }),
    ).rejects.toThrow(/identity|operation|receipt/u);

    const missingReceipt = await importedStore("missing-receipt");
    await rm(
      join(
        missingReceipt.stateRoot,
        ".operation-receipts",
        "imports",
        `${manifest.archiveId}.json`,
      ),
    );
    await expect(missingReceipt.store.projectImported(missingReceipt.request)).rejects.toThrow(
      /persisted|receipt|not found/u,
    );

    const changedReceipt = await importedStore("changed-receipt");
    await writeFile(
      join(
        changedReceipt.stateRoot,
        ".operation-receipts",
        "imports",
        `${manifest.archiveId}.json`,
      ),
      `${JSON.stringify({ ...changedReceipt.receipt, observedAt: "2026-08-08T01:02:03.000Z" })}\n`,
    );
    await expect(changedReceipt.store.projectImported(changedReceipt.request)).rejects.toThrow(
      /corrupt|fingerprint|receipt|invalid|unreadable/u,
    );

    const changedPackage = await importedStore("changed-package");
    await writeFile(
      join(changedPackage.stateRoot, "archives", manifest.archiveId, "package.json"),
      `${JSON.stringify({
        ...archive,
        manifest: { ...archive.manifest, archivedAt: "2026-08-08T01:02:03.000Z" },
      })}\n`,
    );
    await expect(changedPackage.store.projectImported(changedPackage.request)).rejects.toThrow(
      /artifact|fingerprint|package|identity/u,
    );
  });

  it("rejects live workflow state before device policy, Doctor, or login can run", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-live-");
    const { archive, fixture } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-live",
    );
    const destinationRoot = join(root, "destination");
    const clonePolicy = vi.fn(() =>
      Promise.resolve({ status: "PASS" as const, policyFingerprint: fixtureFingerprint }),
    );
    const reconcilePolicy = vi.fn(() =>
      Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
    );
    const doctor = vi.fn(() => Promise.resolve("PASS" as const));
    const loginReadiness = vi.fn(() => Promise.resolve("PASS" as const));
    const importer = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({
        stateRoot: destinationRoot,
        kernel: new InMemoryWorkflowKernel([fixture.events]),
      }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: { clone: clonePolicy, reconcile: reconcilePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });
    const baseRequest = {
      schemaVersion: "hpi-device-import.v1" as const,
      operationId: "op_device-import-live" as const,
      operationFingerprint: `sha256:${"c".repeat(64)}`,
      profileId: "device-profile-live",
      projectPolicy: {
        schemaVersion: "hpi-project-policy.v1" as const,
        policyFingerprint: fixtureFingerprint,
      },
      archive,
      observedAt: fixtureTimestamp,
    };

    await expect(importer.import(baseRequest)).rejects.toThrow(
      /archive-only|live Workflow Kernel|canonical/u,
    );
    await expect(
      importer.import({
        ...baseRequest,
        operationId: "op_device-import-live-package",
        archive: archivePackageSchema.parse({
          ...archive,
          portability: { ...archive.portability, activeAttemptIds: ["att_archive-live"] },
        }),
      }),
    ).rejects.toThrow(/live Attempts|portable Archive/u);
    const forgedPortableMetadata = archivePackageSchema.parse({
      ...archive,
      projection: {
        ...archive.projection,
        attempts: archive.projection.attempts.map((attempt, index) =>
          index === 0 ? { ...attempt, executionStatus: "RUNNING" } : attempt,
        ),
      },
    });
    expect(() => {
      assertPortableArchive(forgedPortableMetadata);
    }).toThrow(/live Attempts|live workflow state|portable Archive/u);
    expect(clonePolicy).not.toHaveBeenCalled();
    expect(reconcilePolicy).not.toHaveBeenCalled();
    expect(doctor).not.toHaveBeenCalled();
    expect(loginReadiness).not.toHaveBeenCalled();
  });

  it("replays one immutable device receipt as NOOP and rejects changed bindings without rerunning checks", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-replay-");
    const firstArchive = await createPortableArchiveFixture(
      join(root, "portable-first"),
      "archive_task9-device-replay",
    );
    const changedArchive = await createPortableArchiveFixture(
      join(root, "portable-changed-archive"),
      "archive_task9-device-other",
    );
    const changedPlan = await createPortableArchiveFixture(
      join(root, "portable-changed-plan"),
      "archive_task9-device-replay",
      "archive-other-plan",
    );
    const destinationRoot = join(root, "destination");
    const clonePolicy = vi.fn(() =>
      Promise.resolve({ status: "PASS" as const, policyFingerprint: fixtureFingerprint }),
    );
    const reconcilePolicy = vi.fn(() =>
      Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
    );
    const doctor = vi.fn(() => Promise.resolve("PASS" as const));
    const loginReadiness = vi.fn(() => Promise.resolve("BLOCKED" as const));
    const importer = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: destinationRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: { clone: clonePolicy, reconcile: reconcilePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });
    const request = {
      schemaVersion: "hpi-device-import.v1" as const,
      operationId: "op_device-import-replay" as const,
      operationFingerprint: `sha256:${"d".repeat(64)}`,
      profileId: "device-profile-replay",
      projectPolicy: {
        schemaVersion: "hpi-project-policy.v1" as const,
        policyFingerprint: fixtureFingerprint,
      },
      archive: firstArchive.archive,
      observedAt: fixtureTimestamp,
    };

    const first = await importer.import(request);
    const replayed = await new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: destinationRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: { clone: clonePolicy, reconcile: reconcilePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    }).import({ ...request, observedAt: "2026-08-08T02:03:04.000Z" });
    const { archiveOutcome: firstInvocation, ...firstFact } = first;
    const { archiveOutcome: replayInvocation, ...replayedFact } = replayed;
    expect(firstInvocation).toBe("APPLIED");
    expect(replayInvocation).toBe("NOOP");
    expect(replayedFact).toEqual(firstFact);
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(reconcilePolicy).toHaveBeenCalledOnce();
    expect(doctor).toHaveBeenCalledOnce();
    expect(loginReadiness).toHaveBeenCalledOnce();

    for (const conflicting of [
      { ...request, operationFingerprint: `sha256:${"e".repeat(64)}` },
      { ...request, operationId: "op_device-import-replay-other" },
      { ...request, profileId: "device-profile-other" },
      {
        ...request,
        projectPolicy: { ...request.projectPolicy, policyFingerprint: `sha256:${"f".repeat(64)}` },
      },
      { ...request, archive: changedArchive.archive },
      { ...request, archive: changedPlan.archive },
    ]) {
      await expect(importer.import(conflicting)).rejects.toThrow(
        /identity|operation|profile|policy|archive|plan|fingerprint/u,
      );
    }
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(doctor).toHaveBeenCalledOnce();
    expect(loginReadiness).toHaveBeenCalledOnce();

    const deviceReceiptPath = join(
      destinationRoot,
      ".operation-receipts",
      "device-imports",
      `${request.profileId}.json`,
    );
    const persistedText = await readFile(deviceReceiptPath, "utf8");
    expect(persistedText).not.toContain(root);
    expect(persistedText).not.toMatch(/(?:file:\/\/|[A-Za-z]:[\\/]|\\\\)/u);
    const persisted = JSON.parse(persistedText) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("stateRoot");
    expect(persisted).not.toHaveProperty("path");
    await writeFile(
      deviceReceiptPath,
      `${JSON.stringify({ ...persisted, doctorStatus: "NOT_PROVEN" })}\n`,
    );
    await expect(importer.import(request)).rejects.toThrow(
      /corrupt|fingerprint|receipt|invalid|unreadable/u,
    );
    expect(clonePolicy).toHaveBeenCalledOnce();
  });

  it("binds one Archive import operation identity to exactly one Archive", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-operation-identity-",
    );
    const first = await createPortableArchiveFixture(
      join(root, "portable-first"),
      "archive_task9-device-operation-first",
    );
    const second = await createPortableArchiveFixture(
      join(root, "portable-second"),
      "archive_task9-device-operation-second",
      "archive-operation-second",
    );
    const store = new FileRunArchiveStore({ stateRoot: join(root, "destination") });
    await store.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: "op_device-import-single-binding",
      operationFingerprint: `sha256:${"3".repeat(64)}`,
      archive: first.archive,
    });

    await expect(
      store.import({
        schemaVersion: "hpi-archive-import.v1",
        operationId: "op_device-import-single-binding",
        operationFingerprint: `sha256:${"4".repeat(64)}`,
        archive: second.archive,
      }),
    ).rejects.toThrow(/operation|identity|bound/u);
  });

  it("resumes an interrupted device import from exact durable policy state without manual editing", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task9-device-interrupted-",
    );
    const { archive } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-interrupted",
      "archive-device-interrupted",
    );
    const destinationRoot = join(root, "destination");
    let policyPresent = false;
    let doctorInvocation = 0;
    const reconcilePolicy = vi.fn(() =>
      Promise.resolve(
        policyPresent
          ? ({ status: "EXACT" as const, policyFingerprint: fixtureFingerprint } as const)
          : ({ status: "ABSENT" as const, policyFingerprint: null } as const),
      ),
    );
    const clonePolicy = vi.fn(() => {
      if (policyPresent) throw new Error("policy clone must not be repeated");
      policyPresent = true;
      return Promise.resolve({ status: "PASS" as const, policyFingerprint: fixtureFingerprint });
    });
    const doctor = vi.fn(() => {
      doctorInvocation += 1;
      return doctorInvocation === 1
        ? Promise.reject(new Error("simulated Doctor interruption"))
        : Promise.resolve("PASS" as const);
    });
    const loginReadiness = vi.fn(() => Promise.resolve("PASS" as const));
    const importer = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: destinationRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: { clone: clonePolicy, reconcile: reconcilePolicy },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    });
    const request = {
      schemaVersion: "hpi-device-import.v1" as const,
      operationId: "op_device-import-interrupted" as const,
      operationFingerprint: `sha256:${"2".repeat(64)}`,
      profileId: "device-profile-interrupted",
      projectPolicy: {
        schemaVersion: "hpi-project-policy.v1" as const,
        policyFingerprint: fixtureFingerprint,
      },
      archive,
      observedAt: fixtureTimestamp,
    };

    await expect(importer.import(request)).rejects.toThrow(/simulated Doctor interruption/u);
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(doctor).toHaveBeenCalledOnce();
    expect(loginReadiness).not.toHaveBeenCalled();

    await expect(importer.import(request)).resolves.toMatchObject({
      archiveOutcome: "NOOP",
      outcome: "READY",
      policyOutcome: "PASS",
      doctorStatus: "PASS",
      loginReadiness: "PASS",
    });
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(reconcilePolicy).toHaveBeenCalledTimes(2);
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(loginReadiness).toHaveBeenCalledOnce();
  });

  it("rejects legacy or mismatched policy clone results", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-legacy-");
    const { archive } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-legacy",
    );
    const destinationRoot = join(root, "destination");
    const legacyImporter = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: destinationRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: destinationRoot }),
      clonePolicy: {
        clone: () => Promise.resolve("PASS" as never),
        reconcile: () =>
          Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
      },
      doctor: { run: () => Promise.resolve("PASS") },
      loginReadiness: { check: () => Promise.resolve("PASS") },
    });
    await expect(
      legacyImporter.import({
        schemaVersion: "hpi-device-import.v1",
        operationId: "op_device-import-legacy-result",
        operationFingerprint: `sha256:${"f".repeat(64)}`,
        profileId: "device-profile-legacy",
        projectPolicy: {
          schemaVersion: "hpi-project-policy.v1",
          policyFingerprint: fixtureFingerprint,
        },
        archive,
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/policy clone result|policy fingerprint/u);

    const mismatchRoot = join(root, "mismatched-destination");
    const mismatchedDoctor = vi.fn(() => Promise.resolve("PASS" as const));
    const mismatchedLogin = vi.fn(() => Promise.resolve("PASS" as const));
    const mismatchedImporter = new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: mismatchRoot }),
      receiptStore: new FilePortableDeviceImportReceiptStore({ stateRoot: mismatchRoot }),
      clonePolicy: {
        clone: () =>
          Promise.resolve({
            status: "BLOCKED" as const,
            policyFingerprint: `sha256:${"0".repeat(64)}`,
          }),
        reconcile: () =>
          Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
      },
      doctor: { run: mismatchedDoctor },
      loginReadiness: { check: mismatchedLogin },
    });
    await expect(
      mismatchedImporter.import({
        schemaVersion: "hpi-device-import.v1",
        operationId: "op_device-import-mismatched-policy",
        operationFingerprint: `sha256:${"1".repeat(64)}`,
        profileId: "device-profile-mismatched-policy",
        projectPolicy: {
          schemaVersion: "hpi-project-policy.v1",
          policyFingerprint: fixtureFingerprint,
        },
        archive,
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/bind|policy fingerprint/u);
    expect(mismatchedDoctor).not.toHaveBeenCalled();
    expect(mismatchedLogin).not.toHaveBeenCalled();
  });

  it("preserves a known BLOCKED policy result ahead of skipped downstream checks", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-device-blocked-");
    const { archive } = await createPortableArchiveFixture(
      join(root, "portable"),
      "archive_task9-device-blocked",
    );
    const clonePolicy = vi.fn(() =>
      Promise.resolve({ status: "BLOCKED" as const, policyFingerprint: fixtureFingerprint }),
    );
    const doctor = vi.fn(() => Promise.resolve("PASS" as const));
    const loginReadiness = vi.fn(() => Promise.resolve("PASS" as const));
    const receipt = await new PortableDeviceImporter({
      archiveStore: new FileRunArchiveStore({ stateRoot: join(root, "destination") }),
      receiptStore: new FilePortableDeviceImportReceiptStore({
        stateRoot: join(root, "destination"),
      }),
      clonePolicy: {
        clone: clonePolicy,
        reconcile: () =>
          Promise.resolve({ status: "ABSENT" as const, policyFingerprint: null }),
      },
      doctor: { run: doctor },
      loginReadiness: { check: loginReadiness },
    }).import({
      schemaVersion: "hpi-device-import.v1",
      operationId: "op_device-import-blocked",
      operationFingerprint: `sha256:${"5".repeat(64)}`,
      profileId: "device-profile-blocked",
      projectPolicy: {
        schemaVersion: "hpi-project-policy.v1",
        policyFingerprint: fixtureFingerprint,
      },
      archive,
      observedAt: fixtureTimestamp,
    });

    expect(receipt).toMatchObject({
      outcome: "BLOCKED",
      policyOutcome: "BLOCKED",
      doctorStatus: "NOT_PROVEN",
      loginReadiness: "NOT_PROVEN",
    });
    expect(clonePolicy).toHaveBeenCalledOnce();
    expect(doctor).not.toHaveBeenCalled();
    expect(loginReadiness).not.toHaveBeenCalled();
  });
});
