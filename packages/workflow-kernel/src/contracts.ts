import { z } from "zod";

import {
  attemptIdSchema,
  attemptSchema,
  checkpointSchema,
  checkIdSchema,
  evidenceIdSchema,
  fingerprintSchema,
  humanReceiptSchema,
  managedChangeSchema,
  observationSchema,
  planRevisionSchema,
  reviewReceiptSchema,
  resourceUsageSchema,
  runIdSchema,
  runSchema,
  schemaVersionSchema,
  timestampSchema,
  verificationReceiptSchema,
  type CheckpointId,
} from "@hunter-pi/domain";

const workflowCommandVersionShape = { schemaVersion: schemaVersionSchema };

export const createRunCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("CREATE_RUN"),
  change: managedChangeSchema,
  planRevision: planRevisionSchema,
  run: runSchema,
});

export const startAttemptCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("START_ATTEMPT"),
  runId: runIdSchema,
  attemptId: attemptIdSchema,
  startedAt: timestampSchema,
});

export const recordObservationCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RECORD_OBSERVATION"),
  observation: observationSchema,
});

export const recordVerificationCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RECORD_VERIFICATION"),
  receipt: verificationReceiptSchema,
});

export const recordHumanReceiptCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RECORD_HUMAN_RECEIPT"),
  receipt: humanReceiptSchema,
});

export const recordReviewReceiptCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RECORD_REVIEW_RECEIPT"),
  receipt: reviewReceiptSchema,
});

export const retryAttemptCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RETRY_ATTEMPT"),
  runId: runIdSchema,
  previousAttemptId: attemptIdSchema,
  attemptId: attemptIdSchema,
  failureEvidenceIds: z.array(evidenceIdSchema).min(1),
  failureFingerprint: fingerprintSchema,
  reason: z.string().trim().min(1).max(4_096),
  elapsedMs: z.number().int().nonnegative(),
  consumedResources: resourceUsageSchema,
  userInputRequired: z.boolean(),
  workspaceDriftDetected: z.boolean(),
  startedAt: timestampSchema,
});

export const recordCheckpointCommandSchema = z.strictObject({
  ...workflowCommandVersionShape,
  type: z.literal("RECORD_CHECKPOINT"),
  checkpoint: checkpointSchema,
});

export const workflowCommandSchema = z.discriminatedUnion("type", [
  createRunCommandSchema,
  startAttemptCommandSchema,
  recordObservationCommandSchema,
  recordVerificationCommandSchema,
  recordHumanReceiptCommandSchema,
  recordReviewReceiptCommandSchema,
  retryAttemptCommandSchema,
  recordCheckpointCommandSchema,
]);
export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;

export const workflowEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("RUN_CREATED"),
    change: managedChangeSchema,
    planRevision: planRevisionSchema,
    run: runSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("ATTEMPT_STARTED"),
    attempt: attemptSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("OBSERVATION_RECORDED"),
    observation: observationSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("VERIFICATION_RECORDED"),
    receipt: verificationReceiptSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("HUMAN_RECEIPT_RECORDED"),
    receipt: humanReceiptSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("REVIEW_RECEIPT_RECORDED"),
    receipt: reviewReceiptSchema,
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    cursor: z.number().int().positive(),
    type: z.literal("CHECKPOINT_RECORDED"),
    checkpoint: checkpointSchema,
  }),
]);
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

export const checkProjectionSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  checkId: checkIdSchema,
  required: z.boolean(),
  status: z.enum(["NOT_RUN", "PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]),
});
export type CheckProjection = z.infer<typeof checkProjectionSchema>;

export const runProjectionSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  change: managedChangeSchema,
  planRevision: planRevisionSchema,
  run: runSchema,
  attempts: z.array(attemptSchema),
  observations: z.array(observationSchema),
  verificationReceipts: z.array(verificationReceiptSchema),
  humanReceipts: z.array(humanReceiptSchema),
  reviewReceipts: z.array(reviewReceiptSchema),
  checkpoints: z.array(checkpointSchema),
  checks: z.array(checkProjectionSchema),
  eventCursor: z.number().int().positive(),
});
export type RunProjection = z.infer<typeof runProjectionSchema>;

export const workflowDecisionSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  status: z.literal("ACCEPTED"),
  events: z.array(workflowEventSchema).min(1),
  projection: runProjectionSchema,
});
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;

export const recoveryDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    status: z.literal("NOT_PROVEN"),
    checkpoint: checkpointSchema,
    projection: runProjectionSchema,
    reasons: z.tuple([
      z.literal("IN_MEMORY_STATE_NOT_DURABLE"),
      z.literal("WORKSPACE_NOT_REVALIDATED"),
      z.literal("ENGINE_STATE_NOT_RECONCILED"),
    ]),
  }),
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    status: z.literal("NOT_FOUND"),
  }),
]);
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;

export interface WorkflowKernel {
  dispatch(command: WorkflowCommand): Promise<WorkflowDecision>;
  project(runId: z.infer<typeof runIdSchema>): Promise<RunProjection>;
  recover(checkpointId: CheckpointId): Promise<RecoveryDecision>;
}
