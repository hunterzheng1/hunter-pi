import { z } from "zod";

import {
  attemptFinalityReceiptSchema,
  attemptIdSchema,
  checkpointIdSchema,
  evidenceIdSchema,
  fingerprintSchema,
  observationIdSchema,
  operationReconciliationReceiptSchema,
  operationIdSchema,
  operationReceiptIdSchema,
  runIdSchema,
  timestampSchema,
  type Checkpoint,
  type AttemptFinalityReceipt,
  type CheckpointId,
  type EvidenceId,
  type Fingerprint,
  type OperationId,
  type OperationReceiptId,
} from "@hunter-pi/domain";

import {
  recoveryDecisionSchema,
  recoveryIdentitySchema,
  recoveryReconciliationSchema,
  type RecoveryDecision,
  type RecoveryReason,
  type RecoveryReconciliation,
  type WorkflowKernel,
} from "./contracts.js";

export const recoveryCheckSchema = z
  .strictObject({
    status: z.enum(["PASS", "BLOCKED", "NOT_PROVEN"]),
    identity: recoveryIdentitySchema.optional(),
    reason: z.string().trim().min(1).max(4_096).optional(),
  })
  .superRefine((check, context) => {
    if (check.status === "PASS" && check.identity === undefined) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "a PASS recovery reconciliation must bind an exact external identity",
      });
    }
  });
export type RecoveryCheck = z.infer<typeof recoveryCheckSchema>;

export const recoveryOperationResultSchema = z
  .strictObject({
    activeOperationReceiptIds: z.array(operationReceiptIdSchema),
    unknownOperationIds: z.array(operationIdSchema),
    receipts: z.array(operationReconciliationReceiptSchema),
  })
  .superRefine((result, context) => {
    if (
      new Set(result.activeOperationReceiptIds).size !== result.activeOperationReceiptIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeOperationReceiptIds"],
        message: "active operation receipt identities must be unique",
      });
    }
    if (new Set(result.unknownOperationIds).size !== result.unknownOperationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["unknownOperationIds"],
        message: "unknown operation identities must be unique",
      });
    }
    if (
      new Set(result.receipts.map((receipt) => receipt.operationId)).size !== result.receipts.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipts"],
        message: "operation reconciliation identities must be unique",
      });
    }
  });
export type RecoveryOperationResult = z.infer<typeof recoveryOperationResultSchema>;

export interface RecoveryReconciler {
  revalidateDistributionRelease(checkpoint: Checkpoint): Promise<RecoveryCheck>;
  revalidateWorkspace(checkpoint: Checkpoint): Promise<RecoveryCheck>;
  reconcileOperations(checkpoint: Checkpoint): Promise<RecoveryOperationResult>;
  reconcileAttemptFinality(checkpoint: Checkpoint): Promise<AttemptFinalityReceipt>;
  reconcileEngine(checkpoint: Checkpoint): Promise<RecoveryCheck>;
}

export const recoveryEvidenceRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-recovery-evidence.v1"),
  runId: runIdSchema,
  checkpointId: checkpointIdSchema,
  attemptId: attemptIdSchema,
  sourceFingerprint: fingerprintSchema,
  createdAt: timestampSchema,
  reconciliation: recoveryReconciliationSchema,
});
export type RecoveryEvidenceRequest = z.input<typeof recoveryEvidenceRequestSchema>;

export interface RecoveryEvidenceCapture {
  capture(request: RecoveryEvidenceRequest): Promise<{
    readonly evidenceId: EvidenceId;
    readonly fingerprint: Fingerprint;
  }>;
}

export const recoveryAttemptRequestSchema = z.strictObject({
  attemptId: attemptIdSchema,
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  elapsedMs: z.number().int().nonnegative(),
  consumedResources: z.strictObject({
    agentTurns: z.number().int().nonnegative().optional(),
    externalOperations: z.number().int().nonnegative().optional(),
    commands: z.number().int().nonnegative().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    tokens: z.number().int().nonnegative().optional(),
    costMinorUnits: z.number().int().nonnegative().optional(),
  }),
  startedAt: timestampSchema,
});
export type RecoveryAttemptRequest = z.input<typeof recoveryAttemptRequestSchema>;

export interface RecoveryCoordinatorOptions {
  readonly kernel: WorkflowKernel;
  readonly reconciler: RecoveryReconciler;
  readonly captureEvidence: RecoveryEvidenceCapture;
  readonly now?: () => string;
}

