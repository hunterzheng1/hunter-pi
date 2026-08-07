import { z } from "zod";

import { fingerprintSchema } from "@hunter-pi/domain";

import { pilotFingerprint } from "./serialization.js";

export const pilotTargetIdSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u,
    "pilot target identities must be stable and path-free",
  );
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);

export const pilotTargetReasonSchema = z.enum([
  "PILOT_TARGET_SCOPE_FROZEN",
  "PILOT_TARGET_DIRTY",
  "PILOT_TARGET_NOT_GIT_ROOT",
  "PILOT_TARGET_NOT_CANONICAL",
  "PILOT_TARGET_DETACHED_HEAD",
  "PILOT_TARGET_INSPECTION_FAILED",
]);
export type PilotTargetReason = z.infer<typeof pilotTargetReasonSchema>;

export const pilotRepositoryTargetReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-repository-target.v1"),
    status: z.enum(["READY", "BLOCKED"]),
    targetId: pilotTargetIdSchema,
    selectionMode: z.literal("EXPLICIT_OPERATOR_SELECTED"),
    repositoryFingerprint: fingerprintSchema.nullable(),
    sourceFingerprint: fingerprintSchema.nullable(),
    targetReferenceFingerprint: fingerprintSchema.nullable(),
    reasons: z.array(pilotTargetReasonSchema).min(1),
  })
  .superRefine((receipt, context) => {
    const fingerprints = [
      receipt.repositoryFingerprint,
      receipt.sourceFingerprint,
      receipt.targetReferenceFingerprint,
    ];
    const allPresent = fingerprints.every((fingerprint) => fingerprint !== null);
    if (receipt.status === "READY" && !allPresent) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "READY target receipts require all frozen identity fingerprints",
      });
    }
    if (receipt.status === "BLOCKED" && allPresent) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "BLOCKED target receipts cannot carry repository identity fingerprints",
      });
    }
    if (receipt.reasons.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "target receipts must contain exactly one fixed reason",
      });
    }
    if ((receipt.status === "READY") !== receipt.reasons.includes("PILOT_TARGET_SCOPE_FROZEN")) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "only READY target receipts may claim a frozen pilot scope",
      });
    }
  });
export type PilotRepositoryTargetReceipt = z.infer<typeof pilotRepositoryTargetReceiptSchema>;

export interface PilotRepositoryTargetFacts {
  readonly targetId: string;
  /** The canonical physical repository identity is hashed and never returned. */
  readonly canonicalRepositoryIdentity: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly dirty: boolean;
}

export function createPilotRepositoryTargetBlockedReceipt(
  targetId: string,
  reason: Exclude<PilotTargetReason, "PILOT_TARGET_SCOPE_FROZEN">,
): PilotRepositoryTargetReceipt {
  return pilotRepositoryTargetReceiptSchema.parse({
    schemaVersion: "hpi-pilot-repository-target.v1",
    status: "BLOCKED",
    targetId,
    selectionMode: "EXPLICIT_OPERATOR_SELECTED",
    repositoryFingerprint: null,
    sourceFingerprint: null,
    targetReferenceFingerprint: null,
    reasons: [reason],
  });
}

export function createPilotRepositoryTargetReceipt(
  facts: PilotRepositoryTargetFacts,
): PilotRepositoryTargetReceipt {
  const targetId = pilotTargetIdSchema.parse(facts.targetId);
  if (facts.dirty) {
    return createPilotRepositoryTargetBlockedReceipt(targetId, "PILOT_TARGET_DIRTY");
  }
  const canonicalRepositoryIdentity = z
    .string()
    .trim()
    .min(1)
    .parse(facts.canonicalRepositoryIdentity);
  const branch = z.string().trim().min(1).max(512).parse(facts.branch);
  const baseCommit = gitObjectIdSchema.parse(facts.baseCommit);
  const baseTree = gitObjectIdSchema.parse(facts.baseTree);
  return pilotRepositoryTargetReceiptSchema.parse({
    schemaVersion: "hpi-pilot-repository-target.v1",
    status: "READY",
    targetId,
    selectionMode: "EXPLICIT_OPERATOR_SELECTED",
    repositoryFingerprint: pilotFingerprint({
      schemaVersion: "hpi-pilot-repository-identity.v1",
      canonicalRepositoryIdentity,
    }),
    sourceFingerprint: pilotFingerprint({
      schemaVersion: "hpi-pilot-source.v1",
      baseCommit,
      baseTree,
    }),
    targetReferenceFingerprint: pilotFingerprint({
      schemaVersion: "hpi-pilot-target-reference.v1",
      branch,
      baseCommit,
    }),
    reasons: ["PILOT_TARGET_SCOPE_FROZEN"],
  });
}
