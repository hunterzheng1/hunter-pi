import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attemptFinalityReceiptSchema,
  attemptIdSchema,
  checkpointSchema,
  checkpointIdSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  evidenceIdSchema,
  observationIdSchema,
  operationIdSchema,
  operationReconciliationReceiptSchema,
} from "@hunter-pi/domain";
import { FileWorkflowEventStore } from "@hunter-pi/evidence";
import {
  CheckpointCoordinator,
  DurableWorkflowKernel,
  InMemoryWorkflowKernel,
  RecoveryCoordinator,
} from "@hunter-pi/workflow-kernel";

import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

async function createRecoveryScenario(suffix: string) {
  const fixture = createWorkflowDomainFixture({ suffix });
  const kernel = new InMemoryWorkflowKernel();
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "CREATE_RUN",
    change: fixture.change,
    planRevision: fixture.planRevision,
    run: fixture.run,
  });
  const originalAttemptId = attemptIdSchema.parse(`att_${suffix}-original`);
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "START_ATTEMPT",
    runId: fixture.run.runId,
    attemptId: originalAttemptId,
    startedAt: fixtureTimestamp,
  });
  const running = await kernel.project(fixture.run.runId);
  const checkpoint = checkpointSchema.parse({
    schemaVersion: "1.0.0",
    checkpointId: checkpointIdSchema.parse(`checkpoint_${suffix}`),
    runId: fixture.run.runId,
    attemptId: originalAttemptId,
    planRevisionId: fixture.planRevision.planRevisionId,
    distributionReleaseId: `release_${suffix}`,
    repositoryFingerprint: fixtureFingerprint,
    workspaceId: fixture.planRevision.workspaceId,
    workspaceFingerprint: fixture.planRevision.workspaceFingerprint,
    sourceFingerprint: fixture.planRevision.sourceFingerprint,
    eventCursor: running.eventCursor,
    createdAt: fixtureTimestamp,
    engine: {
      engineReleaseId: `engine-release_${suffix}`,
      engineReleaseFingerprint: fixtureFingerprint,
      sessionReference: { namespace: "pi-session", reference: `session_${suffix}` },
      resumeCapability: "SUPPORTED",
    },
    activeOperationReceiptIds: [`opreceipt_${suffix}`],
    unknownOperationIds: [`op_${suffix}`],
    heldWriterLeaseIds: [`lease_${suffix}`],
    processReferences: [{ namespace: "process", reference: `process_${suffix}` }],
    remainingResourceBudgets: fixture.planRevision.loopPolicy.resourceBudgets,
  });
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "RECORD_CHECKPOINT",
    checkpoint,
  });
  return { fixture, kernel, checkpoint, originalAttemptId };
}

function identitiesFor(
  checkpoint: Awaited<ReturnType<typeof createRecoveryScenario>>["checkpoint"],
) {
  return {
    distribution: {
      kind: "DISTRIBUTION_RELEASE" as const,
      distributionReleaseId: checkpoint.distributionReleaseId,
    },
    workspace: {
      kind: "WORKSPACE" as const,
      workspaceId: checkpoint.workspaceId,
      repositoryFingerprint: checkpoint.repositoryFingerprint,
      workspaceFingerprint: checkpoint.workspaceFingerprint,
      sourceFingerprint: checkpoint.sourceFingerprint,
    },
    engine: {
      kind: "ENGINE" as const,
      engineReleaseId: checkpoint.engine.engineReleaseId,
      engineReleaseFingerprint: checkpoint.engine.engineReleaseFingerprint,
      sessionReference: checkpoint.engine.sessionReference,
    },
  };
}