function reasonsFor(
  distributionRelease: RecoveryCheck,
  workspace: RecoveryCheck,
  operations: RecoveryOperationResult,
  expectedOperationIds: readonly OperationId[],
  expectedOperationReceiptIds: readonly OperationReceiptId[],
  attemptFinality: AttemptFinalityReceipt | undefined,
  engine: RecoveryCheck,
  checkpoint: Checkpoint,
): RecoveryReason[] {
  const reasons = new Set<RecoveryReason>();
  const expectedDistributionIdentity = {
    kind: "DISTRIBUTION_RELEASE" as const,
    distributionReleaseId: checkpoint.distributionReleaseId,
  };
  const expectedWorkspaceIdentity = {
    kind: "WORKSPACE" as const,
    workspaceId: checkpoint.workspaceId,
    repositoryFingerprint: checkpoint.repositoryFingerprint,
    workspaceFingerprint: checkpoint.workspaceFingerprint,
    sourceFingerprint: checkpoint.sourceFingerprint,
  };
  const expectedEngineIdentity = {
    kind: "ENGINE" as const,
    engineReleaseId: checkpoint.engine.engineReleaseId,
    engineReleaseFingerprint: checkpoint.engine.engineReleaseFingerprint,
    ...(checkpoint.engine.sessionReference === undefined
      ? {}
      : { sessionReference: checkpoint.engine.sessionReference }),
  };
  const canonicalIdentity = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalIdentity).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalIdentity(nested)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const identityMatches = (actual: RecoveryCheck, expected: unknown): boolean =>
    actual.status === "PASS" &&
    actual.identity !== undefined &&
    canonicalIdentity(actual.identity) === canonicalIdentity(expected);
  const identitySetMatches = (
    actual: readonly unknown[],
    expected: readonly unknown[],
  ): boolean => {
    const actualSet = new Set(actual.map(canonicalIdentity));
    const expectedSet = new Set(expected.map(canonicalIdentity));
    return (
      actualSet.size === expectedSet.size &&
      [...actualSet].every((identity) => expectedSet.has(identity))
    );
  };
  if (!identityMatches(distributionRelease, expectedDistributionIdentity)) {
    reasons.add("DISTRIBUTION_RELEASE_NOT_REVALIDATED");
  }
  if (!identityMatches(workspace, expectedWorkspaceIdentity)) {
    reasons.add("WORKSPACE_NOT_REVALIDATED");
  }
  if (!identityMatches(engine, expectedEngineIdentity)) {
    reasons.add("ENGINE_STATE_NOT_RECONCILED");
  }
  const expected = new Set(expectedOperationIds);
  const observed = new Set<string>(operations.receipts.map((receipt) => receipt.operationId));
  const expectedReceipts = new Set(expectedOperationReceiptIds);
  const observedReceipts = new Set(operations.activeOperationReceiptIds);
  if (
    observed.size !== expected.size ||
    [...expected].some((operationId) => !observed.has(operationId)) ||
    operations.unknownOperationIds.length !== expected.size ||
    [...expected].some((operationId) => !operations.unknownOperationIds.includes(operationId)) ||
    operations.receipts.some((receipt) => receipt.outcome === "UNKNOWN") ||
    observedReceipts.size !== expectedReceipts.size ||
    [...expectedReceipts].some((receiptId) => !observedReceipts.has(receiptId))
  ) {
    reasons.add("ACTIVE_OPERATIONS_NOT_RECONCILED");
  }
  if (
    attemptFinality?.runId !== checkpoint.runId ||
    attemptFinality.attemptId !== checkpoint.attemptId ||
    attemptFinality.checkpointId !== checkpoint.checkpointId ||
    attemptFinality.workspaceId !== checkpoint.workspaceId ||
    attemptFinality.workspaceFingerprint !== checkpoint.workspaceFingerprint ||
    attemptFinality.sourceFingerprint !== checkpoint.sourceFingerprint ||
    !identitySetMatches(
      attemptFinality.processFinalities.map(({ processReference }) => processReference),
      checkpoint.processReferences,
    ) ||
    !identitySetMatches(attemptFinality.releasedWriterLeaseIds, checkpoint.heldWriterLeaseIds) ||
    Date.parse(attemptFinality.observedAt) < Date.parse(checkpoint.createdAt)
  ) {
    reasons.add("ATTEMPT_FINALITY_NOT_RECONCILED");
  }
  return [...reasons];
}

