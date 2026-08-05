import { z } from "zod";

import {
  archiveIdSchema,
  attemptIdSchema,
  changeIdSchema,
  checkIdSchema,
  checkpointIdSchema,
  compatibilityReceiptIdSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  evidenceIdSchema,
  humanReceiptIdSchema,
  observationIdSchema,
  operationIdSchema,
  operationReceiptIdSchema,
  planRevisionIdSchema,
  pluginAssuranceReceiptIdSchema,
  pluginIdSchema,
  reconciliationReceiptIdSchema,
  reviewReceiptIdSchema,
  runIdSchema,
  stepIdSchema,
  verificationReceiptIdSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
} from "./identities.js";

export const schemaVersion = "1.0.0" as const;
export const schemaVersionSchema = z.literal(schemaVersion);
export const timestampSchema = z.iso.datetime({ offset: true });
export const fingerprintSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "expected a sha256 fingerprint");
export type Fingerprint = z.infer<typeof fingerprintSchema>;

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
const positiveFiniteIntegerSchema = z.number().int().positive();

export const changeLifecycleSchema = z.enum([
  "DRAFT",
  "PLANNED",
  "RUNNING",
  "VERIFYING",
  "REVIEWING",
  "READY",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INCOMPLETE",
]);
export type ChangeLifecycle = z.infer<typeof changeLifecycleSchema>;

export const managedChangeSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  changeId: changeIdSchema,
  title: nonEmptyTextSchema,
  goal: nonEmptyTextSchema,
  nonGoals: z.array(nonEmptyTextSchema),
  constraints: z.array(nonEmptyTextSchema),
  lifecycle: changeLifecycleSchema,
  createdAt: timestampSchema,
});
export type ManagedChange = z.infer<typeof managedChangeSchema>;

export const stepKindSchema = z.enum([
  "context",
  "plan",
  "agent",
  "command",
  "verify",
  "human_gate",
  "review",
]);
export type StepKind = z.infer<typeof stepKindSchema>;

const stepBaseShape = {
  stepId: stepIdSchema,
  title: nonEmptyTextSchema,
  dependsOn: z.array(stepIdSchema),
  required: z.boolean(),
  inputContractFingerprint: fingerprintSchema,
  outputContractFingerprint: fingerprintSchema,
};

export const humanDecisionSchema = z.enum(["APPROVED", "REJECTED", "BLOCKED"]);
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

export const stepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...stepBaseShape,
    kind: z.enum(["context", "plan", "agent", "command", "verify"]),
  }),
  z.strictObject({
    ...stepBaseShape,
    kind: z.literal("human_gate"),
    expectedContentHash: fingerprintSchema,
    allowedDecisions: z
      .array(humanDecisionSchema)
      .min(1)
      .refine(
        (decisions) => new Set(decisions).size === decisions.length,
        "human gate decisions must be unique",
      ),
  }),
  z.strictObject({
    ...stepBaseShape,
    kind: z.literal("review"),
    inputFingerprint: fingerprintSchema,
    reviewDefinitionFingerprint: fingerprintSchema,
    configurationFingerprint: fingerprintSchema,
  }),
]);
export type Step = z.infer<typeof stepSchema>;

export const declaredCheckSchema = z.strictObject({
  checkId: checkIdSchema,
  version: positiveFiniteIntegerSchema,
  label: nonEmptyTextSchema,
  kind: z.literal("command"),
  required: z.boolean(),
  definition: z.strictObject({
    executable: nonEmptyTextSchema,
    argv: z.array(z.string().max(32_768)),
    workingDirectoryReference: nonEmptyTextSchema,
  }),
  definitionFingerprint: fingerprintSchema,
  configurationFingerprint: fingerprintSchema,
});
export type DeclaredCheck = z.infer<typeof declaredCheckSchema>;

