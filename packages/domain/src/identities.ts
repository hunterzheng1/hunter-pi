import { z } from "zod";

const identitySchema = (prefix: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9.-]*$`, "u"));

export const attemptIdSchema = identitySchema("att").brand<"AttemptId">();
export type AttemptId = z.infer<typeof attemptIdSchema>;

export const attemptFinalityReceiptIdSchema =
  identitySchema("finality").brand<"AttemptFinalityReceiptId">();
export type AttemptFinalityReceiptId = z.infer<typeof attemptFinalityReceiptIdSchema>;

export const archiveIdSchema = identitySchema("archive").brand<"ArchiveId">();
export type ArchiveId = z.infer<typeof archiveIdSchema>;

export const changeIdSchema = identitySchema("chg").brand<"ChangeId">();
export type ChangeId = z.infer<typeof changeIdSchema>;

export const checkIdSchema = identitySchema("check").brand<"CheckId">();
export type CheckId = z.infer<typeof checkIdSchema>;

export const checkpointIdSchema = identitySchema("checkpoint").brand<"CheckpointId">();
export type CheckpointId = z.infer<typeof checkpointIdSchema>;

export const compatibilityReceiptIdSchema =
  identitySchema("compat").brand<"CompatibilityReceiptId">();
export type CompatibilityReceiptId = z.infer<typeof compatibilityReceiptIdSchema>;

export const distributionReleaseIdSchema =
  identitySchema("release").brand<"DistributionReleaseId">();
export type DistributionReleaseId = z.infer<typeof distributionReleaseIdSchema>;

export const engineReleaseIdSchema = identitySchema("engine-release").brand<"EngineReleaseId">();
export type EngineReleaseId = z.infer<typeof engineReleaseIdSchema>;

export const evidenceIdSchema = identitySchema("evidence").brand<"EvidenceId">();
export type EvidenceId = z.infer<typeof evidenceIdSchema>;

export const humanReceiptIdSchema = identitySchema("human").brand<"HumanReceiptId">();
export type HumanReceiptId = z.infer<typeof humanReceiptIdSchema>;

export const observationIdSchema = identitySchema("obs").brand<"ObservationId">();
export type ObservationId = z.infer<typeof observationIdSchema>;

export const operationIdSchema = identitySchema("op").brand<"OperationId">();
export type OperationId = z.infer<typeof operationIdSchema>;

export const operationReceiptIdSchema = identitySchema("opreceipt").brand<"OperationReceiptId">();
export type OperationReceiptId = z.infer<typeof operationReceiptIdSchema>;

export const planRevisionIdSchema = identitySchema("plan").brand<"PlanRevisionId">();
export type PlanRevisionId = z.infer<typeof planRevisionIdSchema>;

export const pluginIdSchema = identitySchema("plugin").brand<"PluginId">();
export type PluginId = z.infer<typeof pluginIdSchema>;

export const pluginAssuranceReceiptIdSchema =
  identitySchema("assurance").brand<"PluginAssuranceReceiptId">();
export type PluginAssuranceReceiptId = z.infer<typeof pluginAssuranceReceiptIdSchema>;

export const reviewReceiptIdSchema = identitySchema("review").brand<"ReviewReceiptId">();
export type ReviewReceiptId = z.infer<typeof reviewReceiptIdSchema>;

export const reconciliationReceiptIdSchema =
  identitySchema("reconcile").brand<"ReconciliationReceiptId">();
export type ReconciliationReceiptId = z.infer<typeof reconciliationReceiptIdSchema>;

export const runIdSchema = identitySchema("run").brand<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;

export const stepIdSchema = identitySchema("step").brand<"StepId">();
export type StepId = z.infer<typeof stepIdSchema>;

export const verificationReceiptIdSchema =
  identitySchema("verify").brand<"VerificationReceiptId">();
export type VerificationReceiptId = z.infer<typeof verificationReceiptIdSchema>;

export const workspaceIdSchema = identitySchema("workspace").brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const writerLeaseIdSchema = identitySchema("lease").brand<"WriterLeaseId">();
export type WriterLeaseId = z.infer<typeof writerLeaseIdSchema>;