function finalityFor(checkpoint: Awaited<ReturnType<typeof createRecoveryScenario>>["checkpoint"]) {
  const identityBody = checkpoint.checkpointId.slice("checkpoint_".length);
  return attemptFinalityReceiptSchema.parse({
    schemaVersion: "1.0.0",
    attemptFinalityReceiptId: `finality_${identityBody}`,
    runId: checkpoint.runId,
    attemptId: checkpoint.attemptId,
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    workspaceFingerprint: checkpoint.workspaceFingerprint,
    sourceFingerprint: checkpoint.sourceFingerprint,
    processFinalities: checkpoint.processReferences.map((processReference) => ({
      processReference,
      finalReceiptFingerprint: fixtureFingerprint,
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "RELEASED",
      terminalFinality: "FINAL",
    })),
    releasedWriterLeaseIds: checkpoint.heldWriterLeaseIds,
    terminalFinality: "FINAL",
    evidenceIds: [`evidence_${identityBody}-finality`],
    observedAt: "2026-08-03T00:00:01.000Z",
  });
}

function finalityReconcilerFor(
  checkpoint: Awaited<ReturnType<typeof createRecoveryScenario>>["checkpoint"],
) {
  return { reconcileAttemptFinality: vi.fn().mockResolvedValue(finalityFor(checkpoint)) };
}