export const resourceBudgetsSchema = z
  .strictObject({
    maxAgentTurns: positiveFiniteIntegerSchema.optional(),
    maxExternalOperations: positiveFiniteIntegerSchema.optional(),
    maxCommands: positiveFiniteIntegerSchema.optional(),
    maxOutputBytes: positiveFiniteIntegerSchema.optional(),
    maxTokens: positiveFiniteIntegerSchema.optional(),
    maxCostMinorUnits: positiveFiniteIntegerSchema.optional(),
  })
  .refine(
    (budgets) => Object.values(budgets).some((value) => value !== undefined),
    "at least one finite resource budget is required",
  );
export type ResourceBudgets = z.infer<typeof resourceBudgetsSchema>;

export const resourceUsageSchema = z.strictObject({
  agentTurns: z.number().int().nonnegative().optional(),
  externalOperations: z.number().int().nonnegative().optional(),
  commands: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  costMinorUnits: z.number().int().nonnegative().optional(),
});
export type ResourceUsage = z.infer<typeof resourceUsageSchema>;

export const loopPolicySchema = z.strictObject({
  maxIterations: positiveFiniteIntegerSchema,
  maxElapsedMs: positiveFiniteIntegerSchema,
  repeatedFailureLimit: positiveFiniteIntegerSchema,
  resourceBudgets: resourceBudgetsSchema,
  stopOnUserInput: z.boolean(),
  stopOnWorkspaceDrift: z.boolean(),
});
export type LoopPolicy = z.infer<typeof loopPolicySchema>;

export const planRevisionSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    planRevisionId: planRevisionIdSchema,
    changeId: changeIdSchema,
    revision: positiveFiniteIntegerSchema,
    workspaceId: workspaceIdSchema,
    workspaceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    goal: nonEmptyTextSchema,
    nonGoals: z.array(nonEmptyTextSchema),
    constraints: z.array(nonEmptyTextSchema),
    steps: z.array(stepSchema).min(1),
    checks: z.array(declaredCheckSchema).min(1),
    loopPolicy: loopPolicySchema,
    createdAt: timestampSchema,
  })
  .refine(
    (plan) => plan.checks.some((check) => check.required),
    "at least one required automated check is required",
  )
  .superRefine((plan, context) => {
    const stepIds = plan.steps.map((step) => step.stepId);
    if (new Set(stepIds).size !== stepIds.length) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step identities must be unique within a Plan Revision",
      });
    }

    const checkIds = plan.checks.map((check) => check.checkId);
    if (new Set(checkIds).size !== checkIds.length) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Check identities must be unique within a Plan Revision",
      });
    }

    const knownStepIds = new Set<string>(stepIds);
    for (const [index, step] of plan.steps.entries()) {
      if (
        step.kind === "human_gate" &&
        step.required &&
        !step.allowedDecisions.includes("APPROVED")
      ) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "allowedDecisions"],
          message: "a required human gate must permit APPROVED",
        });
      }
      if (new Set(step.dependsOn).size !== step.dependsOn.length) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "dependsOn"],
          message: "Step dependencies must be unique",
        });
      }
      for (const dependency of step.dependsOn) {
        if (!knownStepIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "dependsOn"],
            message: `unknown Step dependency ${dependency}`,
          });
        }
        if (dependency === step.stepId) {
          context.addIssue({
            code: "custom",
            path: ["steps", index, "dependsOn"],
            message: "a Step cannot depend on itself",
          });
        }
      }
    }

    const dependenciesByStep = new Map<string, readonly string[]>(
      plan.steps.map((step) => [step.stepId, step.dependsOn]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (stepId: string): boolean => {
      if (visiting.has(stepId)) {
        return true;
      }
      if (visited.has(stepId)) {
        return false;
      }
      visiting.add(stepId);
      for (const dependency of dependenciesByStep.get(stepId) ?? []) {
        if (knownStepIds.has(dependency) && hasCycle(dependency)) {
          return true;
        }
      }
      visiting.delete(stepId);
      visited.add(stepId);
      return false;
    };
    if (stepIds.some((stepId) => hasCycle(stepId))) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step dependencies must form an acyclic graph",
      });
    }
  });
