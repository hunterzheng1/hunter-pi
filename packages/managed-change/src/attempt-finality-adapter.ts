import { createHash } from "node:crypto";

import { z } from "zod";

import {
  attemptFinalityReceiptIdSchema,
  attemptFinalityReceiptSchema,
  checkpointSchema,
  evidenceIdSchema,
  externalReferenceSchema,
  fingerprintSchema,
  timestampSchema,
  writerLeaseIdSchema,
  type AttemptFinalityReceipt,
  type Checkpoint,
  type EvidenceId,
  type Fingerprint,
} from "@hunter-pi/domain";
import {
  leaseMutationReceiptSchema,
  managedProcessFinalReceiptSchema,
  managedProcessSessionIdSchema,
  type LeaseMutationReceipt,
  type ManagedProcessFinalReceipt,
  type ManagedProcessSessionId,
} from "@hunter-pi/execution";

export const MANAGED_PROCESS_SESSION_NAMESPACE = "hunter-pi.managed-process-session";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
  );
}

function fingerprintOf(value: unknown): Fingerprint {
  return sha256(canonicalJson(value));
}

const finalProcessEvidenceSchema = z.strictObject({
  processReference: externalReferenceSchema,
  receipt: managedProcessFinalReceiptSchema,
  receiptFingerprint: fingerprintSchema,
});

const releasedLeaseEvidenceSchema = z.strictObject({
  leaseId: writerLeaseIdSchema,
  receipt: leaseMutationReceiptSchema,
  receiptFingerprint: fingerprintSchema,
});

const attemptFinalityEvidencePayloadSchema = z.strictObject({
  schemaVersion: z.literal("hpi-attempt-finality-evidence.v1"),
  runId: checkpointSchema.shape.runId,
  attemptId: checkpointSchema.shape.attemptId.unwrap(),
  checkpointId: checkpointSchema.shape.checkpointId,
  workspaceId: checkpointSchema.shape.workspaceId,
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  processes: z.array(finalProcessEvidenceSchema).max(128),
  leases: z.array(releasedLeaseEvidenceSchema).max(128),
  observedAt: timestampSchema,
});

type AttemptFinalityEvidencePayload = z.infer<typeof attemptFinalityEvidencePayloadSchema>;

function evidenceIdFor(payload: AttemptFinalityEvidencePayload): EvidenceId {
  const digest = sha256(canonicalJson(payload)).slice("sha256:".length, "sha256:".length + 40);
  return evidenceIdSchema.parse(`evidence_finality-${digest}`);
}

export const attemptFinalityEvidenceRequestSchema = attemptFinalityEvidencePayloadSchema
  .safeExtend({ evidenceId: evidenceIdSchema })
  .superRefine((request, context) => {
    const payload = attemptFinalityEvidencePayloadSchema.parse({
      schemaVersion: request.schemaVersion,
      runId: request.runId,
      attemptId: request.attemptId,
      checkpointId: request.checkpointId,
      workspaceId: request.workspaceId,
      workspaceFingerprint: request.workspaceFingerprint,
      sourceFingerprint: request.sourceFingerprint,
      processes: request.processes,
      leases: request.leases,
      observedAt: request.observedAt,
    });
    if (request.evidenceId !== evidenceIdFor(payload)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceId"],
        message: "Attempt-finality Evidence identity is not payload-bound",
      });
    }

    const processReferences = request.processes.map(({ processReference }) =>
      canonicalJson(processReference),
    );
    if (new Set(processReferences).size !== processReferences.length) {
      context.addIssue({ code: "custom", message: "process Evidence identities must be unique" });
    }
    const leaseIds = request.leases.map(({ leaseId }) => leaseId);
    if (new Set(leaseIds).size !== leaseIds.length) {
      context.addIssue({ code: "custom", message: "lease Evidence identities must be unique" });
    }

    for (const [index, process] of request.processes.entries()) {
      if (
        process.processReference.namespace !== MANAGED_PROCESS_SESSION_NAMESPACE ||
        process.processReference.reference !== process.receipt.sessionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["processes", index],
          message: "process Evidence is not bound to an exact managed process session",
        });
      }
      if (process.receiptFingerprint !== fingerprintOf(process.receipt)) {
        context.addIssue({
          code: "custom",
          path: ["processes", index, "receiptFingerprint"],
          message: "process final Receipt fingerprint is invalid",
        });
      }
    }

    for (const [index, lease] of request.leases.entries()) {
      if (
        lease.leaseId !== lease.receipt.leaseId ||
        lease.receipt.workspaceId !== request.workspaceId ||
        lease.receipt.action !== "RELEASE" ||
        lease.receipt.outcome !== "RELEASED" ||
        lease.receipt.state !== "RELEASED"
      ) {
        context.addIssue({
          code: "custom",
          path: ["leases", index],
          message: "Writer Lease Evidence is not an exact released workspace binding",
        });
      }
      if (lease.receiptFingerprint !== fingerprintOf(lease.receipt)) {
        context.addIssue({
          code: "custom",
          path: ["leases", index, "receiptFingerprint"],
          message: "Writer Lease status fingerprint is invalid",
        });
      }
    }

    const exactObservedAt = [
      ...request.processes.map(({ receipt }) => receipt.observedAt),
      ...request.leases.map(({ receipt }) => receipt.observedAt),
    ]
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1);
    if (exactObservedAt !== undefined && request.observedAt !== exactObservedAt) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "Attempt-finality Evidence observation time is not exact",
      });
    }
  });
