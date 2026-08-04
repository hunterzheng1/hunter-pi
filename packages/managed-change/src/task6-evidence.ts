import { z } from "zod";

import {
  evidenceEnvelopeSchema,
  fingerprintSchema,
  operationReceiptSchema,
  timestampSchema,
} from "@hunter-pi/domain";
import { capabilityReceiptSchema } from "@hunter-pi/engine-contracts";
import { runProjectionSchema } from "@hunter-pi/workflow-kernel";

const normalizedFixturePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.startsWith("/") &&
      !/^[A-Za-z]:/u.test(path) &&
      path !== "." &&
      path !== ".." &&
      !path.startsWith("../") &&
      !path.split("/").includes(".."),
    "expected a normalized fixture-relative path",
  );

export const task6ManagedChangeEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-task6-managed-change.v1"),
    observedAt: timestampSchema,
    taskResult: z.enum(["GO", "REVISE", "STOP"]),
    productSource: z.strictObject({
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      state: z.enum(["CLEAN", "DIRTY"]),
    }),
    engineRelease: z.strictObject({
      packageName: z.string().trim().min(1).max(256),
      version: z.string().trim().min(1).max(128),
    }),
    provider: z.strictObject({
      id: z.string().trim().min(1).max(256),
      authStatus: z.literal("DETECTED"),
      requestStatus: z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]),
      promptFingerprint: fingerprintSchema,
    }),
    fixture: z.strictObject({
      fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_GIT_ONLY"),
      baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      includePaths: z.array(normalizedFixturePathSchema).min(1),
      excludePaths: z.array(normalizedFixturePathSchema),
      dirtyPaths: z.array(normalizedFixturePathSchema).min(1),
      workspaceFingerprint: fingerprintSchema,
      sourceFingerprint: fingerprintSchema,
      excludedContentFingerprint: fingerprintSchema,
    }),
    capabilityReceipt: capabilityReceiptSchema,
    operationReceipts: z.array(operationReceiptSchema),
    lifecycleAfterAgentReturn: z.enum(["VERIFYING", "NOT_OBSERVED"]),
    projection: runProjectionSchema,
    evidence: z.array(evidenceEnvelopeSchema).min(1),
    finalSummary: z.strictObject({
      attempts: z.array(z.string().trim().min(1)),
      checks: z.array(z.string().trim().min(1)),
      blockingFindings: z.array(z.string().trim().min(1)),
      unresolvedRisks: z.array(z.string().trim().min(1)),
    }),
    scorecard: z.strictObject({
      zeroFalseReady: z.boolean(),
      sourceLoss: z.boolean(),
      secretLeak: z.boolean(),
      failedAttemptPreserved: z.boolean(),
      fixbackPass: z.boolean(),
      unplannedInterventions: z.number().int().nonnegative(),
      overheadMs: z.number().nonnegative(),
      overheadWithinLimit: z.boolean(),
      summaryComplete: z.boolean(),
    }),
    cleanup: z.strictObject({
      status: z.enum(["PASS", "BLOCKED"]),
    }),
    remoteCi: z.literal("PENDING"),
  })
  .superRefine((artifact, context) => {
    const correctnessPassed =
      artifact.projection.change.lifecycle === "READY" &&
      artifact.scorecard.zeroFalseReady &&
      !artifact.scorecard.sourceLoss &&
      !artifact.scorecard.secretLeak &&
      artifact.scorecard.failedAttemptPreserved &&
      artifact.scorecard.fixbackPass &&
      artifact.scorecard.summaryComplete;
    if (
      artifact.taskResult === "GO" &&
      (!correctnessPassed || !artifact.scorecard.overheadWithinLimit)
    ) {
      context.addIssue({ code: "custom", message: "GO requires every Task 6 scorecard gate" });
    }
    if (artifact.taskResult === "REVISE" && !correctnessPassed) {
      context.addIssue({ code: "custom", message: "REVISE requires correctness to pass" });
    }
    if (artifact.taskResult === "STOP" && artifact.projection.change.lifecycle === "READY") {
      context.addIssue({ code: "custom", message: "a READY Task 6 result is GO or REVISE" });
    }
  });
export type Task6ManagedChangeEvidence = z.infer<typeof task6ManagedChangeEvidenceSchema>;