export type PlanRevision = z.infer<typeof planRevisionSchema>;

export const archiveStatusSchema = z.enum(["UNARCHIVED", "ARCHIVED"]);
export type ArchiveStatus = z.infer<typeof archiveStatusSchema>;

export const runSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  runId: runIdSchema,
  changeId: changeIdSchema,
  planRevisionId: planRevisionIdSchema,
  workspaceId: workspaceIdSchema,
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  lifecycle: changeLifecycleSchema,
  archiveStatus: archiveStatusSchema,
  archiveId: archiveIdSchema.optional(),
  startedAt: timestampSchema,
  predecessorRunId: runIdSchema.optional(),
  endedAt: timestampSchema.optional(),
  terminalReason: nonEmptyTextSchema.optional(),
});
export type Run = z.infer<typeof runSchema>;

export const executionStatusSchema = z.enum([
  "PENDING",
  "STARTING",
  "RUNNING",
  "WAITING_INPUT",
  "RETURNED",
  "INTERRUPTED",
  "INCOMPLETE",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const verificationStatusSchema = z.enum([
  "NOT_READY",
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "BLOCKED",
  "NOT_PROVEN",
]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const attemptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    attemptId: attemptIdSchema,
    runId: runIdSchema,
    planRevisionId: planRevisionIdSchema,
    sequence: positiveFiniteIntegerSchema,
    previousAttemptId: attemptIdSchema.optional(),
    recoveryCheckpointId: checkpointIdSchema.optional(),
    recoveryOperationId: operationIdSchema.optional(),
    recoveryOperationFingerprint: fingerprintSchema.optional(),
    failureEvidenceIds: z.array(evidenceIdSchema).min(1).optional(),
    retryReason: nonEmptyTextSchema.optional(),
    precedingFailureFingerprint: fingerprintSchema.optional(),
    retryStopConditions: z
      .strictObject({
        userInputRequired: z.boolean(),
        workspaceDriftDetected: z.boolean(),
      })
      .optional(),
    elapsedMsAtStart: z.number().int().nonnegative(),
    remainingResourceBudgets: resourceBudgetsSchema,
    executionStatus: executionStatusSchema,
    verificationStatus: verificationStatusSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
  })
  .superRefine((attempt, context) => {
    const retryFields = [
      attempt.previousAttemptId,
      attempt.failureEvidenceIds,
      attempt.retryReason,
      attempt.precedingFailureFingerprint,
      attempt.retryStopConditions,
    ];
    const presentCount = retryFields.filter((value) => value !== undefined).length;
    const hasRetryFields = presentCount > 0;
    const recoveryOperationFields = [
      attempt.recoveryOperationId,
      attempt.recoveryOperationFingerprint,
    ];
    const recoveryOperationPresentCount = recoveryOperationFields.filter(
      (value) => value !== undefined,
    ).length;
    if (
      (hasRetryFields && presentCount !== retryFields.length) ||
      (attempt.sequence === 1 && hasRetryFields) ||
      (attempt.sequence > 1 && presentCount !== retryFields.length) ||
      (attempt.sequence === 1 && attempt.recoveryCheckpointId !== undefined) ||
      (attempt.recoveryCheckpointId === undefined && recoveryOperationPresentCount > 0) ||
      (attempt.recoveryCheckpointId !== undefined && recoveryOperationPresentCount !== 2)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "retry Attempts require previousAttemptId, failureEvidenceIds, retryReason, precedingFailureFingerprint, and retryStopConditions",
      });
    }
  });
export type Attempt = z.infer<typeof attemptSchema>;