export type AttemptFinalityEvidenceRequest = z.infer<typeof attemptFinalityEvidenceRequestSchema>;

export interface ManagedProcessFinalReceiptReader {
  read(sessionId: ManagedProcessSessionId): Promise<ManagedProcessFinalReceipt>;
}

export interface WriterLeaseReleaseReceiptReader {
  read(leaseId: Checkpoint["heldWriterLeaseIds"][number]): Promise<LeaseMutationReceipt>;
}

export interface AttemptFinalityEvidenceCapture {
  capture(request: AttemptFinalityEvidenceRequest): Promise<{
    readonly evidenceId: EvidenceId;
    readonly fingerprint: Fingerprint;
  }>;
}

export interface ExecutionAttemptFinalityAdapterOptions {
  readonly processFinalReceipts: ManagedProcessFinalReceiptReader;
  readonly writerLeaseReleaseReceipts: WriterLeaseReleaseReceiptReader;
  readonly captureEvidence: AttemptFinalityEvidenceCapture;
}

export class AttemptFinalityReconciliationError extends Error {
  public readonly code:
    | "PROCESS_REFERENCE_UNSUPPORTED"
    | "PROCESS_FINAL_RECEIPT_MISMATCH"
    | "PROCESS_FINAL_RECEIPT_STALE"
    | "LEASE_RELEASE_NOT_PROVEN"
    | "LEASE_RELEASE_STALE"
    | "EVIDENCE_CAPTURE_MISMATCH";

  public constructor(code: AttemptFinalityReconciliationError["code"], message: string) {
    super(message);
    this.name = "AttemptFinalityReconciliationError";
    this.code = code;
  }
}

function requireFresh(observedAt: string, checkpoint: Checkpoint, label: string): void {
  if (Date.parse(observedAt) < Date.parse(checkpoint.createdAt)) {
    throw new AttemptFinalityReconciliationError(
      label === "process" ? "PROCESS_FINAL_RECEIPT_STALE" : "LEASE_RELEASE_STALE",
      `${label} finality observation predates the exact Checkpoint`,
    );
  }
}

export class ExecutionAttemptFinalityAdapter {
  readonly #processFinalReceipts: ManagedProcessFinalReceiptReader;
  readonly #writerLeaseReleaseReceipts: WriterLeaseReleaseReceiptReader;
  readonly #captureEvidence: AttemptFinalityEvidenceCapture;

  public constructor(options: ExecutionAttemptFinalityAdapterOptions) {
    this.#processFinalReceipts = options.processFinalReceipts;
    this.#writerLeaseReleaseReceipts = options.writerLeaseReleaseReceipts;
    this.#captureEvidence = options.captureEvidence;
  }

