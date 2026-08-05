import { z } from "zod";

import {
  checkpointSchema,
  checkpointIdSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  externalReferenceSchema,
  fingerprintSchema,
  operationReceiptIdSchema,
  operationIdSchema,
  resourceBudgetsSchema,
  runIdSchema,
  timestampSchema,
  writerLeaseIdSchema,
  type Checkpoint,
} from "@hunter-pi/domain";

import type { RunProjection, WorkflowKernel } from "./contracts.js";
import { WorkflowTransitionError } from "./in-memory-workflow-kernel.js";

const positiveIntegerSchema = z.number().int().positive();

export const checkpointPolicySchema = z.strictObject({
  everyEvents: positiveIntegerSchema,
  everyElapsedMs: positiveIntegerSchema,
});
export type CheckpointPolicy = z.infer<typeof checkpointPolicySchema>;

const checkpointEngineSnapshotSchema = z.strictObject({
  engineReleaseId: engineReleaseIdSchema,
  engineReleaseFingerprint: fingerprintSchema,
  sessionReference: externalReferenceSchema.optional(),
  resumeCapability: z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]),
});

export const checkpointSnapshotSchema = z.strictObject({
  checkpointId: checkpointIdSchema,
  distributionReleaseId: distributionReleaseIdSchema,
  repositoryFingerprint: fingerprintSchema,
  engine: checkpointEngineSnapshotSchema,
  activeOperationReceiptIds: z.array(operationReceiptIdSchema),
  unknownOperationIds: z.array(operationIdSchema),
  heldWriterLeaseIds: z.array(writerLeaseIdSchema),
  processReferences: z.array(externalReferenceSchema),
  remainingResourceBudgets: resourceBudgetsSchema,
  createdAt: timestampSchema,
});
export type CheckpointSnapshot = Pick<
  Checkpoint,
  | "checkpointId"
  | "distributionReleaseId"
  | "repositoryFingerprint"
  | "engine"
  | "activeOperationReceiptIds"
  | "unknownOperationIds"
  | "heldWriterLeaseIds"
  | "processReferences"
  | "remainingResourceBudgets"
  | "createdAt"
>;

export const checkpointDecisionSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    schemaVersion: z.literal("hpi-checkpoint-decision.v1"),
    outcome: z.literal("RECORDED"),
    runId: runIdSchema,
    checkpointId: checkpointIdSchema,
    eventCursor: z.number().int().positive(),
  }),
  z.strictObject({
    schemaVersion: z.literal("hpi-checkpoint-decision.v1"),
    outcome: z.literal("NOOP"),
    runId: runIdSchema,
    reason: z.enum(["ALREADY_CURRENT", "THRESHOLD_NOT_REACHED"]),
  }),
]);
export type CheckpointDecision = z.infer<typeof checkpointDecisionSchema>;

export interface CheckpointCapture {
  capture(input: {
    readonly projection: RunProjection;
    readonly now: string;
  }): Promise<CheckpointSnapshot>;
}

export interface CheckpointCoordinatorOptions {
  readonly kernel: WorkflowKernel;
  readonly policy: CheckpointPolicy;
  readonly capture: CheckpointCapture;
  readonly now?: () => string;
}

function sameBudgetValues(
  left: Checkpoint["remainingResourceBudgets"],
  right: Checkpoint["remainingResourceBudgets"],
): boolean {
  const keys = [
    "maxAgentTurns",
    "maxExternalOperations",
    "maxCommands",
    "maxOutputBytes",
    "maxTokens",
    "maxCostMinorUnits",
  ] as const;
  return keys.every((key) => left[key] === right[key]);
}

export class CheckpointCoordinator {
  readonly #kernel: WorkflowKernel;
  readonly #policy: CheckpointPolicy;
  readonly #capture: CheckpointCapture;
  readonly #now: () => string;

  public constructor(options: CheckpointCoordinatorOptions) {
    this.#kernel = options.kernel;
    this.#policy = checkpointPolicySchema.parse(options.policy);
    this.#capture = options.capture;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async maybeRecord(
    runId: z.input<typeof runIdSchema>,
    options: { readonly force?: boolean } = {},
  ): Promise<CheckpointDecision> {
    const parsedRunId = runIdSchema.parse(runId);
    const projection = await this.#kernel.project(parsedRunId);
    const latest = projection.checkpoints.at(-1);
    const now = timestampSchema.parse(this.#now());
    if (latest !== undefined && projection.eventCursor === latest.eventCursor + 1) {
      return checkpointDecisionSchema.parse({
        schemaVersion: "hpi-checkpoint-decision.v1",
        outcome: "NOOP",
        runId: parsedRunId,
        reason: "ALREADY_CURRENT",
      });
    }

    const baseline = latest?.createdAt ?? projection.run.startedAt;
    const elapsedSinceCheckpoint = Date.parse(now) - Date.parse(baseline);
    const eventsSinceCheckpoint = Math.max(
      0,
      projection.eventCursor - (latest?.eventCursor ?? 0) - (latest === undefined ? 0 : 1),
    );
    if (
      options.force !== true &&
      (elapsedSinceCheckpoint < 0 ||
        (eventsSinceCheckpoint < this.#policy.everyEvents &&
          elapsedSinceCheckpoint < this.#policy.everyElapsedMs))
    ) {
      return checkpointDecisionSchema.parse({
        schemaVersion: "hpi-checkpoint-decision.v1",
        outcome: "NOOP",
        runId: parsedRunId,
        reason: "THRESHOLD_NOT_REACHED",
      });
    }

    const snapshot = checkpointSnapshotSchema.parse(
      await this.#capture.capture({ projection, now }),
    );
    const attempt = projection.attempts.at(-1);
    if (attempt === undefined) {
      throw new WorkflowTransitionError("a periodic Checkpoint requires an active Attempt");
    }
    if (
      snapshot.createdAt !== now ||
      !sameBudgetValues(snapshot.remainingResourceBudgets, attempt.remainingResourceBudgets)
    ) {
      throw new WorkflowTransitionError(
        "Checkpoint capture does not bind the current Attempt time and budgets",
      );
    }
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: snapshot.checkpointId,
      runId: projection.run.runId,
      attemptId: attempt.attemptId,
      planRevisionId: projection.planRevision.planRevisionId,
      distributionReleaseId: snapshot.distributionReleaseId,
      workspaceId: projection.planRevision.workspaceId,
      repositoryFingerprint: snapshot.repositoryFingerprint,
      workspaceFingerprint: projection.planRevision.workspaceFingerprint,
      sourceFingerprint: projection.planRevision.sourceFingerprint,
      eventCursor: projection.eventCursor,
      createdAt: snapshot.createdAt,
      engine: snapshot.engine,
      activeOperationReceiptIds: snapshot.activeOperationReceiptIds,
      unknownOperationIds: snapshot.unknownOperationIds,
      heldWriterLeaseIds: snapshot.heldWriterLeaseIds,
      processReferences: snapshot.processReferences,
      remainingResourceBudgets: snapshot.remainingResourceBudgets,
    });
    await this.#kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_CHECKPOINT",
      checkpoint,
    });
    return checkpointDecisionSchema.parse({
      schemaVersion: "hpi-checkpoint-decision.v1",
      outcome: "RECORDED",
      runId: parsedRunId,
      checkpointId: checkpoint.checkpointId,
      eventCursor: checkpoint.eventCursor,
    });
  }
}