export const observationKindSchema = z.enum([
  "AGENT_RETURNED",
  "PROCESS_EXITED",
  "TERMINAL_IDLE",
  "WINDOW_OPENED",
  "OUTPUT_CAPTURED",
  "INPUT_REQUESTED",
  "OPERATION_OBSERVED",
]);
export type ObservationKind = z.infer<typeof observationKindSchema>;

export const observationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  observationId: observationIdSchema,
  runId: runIdSchema,
  attemptId: attemptIdSchema,
  stepId: stepIdSchema.optional(),
  kind: observationKindSchema,
  observedAt: timestampSchema,
  summary: nonEmptyTextSchema.optional(),
  evidenceIds: z.array(evidenceIdSchema),
});
export type Observation = z.infer<typeof observationSchema>;

export const verificationOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED", "NOT_PROVEN"]);
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const verificationReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    verificationReceiptId: verificationReceiptIdSchema,
    runId: runIdSchema,
    attemptId: attemptIdSchema,
    checkId: checkIdSchema,
    checkVersion: positiveFiniteIntegerSchema,
    checkDefinitionFingerprint: fingerprintSchema,
    resultFingerprint: fingerprintSchema,
    outcome: verificationOutcomeSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    observedAt: timestampSchema,
    inputFingerprint: fingerprintSchema,
    configFingerprint: fingerprintSchema,
    workspaceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    environmentFingerprint: fingerprintSchema,
    resultStatus: z.strictObject({
      kind: z.literal("EXIT_CODE"),
      exitCode: z.number().int(),
      timedOut: z.boolean(),
    }),
    output: z.strictObject({
      stdoutDigest: fingerprintSchema,
      stderrDigest: fingerprintSchema,
      artifactDigests: z.array(fingerprintSchema),
      capturedBytes: z.number().int().nonnegative(),
      stdoutTruncated: z.boolean(),
      stderrTruncated: z.boolean(),
      redaction: z.strictObject({
        applied: z.boolean(),
        fieldsRemoved: z.number().int().nonnegative(),
      }),
    }),
    evidenceIds: z.array(evidenceIdSchema).min(1),
  })
  .refine(
    (receipt) => Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt),
    "Verification endedAt must not precede startedAt",
  )
  .refine(
    (receipt) => Date.parse(receipt.observedAt) >= Date.parse(receipt.endedAt),
    "Verification observedAt must not precede endedAt",
  )
  .refine(
    (receipt) =>
      receipt.outcome !== "PASS" ||
      (!receipt.resultStatus.timedOut && receipt.resultStatus.exitCode === 0),
    "a PASS Verification requires a non-timeout zero exit status",
  );
export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;

export const humanReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    humanReceiptId: humanReceiptIdSchema,
    runId: runIdSchema,
    attemptId: attemptIdSchema,
    stepId: stepIdSchema,
    contentHash: fingerprintSchema,
    resultFingerprint: fingerprintSchema,
    decision: humanDecisionSchema,
    actorReference: nonEmptyTextSchema,
    recordedAt: timestampSchema,
    evidenceIds: z.array(evidenceIdSchema),
  })
  .refine(
    (receipt) => receipt.decision === "APPROVED" || receipt.evidenceIds.length > 0,
    "a rejected or blocked Human Receipt requires failure Evidence",
  );
export type HumanReceipt = z.infer<typeof humanReceiptSchema>;

export const reviewFindingSchema = z.strictObject({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  scope: nonEmptyTextSchema,
  rationale: nonEmptyTextSchema,
  evidenceIds: z.array(evidenceIdSchema).min(1),
  confidence: z.number().min(0).max(1),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    reviewReceiptId: reviewReceiptIdSchema,
    runId: runIdSchema,
    attemptId: attemptIdSchema,
    stepId: stepIdSchema,
    inputFingerprint: fingerprintSchema,
    reviewDefinitionFingerprint: fingerprintSchema,
    configurationFingerprint: fingerprintSchema,
    workspaceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    resultFingerprint: fingerprintSchema,
    outcome: verificationOutcomeSchema,
    observedAt: timestampSchema,
    findings: z.array(reviewFindingSchema),
    evidenceIds: z.array(evidenceIdSchema),
  })
  .refine(
    (receipt) =>
      receipt.outcome === "PASS" ||
      receipt.evidenceIds.length > 0 ||
      receipt.findings.some((finding) => finding.evidenceIds.length > 0),
    "a failed, blocked, or not-proven Review Receipt requires failure Evidence",
  );