  public async reconcileAttemptFinality(
    checkpointInput: Checkpoint,
  ): Promise<AttemptFinalityReceipt> {
    const checkpoint = checkpointSchema.parse(checkpointInput);
    if (checkpoint.attemptId === undefined) {
      throw new AttemptFinalityReconciliationError(
        "PROCESS_FINAL_RECEIPT_MISMATCH",
        "Attempt finality requires an Attempt-bound Checkpoint",
      );
    }

    const processes = await Promise.all(
      checkpoint.processReferences.map(async (processReference) => {
        if (processReference.namespace !== MANAGED_PROCESS_SESSION_NAMESPACE) {
          throw new AttemptFinalityReconciliationError(
            "PROCESS_REFERENCE_UNSUPPORTED",
            "Attempt finality requires an exact managed process session reference",
          );
        }
        const sessionId = managedProcessSessionIdSchema.parse(processReference.reference);
        const receipt = managedProcessFinalReceiptSchema.parse(
          await this.#processFinalReceipts.read(sessionId),
        );
        if (receipt.sessionId !== sessionId || receipt.terminalFinality !== "FINAL") {
          throw new AttemptFinalityReconciliationError(
            "PROCESS_FINAL_RECEIPT_MISMATCH",
            "managed process final Receipt identity or finality is inconsistent",
          );
        }
        requireFresh(receipt.observedAt, checkpoint, "process");
        return {
          processReference,
          receipt,
          receiptFingerprint: fingerprintOf(receipt),
        };
      }),
    );

    const leases = await Promise.all(
      checkpoint.heldWriterLeaseIds.map(async (leaseId) => {
        const receipt = leaseMutationReceiptSchema.parse(
          await this.#writerLeaseReleaseReceipts.read(leaseId),
        );
        if (
          receipt.leaseId !== leaseId ||
          receipt.workspaceId !== checkpoint.workspaceId ||
          receipt.action !== "RELEASE" ||
          receipt.outcome !== "RELEASED" ||
          receipt.state !== "RELEASED"
        ) {
          throw new AttemptFinalityReconciliationError(
            "LEASE_RELEASE_NOT_PROVEN",
            "Writer Lease release is not exact and final for the Checkpoint workspace",
          );
        }
        requireFresh(receipt.observedAt, checkpoint, "lease");
        return { leaseId, receipt, receiptFingerprint: fingerprintOf(receipt) };
      }),
    );

    const observedAt = [
      checkpoint.createdAt,
      ...processes.map(({ receipt }) => receipt.observedAt),
      ...leases.map(({ receipt }) => receipt.observedAt),
    ]
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1);
    if (observedAt === undefined) throw new Error("Attempt finality has no observation time");

    const payload = attemptFinalityEvidencePayloadSchema.parse({
      schemaVersion: "hpi-attempt-finality-evidence.v1",
      runId: checkpoint.runId,
      attemptId: checkpoint.attemptId,
      checkpointId: checkpoint.checkpointId,
      workspaceId: checkpoint.workspaceId,
      workspaceFingerprint: checkpoint.workspaceFingerprint,
      sourceFingerprint: checkpoint.sourceFingerprint,
      processes,
      leases,
      observedAt,
    });
    const evidenceRequest = attemptFinalityEvidenceRequestSchema.parse({
      ...payload,
      evidenceId: evidenceIdFor(payload),
    });
    const expectedEvidenceFingerprint = fingerprintOf(evidenceRequest);
    const capture = await this.#captureEvidence.capture(evidenceRequest);
    if (
      capture.evidenceId !== evidenceRequest.evidenceId ||
      capture.fingerprint !== expectedEvidenceFingerprint
    ) {
      throw new AttemptFinalityReconciliationError(
        "EVIDENCE_CAPTURE_MISMATCH",
        "Attempt-finality Evidence identity or fingerprint changed during capture",
      );
    }

    const identityDigest = expectedEvidenceFingerprint.slice(
      "sha256:".length,
      "sha256:".length + 40,
    );
    return attemptFinalityReceiptSchema.parse({
      schemaVersion: "1.0.0",
      attemptFinalityReceiptId: attemptFinalityReceiptIdSchema.parse(`finality_${identityDigest}`),
      runId: checkpoint.runId,
      attemptId: checkpoint.attemptId,
      checkpointId: checkpoint.checkpointId,
      workspaceId: checkpoint.workspaceId,
      workspaceFingerprint: checkpoint.workspaceFingerprint,
      sourceFingerprint: checkpoint.sourceFingerprint,
      processFinalities: processes.map(({ processReference, receipt, receiptFingerprint }) => ({
        processReference,
        finalReceiptFingerprint: receiptFingerprint,
        processTreeState: receipt.processTreeState,
        outputState: receipt.outputState,
        leaseState: receipt.leaseState,
        terminalFinality: receipt.terminalFinality,
      })),
      releasedWriterLeaseIds: leases.map(({ leaseId }) => leaseId),
      terminalFinality: "FINAL",
      evidenceIds: [evidenceRequest.evidenceId],
      observedAt,
    });
  }
}