describe("Task 9 RecoveryCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixtureTimestamp));
  });

  it("reconciles interruption facts and creates one linked recovery Attempt", async () => {
    const { fixture, kernel, checkpoint, originalAttemptId } =
      await createRecoveryScenario("task9");
    const identities = identitiesFor(checkpoint);

    const operationReceipt = operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: "reconcile_task9",
      operationId: "op_task9",
      fingerprint: fixtureFingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "NOOP",
      observedEffects: ["operation-state-reconciled"],
      observedAt: fixtureTimestamp,
    });
    const reconciler = {
      ...finalityReconcilerFor(checkpoint),
      revalidateDistributionRelease: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
      revalidateWorkspace: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
      reconcileOperations: vi.fn().mockResolvedValue({
        activeOperationReceiptIds: ["opreceipt_task9"],
        unknownOperationIds: ["op_task9"],
        receipts: [operationReceipt],
      }),
      reconcileEngine: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
    };
    const captureEvidence = vi.fn().mockResolvedValue({
      evidenceId: "evidence_task9-recovery",
      fingerprint: fixtureFingerprint,
    });

    const result = await new RecoveryCoordinator({
      kernel,
      reconciler,
      captureEvidence: { capture: captureEvidence },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-recovered"),
      operationId: "op_recovery-task9",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(result.status).toBe("RECOVERED");
    expect(reconciler.revalidateDistributionRelease).toHaveBeenCalledOnce();
    expect(reconciler.revalidateWorkspace).toHaveBeenCalledOnce();
    expect(reconciler.reconcileOperations).toHaveBeenCalledOnce();
    expect(reconciler.reconcileEngine).toHaveBeenCalledOnce();
    expect(captureEvidence).toHaveBeenCalledOnce();

    const recovered = await kernel.project(fixture.run.runId);
    expect(recovered.checkpoints).toHaveLength(1);
    expect(recovered.observations.at(-1)?.kind).toBe("PROCESS_EXITED");
    expect(recovered.attempts).toHaveLength(2);
    expect(recovered.attempts.at(-1)).toMatchObject({
      recoveryCheckpointId: checkpoint.checkpointId,
      previousAttemptId: originalAttemptId,
      failureEvidenceIds: ["evidence_task9-recovery"],
    });
  });

  it.each(["process", "lease"] as const)(
    "keeps recovery NOT_PROVEN when the finality Receipt omits a checkpoint %s identity",
    async (mismatch) => {
      const suffix = `task9-finality-${mismatch}`;
      const { kernel, checkpoint } = await createRecoveryScenario(suffix);
      const identities = identitiesFor(checkpoint);
      const operationReceipt = operationReconciliationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        reconciliationReceiptId: `reconcile_${suffix}`,
        operationId: `op_${suffix}`,
        fingerprint: fixtureFingerprint,
        previousOutcome: "UNKNOWN",
        outcome: "NOOP",
        observedEffects: ["operation-state-reconciled"],
        observedAt: fixtureTimestamp,
      });
      const exactFinality = finalityFor(checkpoint);
      const captureEvidence = vi.fn();
      const result = await new RecoveryCoordinator({
        kernel,
        reconciler: {
          revalidateDistributionRelease: vi
            .fn()
            .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
          revalidateWorkspace: vi
            .fn()
            .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
          reconcileOperations: vi.fn().mockResolvedValue({
            activeOperationReceiptIds: checkpoint.activeOperationReceiptIds,
            unknownOperationIds: checkpoint.unknownOperationIds,
            receipts: [operationReceipt],
          }),
          reconcileAttemptFinality: vi.fn().mockResolvedValue({
            ...exactFinality,
            ...(mismatch === "process" ? { processFinalities: [] } : {}),
            ...(mismatch === "lease" ? { releasedWriterLeaseIds: [] } : {}),
          }),
          reconcileEngine: vi
            .fn()
            .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
        },
        captureEvidence: { capture: captureEvidence },
        now: () => fixtureTimestamp,
      }).recover(checkpoint.checkpointId, {
        attemptId: attemptIdSchema.parse(`att_${suffix}-recovered`),
        operationId: operationIdSchema.parse(`op_recovery-${suffix}`),
        operationFingerprint: fixtureFingerprint,
        elapsedMs: 100,
        consumedResources: { externalOperations: 1 },
        startedAt: "2026-08-03T00:00:01.000Z",
      });

      expect(result).toMatchObject({
        status: "NOT_PROVEN",
        reasons: ["ATTEMPT_FINALITY_NOT_RECONCILED"],
      });
      expect(captureEvidence).not.toHaveBeenCalled();
      await expect(kernel.project(checkpoint.runId)).resolves.toMatchObject({
        attempts: [{}],
        attemptFinalityReceipts: [],
      });
    },
  );

  it("keeps recovery NOT_PROVEN when finality reconciliation is unavailable", async () => {
    const { kernel, checkpoint } = await createRecoveryScenario("task9-finality-unavailable");
    const identities = identitiesFor(checkpoint);
    const operationReceipt = operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: "reconcile_task9-finality-unavailable",
      operationId: "op_task9-finality-unavailable",
      fingerprint: fixtureFingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "NOOP",
      observedEffects: ["operation-state-reconciled"],
      observedAt: fixtureTimestamp,
    });
    const result = await new RecoveryCoordinator({
      kernel,
      reconciler: {
        revalidateDistributionRelease: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
        revalidateWorkspace: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: checkpoint.activeOperationReceiptIds,
          unknownOperationIds: checkpoint.unknownOperationIds,
          receipts: [operationReceipt],
        }),
        reconcileAttemptFinality: vi.fn().mockRejectedValue(new Error("finality unavailable")),
        reconcileEngine: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
      },
      captureEvidence: { capture: vi.fn() },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-finality-unavailable-recovered"),
      operationId: operationIdSchema.parse("op_recovery-task9-finality-unavailable"),
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(result).toMatchObject({
      status: "NOT_PROVEN",
      reasons: ["ATTEMPT_FINALITY_NOT_RECONCILED"],
    });
  });

  it("keeps recovery NOT_PROVEN when a PASS adapter reports the wrong release identity", async () => {
    const { kernel, checkpoint } = await createRecoveryScenario("task9-identity");
    const identities = identitiesFor(checkpoint);
    const operationReceipt = operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: "reconcile_task9-identity",
      operationId: "op_task9-identity",
      fingerprint: fixtureFingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "NOOP",
      observedEffects: ["operation-state-reconciled"],
      observedAt: fixtureTimestamp,
    });
    const result = await new RecoveryCoordinator({
      kernel,
      reconciler: {
        ...finalityReconcilerFor(checkpoint),
        revalidateDistributionRelease: vi.fn().mockResolvedValue({
          status: "PASS" as const,
          identity: {
            ...identities.distribution,
            distributionReleaseId: "release_task9-identity-other",
          },
        }),
        revalidateWorkspace: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: checkpoint.activeOperationReceiptIds,
          unknownOperationIds: checkpoint.unknownOperationIds,
          receipts: [operationReceipt],
        }),
        reconcileEngine: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
      },
      captureEvidence: { capture: vi.fn() },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-identity-recovered"),
      operationId: "op_recovery-task9-identity",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(result).toMatchObject({
      status: "NOT_PROVEN",
      reasons: ["DISTRIBUTION_RELEASE_NOT_REVALIDATED"],
    });
  });

  it("replays the same durable recovery operation without a second Attempt or Evidence capture", async () => {
    const { kernel, checkpoint } = await createRecoveryScenario("task9-idempotent");
    const identities = identitiesFor(checkpoint);
    const operationReceipt = operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: "reconcile_task9-idempotent",
      operationId: "op_task9-idempotent",
      fingerprint: fixtureFingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "NOOP",
      observedEffects: ["operation-state-reconciled"],
      observedAt: fixtureTimestamp,
    });
    const reconciler = {
      ...finalityReconcilerFor(checkpoint),
      revalidateDistributionRelease: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
      revalidateWorkspace: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
      reconcileOperations: vi.fn().mockResolvedValue({
        activeOperationReceiptIds: checkpoint.activeOperationReceiptIds,
        unknownOperationIds: checkpoint.unknownOperationIds,
        receipts: [operationReceipt],
      }),
      reconcileEngine: vi
        .fn()
        .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
    };
    const captureEvidence = vi.fn().mockResolvedValue({
      evidenceId: "evidence_task9-idempotent",
      fingerprint: fixtureFingerprint,
    });
    const coordinator = new RecoveryCoordinator({
      kernel,
      reconciler,
      captureEvidence: { capture: captureEvidence },
      now: () => fixtureTimestamp,
    });
    const request = {
      attemptId: attemptIdSchema.parse("att_task9-idempotent-recovered"),
      operationId: "op_recovery-task9-idempotent",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    };

    await expect(coordinator.recover(checkpoint.checkpointId, request)).resolves.toMatchObject({
      status: "RECOVERED",
      recoveryAttemptId: request.attemptId,
    });
    await expect(coordinator.recover(checkpoint.checkpointId, request)).resolves.toMatchObject({
      status: "RECOVERED",
      recoveryAttemptId: request.attemptId,
    });
    expect(captureEvidence).toHaveBeenCalledOnce();
    await expect(kernel.project(checkpoint.runId)).resolves.toMatchObject({
      attempts: [{}, {}],
    });
    expect((await kernel.project(checkpoint.runId)).attempts).toHaveLength(2);
    expect((await kernel.project(checkpoint.runId)).attemptFinalityReceipts).toHaveLength(1);
  });

  it("keeps recovery NOT_PROVEN when workspace or active operations are unresolved", async () => {
    const { fixture, kernel, checkpoint } = await createRecoveryScenario("task9-blocked");
    const identities = identitiesFor(checkpoint);
    const captureEvidence = vi.fn();
    const result = await new RecoveryCoordinator({
      kernel,
      reconciler: {
        ...finalityReconcilerFor(checkpoint),
        revalidateDistributionRelease: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
        revalidateWorkspace: vi
          .fn()
          .mockResolvedValue({ status: "NOT_PROVEN" as const, reason: "workspace changed" }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: [],
          unknownOperationIds: [],
          receipts: [],
        }),
        reconcileEngine: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
      },
      captureEvidence: { capture: captureEvidence },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-blocked-recovered"),
      operationId: "op_recovery-task9-blocked",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(result).toMatchObject({
      status: "NOT_PROVEN",
      reasons: ["WORKSPACE_NOT_REVALIDATED", "ACTIVE_OPERATIONS_NOT_RECONCILED"],
    });
    expect(captureEvidence).not.toHaveBeenCalled();
    const blockedProjection = await kernel.project(fixture.run.runId);
    expect(blockedProjection.attempts).toHaveLength(1);
    expect(blockedProjection.attempts[0]?.attemptId).toBe("att_task9-blocked-original");
  });

  it("does not recover when an active operation receipt is omitted", async () => {
    const { kernel, checkpoint } = await createRecoveryScenario("task9-active-receipt");
    const identities = identitiesFor(checkpoint);
    const operationReceipt = operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: "reconcile_task9-active-receipt",
      operationId: "op_task9-active-receipt",
      fingerprint: fixtureFingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "NOOP",
      observedEffects: ["operation-state-reconciled"],
      observedAt: fixtureTimestamp,
    });
    const result = await new RecoveryCoordinator({
      kernel,
      reconciler: {
        ...finalityReconcilerFor(checkpoint),
        revalidateDistributionRelease: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
        revalidateWorkspace: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: [],
          unknownOperationIds: ["op_task9-active-receipt"],
          receipts: [operationReceipt],
        }),
        reconcileEngine: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.engine }),
      },
      captureEvidence: { capture: vi.fn() },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-active-receipt-recovered"),
      operationId: "op_recovery-task9-active-receipt",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    expect(result).toMatchObject({
      status: "NOT_PROVEN",
      reasons: ["ACTIVE_OPERATIONS_NOT_RECONCILED"],
    });
  });

  it("rejects a direct recovery command whose Evidence is not bound to an observation", async () => {
    const { fixture, kernel, checkpoint, originalAttemptId } =
      await createRecoveryScenario("task9-evidence-binding");

    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_task9-evidence-binding-exit"),
        runId: fixture.run.runId,
        attemptId: originalAttemptId,
        kind: "PROCESS_EXITED",
        observedAt: fixtureTimestamp,
        evidenceIds: [evidenceIdSchema.parse("evidence_task9-other")],
      },
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_ATTEMPT_FINALITY",
      receipt: finalityFor(checkpoint),
    });

    await expect(
      kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECOVER_ATTEMPT",
        runId: fixture.run.runId,
        previousAttemptId: originalAttemptId,
        attemptId: attemptIdSchema.parse("att_task9-evidence-binding-recovered"),
        checkpointId: checkpoint.checkpointId,
        operationId: operationIdSchema.parse("op_recovery-task9-evidence-binding"),
        operationFingerprint: fixtureFingerprint,
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_task9-evidence-binding")],
        failureFingerprint: fixtureFingerprint,
        reason: "test recovery",
        elapsedMs: 100,
        consumedResources: { externalOperations: 1 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: "2026-08-03T00:00:01.000Z",
      }),
    ).rejects.toThrow(/recovery Evidence must be bound/);
  });

  it("fails closed when a reconciliation adapter cannot produce a result", async () => {
    const { fixture, kernel, checkpoint } = await createRecoveryScenario("task9-error");
    const identities = identitiesFor(checkpoint);
    const captureEvidence = vi.fn();
    const resultPromise = new RecoveryCoordinator({
      kernel,
      reconciler: {
        ...finalityReconcilerFor(checkpoint),
        revalidateDistributionRelease: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.distribution }),
        revalidateWorkspace: vi
          .fn()
          .mockResolvedValue({ status: "PASS" as const, identity: identities.workspace }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: [],
          unknownOperationIds: [],
          receipts: [],
        }),
        reconcileEngine: vi.fn().mockRejectedValue(new Error("engine unavailable")),
      },
      captureEvidence: { capture: captureEvidence },
      now: () => fixtureTimestamp,
    }).recover(checkpoint.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-error-recovered"),
      operationId: "op_recovery-task9-error",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:01.000Z",
    });

    await expect(resultPromise).resolves.toMatchObject({
      status: "NOT_PROVEN",
      reasons: ["ENGINE_STATE_NOT_RECONCILED", "ACTIVE_OPERATIONS_NOT_RECONCILED"],
    });
    expect(captureEvidence).not.toHaveBeenCalled();
    const errorProjection = await kernel.project(fixture.run.runId);
    expect(errorProjection.attempts).toHaveLength(1);
    expect(errorProjection.attempts[0]?.attemptId).toBe("att_task9-error-original");
  });

  it("reopens durable workflow facts before creating the recovery Attempt", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-durable-recovery-");
    const fixture = createWorkflowDomainFixture({ suffix: "task9-durable-recovery" });
    const stateRoot = join(root, "workflow");
    const kernel = new DurableWorkflowKernel(new FileWorkflowEventStore({ stateRoot }));
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change: fixture.change,
      planRevision: fixture.planRevision,
      run: fixture.run,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_task9-durable-recovery-original"),
      startedAt: fixtureTimestamp,
    });
    const checkpointDecision = await new CheckpointCoordinator({
      kernel,
      policy: { everyEvents: 1, everyElapsedMs: 1 },
      capture: {
        capture: ({ projection, now }) => {
          const attempt = projection.attempts.at(-1);
          if (attempt === undefined) throw new Error("missing durable recovery Attempt");
          return Promise.resolve({
            checkpointId: checkpointIdSchema.parse("checkpoint_task9-durable-recovery"),
            distributionReleaseId: distributionReleaseIdSchema.parse("release_task9"),
            repositoryFingerprint: fixtureFingerprint,
            engine: {
              engineReleaseId: engineReleaseIdSchema.parse("engine-release_task9"),
              engineReleaseFingerprint: fixtureFingerprint,
              sessionReference: { namespace: "pi-session", reference: "session_task9-durable" },
              resumeCapability: "SUPPORTED" as const,
            },
            activeOperationReceiptIds: [],
            unknownOperationIds: [],
            heldWriterLeaseIds: [],
            processReferences: [],
            remainingResourceBudgets: attempt.remainingResourceBudgets,
            createdAt: now,
          });
        },
      },
      now: () => "2026-08-03T00:00:01.000Z",
    }).maybeRecord(fixture.run.runId);
    expect(checkpointDecision.outcome).toBe("RECORDED");
    if (checkpointDecision.outcome !== "RECORDED") {
      throw new Error("expected a durable Checkpoint");
    }

    const reopenedKernel = new DurableWorkflowKernel(new FileWorkflowEventStore({ stateRoot }));
    const durableCheckpoint = (await reopenedKernel.project(fixture.run.runId)).checkpoints.find(
      (candidate) => candidate.checkpointId === checkpointDecision.checkpointId,
    );
    if (durableCheckpoint === undefined) {
      throw new Error("missing durable recovery Checkpoint after reopen");
    }
    const result = await new RecoveryCoordinator({
      kernel: reopenedKernel,
      reconciler: {
        ...finalityReconcilerFor(durableCheckpoint),
        revalidateDistributionRelease: vi.fn().mockResolvedValue({
          status: "PASS" as const,
          identity: {
            kind: "DISTRIBUTION_RELEASE" as const,
            distributionReleaseId: "release_task9",
          },
        }),
        revalidateWorkspace: vi.fn().mockResolvedValue({
          status: "PASS" as const,
          identity: {
            kind: "WORKSPACE" as const,
            workspaceId: fixture.planRevision.workspaceId,
            repositoryFingerprint: fixtureFingerprint,
            workspaceFingerprint: fixture.planRevision.workspaceFingerprint,
            sourceFingerprint: fixture.planRevision.sourceFingerprint,
          },
        }),
        reconcileOperations: vi.fn().mockResolvedValue({
          activeOperationReceiptIds: [],
          unknownOperationIds: [],
          receipts: [],
        }),
        reconcileEngine: vi.fn().mockResolvedValue({
          status: "PASS" as const,
          identity: {
            kind: "ENGINE" as const,
            engineReleaseId: "engine-release_task9",
            engineReleaseFingerprint: fixtureFingerprint,
            sessionReference: { namespace: "pi-session", reference: "session_task9-durable" },
          },
        }),
      },
      captureEvidence: {
        capture: vi.fn().mockResolvedValue({
          evidenceId: evidenceIdSchema.parse("evidence_task9-durable-recovery"),
          fingerprint: fixtureFingerprint,
        }),
      },
      now: () => fixtureTimestamp,
    }).recover(checkpointDecision.checkpointId, {
      attemptId: attemptIdSchema.parse("att_task9-durable-recovery-recovered"),
      operationId: "op_recovery-task9-durable",
      operationFingerprint: fixtureFingerprint,
      elapsedMs: 100,
      consumedResources: { externalOperations: 1 },
      startedAt: "2026-08-03T00:00:02.000Z",
    });

    expect(result.status).toBe("RECOVERED");
    const recoveredProjection = await reopenedKernel.project(fixture.run.runId);
    expect(recoveredProjection.attempts.at(-1)?.attemptId).toBe(
      "att_task9-durable-recovery-recovered",
    );
    expect(recoveredProjection.attemptFinalityReceipts).toEqual([finalityFor(durableCheckpoint)]);
  });
});
