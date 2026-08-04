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

const nonnegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const task6ResourceAccountingSchema = z
  .strictObject({
    status: z.enum(["PASS", "NOT_PROVEN", "EXCEEDED"]),
    budgets: z.strictObject({
      maxAgentTurns: positiveIntegerSchema,
      maxExternalOperations: positiveIntegerSchema,
      maxCommands: positiveIntegerSchema,
      maxOutputBytes: positiveIntegerSchema,
    }),
    captureLimits: z.strictObject({
      engine: positiveIntegerSchema,
      verificationAttempt1: positiveIntegerSchema,
      verificationAttempt2: positiveIntegerSchema,
    }),
    capturedOutputBytes: z.strictObject({
      engine: nonnegativeIntegerSchema.optional(),
      verificationAttempt1: nonnegativeIntegerSchema,
      verificationAttempt2: nonnegativeIntegerSchema,
    }),
    consumed: z.strictObject({
      agentTurns: nonnegativeIntegerSchema,
      externalOperations: nonnegativeIntegerSchema,
      commands: nonnegativeIntegerSchema,
      outputBytes: nonnegativeIntegerSchema.optional(),
    }),
    unprovenReasons: z.array(
      z.enum(["ENGINE_OUTPUT_BYTES_MISSING", "OUTPUT_CAPTURE_LIMITS_EXCEED_RUN_BUDGET"]),
    ),
  })
  .superRefine((accounting, context) => {
    const engineOutputMissing = accounting.capturedOutputBytes.engine === undefined;
    const captureLimitTotal =
      accounting.captureLimits.engine +
      accounting.captureLimits.verificationAttempt1 +
      accounting.captureLimits.verificationAttempt2;
    const captureLimitsExceedBudget = captureLimitTotal > accounting.budgets.maxOutputBytes;
    const reasons = new Set(accounting.unprovenReasons);
    if (reasons.size !== accounting.unprovenReasons.length) {
      context.addIssue({ code: "custom", message: "resource-accounting reasons must be unique" });
    }
    if (engineOutputMissing !== reasons.has("ENGINE_OUTPUT_BYTES_MISSING")) {
      context.addIssue({
        code: "custom",
        message: "engine output measurement and its NOT_PROVEN reason must agree",
      });
    }
    if (captureLimitsExceedBudget !== reasons.has("OUTPUT_CAPTURE_LIMITS_EXCEED_RUN_BUDGET")) {
      context.addIssue({
        code: "custom",
        message: "capture-limit partition and its NOT_PROVEN reason must agree",
      });
    }

    const measuredOutputBytes =
      accounting.capturedOutputBytes.engine === undefined
        ? undefined
        : accounting.capturedOutputBytes.engine +
          accounting.capturedOutputBytes.verificationAttempt1 +
          accounting.capturedOutputBytes.verificationAttempt2;
    if (measuredOutputBytes !== accounting.consumed.outputBytes) {
      context.addIssue({
        code: "custom",
        message: "cumulative output usage must equal every measured output component",
      });
    }

    const budgetExceeded =
      accounting.consumed.agentTurns > accounting.budgets.maxAgentTurns ||
      accounting.consumed.externalOperations > accounting.budgets.maxExternalOperations ||
      accounting.consumed.commands > accounting.budgets.maxCommands ||
      (accounting.consumed.outputBytes !== undefined &&
        accounting.consumed.outputBytes > accounting.budgets.maxOutputBytes) ||
      (accounting.capturedOutputBytes.engine !== undefined &&
        accounting.capturedOutputBytes.engine > accounting.captureLimits.engine) ||
      accounting.capturedOutputBytes.verificationAttempt1 >
        accounting.captureLimits.verificationAttempt1 ||
      accounting.capturedOutputBytes.verificationAttempt2 >
        accounting.captureLimits.verificationAttempt2;
    const expectedStatus = budgetExceeded ? "EXCEEDED" : reasons.size > 0 ? "NOT_PROVEN" : "PASS";
    if (accounting.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        message: `resource-accounting status must be ${expectedStatus}`,
      });
    }
  });

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
    resourceAccounting: task6ResourceAccountingSchema,
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
      resourceBudgetReconciled: z.boolean(),
    }),
    cleanup: z.strictObject({
      status: z.enum(["PASS", "BLOCKED"]),
    }),
    remoteCi: z.literal("PENDING"),
  })
  .superRefine((artifact, context) => {
    if (
      artifact.scorecard.resourceBudgetReconciled !==
      (artifact.resourceAccounting.status === "PASS")
    ) {
      context.addIssue({
        code: "custom",
        message: "scorecard and resource-accounting status must agree",
      });
    }
    const correctnessPassed =
      artifact.projection.change.lifecycle === "READY" &&
      artifact.scorecard.zeroFalseReady &&
      !artifact.scorecard.sourceLoss &&
      !artifact.scorecard.secretLeak &&
      artifact.scorecard.failedAttemptPreserved &&
      artifact.scorecard.fixbackPass &&
      artifact.scorecard.summaryComplete &&
      artifact.scorecard.resourceBudgetReconciled;
    const deliveryTargetPassed =
      artifact.scorecard.overheadWithinLimit && artifact.scorecard.unplannedInterventions <= 2;
    const cleanupPassed = artifact.cleanup.status === "PASS";
    if (
      artifact.taskResult === "GO" &&
      (!correctnessPassed || !deliveryTargetPassed || !cleanupPassed)
    ) {
      context.addIssue({ code: "custom", message: "GO requires every Task 6 scorecard gate" });
    }
    if (
      artifact.taskResult === "REVISE" &&
      (!correctnessPassed || deliveryTargetPassed || !cleanupPassed)
    ) {
      context.addIssue({
        code: "custom",
        message: "REVISE requires correctness and cleanup to pass but a delivery target to miss",
      });
    }
    if (
      artifact.taskResult === "STOP" &&
      correctnessPassed &&
      deliveryTargetPassed &&
      cleanupPassed
    ) {
      context.addIssue({
        code: "custom",
        message: "STOP requires a correctness, cleanup, or delivery-target failure",
      });
    }
  });
export type Task6ManagedChangeEvidence = z.infer<typeof task6ManagedChangeEvidenceSchema>;
