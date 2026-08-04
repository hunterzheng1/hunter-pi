import { z } from "zod";

import {
  fingerprintSchema,
  operationIdSchema,
  timestampSchema,
  writerLeaseIdSchema,
} from "@hunter-pi/domain";

export const managedProcessSessionIdSchema = z
  .string()
  .regex(/^process_[a-z0-9][a-z0-9_-]{0,63}$/u, "expected a managed process session identity")
  .brand<"ManagedProcessSessionId">();
export type ManagedProcessSessionId = z.infer<typeof managedProcessSessionIdSchema>;

export const processContainmentSchema = z.enum([
  "WINDOWS_JOB_OBJECT",
  "LINUX_SUBREAPER_PROCESS_TREE",
  "TEST_CONTAINED",
]);
export type ProcessContainment = z.infer<typeof processContainmentSchema>;

const leaseBindingSchema = z.strictObject({
  leaseId: writerLeaseIdSchema,
  ownerFingerprint: fingerprintSchema,
  releaseOperationId: operationIdSchema,
  releaseOperationFingerprint: fingerprintSchema,
});
export type ManagedProcessLeaseBinding = z.infer<typeof leaseBindingSchema>;

const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const osStringSchema = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !value.includes("\0"), "OS-bound strings must not contain NUL");

export const managedProcessStartRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-process-start.v1"),
    operationId: operationIdSchema,
    operationFingerprint: fingerprintSchema,
    sessionId: managedProcessSessionIdSchema,
    executable: osStringSchema(32_768).pipe(z.string().min(1)),
    argv: z.array(osStringSchema(32_768)).max(512),
    cwd: osStringSchema(32_768).pipe(z.string().min(1)),
    environment: z.record(environmentNameSchema, osStringSchema(131_072)),
    timeoutMs: z.number().int().positive().max(86_400_000),
    maxOutputBytes: z.number().int().positive().max(268_435_456),
    leases: z.array(leaseBindingSchema).max(128),
    leaseBindOperationId: operationIdSchema,
    leaseBindOperationFingerprint: fingerprintSchema,
  })
  .superRefine((request, context) => {
    if (new Set(request.leases.map((binding) => binding.leaseId)).size !== request.leases.length) {
      context.addIssue({ code: "custom", message: "process lease identities must be unique" });
    }
    if (
      new Set(request.leases.map((binding) => binding.releaseOperationId)).size !==
      request.leases.length
    ) {
      context.addIssue({ code: "custom", message: "lease release operations must be unique" });
    }
  });
export type ManagedProcessStartRequest = z.infer<typeof managedProcessStartRequestSchema>;

export const managedProcessStartReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-start-receipt.v1"),
  action: z.literal("START"),
  outcome: z.literal("STARTED"),
  sessionId: managedProcessSessionIdSchema,
  operationFingerprint: fingerprintSchema,
  commandFingerprint: fingerprintSchema,
  cwdFingerprint: fingerprintSchema,
  environmentFingerprint: fingerprintSchema,
  processIdentityFingerprint: fingerprintSchema,
  containment: processContainmentSchema,
  leaseCount: z.number().int().nonnegative(),
  terminalFinality: z.literal("PENDING"),
  observedAt: timestampSchema,
});
export type ManagedProcessStartReceipt = z.infer<typeof managedProcessStartReceiptSchema>;

export const managedProcessLogReadRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-log-read.v1"),
  sessionId: managedProcessSessionIdSchema,
  cursor: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive().max(16_777_216),
});
export type ManagedProcessLogReadRequest = z.infer<typeof managedProcessLogReadRequestSchema>;

export const managedProcessLogReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-log-receipt.v1"),
  sessionId: managedProcessSessionIdSchema,
  cursor: z.number().int().nonnegative(),
  nextCursor: z.number().int().nonnegative(),
  returnedBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative(),
  observedBytes: z.number().int().nonnegative(),
  outputDigest: fingerprintSchema,
  truncated: z.boolean(),
  eof: z.boolean(),
  observedAt: timestampSchema,
});
export type ManagedProcessLogReceipt = z.infer<typeof managedProcessLogReceiptSchema>;

export const managedProcessHeartbeatReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-heartbeat.v1"),
  sessionId: managedProcessSessionIdSchema,
  state: z.enum(["LIVE", "EXITED", "TIMED_OUT", "CANCELLED", "UNRECONCILED", "FINAL"]),
  exitCode: z.number().int().nullable(),
  terminationCause: z.enum(["NONE", "CANCEL", "TIMEOUT"]),
  identityState: z.enum(["MATCH", "MISMATCH", "NOT_PROVEN"]),
  processTreeState: z.enum(["ACTIVE", "EMPTY", "NOT_PROVEN"]),
  outputState: z.enum(["OPEN", "CLOSED", "NOT_PROVEN"]),
  leaseState: z.enum(["HELD", "RELEASED", "NOT_REQUIRED", "NOT_PROVEN"]),
  terminalFinality: z.enum(["PENDING", "FINAL", "NOT_PROVEN"]),
  observedAt: timestampSchema,
});
export type ManagedProcessHeartbeatReceipt = z.infer<typeof managedProcessHeartbeatReceiptSchema>;

