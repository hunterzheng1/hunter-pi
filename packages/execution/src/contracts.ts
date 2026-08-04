import { z } from "zod";

import {
  fingerprintSchema,
  operationIdSchema,
  timestampSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type Fingerprint,
  type OperationId,
  type WorkspaceId,
  type WriterLeaseId,
} from "@hunter-pi/domain";

export const leaseResourceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u, "expected a portable named resource");
export type LeaseResource = z.infer<typeof leaseResourceSchema>;

export const leaseAcquireRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-lease-acquire.v1"),
    operationId: operationIdSchema,
    operationFingerprint: fingerprintSchema,
    leaseId: writerLeaseIdSchema,
    workspaceId: workspaceIdSchema,
    ownerFingerprint: fingerprintSchema,
    resources: z.array(leaseResourceSchema).max(128),
    ttlMs: z.number().int().positive().max(86_400_000),
  })
  .superRefine((request, context) => {
    if (new Set(request.resources).size !== request.resources.length) {
      context.addIssue({
        code: "custom",
        message: "lease resources must be unique",
        path: ["resources"],
      });
    }
  });
export interface LeaseAcquireRequest {
  readonly schemaVersion: "hpi-lease-acquire.v1";
  readonly operationId: OperationId;
  readonly operationFingerprint: Fingerprint;
  readonly leaseId: WriterLeaseId;
  readonly workspaceId: WorkspaceId;
  readonly ownerFingerprint: Fingerprint;
  readonly resources: readonly LeaseResource[];
  readonly ttlMs: number;
}

export const leaseReasonCodeSchema = z.enum([
  "WORKSPACE_CONFLICT",
  "RESOURCE_CONFLICT",
  "LEASE_ID_CONFLICT",
  "OWNER_LIVENESS_NOT_PROVEN",
  "OWNER_STILL_LIVE",
]);
export type LeaseReasonCode = z.infer<typeof leaseReasonCodeSchema>;

export const leaseAcquireReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-lease-receipt.v1"),
    action: z.literal("ACQUIRE"),
    outcome: z.enum(["ACQUIRED", "BLOCKED"]),
    leaseId: writerLeaseIdSchema,
    workspaceId: workspaceIdSchema,
    ownerFingerprint: fingerprintSchema,
    generation: z.number().int().nonnegative(),
    resourceSetFingerprint: fingerprintSchema,
    resourceCount: z.number().int().nonnegative(),
    state: z.enum(["ACTIVE", "NOT_ACQUIRED"]),
    expiresAt: timestampSchema.nullable(),
    reasonCodes: z.array(leaseReasonCodeSchema),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    const acquired = receipt.outcome === "ACQUIRED";
    if (
      acquired !== (receipt.state === "ACTIVE") ||
      acquired !== receipt.generation > 0 ||
      acquired !== (receipt.expiresAt !== null) ||
      acquired !== (receipt.reasonCodes.length === 0)
    ) {
      context.addIssue({ code: "custom", message: "lease acquisition outcome is inconsistent" });
    }
  });
export type LeaseAcquireReceipt = z.infer<typeof leaseAcquireReceiptSchema>;

const leaseOwnedMutationRequestShape = {
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  leaseId: writerLeaseIdSchema,
  ownerFingerprint: fingerprintSchema,
};

export const leaseRenewRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-lease-renew.v1"),
  ...leaseOwnedMutationRequestShape,
  ttlMs: z.number().int().positive().max(86_400_000),
});
export type LeaseRenewRequest = z.infer<typeof leaseRenewRequestSchema>;

export const leaseReleaseRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-lease-release.v1"),
  ...leaseOwnedMutationRequestShape,
  bindingFingerprint: fingerprintSchema.nullable(),
});
export type LeaseReleaseRequest = z.infer<typeof leaseReleaseRequestSchema>;

const leaseBindingEntrySchema = z.strictObject({
  leaseId: writerLeaseIdSchema,
  ownerFingerprint: fingerprintSchema,
});

export const leaseBindRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-lease-bind.v1"),
    operationId: operationIdSchema,
    operationFingerprint: fingerprintSchema,
    bindingFingerprint: fingerprintSchema,
    leases: z.array(leaseBindingEntrySchema).min(1).max(128),
  })
  .superRefine((request, context) => {
    if (new Set(request.leases.map((lease) => lease.leaseId)).size !== request.leases.length) {
      context.addIssue({ code: "custom", message: "bound lease identities must be unique" });
    }
  });
export type LeaseBindRequest = z.infer<typeof leaseBindRequestSchema>;

export const leaseBindReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-lease-bind-receipt.v1"),
  action: z.literal("BIND"),
  outcome: z.literal("BOUND"),
  bindingFingerprint: fingerprintSchema,
  leaseSetFingerprint: fingerprintSchema,
  leaseCount: z.number().int().positive(),
  observedAt: timestampSchema,
});
export type LeaseBindReceipt = z.infer<typeof leaseBindReceiptSchema>;

export const leaseMutationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-lease-mutation-receipt.v1"),
    action: z.enum(["RENEW", "RELEASE"]),
    outcome: z.enum(["RENEWED", "RELEASED"]),
    leaseId: writerLeaseIdSchema,
    workspaceId: workspaceIdSchema,
    ownerFingerprint: fingerprintSchema,
    generation: z.number().int().positive(),
    resourceSetFingerprint: fingerprintSchema,
    resourceCount: z.number().int().nonnegative(),
    state: z.enum(["ACTIVE", "RELEASED"]),
    expiresAt: timestampSchema,
    bindingFingerprint: fingerprintSchema.nullable(),
    reasonCodes: z.tuple([]),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    if (
      (receipt.action === "RENEW" &&
        (receipt.outcome !== "RENEWED" || receipt.state !== "ACTIVE")) ||
      (receipt.action === "RELEASE" &&
        (receipt.outcome !== "RELEASED" || receipt.state !== "RELEASED"))
    ) {
      context.addIssue({ code: "custom", message: "lease mutation outcome is inconsistent" });
    }
  });
export type LeaseMutationReceipt = z.infer<typeof leaseMutationReceiptSchema>;

export const leaseStatusReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-lease-status.v1"),
  leaseId: writerLeaseIdSchema,
  workspaceId: workspaceIdSchema,
  ownerFingerprint: fingerprintSchema,
  generation: z.number().int().positive(),
  resourceSetFingerprint: fingerprintSchema,
  resourceCount: z.number().int().nonnegative(),
  state: z.enum(["ACTIVE", "EXPIRED", "REVOKED", "RELEASED"]),
  expiresAt: timestampSchema,
  bindingFingerprint: fingerprintSchema.nullable(),
  observedAt: timestampSchema,
});
export type LeaseStatusReceipt = z.infer<typeof leaseStatusReceiptSchema>;

export interface LeaseManager {
  acquire(request: LeaseAcquireRequest): Promise<{ readonly receipt: LeaseAcquireReceipt }>;
  bind(request: LeaseBindRequest): Promise<{ readonly receipt: LeaseBindReceipt }>;
  inspect(leaseId: WriterLeaseId): Promise<{ readonly receipt: LeaseStatusReceipt }>;
  renew(request: LeaseRenewRequest): Promise<{ readonly receipt: LeaseMutationReceipt }>;
  release(request: LeaseReleaseRequest): Promise<{ readonly receipt: LeaseMutationReceipt }>;
}
