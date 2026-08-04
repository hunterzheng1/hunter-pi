import { z } from "zod";

import {
  attemptIdSchema,
  checkpointIdSchema,
  externalReferenceSchema,
  externalOperationSchema,
  fingerprintSchema,
  operationIdSchema,
  operationReceiptSchema,
  planRevisionIdSchema,
  resourceUsageSchema,
  runIdSchema,
  schemaVersionSchema,
  timestampSchema,
  type OperationReceipt,
  type OperationReconciliationReceipt,
} from "@hunter-pi/domain";

export const engineHandleIdSchema = z
  .string()
  .regex(/^engine_[A-Za-z0-9][A-Za-z0-9.-]*$/u)
  .brand<"EngineHandleId">();
export type EngineHandleId = z.infer<typeof engineHandleIdSchema>;

export const eventCursorSchema = z.number().int().nonnegative();
export type EventCursor = z.infer<typeof eventCursorSchema>;

export const engineCapabilitySchema = z.enum([
  "START_ATTEMPT",
  "SEND_INPUT",
  "OBSERVE",
  "INTERRUPT",
  "CHECKPOINT",
  "RECONCILE",
  "RESUME",
  "CLOSE",
]);
export type EngineCapability = z.infer<typeof engineCapabilitySchema>;

export const capabilityStatusSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const probeRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  requestedCapabilities: z.array(engineCapabilitySchema).min(1),
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const capabilityProbeResultSchema = z.strictObject({
  capability: engineCapabilitySchema,
  status: capabilityStatusSchema,
});
export type CapabilityProbeResult = z.infer<typeof capabilityProbeResultSchema>;

export const capabilityReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    observedAt: timestampSchema,
    results: z.array(capabilityProbeResultSchema).min(1),
  })
  .refine(
    (receipt) =>
      new Set(receipt.results.map((result) => result.capability)).size === receipt.results.length,
    "a Capability Receipt must contain exactly one result per capability",
  );
export type CapabilityReceipt = z.infer<typeof capabilityReceiptSchema>;

export function supportsEngineCapability(
  receipt: CapabilityReceipt,
  capability: EngineCapability,
): boolean {
  const parsedReceipt = capabilityReceiptSchema.parse(receipt);
  return parsedReceipt.results.some(
    (result) => result.capability === capability && result.status === "SUPPORTED",
  );
}

const externalOperationFields = externalOperationSchema.shape;

export const workspaceTargetNamespace = "workspace" as const;
export const engineHandleTargetNamespace = "engine-handle" as const;
export const workspaceTargetReferenceSchema = externalReferenceSchema.extend({
  namespace: z.literal(workspaceTargetNamespace),
});
export const engineHandleTargetReferenceSchema = externalReferenceSchema.extend({
  namespace: z.literal(engineHandleTargetNamespace),
});

export const startAttemptRequestSchema = z
  .strictObject({
    ...externalOperationFields,
    expectedTarget: workspaceTargetReferenceSchema,
    runId: runIdSchema,
    attemptId: attemptIdSchema,
    planRevisionId: planRevisionIdSchema,
    workspaceReference: z.string().trim().min(1).max(512),
  })
  .refine(
    (request) => request.expectedTarget.reference === request.workspaceReference,
    "start expectedTarget must identify the requested workspace",
  );
export type StartAttemptRequest = z.infer<typeof startAttemptRequestSchema>;

export const engineHandleSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  engineHandleId: engineHandleIdSchema,
  attemptId: attemptIdSchema,
});
export type EngineHandle = z.infer<typeof engineHandleSchema>;

export const startAttemptReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  handle: engineHandleSchema,
  operationReceipt: operationReceiptSchema,
});
export type StartAttemptReceipt = z.infer<typeof startAttemptReceiptSchema>;

const engineHandleOperationFields = {
  ...externalOperationFields,
  expectedTarget: engineHandleTargetReferenceSchema,
};

export const engineInputSchema = z.strictObject({
  ...engineHandleOperationFields,
  kind: z.enum(["USER_INPUT", "CONTROL_MESSAGE"]),
  content: z.string().min(1).max(1_000_000),
});
export type EngineInput = z.infer<typeof engineInputSchema>;

export const interruptRequestSchema = z.strictObject({
  ...engineHandleOperationFields,
  reason: z.string().trim().min(1).max(4_096),
});
export type InterruptRequest = z.infer<typeof interruptRequestSchema>;

export const checkpointRequestSchema = z.strictObject(engineHandleOperationFields);
export type CheckpointRequest = z.infer<typeof checkpointRequestSchema>;

export const closeRequestSchema = z.strictObject({
  ...engineHandleOperationFields,
  reason: z.string().trim().min(1).max(4_096),
});
export type CloseRequest = z.infer<typeof closeRequestSchema>;

export const reconcileOperationRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  operationId: operationIdSchema,
  fingerprint: fingerprintSchema,
});
export type ReconcileOperationRequest = z.infer<typeof reconcileOperationRequestSchema>;

export const engineCheckpointReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  checkpointId: checkpointIdSchema,
  operationReceipt: operationReceiptSchema,
});
export type EngineCheckpointReceipt = z.infer<typeof engineCheckpointReceiptSchema>;

export const engineObservationKindSchema = z.enum([
  "AGENT_RETURNED",
  "PROCESS_EXITED",
  "TERMINAL_IDLE",
  "WINDOW_OPENED",
  "OUTPUT_CAPTURED",
  "INPUT_REQUESTED",
  "OPERATION_OBSERVED",
]);
export type EngineObservationKind = z.infer<typeof engineObservationKindSchema>;

export const engineObservationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  cursor: eventCursorSchema,
  attemptId: attemptIdSchema,
  kind: engineObservationKindSchema,
  observedAt: timestampSchema,
  summary: z.string().trim().min(1).max(4_096).optional(),
  resourceUsage: resourceUsageSchema.optional(),
});
export type EngineObservation = z.infer<typeof engineObservationSchema>;

export interface EngineHost {
  probe(request: ProbeRequest): Promise<CapabilityReceipt>;
  start(request: StartAttemptRequest): Promise<StartAttemptReceipt>;
  send(handle: EngineHandle, input: EngineInput): Promise<OperationReceipt>;
  observe(handle: EngineHandle, cursor?: EventCursor): AsyncIterable<EngineObservation>;
  interrupt(handle: EngineHandle, request: InterruptRequest): Promise<OperationReceipt>;
  checkpoint(handle: EngineHandle, request: CheckpointRequest): Promise<EngineCheckpointReceipt>;
  reconcile(request: ReconcileOperationRequest): Promise<OperationReconciliationReceipt>;
  close(handle: EngineHandle, request: CloseRequest): Promise<OperationReceipt>;
}