export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;

export const evidenceKindSchema = z.enum([
  "observation",
  "verification",
  "review",
  "human_receipt",
  "operation",
  "checkpoint",
  "run_summary",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceContentClassSchema = z.enum([
  "LOG",
  "SUMMARY",
  "PRIVATE_PROMPT",
  "ENVIRONMENT_DUMP",
  "CREDENTIAL_MATERIAL",
]);
export type EvidenceContentClass = z.infer<typeof evidenceContentClassSchema>;

export const evidenceRetentionStatusSchema = z.enum([
  "RETAINED",
  "TRUNCATED",
  "DIGEST_ONLY",
  "PRUNED",
]);
export type EvidenceRetentionStatus = z.infer<typeof evidenceRetentionStatusSchema>;

export const redactionCategorySchema = z.enum([
  "CREDENTIAL",
  "ENVIRONMENT_DUMP",
  "PRIVATE_PATH",
  "PRIVATE_PROMPT",
  "SENSITIVE_QUERY",
]);
export type RedactionCategory = z.infer<typeof redactionCategorySchema>;

export const redactionMetadataSchema = z
  .strictObject({
    version: z.literal("hunter-redaction/1"),
    applied: z.boolean(),
    fieldsRemoved: z.number().int().nonnegative(),
    categories: z.array(redactionCategorySchema),
  })
  .superRefine((metadata, context) => {
    if (new Set(metadata.categories).size !== metadata.categories.length) {
      context.addIssue({ code: "custom", message: "redaction categories must be unique" });
    }
    const validAppliedState = metadata.applied
      ? metadata.fieldsRemoved > 0 && metadata.categories.length > 0
      : metadata.fieldsRemoved === 0 && metadata.categories.length === 0;
    if (!validAppliedState) {
      context.addIssue({
        code: "custom",
        message: "redaction applied must match removed fields and categories",
      });
    }
  });
export type RedactionMetadata = z.infer<typeof redactionMetadataSchema>;

export const maxEvidenceCaptureBytes = 8 * 1_024 * 1_024;

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

export const evidenceCaptureSchema = z
  .strictObject({
    mediaType: z.literal("text/plain; charset=utf-8"),
    retentionStatus: evidenceRetentionStatusSchema,
    capturedText: z.string().optional(),
    capturedBytes: z.number().int().nonnegative().max(maxEvidenceCaptureBytes),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    cursor: z.strictObject({
      startByte: z.literal(0),
      endByte: z.number().int().nonnegative(),
      nextByte: z.number().int().positive().optional(),
    }),
  })
  .superRefine((capture, context) => {
    const capturedTextBytes =
      capture.capturedText === undefined ? 0 : utf8ByteLength(capture.capturedText);
    if (
      capture.capturedBytes !== capturedTextBytes ||
      capture.cursor.endByte !== capture.capturedBytes ||
      capture.capturedBytes > capture.totalBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "capture byte counts and cursor must match retained UTF-8 content",
      });
    }
    if (
      capture.retentionStatus === "RETAINED" &&
      (capture.capturedText === undefined ||
        capture.capturedBytes !== capture.totalBytes ||
        capture.truncated ||
        capture.cursor.nextByte !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "retained capture metadata is inconsistent" });
    }
    if (
      capture.retentionStatus === "TRUNCATED" &&
      (capture.capturedText === undefined ||
        capture.capturedBytes >= capture.totalBytes ||
        !capture.truncated ||
        capture.cursor.nextByte !== capture.capturedBytes)
    ) {
      context.addIssue({ code: "custom", message: "truncated capture metadata is inconsistent" });
    }
    if (
      (capture.retentionStatus === "DIGEST_ONLY" || capture.retentionStatus === "PRUNED") &&
      (capture.capturedText !== undefined ||
        capture.capturedBytes !== 0 ||
        capture.truncated ||
        capture.cursor.endByte !== 0 ||
        capture.cursor.nextByte !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "unretained capture cannot claim content" });
    }
  });
