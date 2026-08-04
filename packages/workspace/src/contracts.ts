import { z } from "zod";

import {
  fingerprintSchema,
  operationIdSchema,
  timestampSchema,
  workspaceIdSchema,
  type Fingerprint,
  type OperationId,
  type WorkspaceId,
} from "@hunter-pi/domain";

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "expected a full Git object identity");
export type GitObjectId = z.infer<typeof gitObjectIdSchema>;

export const workspacePrepareRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-workspace-prepare.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  workspaceId: workspaceIdSchema,
  repository: z.string().min(1).max(32_768),
  baseCommit: gitObjectIdSchema,
});
export interface WorkspacePrepareRequest {
  readonly schemaVersion: "hpi-workspace-prepare.v1";
  readonly operationId: OperationId;
  readonly operationFingerprint: Fingerprint;
  readonly workspaceId: WorkspaceId;
  readonly repository: string;
  readonly baseCommit: GitObjectId;
}

export const workspaceReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-workspace-receipt.v1"),
  action: z.literal("PREPARE"),
  outcome: z.literal("APPLIED"),
  workspaceId: workspaceIdSchema,
  baseCommit: gitObjectIdSchema,
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  sourceCheckout: z.strictObject({
    dirty: z.boolean(),
    preserved: z.literal(true),
  }),
  reasonCode: z.null(),
  observedAt: timestampSchema,
});
export type WorkspaceReceipt = z.infer<typeof workspaceReceiptSchema>;

export interface WorkspaceHandle {
  readonly workspaceId: WorkspaceId;
  readonly directory: string;
  readonly branchName: string;
  readonly baseCommit: GitObjectId;
}

export interface PreparedWorkspace {
  readonly handle: WorkspaceHandle;
  readonly receipt: WorkspaceReceipt;
}

export const branchHygieneReasonCodeSchema = z.enum([
  "DIRTY_WORKTREE",
  "UNPUSHED_COMMITS",
  "UNSAFE_LINKS",
  "WORKSPACE_IDENTITY_DRIFT",
  "CLEANUP_AMBIGUOUS",
]);
export type BranchHygieneReasonCode = z.infer<typeof branchHygieneReasonCodeSchema>;

export const branchHygieneReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-branch-hygiene-receipt.v1"),
  workspaceId: workspaceIdSchema,
  decision: z.enum(["REMOVABLE", "PRESERVE"]),
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  hygieneFingerprint: fingerprintSchema,
  baseCommit: gitObjectIdSchema,
  headCommit: gitObjectIdSchema,
  workingTree: z.strictObject({
    clean: z.boolean(),
    stagedEntries: z.number().int().nonnegative(),
    unstagedEntries: z.number().int().nonnegative(),
    untrackedEntries: z.number().int().nonnegative(),
  }),
  commits: z.strictObject({
    uniqueCommitCount: z.number().int().nonnegative(),
    unpushedCommitCount: z.number().int().nonnegative(),
    upstreamStatus: z.enum(["ABSENT", "PRESENT"]),
  }),
  branchDisposition: z.strictObject({
    localBranch: z.enum(["REMOVE", "PRESERVE"]),
    recoverability: z.enum(["BASE_ONLY", "REMOTE_REF", "NOT_PROVEN"]),
    reviewState: z.enum(["NOT_APPLICABLE", "NOT_PROVEN"]),
  }),
  linkedEntries: z.number().int().nonnegative(),
  linkAssessment: z.strictObject({
    status: z.enum(["PASS", "BLOCKED"]),
    escapingTargets: z.number().int().nonnegative(),
    unresolvedTargets: z.number().int().nonnegative(),
  }),
  reasonCodes: z.array(branchHygieneReasonCodeSchema),
  observedAt: timestampSchema,
});
export type BranchHygieneReceipt = z.infer<typeof branchHygieneReceiptSchema>;

export const workspaceDisposeRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-workspace-dispose.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  workspaceId: workspaceIdSchema,
});
export type WorkspaceDisposeRequest = z.infer<typeof workspaceDisposeRequestSchema>;

export const workspaceDisposalReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-workspace-disposal-receipt.v1"),
  action: z.literal("DISPOSE"),
  outcome: z.enum(["APPLIED", "BLOCKED"]),
  workspaceId: workspaceIdSchema,
  hygieneFingerprint: fingerprintSchema,
  worktreeState: z.enum(["REMOVED", "PRESERVED"]),
  registrationState: z.enum(["REMOVED", "REGISTERED", "AMBIGUOUS"]),
  branchState: z.enum(["REMOVED", "PRESERVED"]),
  reasonCodes: z.array(branchHygieneReasonCodeSchema),
  observedAt: timestampSchema,
});
export type WorkspaceDisposalReceipt = z.infer<typeof workspaceDisposalReceiptSchema>;

export interface GitWorkspaceManager {
  prepare(request: WorkspacePrepareRequest): Promise<PreparedWorkspace>;
  inspect(workspaceId: WorkspaceId): Promise<{ readonly receipt: BranchHygieneReceipt }>;
  dispose(
    request: WorkspaceDisposeRequest,
  ): Promise<{ readonly receipt: WorkspaceDisposalReceipt }>;
}
