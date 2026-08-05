import { z } from "zod";

import {
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  evidenceIdSchema,
  fingerprintSchema,
  operationIdSchema,
  timestampSchema,
  type DistributionReleaseId,
  type Fingerprint,
} from "@hunter-pi/domain";

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
function containsCredentialBearingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function containsUnsafePath(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded.startsWith("/") ||
      decoded.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/u.test(decoded) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(decoded)
    );
  } catch {
    return true;
  }
}

const portableReferenceSchema = nonEmptyTextSchema.refine(
  (value) =>
    !containsUnsafePath(value) &&
    !/(?:^|[\s"'])[A-Za-z]:[\\/]|(?:^|[\s"'])\/(?:Users|home|private|tmp)\//u.test(value) &&
    !containsCredentialBearingUrl(value) &&
    (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || new URL(value).protocol === "https:"),
  "private paths, unsafe paths, and non-HTTPS URLs are not portable release references",
);
const exactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);

export const releaseChannelSchema = z.enum(["STABLE", "PREVIEW"]);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

export const releaseQualificationCheckSchema = z.strictObject({
  name: nonEmptyTextSchema,
  outcome: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]),
  evidenceIds: z.array(evidenceIdSchema),
  reason: nonEmptyTextSchema.optional(),
});

const qualificationOutcomeOrder: readonly z.infer<
  typeof releaseQualificationCheckSchema
>["outcome"][] = ["PASS", "NOT_PROVEN", "BLOCKED", "FAIL"];

export function aggregateQualificationOutcome(
  checks: readonly z.infer<typeof releaseQualificationCheckSchema>[],
): z.infer<typeof releaseQualificationCheckSchema>["outcome"] {
  return checks.reduce<z.infer<typeof releaseQualificationCheckSchema>["outcome"]>(
    (current, check) =>
      qualificationOutcomeOrder.indexOf(check.outcome) > qualificationOutcomeOrder.indexOf(current)
        ? check.outcome
        : current,
    "PASS",
  );
}

export const releaseCandidateBaseSchema = z.strictObject({
  schemaVersion: z.literal("hpi-release-candidate.v1"),
  releaseId: distributionReleaseIdSchema,
  productVersion: exactVersionSchema,
  channel: releaseChannelSchema,
  artifact: z.strictObject({
    reference: portableReferenceSchema,
    fingerprint: fingerprintSchema,
    byteLength: z.number().int().positive(),
  }),
  engine: z.strictObject({
    releaseId: engineReleaseIdSchema,
    fingerprint: fingerprintSchema,
    piVersion: exactVersionSchema,
  }),
  updatePolicy: z.strictObject({
    piSelfUpdate: z.enum(["DISABLED", "ENABLED"]),
    unsigned: z.boolean(),
  }),
  licenses: z.array(
    z.strictObject({
      name: nonEmptyTextSchema,
      version: exactVersionSchema,
      license: nonEmptyTextSchema,
      sourceReference: portableReferenceSchema,
    }),
  ),
});
export const releaseCandidateSchema = releaseCandidateBaseSchema.extend({
  qualification: z
    .strictObject({
      status: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]),
      verifierFingerprint: fingerprintSchema,
      checks: z.array(releaseQualificationCheckSchema).min(1),
      qualifiedAt: timestampSchema,
    })
    .superRefine((qualification, context) => {
      if (
        new Set(qualification.checks.map((check) => check.name)).size !==
        qualification.checks.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: "release qualification check identities must be unique",
        });
      }
      if (qualification.status !== aggregateQualificationOutcome(qualification.checks)) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "release qualification status must equal the aggregate of its checks",
        });
      }
      if (
        qualification.status === "PASS" &&
        qualification.checks.some((check) => check.evidenceIds.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: "a PASS release qualification must bind Evidence for every declared check",
        });
      }
    }),
});
export type ReleaseCandidateBase = z.infer<typeof releaseCandidateBaseSchema>;
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;

export const qualificationProbeResultSchema = z.strictObject({
  outcome: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]),
  evidenceIds: z.array(evidenceIdSchema),
  reason: nonEmptyTextSchema.optional(),
});
export type QualificationProbeResult = z.input<typeof qualificationProbeResultSchema>;

export interface ReleaseQualificationProbe {
  readonly name: string;
  run(): Promise<QualificationProbeResult>;
}

export interface ReleaseQualificationRunnerOptions {
  readonly verifierFingerprint: Fingerprint;
  readonly now?: () => string;
}

export interface ReleaseQualificationRunnerInput {
  readonly candidate: ReleaseCandidateBase;
  readonly checks: readonly ReleaseQualificationProbe[];
  readonly qualifiedAt?: string;
}

export const updateApplyRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-apply.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  candidate: releaseCandidateSchema,
  observedAt: timestampSchema,
});
export type UpdateApplyRequest = z.input<typeof updateApplyRequestSchema>;

export const updateRollbackRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-rollback.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  targetReleaseId: distributionReleaseIdSchema,
  observedAt: timestampSchema,
});
export type UpdateRollbackRequest = z.input<typeof updateRollbackRequestSchema>;

export const updateReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  action: z.enum(["APPLY", "ROLLBACK"]),
  outcome: z.enum(["APPLIED", "NOOP", "BLOCKED", "FAILED"]),
  candidateReleaseId: distributionReleaseIdSchema.optional(),
  targetReleaseId: distributionReleaseIdSchema.optional(),
  previousReleaseId: distributionReleaseIdSchema.optional(),
  activeReleaseId: distributionReleaseIdSchema.optional(),
  reason: nonEmptyTextSchema.optional(),
  observedAt: timestampSchema,
});
export type UpdateReceipt = z.infer<typeof updateReceiptSchema>;

export const updateJournalEntrySchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-journal.v1"),
  sequence: z.number().int().positive(),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
  action: z.enum(["APPLY", "ROLLBACK"]),
  candidate: releaseCandidateSchema.optional(),
  targetReleaseId: distributionReleaseIdSchema.optional(),
  receipt: updateReceiptSchema,
  createdAt: timestampSchema,
  previousEntryFingerprint: fingerprintSchema.nullable(),
  entryFingerprint: fingerprintSchema,
});
export type UpdateJournalEntry = z.infer<typeof updateJournalEntrySchema>;

export interface ReleaseArtifactSource {
  read(candidate: ReleaseCandidate): Promise<Uint8Array>;
}

export interface StagedRelease {
  readonly releaseId: DistributionReleaseId;
}

export interface MigrationTransaction {
  rollback(): Promise<void>;
}

export interface ReleaseAdapter {
  current(): Promise<DistributionReleaseId | undefined>;
  stage(candidate: ReleaseCandidate, artifact: Uint8Array): Promise<StagedRelease>;
  healthCheck(
    release: StagedRelease,
  ): Promise<{ readonly status: "PASS" } | { readonly status: "FAIL"; readonly reason: string }>;
  migrate?: (
    release: StagedRelease,
    previousReleaseId: DistributionReleaseId | undefined,
  ) => Promise<MigrationTransaction>;
  activate(release: StagedRelease): Promise<void>;
  restore(release: StagedRelease): Promise<void>;
  discard(release: StagedRelease): Promise<void>;
}

export interface UpdateManager {
  apply(request: UpdateApplyRequest): Promise<UpdateReceipt>;
  rollback(request: UpdateRollbackRequest): Promise<UpdateReceipt>;
  current(): Promise<{ readonly releaseId: DistributionReleaseId | undefined }>;
  history(): Promise<readonly ReleaseCandidate[]>;
}