export const managedProcessCancelRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-cancel.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  sessionId: managedProcessSessionIdSchema,
  reason: z.enum(["USER_REQUEST", "POLICY", "TIMEOUT"]),
});
export type ManagedProcessCancelRequest = z.infer<typeof managedProcessCancelRequestSchema>;

export const managedProcessCancelReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-process-cancel-receipt.v1"),
    action: z.literal("CANCEL"),
    outcome: z.enum(["ACKNOWLEDGED", "NOT_PROVEN"]),
    sessionId: managedProcessSessionIdSchema,
    identityState: z.enum(["MATCH", "MISMATCH", "NOT_PROVEN"]),
    terminationAcknowledged: z.boolean(),
    terminalFinality: z.literal("PENDING"),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    if (
      (receipt.outcome === "ACKNOWLEDGED") !== receipt.terminationAcknowledged ||
      (receipt.outcome === "ACKNOWLEDGED") !== (receipt.identityState === "MATCH")
    ) {
      context.addIssue({ code: "custom", message: "cancel acknowledgement is inconsistent" });
    }
  });
export type ManagedProcessCancelReceipt = z.infer<typeof managedProcessCancelReceiptSchema>;

export const managedProcessFinalReasonSchema = z.enum([
  "DRIVER_UNRECONCILED",
  "IDENTITY_MISMATCH",
  "PROCESS_TREE_NOT_EMPTY",
  "PROCESS_TREE_NOT_PROVEN",
  "OUTPUT_NOT_CLOSED",
  "LEASE_RELEASE_FAILED",
]);
export type ManagedProcessFinalReason = z.infer<typeof managedProcessFinalReasonSchema>;

export const managedProcessFinalReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-process-final-receipt.v1"),
    sessionId: managedProcessSessionIdSchema,
    executionObservation: z.enum(["EXITED", "CANCELLED", "TIMED_OUT", "UNRECONCILED"]),
    exitCode: z.number().int().nullable(),
    processTreeState: z.enum(["EMPTY", "ACTIVE", "NOT_PROVEN"]),
    outputState: z.enum(["CLOSED", "OPEN", "NOT_PROVEN"]),
    leaseState: z.enum(["RELEASED", "HELD", "NOT_REQUIRED", "NOT_PROVEN"]),
    observedBytes: z.number().int().nonnegative(),
    retainedBytes: z.number().int().nonnegative(),
    outputDigest: fingerprintSchema,
    truncated: z.boolean(),
    terminalFinality: z.enum(["FINAL", "NOT_PROVEN"]),
    reasonCodes: z.array(managedProcessFinalReasonSchema),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    const reconciled =
      receipt.executionObservation !== "UNRECONCILED" &&
      receipt.processTreeState === "EMPTY" &&
      receipt.outputState === "CLOSED" &&
      (receipt.leaseState === "RELEASED" || receipt.leaseState === "NOT_REQUIRED");
    if (receipt.terminalFinality === "FINAL" && !reconciled) {
      context.addIssue({
        code: "custom",
        message: "process finality requires reconciled execution, tree, output, and leases",
      });
    }
    if ((receipt.terminalFinality === "FINAL") !== (receipt.reasonCodes.length === 0)) {
      context.addIssue({ code: "custom", message: "process finality reasons are inconsistent" });
    }
  });
export type ManagedProcessFinalReceipt = z.infer<typeof managedProcessFinalReceiptSchema>;

export interface ManagedProcessLogChunk {
  readonly stream: "STDOUT" | "STDERR";
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly dataBase64: string;
}

export interface ManagedProcessHost {
  start(
    request: ManagedProcessStartRequest,
  ): Promise<{ readonly receipt: ManagedProcessStartReceipt }>;
  read(request: ManagedProcessLogReadRequest): Promise<{
    readonly chunks: readonly ManagedProcessLogChunk[];
    readonly receipt: ManagedProcessLogReceipt;
  }>;
  heartbeat(
    sessionId: ManagedProcessSessionId,
  ): Promise<{ readonly receipt: ManagedProcessHeartbeatReceipt }>;
  cancel(
    request: ManagedProcessCancelRequest,
  ): Promise<{ readonly receipt: ManagedProcessCancelReceipt }>;
  awaitFinal(
    sessionId: ManagedProcessSessionId,
  ): Promise<{ readonly receipt: ManagedProcessFinalReceipt }>;
}