export type EvidenceCapture = z.infer<typeof evidenceCaptureSchema>;

export const evidenceScopeSchema = z.strictObject({
  runId: runIdSchema,
  attemptId: attemptIdSchema.optional(),
  verificationReceiptId: verificationReceiptIdSchema.optional(),
});
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

export const evidenceEnvelopeSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    evidenceId: evidenceIdSchema,
    kind: evidenceKindSchema,
    scope: evidenceScopeSchema,
    createdAt: timestampSchema,
    sourceFingerprint: fingerprintSchema,
    contentClass: evidenceContentClassSchema,
    contentHash: fingerprintSchema,
    summary: nonEmptyTextSchema,
    capture: evidenceCaptureSchema,
    redaction: redactionMetadataSchema,
  })
  .superRefine((envelope, context) => {
    if (
      ["observation", "verification", "review", "human_receipt"].includes(envelope.kind) &&
      envelope.scope.attemptId === undefined
    ) {
      context.addIssue({ code: "custom", message: "Attempt-scoped Evidence requires attemptId" });
    }
    if (
      (envelope.kind === "verification") !==
      (envelope.scope.verificationReceiptId !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "verification Evidence requires only its exact Verification Receipt identity",
      });
    }
    if (
      ["PRIVATE_PROMPT", "ENVIRONMENT_DUMP", "CREDENTIAL_MATERIAL"].includes(
        envelope.contentClass,
      ) &&
      envelope.capture.retentionStatus !== "DIGEST_ONLY"
    ) {
      context.addIssue({
        code: "custom",
        message: "forbidden portable content classes must remain digest-only",
      });
    }
  });
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;

export const externalReferenceSchema = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/u),
  reference: z.string().min(1).max(1_024),
});
export type ExternalReference = z.infer<typeof externalReferenceSchema>;

export const externalOperationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  operationId: operationIdSchema,
  fingerprint: fingerprintSchema,
  expectedTarget: externalReferenceSchema,
  deadline: timestampSchema,
  cancellationPolicy: z.strictObject({
    mode: z.literal("FAIL_CLOSED"),
    timeoutMs: positiveFiniteIntegerSchema,
  }),
});
export type ExternalOperation = z.infer<typeof externalOperationSchema>;

