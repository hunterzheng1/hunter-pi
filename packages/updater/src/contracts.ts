import { z } from "zod";

import {
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  evidenceIdSchema,
  externalReferenceSchema,
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
export const releaseCandidateIdentitySchema = releaseCandidateSchema.omit({
  qualification: true,
});
export type ReleaseCandidateBase = z.infer<typeof releaseCandidateBaseSchema>;
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;

/**
 * Stable identity of the built-in developer-preview qualification policy.
 * Bump the policy version when its acceptance rules change.
 */
export const HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT = fingerprintSchema.parse(
  "sha256:91015d5db9376b5e86a25538034c76609dcfddee1d7975faf64cca2bcbffe0c6",
);

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

export const githubActionsQualificationSourceSchema = z.strictObject({
  kind: z.literal("GITHUB_ACTIONS_RUN"),
  repository: z.literal("hunterzheng1/hunter-pi"),
  runId: z.number().int().positive(),
});
export type GitHubActionsQualificationSource = z.infer<
  typeof githubActionsQualificationSourceSchema
>;

export const updateQualificationRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-qualification.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  expectedTarget: externalReferenceSchema,
  source: githubActionsQualificationSourceSchema,
  deadline: timestampSchema,
  cancellationPolicy: z.strictObject({
    mode: z.literal("FAIL_CLOSED"),
    timeoutMs: z.number().int().positive(),
  }),
  observedAt: timestampSchema,
});
export type UpdateQualificationRequest = z.input<typeof updateQualificationRequestSchema>;

export const updateReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-update-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  action: z.enum(["APPLY", "ROLLBACK", "QUALIFY"]),
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
  action: z.enum(["APPLY", "ROLLBACK", "QUALIFY"]),
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
  commit?(): Promise<void>;
}

export const updateReconciliationSchema = z
  .strictObject({
    status: z.enum(["NONE", "RECOVERED", "ABORTED"]),
    candidate: releaseCandidateSchema.optional(),
    previousReleaseId: distributionReleaseIdSchema.optional(),
    activeReleaseId: distributionReleaseIdSchema.optional(),
    reason: nonEmptyTextSchema.optional(),
    operation: z
      .strictObject({
        operationId: operationIdSchema,
        operationFingerprint: fingerprintSchema,
        requestFingerprint: fingerprintSchema,
        action: z.literal("QUALIFY"),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "RECOVERED" && value.candidate === undefined) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "a recovered update must bind its exact release candidate",
      });
    }
    if (value.status === "ABORTED" && value.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "an aborted update must explain the recovery decision",
      });
    }
    if (value.operation !== undefined && value.status !== "RECOVERED") {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "only a recovered update may bind an interrupted original operation",
      });
    }
  });
export type UpdateReconciliation = z.infer<typeof updateReconciliationSchema>;

export const releaseCheckResultSchema = z.strictObject({
  status: z.enum(["AVAILABLE", "BLOCKED", "NOT_CONFIGURED"]),
  candidate: releaseCandidateSchema.optional(),
  reason: nonEmptyTextSchema.optional(),
});
export type ReleaseCheckResult = z.infer<typeof releaseCheckResultSchema>;

export interface ReleaseCandidateCheckOptions {
  readonly channel: ReleaseChannel;
  readonly qualificationVerifierFingerprint: Fingerprint;
  readonly artifacts: ReleaseArtifactSource;
}

export interface ReleaseCandidateCheck {
  check(candidate: ReleaseCandidate): Promise<ReleaseCheckResult>;
}

export interface ReleaseAdapter {
  current(): Promise<DistributionReleaseId | undefined>;
  assertQualificationEvidence(candidate: ReleaseCandidate, artifact: Uint8Array): Promise<void>;
  installedCandidate(release: StagedRelease): Promise<ReleaseCandidate | undefined>;
  stage(candidate: ReleaseCandidate, artifact: Uint8Array): Promise<StagedRelease>;
  healthCheck(
    release: StagedRelease,
  ): Promise<{ readonly status: "PASS" } | { readonly status: "FAIL"; readonly reason: string }>;
  migrate?: (
    release: StagedRelease,
    previousReleaseId: DistributionReleaseId | undefined,
  ) => Promise<MigrationTransaction | undefined>;
  activate(release: StagedRelease): Promise<void>;
  restore(release: StagedRelease): Promise<void>;
  promoteQualification?(input: {
    readonly operationId: UpdateQualificationRequest["operationId"];
    readonly operationFingerprint: Fingerprint;
    readonly requestFingerprint: Fingerprint;
    readonly baseCandidate: ReleaseCandidate;
    readonly candidate: ReleaseCandidate;
    readonly evidence: unknown;
    readonly artifact: Uint8Array;
    readonly observedAt: string;
  }): Promise<"PROMOTED" | "NOOP">;
  finalizeQualification?(input: {
    readonly operationId: UpdateQualificationRequest["operationId"];
    readonly operationFingerprint: Fingerprint;
    readonly requestFingerprint: Fingerprint;
    readonly candidate: ReleaseCandidate;
  }): Promise<void>;
  discard(release: StagedRelease): Promise<void>;
  reconcile?(): Promise<UpdateReconciliation>;
}

export interface UpdateManager {
  check(candidate: ReleaseCandidate): Promise<ReleaseCheckResult>;
  apply(request: UpdateApplyRequest): Promise<UpdateReceipt>;
  qualify(request: UpdateQualificationRequest): Promise<UpdateReceipt>;
  rollback(request: UpdateRollbackRequest): Promise<UpdateReceipt>;
  reconcile(): Promise<readonly UpdateReceipt[]>;
  current(): Promise<{ readonly releaseId: DistributionReleaseId | undefined }>;
  history(): Promise<readonly ReleaseCandidate[]>;
}