export class RecoveryCoordinator {
  readonly #kernel: WorkflowKernel;
  readonly #reconciler: RecoveryReconciler;
  readonly #captureEvidence: RecoveryEvidenceCapture;
  readonly #now: () => string;

  public constructor(options: RecoveryCoordinatorOptions) {
    this.#kernel = options.kernel;
    this.#reconciler = options.reconciler;
    this.#captureEvidence = options.captureEvidence;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async recover(
    checkpointId: CheckpointId,
    request: RecoveryAttemptRequest,
  ): Promise<RecoveryDecision> {
    const parsedCheckpointId = checkpointIdSchema.parse(checkpointId);
    const parsedRequest = recoveryAttemptRequestSchema.parse(request);
    const initial = await this.#kernel.recover(parsedCheckpointId);
    if (initial.status !== "NOT_PROVEN") {
      return initial;
    }

    const checkpoint = initial.checkpoint;
    const unresolvedCheck: RecoveryCheck = { status: "NOT_PROVEN" };
    const [distributionRelease, workspace, operationResult, finalityResult, engine] =
      await Promise.all([
        this.#reconciler
          .revalidateDistributionRelease(checkpoint)
          .then((check) => recoveryCheckSchema.parse(check))
          .catch(() => unresolvedCheck),
        this.#reconciler
          .revalidateWorkspace(checkpoint)
          .then((check) => recoveryCheckSchema.parse(check))
          .catch(() => unresolvedCheck),
        this.#reconciler
          .reconcileOperations(checkpoint)
          .then((result) => ({
            result: recoveryOperationResultSchema.parse(result),
            unavailable: false,
          }))
          .catch(() => ({
            result: recoveryOperationResultSchema.parse({
              activeOperationReceiptIds: [],
              unknownOperationIds: [],
              receipts: [],
            }),
            unavailable: true,
          })),
        this.#reconciler
          .reconcileAttemptFinality(checkpoint)
          .then((receipt) => ({
            receipt: attemptFinalityReceiptSchema.parse(receipt),
            unavailable: false,
          }))
          .catch(() => ({ receipt: undefined, unavailable: true })),
        this.#reconciler
          .reconcileEngine(checkpoint)
          .then((check) => recoveryCheckSchema.parse(check))
          .catch(() => unresolvedCheck),
      ]);
    const operations = operationResult.result;
    const attemptFinality = finalityResult.receipt;
    const reasons = [
      ...reasonsFor(
        distributionRelease,
        workspace,
        operations,
        checkpoint.unknownOperationIds,
        checkpoint.activeOperationReceiptIds,
        attemptFinality,
        engine,
        checkpoint,
      ),
      ...(operationResult.unavailable ? ["ACTIVE_OPERATIONS_NOT_RECONCILED" as const] : []),
      ...(finalityResult.unavailable ? ["ATTEMPT_FINALITY_NOT_RECONCILED" as const] : []),
    ].filter((reason, index, all) => all.indexOf(reason) === index);
    if (reasons.length > 0) {
      return recoveryDecisionSchema.parse({
        schemaVersion: "1.0.0",
        status: "NOT_PROVEN",
        checkpoint,
        projection: initial.projection,
        reasons,
      });
    }
    if (attemptFinality === undefined) {
      throw new Error("Attempt finality reconciliation passed without a Receipt");
    }

    const distributionIdentity = recoveryIdentitySchema.parse(distributionRelease.identity);
    const workspaceIdentity = recoveryIdentitySchema.parse(workspace.identity);
    const engineIdentity = recoveryIdentitySchema.parse(engine.identity);
    const reconciliation: RecoveryReconciliation = recoveryReconciliationSchema.parse({
      schemaVersion: "1.0.0",
      distributionRelease: "PASS",
      distributionIdentity,
      workspace: "PASS",
      workspaceIdentity,
      activeOperationReceiptIds: operations.activeOperationReceiptIds,
      unknownOperationIds: operations.unknownOperationIds,
      operations: operations.receipts,
      attemptFinality: "PASS",
      attemptFinalityReceipt: attemptFinality,
      engine: "PASS",
      engineIdentity,
    });
    const existingRecovery = initial.projection.attempts.find(
      (attempt) => attempt.attemptId === parsedRequest.attemptId,
    );
    const operationCollision = initial.projection.attempts.find(
      (attempt) =>
        attempt.recoveryOperationId === parsedRequest.operationId &&
        attempt.attemptId !== parsedRequest.attemptId,
    );
    if (operationCollision !== undefined) {
      throw new Error("recovery operation identity is already bound to another Attempt");
    }
    if (existingRecovery !== undefined) {
      if (
        existingRecovery.recoveryCheckpointId !== checkpoint.checkpointId ||
        existingRecovery.recoveryOperationId !== parsedRequest.operationId ||
        existingRecovery.recoveryOperationFingerprint !== parsedRequest.operationFingerprint ||
        existingRecovery.previousAttemptId !== checkpoint.attemptId
      ) {
        throw new Error("recovery Attempt identity or operation fingerprint changed during replay");
      }
      return recoveryDecisionSchema.parse({
        schemaVersion: "1.0.0",
        status: "RECOVERED",
        checkpoint,
        recoveryAttemptId: existingRecovery.attemptId,
        reconciliation,
        projection: initial.projection,
      });
    }

    const previousAttempt = initial.projection.attempts.at(-1);
    if (previousAttempt === undefined || checkpoint.attemptId !== previousAttempt.attemptId) {
      return recoveryDecisionSchema.parse({
        schemaVersion: "1.0.0",
        status: "NOT_PROVEN",
        checkpoint,
        projection: initial.projection,
        reasons: ["ENGINE_STATE_NOT_RECONCILED"],
      });
    }

    const existingFinality = initial.projection.attemptFinalityReceipts.find(
      (receipt) => receipt.attemptId === previousAttempt.attemptId,
    );
    if (
      existingFinality !== undefined &&
      JSON.stringify(existingFinality) !== JSON.stringify(attemptFinality)
    ) {
      throw new Error("Attempt Finality Receipt changed during recovery replay");
    }

    const evidence = await this.#captureEvidence.capture({
      schemaVersion: "hpi-recovery-evidence.v1",
      runId: checkpoint.runId,
      checkpointId: checkpoint.checkpointId,
      attemptId: previousAttempt.attemptId,
      sourceFingerprint: checkpoint.sourceFingerprint,
      createdAt: this.#now(),
      reconciliation,
    });
    const evidenceId = evidenceIdSchema.parse(evidence.evidenceId);
    const failureFingerprint = fingerprintSchema.parse(evidence.fingerprint);

    const hasRecoveryObservation = initial.projection.observations.some(
      (observation) =>
        observation.attemptId === previousAttempt.attemptId &&
        observation.kind === "PROCESS_EXITED" &&
        [evidenceId].every((candidate) => observation.evidenceIds.includes(candidate)),
    );
    if (!hasRecoveryObservation) {
      await this.#kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_OBSERVATION",
        observation: {
          schemaVersion: "1.0.0",
          observationId: observationIdSchema.parse(
            `obs_recovery-${checkpoint.checkpointId.slice("checkpoint_".length)}`,
          ),
          runId: checkpoint.runId,
          attemptId: previousAttempt.attemptId,
          kind: "PROCESS_EXITED",
          observedAt: parsedRequest.startedAt,
          summary: "Recovery reconciliation observed the owned process tree as final.",
          evidenceIds: [evidenceId],
        },
      });
    }
    if (existingFinality === undefined) {
      await this.#kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_ATTEMPT_FINALITY",
        receipt: attemptFinality,
      });
    }

    const decision = await this.#kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECOVER_ATTEMPT",
      runId: checkpoint.runId,
      previousAttemptId: previousAttempt.attemptId,
      attemptId: parsedRequest.attemptId,
      checkpointId: checkpoint.checkpointId,
      operationId: parsedRequest.operationId,
      operationFingerprint: parsedRequest.operationFingerprint,
      failureEvidenceIds: [evidenceId],
      failureFingerprint,
      reason: "Recovery after exact external-state reconciliation",
      elapsedMs: parsedRequest.elapsedMs,
      consumedResources: parsedRequest.consumedResources,
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: parsedRequest.startedAt,
    });
    const recoveredAttempt = decision.projection.attempts.at(-1);
    if (recoveredAttempt === undefined) {
      throw new Error("Recovery created no recovery Attempt");
    }
    return recoveryDecisionSchema.parse({
      schemaVersion: "1.0.0",
      status: "RECOVERED",
      checkpoint,
      recoveryAttemptId: recoveredAttempt.attemptId,
      reconciliation,
      projection: decision.projection,
    });
  }
}