export const checkpointSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    checkpointId: checkpointIdSchema,
    runId: runIdSchema,
    attemptId: attemptIdSchema.optional(),
    planRevisionId: planRevisionIdSchema,
    distributionReleaseId: distributionReleaseIdSchema,
    workspaceId: workspaceIdSchema,
    repositoryFingerprint: fingerprintSchema,
    workspaceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    eventCursor: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    engine: z.strictObject({
      engineReleaseId: engineReleaseIdSchema,
      engineReleaseFingerprint: fingerprintSchema,
      sessionReference: externalReferenceSchema.optional(),
      resumeCapability: z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]),
    }),
    activeOperationReceiptIds: z.array(operationReceiptIdSchema),
    unknownOperationIds: z.array(operationIdSchema),
    heldWriterLeaseIds: z.array(writerLeaseIdSchema),
    processReferences: z.array(externalReferenceSchema),
    remainingResourceBudgets: resourceBudgetsSchema,
  })
  .refine(
    (checkpoint) =>
      checkpoint.engine.resumeCapability !== "SUPPORTED" ||
      checkpoint.engine.sessionReference !== undefined,
    "a supported resume capability requires an engine session reference",
  )
  .superRefine((checkpoint, context) => {
    for (const key of [
      "activeOperationReceiptIds",
      "unknownOperationIds",
      "heldWriterLeaseIds",
      "processReferences",
    ] as const) {
      const values = checkpoint[key].map((value) => JSON.stringify(value));
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} identities must be unique`,
        });
      }
    }
  });
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const pluginCompatibilitySchema = z.enum(["VERIFIED", "UNVERIFIED", "INCOMPATIBLE"]);
export type PluginCompatibility = z.infer<typeof pluginCompatibilitySchema>;

export const pluginTrustSchema = z.enum(["BUNDLED", "USER_APPROVED", "QUARANTINED"]);
export type PluginTrust = z.infer<typeof pluginTrustSchema>;

export const pluginIsolationSchema = z.enum(["CONTAINED", "PROCESS_AUTHORITY", "NOT_PROVEN"]);
export type PluginIsolation = z.infer<typeof pluginIsolationSchema>;

export const compatibilityReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  compatibilityReceiptId: compatibilityReceiptIdSchema,
  pluginId: pluginIdSchema,
  pluginVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
  pluginReleaseFingerprint: fingerprintSchema,
  distributionReleaseId: distributionReleaseIdSchema,
  engineReleaseId: engineReleaseIdSchema,
  engineReleaseFingerprint: fingerprintSchema,
  platformFingerprint: fingerprintSchema,
  configurationFingerprint: fingerprintSchema,
  outcome: pluginCompatibilitySchema,
  checkedAt: timestampSchema,
  evidenceIds: z.array(evidenceIdSchema),
});
export type CompatibilityReceipt = z.infer<typeof compatibilityReceiptSchema>;

export const pluginAssuranceReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    pluginAssuranceReceiptId: pluginAssuranceReceiptIdSchema,
    compatibilityReceipt: compatibilityReceiptSchema,
    compatibility: pluginCompatibilitySchema,
    trust: pluginTrustSchema,
    isolation: pluginIsolationSchema,
    assessedAt: timestampSchema,
    evidenceIds: z.array(evidenceIdSchema),
  })
  .refine(
    (receipt) => receipt.compatibility === receipt.compatibilityReceipt.outcome,
    "Plugin Assurance compatibility must match its embedded Compatibility Receipt",
  );
export type PluginAssuranceReceipt = z.infer<typeof pluginAssuranceReceiptSchema>;

export const operationReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    operationReceiptId: operationReceiptIdSchema,
    operationId: operationIdSchema,
    fingerprint: fingerprintSchema,
    outcome: z.enum(["APPLIED", "NOOP", "UNKNOWN", "REJECTED"]),
    observedEffects: z.array(nonEmptyTextSchema),
    observedAt: timestampSchema,
  })
  .refine(
    (receipt) => receipt.outcome !== "UNKNOWN" || receipt.observedEffects.length === 0,
    "an UNKNOWN Operation Receipt cannot claim observed effects",
  );
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;

export const operationReconciliationReceiptSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    reconciliationReceiptId: reconciliationReceiptIdSchema,
    operationId: operationIdSchema,
    fingerprint: fingerprintSchema,
    previousOutcome: z.literal("UNKNOWN"),
    outcome: z.enum(["APPLIED", "NOOP", "UNKNOWN", "REJECTED"]),
    observedEffects: z.array(nonEmptyTextSchema),
    observedAt: timestampSchema,
  })
  .refine(
    (receipt) => receipt.outcome !== "UNKNOWN" || receipt.observedEffects.length === 0,
    "an UNKNOWN reconciliation cannot claim observed effects",
  );
export type OperationReconciliationReceipt = z.infer<typeof operationReconciliationReceiptSchema>;
