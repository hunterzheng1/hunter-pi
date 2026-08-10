import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";

import { pilotFingerprint } from "./serialization.js";

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
const pathFreeIdentityTextSchema = nonEmptyTextSchema.refine(
  (value) => !/[\\/]/u.test(value),
  "pilot identity text must not contain filesystem separators",
);
const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "pilot identities must be stable and path-free");
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nonnegativeNumberSchema = z.number().nonnegative();
const positiveIntegerSchema = z.number().int().positive();

export const pilotMachineProfileSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-machine.v2"),
  platform: z.literal("win32"),
  architecture: z.literal("x64"),
  osBuild: stableIdSchema,
  cpuModel: pathFreeIdentityTextSchema,
  logicalCores: z.number().int().positive(),
  memoryMiB: z.number().int().positive(),
  storage: z.enum(["SSD", "HDD", "UNKNOWN"]),
  terminal: stableIdSchema,
  gitVersion: pathFreeIdentityTextSchema,
  securitySoftwareState: stableIdSchema,
  powerMode: stableIdSchema,
  networkCondition: stableIdSchema,
  sourceFingerprint: fingerprintSchema,
  hunterReleaseFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
});
export type PilotMachineProfile = z.infer<typeof pilotMachineProfileSchema>;

export const pilotModeSchema = z.enum(["QUICK", "MANAGED"]);
export const pilotCaptureProvenanceSchema = z.enum(["LIVE_WINDOWS_PILOT", "FIXTURE", "TEST"]);
export type PilotCaptureProvenance = z.infer<typeof pilotCaptureProvenanceSchema>;
export const pilotOutcomeSchema = z.enum([
  "READY",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INCOMPLETE",
  "NOT_PROVEN",
]);

export const pilotProviderRequestPolicySchema = z.enum([
  "NO_PROVIDER_REQUESTS",
  "EXPLICIT_OPERATOR_AUTHORIZED",
]);

export const pilotRepositorySelectionModeSchema = z.literal("EXPLICIT_OPERATOR_SELECTED");

export const pilotOperatorScopeSchema = z.strictObject({
  repositorySelection: z.literal("EXPLICIT_OPERATOR_SELECTED"),
  providerRequestPolicy: pilotProviderRequestPolicySchema,
  providerEndpointFingerprint: fingerprintSchema.nullable(),
  providerModelFingerprint: fingerprintSchema.nullable(),
  credentialScopeFingerprint: fingerprintSchema.nullable(),
  maxProviderRequests: positiveIntegerSchema.nullable(),
  maxProviderTokens: positiveIntegerSchema.nullable(),
  maxProviderCostMinor: positiveIntegerSchema.nullable(),
  acknowledged: z.boolean(),
  workspacePolicy: z.literal("DISPOSABLE_PILOT_WORKTREES"),
});
export type PilotOperatorScope = z.infer<typeof pilotOperatorScopeSchema>;

export const pilotPlanAcceptanceCheckSchema = z.strictObject({
  checkId: stableIdSchema,
  definitionFingerprint: fingerprintSchema,
});
export type PilotPlanAcceptanceCheck = z.infer<typeof pilotPlanAcceptanceCheckSchema>;

export const pilotPlanPluginFixtureIdSchema = z.enum([
  "THROWING_INITIALIZATION",
  "RESERVED_COLLISION",
  "BUILTIN_OVERRIDE",
  "SECRET_PATH_LEAKAGE",
  "OVERSIZED_OUTPUT",
]);

export const pilotPlanPluginFixtureSchema = z.strictObject({
  fixtureId: pilotPlanPluginFixtureIdSchema,
  definitionFingerprint: fingerprintSchema,
});
export type PilotPlanPluginFixture = z.infer<typeof pilotPlanPluginFixtureSchema>;

export const pilotPlanUpdateCandidateSchema = z.strictObject({
  candidateId: stableIdSchema,
  artifactFingerprint: fingerprintSchema,
  qualificationFingerprint: fingerprintSchema,
});
export type PilotPlanUpdateCandidate = z.infer<typeof pilotPlanUpdateCandidateSchema>;

export const pilotPreflightReasonSchema = z.enum([
  "PILOT_PLAN_SCOPE_FROZEN",
  "PILOT_PLAN_FILE_UNREADABLE",
  "PILOT_PLAN_JSON_INVALID",
  "PILOT_PLAN_VERSION_INVALID",
  "PILOT_PLAN_MACHINE_PROFILE_INVALID",
  "PILOT_PLAN_COMPARATOR_CONFIG_INVALID",
  "PILOT_PLAN_WORKFLOW_CHECKLIST_INVALID",
  "PILOT_PLAN_ACCEPTANCE_CHECKS_INVALID",
  "PILOT_PLAN_PROVIDER_SCOPE_INVALID",
  "PILOT_PLAN_TARGETS_INVALID",
  "PILOT_PLAN_TASKS_INVALID",
  "PILOT_PLAN_PLUGIN_FIXTURES_INVALID",
  "PILOT_PLAN_UPDATE_CANDIDATES_INVALID",
  "PILOT_PLAN_PAIRED_TASKS_INVALID",
  "PILOT_PLAN_INTERRUPTION_TASKS_INVALID",
  "PILOT_PLAN_FIELDS_INVALID",
  "PILOT_PLAN_SCHEMA_INVALID",
  "PILOT_PLAN_COMPILATION_FAILED",
]);
export type PilotPreflightReason = z.infer<typeof pilotPreflightReasonSchema>;

const pilotPlanTaskV2Schema = z.strictObject({
  taskId: stableIdSchema,
  targetId: stableIdSchema,
  sourceFingerprint: fingerprintSchema,
  mode: pilotModeSchema,
  expectedOutcome: pilotOutcomeSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
});

const pilotPlanTaskCommonShape = {
  taskId: stableIdSchema,
  targetId: stableIdSchema,
  sourceFingerprint: fingerprintSchema,
  taskDefinitionFingerprint: fingerprintSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
} as const;

export const pilotQuickExecutionObservationSchema = z.enum([
  "RETURNED",
  "TIMED_OUT",
  "PROCESS_ERROR",
  "BLOCKED",
  "NOT_PROVEN",
]);
export const pilotQuickAcceptanceObservationSchema = z.enum([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_RUN",
  "NOT_PROVEN",
]);

export const pilotPlanTaskSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...pilotPlanTaskCommonShape,
    mode: z.literal("QUICK"),
    expectedExecutionObservation: z.literal("RETURNED"),
    expectedAcceptanceObservation: z.literal("PASS"),
  }),
  z.strictObject({
    ...pilotPlanTaskCommonShape,
    mode: z.literal("MANAGED"),
    expectedOutcome: pilotOutcomeSchema,
  }),
]);
export type PilotPlanTask = z.infer<typeof pilotPlanTaskSchema>;

export const pilotPlanInterruptionTaskSchema = z.strictObject({
  interruptionId: stableIdSchema,
  taskId: stableIdSchema,
  kind: z.enum(["FORCED_PROCESS_KILL", "TERMINAL_CLOSE_SIMULATION", "POWER_LOSS_SIMULATION"]),
});
export type PilotPlanInterruptionTask = z.infer<typeof pilotPlanInterruptionTaskSchema>;

const pilotPlanCommonBodyShape = {
  platform: z.literal("win32"),
  architecture: z.literal("x64"),
  sourceFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
  machineProfile: pilotMachineProfileSchema,
  comparatorConfigurationFingerprint: fingerprintSchema,
  workflowFactChecklistFingerprint: fingerprintSchema,
  acceptanceChecks: z.array(pilotPlanAcceptanceCheckSchema).min(1),
  operatorScope: pilotOperatorScopeSchema,
  repositoryTargets: z.array(
    z.strictObject({
      targetId: stableIdSchema,
      repositoryFingerprint: fingerprintSchema,
      sourceFingerprint: fingerprintSchema,
      targetReferenceFingerprint: fingerprintSchema,
      selectionMode: pilotRepositorySelectionModeSchema,
    }),
  ),
  pluginFixtures: z.array(pilotPlanPluginFixtureSchema).length(5),
  updateCandidates: z.array(pilotPlanUpdateCandidateSchema).length(2),
  pairedTaskIds: z.array(stableIdSchema).length(3),
} as const;

const pilotPlanV2BodyShape = {
  ...pilotPlanCommonBodyShape,
  tasks: z.array(pilotPlanTaskV2Schema).length(10),
} as const;

const pilotPlanBodyShape = {
  ...pilotPlanCommonBodyShape,
  tasks: z.array(pilotPlanTaskSchema).length(10),
  interruptionTasks: z.array(pilotPlanInterruptionTaskSchema).length(3),
} as const;

function validatePilotPlanBodyBase(
  body:
    | z.infer<z.ZodObject<typeof pilotPlanBodyShape>>
    | z.infer<z.ZodObject<typeof pilotPlanV2BodyShape>>,
  context: z.RefinementCtx,
): void {
  const targetIds = body.repositoryTargets.map((target) => target.targetId);
  const taskIds = body.tasks.map((task) => task.taskId);
  if (new Set(targetIds).size !== targetIds.length) {
    context.addIssue({
      code: "custom",
      path: ["repositoryTargets"],
      message: "pilot repository targets must be unique",
    });
  }
  if (body.repositoryTargets.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["repositoryTargets"],
      message: "pilot requires at least two explicitly selected repositories",
    });
  }
  if (new Set(body.repositoryTargets.map((target) => target.repositoryFingerprint)).size < 2) {
    context.addIssue({
      code: "custom",
      path: ["repositoryTargets"],
      message: "pilot requires at least two distinct repository identities",
    });
  }
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "pilot task identities must be unique",
    });
  }
  const targetById = new Map(body.repositoryTargets.map((target) => [target.targetId, target]));
  const acceptanceCheckIds = body.acceptanceChecks.map((check) => check.checkId);
  if (new Set(acceptanceCheckIds).size !== acceptanceCheckIds.length) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceChecks"],
      message: "pilot acceptance check identities must be unique",
    });
  }
  const acceptanceCheckIdSet = new Set(acceptanceCheckIds);
  for (const task of body.tasks) {
    const target = targetById.get(task.targetId);
    if (task.sourceFingerprint !== target?.sourceFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "each pilot task must bind the selected target and its exact source",
      });
    }
    if (task.acceptanceCheckIds.some((checkId) => !acceptanceCheckIdSet.has(checkId))) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "each pilot task must bind declared acceptance checks",
      });
    }
  }
  if (
    new Set(body.tasks.map((task) => targetById.get(task.targetId)?.repositoryFingerprint ?? null))
      .size < 2
  ) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "pilot tasks must cover at least two selected repositories",
    });
  }
  if (!body.tasks.some((task) => task.mode === "QUICK")) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "pilot must include a Quick task",
    });
  }
  if (!body.tasks.some((task) => task.mode === "MANAGED")) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "pilot must include a Managed task",
    });
  }
  if (new Set(body.pairedTaskIds).size !== body.pairedTaskIds.length) {
    context.addIssue({
      code: "custom",
      path: ["pairedTaskIds"],
      message: "paired pilot tasks must be unique",
    });
  }
  if (
    body.pairedTaskIds.length !== 3 ||
    body.pairedTaskIds.some((taskId) => !taskIds.includes(taskId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["pairedTaskIds"],
      message: "pilot must declare three existing paired tasks",
    });
  }
  if (new Set(body.pluginFixtures.map((fixture) => fixture.fixtureId)).size !== 5) {
    context.addIssue({
      code: "custom",
      path: ["pluginFixtures"],
      message: "pilot plugin fixture identities must be unique",
    });
  }
  if (new Set(body.updateCandidates.map((candidate) => candidate.candidateId)).size !== 2) {
    context.addIssue({
      code: "custom",
      path: ["updateCandidates"],
      message: "pilot update candidate identities must be unique",
    });
  }
  if (
    body.machineProfile.sourceFingerprint !== body.sourceFingerprint ||
    body.machineProfile.hunterReleaseFingerprint !== body.artifactFingerprint ||
    body.machineProfile.engineReleaseFingerprint !== body.engineReleaseFingerprint
  ) {
    context.addIssue({
      code: "custom",
      path: ["machineProfile"],
      message: "pilot machine profile must bind the exact source, artifact, and Engine release",
    });
  }
  const providerScope = body.operatorScope;
  if (providerScope.providerRequestPolicy === "EXPLICIT_OPERATOR_AUTHORIZED") {
    if (
      providerScope.providerEndpointFingerprint === null ||
      providerScope.providerModelFingerprint === null ||
      providerScope.credentialScopeFingerprint === null ||
      providerScope.maxProviderRequests === null ||
      providerScope.maxProviderTokens === null ||
      providerScope.maxProviderCostMinor === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["operatorScope"],
        message:
          "explicit Provider requests require endpoint, model, credential, and finite request/token/cost scope",
      });
    }
    if (!providerScope.acknowledged) {
      context.addIssue({
        code: "custom",
        path: ["operatorScope", "acknowledged"],
        message: "explicit Provider scope requires operator acknowledgement",
      });
    }
  } else if (
    providerScope.providerEndpointFingerprint !== null ||
    providerScope.providerModelFingerprint !== null ||
    providerScope.credentialScopeFingerprint !== null ||
    providerScope.maxProviderRequests !== null ||
    providerScope.maxProviderTokens !== null ||
    providerScope.maxProviderCostMinor !== null ||
    providerScope.acknowledged
  ) {
    context.addIssue({
      code: "custom",
      path: ["operatorScope"],
      message:
        "Provider-disabled pilot scope cannot carry endpoint, credential, or acknowledgement data",
    });
  }
}

function validatePilotPlanBody(
  body: z.infer<z.ZodObject<typeof pilotPlanBodyShape>>,
  context: z.RefinementCtx,
): void {
  validatePilotPlanBodyBase(body, context);
  const interruptionIds = body.interruptionTasks.map((item) => item.interruptionId);
  const interruptionKinds = body.interruptionTasks.map((item) => item.kind);
  if (
    new Set(interruptionIds).size !== 3 ||
    new Set(interruptionKinds).size !== 3 ||
    new Set(body.interruptionTasks.map((item) => item.taskId)).size !== 3 ||
    body.interruptionTasks.some(
      (item) => body.tasks.find((task) => task.taskId === item.taskId)?.mode !== "MANAGED",
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["interruptionTasks"],
      message:
        "pilot must freeze each interruption kind once and bind every interruption to a Managed task",
    });
  }
}

type PilotPlanBody = z.infer<z.ZodObject<typeof pilotPlanBodyShape>>;
type PilotPlanV2Body = z.infer<z.ZodObject<typeof pilotPlanV2BodyShape>>;

export const pilotPlanInputV2Schema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-plan-input.v2"),
    ...pilotPlanV2BodyShape,
  })
  .superRefine((input, context) => {
    validatePilotPlanBodyBase(input, context);
  });

export const pilotExecutionPlanV2Schema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-execution-plan.v2"),
    ...pilotPlanV2BodyShape,
    planFingerprint: fingerprintSchema,
  })
  .superRefine((plan, context) => {
    const body: PilotPlanV2Body = {
      platform: plan.platform,
      architecture: plan.architecture,
      sourceFingerprint: plan.sourceFingerprint,
      artifactFingerprint: plan.artifactFingerprint,
      engineReleaseFingerprint: plan.engineReleaseFingerprint,
      machineProfile: plan.machineProfile,
      comparatorConfigurationFingerprint: plan.comparatorConfigurationFingerprint,
      workflowFactChecklistFingerprint: plan.workflowFactChecklistFingerprint,
      acceptanceChecks: plan.acceptanceChecks,
      operatorScope: plan.operatorScope,
      repositoryTargets: plan.repositoryTargets,
      tasks: plan.tasks,
      pluginFixtures: plan.pluginFixtures,
      updateCandidates: plan.updateCandidates,
      pairedTaskIds: plan.pairedTaskIds,
    };
    validatePilotPlanBodyBase(body, context);
    if (pilotFingerprint(body) !== plan.planFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["planFingerprint"],
        message: "historical pilot execution plan fingerprint does not match its frozen body",
      });
    }
  });

export const pilotPlanInputSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-plan-input.v3"),
    ...pilotPlanBodyShape,
  })
  .superRefine((input, context) => {
    validatePilotPlanBody(input, context);
  });
export type PilotPlanInput = z.infer<typeof pilotPlanInputSchema>;

export const pilotExecutionPlanSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-execution-plan.v3"),
    ...pilotPlanBodyShape,
    planFingerprint: fingerprintSchema,
  })
  .superRefine((plan, context) => {
    const body: PilotPlanBody = {
      platform: plan.platform,
      architecture: plan.architecture,
      sourceFingerprint: plan.sourceFingerprint,
      artifactFingerprint: plan.artifactFingerprint,
      engineReleaseFingerprint: plan.engineReleaseFingerprint,
      machineProfile: plan.machineProfile,
      comparatorConfigurationFingerprint: plan.comparatorConfigurationFingerprint,
      workflowFactChecklistFingerprint: plan.workflowFactChecklistFingerprint,
      acceptanceChecks: plan.acceptanceChecks,
      operatorScope: plan.operatorScope,
      repositoryTargets: plan.repositoryTargets,
      tasks: plan.tasks,
      pluginFixtures: plan.pluginFixtures,
      updateCandidates: plan.updateCandidates,
      pairedTaskIds: plan.pairedTaskIds,
      interruptionTasks: plan.interruptionTasks,
    };
    validatePilotPlanBody(body, context);
    if (pilotFingerprint(body) !== plan.planFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["planFingerprint"],
        message: "pilot execution plan fingerprint does not match its frozen body",
      });
    }
  });
export type PilotExecutionPlan = z.infer<typeof pilotExecutionPlanSchema>;

export const pilotPreflightReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-preflight.v1"),
    status: z.enum(["READY", "BLOCKED"]),
    planFingerprint: fingerprintSchema.nullable(),
    reasons: z.array(pilotPreflightReasonSchema).min(1),
  })
  .superRefine((receipt, context) => {
    if ((receipt.status === "READY") !== (receipt.planFingerprint !== null)) {
      context.addIssue({
        code: "custom",
        path: ["planFingerprint"],
        message:
          "READY preflight receipts require a fingerprint and BLOCKED receipts cannot carry one",
      });
    }
  });
export type PilotPreflightReceipt = z.infer<typeof pilotPreflightReceiptSchema>;

export const pilotTaskOracleV6Schema = z.strictObject({
  taskId: stableIdSchema,
  repositoryFingerprint: fingerprintSchema,
  targetReferenceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  mode: pilotModeSchema,
  expectedOutcome: pilotOutcomeSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
  acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
});
export type PilotTaskOracleV6 = z.infer<typeof pilotTaskOracleV6Schema>;

export const pilotTaskResultV6Schema = z
  .strictObject({
    taskId: stableIdSchema,
    repositoryFingerprint: fingerprintSchema,
    targetReferenceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    mode: pilotModeSchema,
    acceptanceCheckIds: z.array(stableIdSchema).min(1),
    acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
    terminalOutcome: pilotOutcomeSchema,
    oracleOutcome: pilotOutcomeSchema,
    correct: z.boolean(),
    sourcePreserved: z.boolean(),
    rawSecretLeakage: z.boolean(),
    providerSendAcknowledged: z.boolean(),
    providerRequestCount: nonnegativeIntegerSchema,
    providerTokenCount: nonnegativeIntegerSchema,
    providerCostMinor: nonnegativeIntegerSchema,
    applicableFactCount: z.number().int().positive(),
    capturedFactCount: nonnegativeIntegerSchema,
    manualInterventions: nonnegativeIntegerSchema,
    hunterOverheadMinutes: nonnegativeNumberSchema,
    rawPiCapturedFactCount: nonnegativeIntegerSchema,
    rawPiManualInterventions: nonnegativeIntegerSchema,
  })
  .superRefine((result, context) => {
    if (result.capturedFactCount > result.applicableFactCount) {
      context.addIssue({
        code: "custom",
        path: ["capturedFactCount"],
        message: "captured workflow facts cannot exceed applicable facts",
      });
    }
    if (result.correct !== (result.terminalOutcome === result.oracleOutcome)) {
      context.addIssue({
        code: "custom",
        path: ["correct"],
        message: "correct must be derived from terminalOutcome and oracleOutcome",
      });
    }
    if (result.providerSendAcknowledged !== result.providerRequestCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["providerRequestCount"],
        message: "Provider send acknowledgement must match the observed request count",
      });
    }
  });
export type PilotTaskResultV6 = z.infer<typeof pilotTaskResultV6Schema>;

export const pilotRunArchiveReceiptV6Schema = z.strictObject({
  runId: stableIdSchema,
  taskId: stableIdSchema,
  replacementOfRunId: stableIdSchema.nullable(),
  archiveId: stableIdSchema,
  archiveFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  terminalOutcome: pilotOutcomeSchema,
  providerRequestCount: nonnegativeIntegerSchema,
  providerTokenCount: nonnegativeIntegerSchema,
  providerCostMinor: nonnegativeIntegerSchema,
});
export type PilotRunArchiveReceiptV6 = z.infer<typeof pilotRunArchiveReceiptV6Schema>;

export const pilotInstallationSchema = z.strictObject({
  status: z.literal("PASS"),
  sourceFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  cleanProfileFingerprint: fingerprintSchema,
});
export type PilotInstallation = z.infer<typeof pilotInstallationSchema>;

export const pilotInterruptionV6Schema = z.strictObject({
  interruptionId: stableIdSchema,
  taskId: stableIdSchema,
  kind: z.enum(["FORCED_PROCESS_KILL", "TERMINAL_CLOSE", "POWER_INTERRUPTION"]),
  interruptedRunId: stableIdSchema,
  replacementRunId: stableIdSchema,
  replacementArchiveFingerprint: fingerprintSchema,
  historyPreserved: z.boolean(),
  sourcePreserved: z.boolean(),
  resumeOutcome: pilotOutcomeSchema,
  actionableWithinFiveMinutes: z.boolean(),
});
export type PilotInterruptionV6 = z.infer<typeof pilotInterruptionV6Schema>;

export const pilotUpdateRollbackCycleSchema = z.strictObject({
  cycleId: stableIdSchema,
  candidateId: stableIdSchema,
  artifactFingerprint: fingerprintSchema,
  qualificationFingerprint: fingerprintSchema,
  applyOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  rollbackOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  statePreserved: z.boolean(),
  usableKnownGood: z.boolean(),
});
export type PilotUpdateRollbackCycle = z.infer<typeof pilotUpdateRollbackCycleSchema>;

export const pilotPluginFixtureSchema = z.strictObject({
  fixtureId: pilotPlanPluginFixtureIdSchema,
  definitionFingerprint: fingerprintSchema,
  safeMode: z.boolean(),
  userCodeEvaluated: z.boolean(),
});
export type PilotPluginFixture = z.infer<typeof pilotPluginFixtureSchema>;

export const pilotComparatorV6Schema = z
  .strictObject({
    taskId: stableIdSchema,
    repositoryFingerprint: fingerprintSchema,
    targetReferenceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    mode: pilotModeSchema,
    acceptanceCheckIds: z.array(stableIdSchema).min(1),
    acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
    applicableFactCount: z.number().int().positive(),
    rawPiCapturedFactCount: nonnegativeIntegerSchema,
    hunterCapturedFactCount: nonnegativeIntegerSchema,
    rawPiManualInterventions: nonnegativeIntegerSchema,
    hunterManualInterventions: nonnegativeIntegerSchema,
    hunterAdditionalOverheadMinutes: nonnegativeNumberSchema,
    containedFalseCompletion: z.boolean(),
    rawPiProviderRequestCount: positiveIntegerSchema,
    rawPiProviderTokenCount: nonnegativeIntegerSchema,
    rawPiProviderCostMinor: nonnegativeIntegerSchema,
  })
  .superRefine((comparator, context) => {
    if (comparator.rawPiCapturedFactCount > comparator.applicableFactCount) {
      context.addIssue({
        code: "custom",
        path: ["rawPiCapturedFactCount"],
        message: "raw Pi captured facts cannot exceed applicable facts",
      });
    }
    if (comparator.hunterCapturedFactCount > comparator.applicableFactCount) {
      context.addIssue({
        code: "custom",
        path: ["hunterCapturedFactCount"],
        message: "Hunter captured facts cannot exceed applicable facts",
      });
    }
  });
export type PilotComparatorV6 = z.infer<typeof pilotComparatorV6Schema>;

export const pilotCiStatusSchema = z.enum(["PASS", "FAIL", "PENDING"]);
export const pilotCiReceiptSchema = z.strictObject({
  platform: z.enum(["WINDOWS", "UBUNTU"]),
  status: pilotCiStatusSchema,
  sourceFingerprint: fingerprintSchema,
  runFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
});
export type PilotCiReceipt = z.infer<typeof pilotCiReceiptSchema>;

export const pilotEvidenceV6Schema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-evidence.v6"),
    captureProvenance: pilotCaptureProvenanceSchema,
    planFingerprint: fingerprintSchema,
    operatorScope: pilotOperatorScopeSchema,
    machine: pilotMachineProfileSchema,
    installation: pilotInstallationSchema,
    taskOracles: z.array(pilotTaskOracleV6Schema).length(10),
    taskResults: z.array(pilotTaskResultV6Schema).length(10),
    runArchives: z.array(pilotRunArchiveReceiptV6Schema).min(10).max(100),
    interruptions: z.array(pilotInterruptionV6Schema).length(3),
    discardedWarmups: z.literal(5),
    warmStartSamplesMs: z.array(nonnegativeNumberSchema).min(20),
    acknowledgementSamplesMs: z.array(nonnegativeNumberSchema).min(30),
    updateRollbackCycles: z.array(pilotUpdateRollbackCycleSchema).length(2),
    pluginFixtures: z.array(pilotPluginFixtureSchema).length(5),
    memorySamplesMiB: z.array(nonnegativeNumberSchema).min(30),
    storageGate: z.boolean(),
    manualStateEditingRequired: z.boolean(),
    privacyGate: z.boolean(),
    providerLatencySeparated: z.boolean(),
    reviewP0P1Count: nonnegativeIntegerSchema,
    ci: z.strictObject({
      sourceFingerprint: fingerprintSchema,
      windows: pilotCiReceiptSchema,
      ubuntu: pilotCiReceiptSchema,
    }),
    pairedComparators: z.array(pilotComparatorV6Schema).length(3),
    observedAt: timestampSchema,
  })
  .superRefine((evidence, context) => {
    const oracleIds = evidence.taskOracles.map((oracle) => oracle.taskId);
    const resultIds = evidence.taskResults.map((result) => result.taskId);
    const comparatorIds = evidence.pairedComparators.map((comparator) => comparator.taskId);
    if (new Set(oracleIds).size !== oracleIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskOracles"],
        message: "task oracle identities must be unique",
      });
    }
    if (new Set(resultIds).size !== resultIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskResults"],
        message: "task result identities must be unique",
      });
    }
    if (new Set(comparatorIds).size !== comparatorIds.length) {
      context.addIssue({
        code: "custom",
        path: ["pairedComparators"],
        message: "paired comparator identities must be unique",
      });
    }
    if (
      new Set(evidence.interruptions.map((item) => item.interruptionId)).size !==
      evidence.interruptions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["interruptions"],
        message: "interruption identities must be unique",
      });
    }
    if (
      new Set(evidence.interruptions.map((item) => item.interruptedRunId)).size !==
      evidence.interruptions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["interruptions"],
        message: "interruption predecessor Run identities must be unique",
      });
    }
    if (
      new Set(evidence.interruptions.map((item) => item.replacementRunId)).size !==
      evidence.interruptions.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["interruptions"],
        message: "interruption replacement Run identities must be unique",
      });
    }
    if (
      new Set(evidence.updateRollbackCycles.map((item) => item.cycleId)).size !==
      evidence.updateRollbackCycles.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["updateRollbackCycles"],
        message: "update rollback cycle identities must be unique",
      });
    }
    if (
      new Set(evidence.updateRollbackCycles.map((item) => item.candidateId)).size !==
      evidence.updateRollbackCycles.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["updateRollbackCycles"],
        message: "update rollback candidate identities must be unique",
      });
    }
    if (
      new Set(evidence.pluginFixtures.map((item) => item.fixtureId)).size !==
      evidence.pluginFixtures.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pluginFixtures"],
        message: "Plugin fixture identities must be unique",
      });
    }
    const oracleById = new Map(evidence.taskOracles.map((oracle) => [oracle.taskId, oracle]));
    const resultByTaskId = new Map(evidence.taskResults.map((result) => [result.taskId, result]));
    const runById = new Map(evidence.runArchives.map((run) => [run.runId, run]));
    if (runById.size !== evidence.runArchives.length) {
      context.addIssue({
        code: "custom",
        path: ["runArchives"],
        message: "linked Run Archive identities must be unique",
      });
    }
    if (
      new Set(evidence.runArchives.map((run) => run.archiveId)).size !== evidence.runArchives.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["runArchives"],
        message: "linked Run Archive identities must be unique",
      });
    }
    for (const run of evidence.runArchives) {
      const oracle = oracleById.get(run.taskId);
      const predecessor =
        run.replacementOfRunId === null ? undefined : runById.get(run.replacementOfRunId);
      const predecessorMatches =
        run.replacementOfRunId === null ||
        (predecessor?.taskId === run.taskId && predecessor.runId !== run.runId);
      if (run.sourceFingerprint !== oracle?.sourceFingerprint || !predecessorMatches) {
        context.addIssue({
          code: "custom",
          path: ["runArchives"],
          message: "linked Run Archive receipts must bind frozen task/source identities",
        });
      }
    }
    for (const result of evidence.taskResults) {
      const chain = evidence.runArchives.filter((run) => run.taskId === result.taskId);
      const rootRuns = chain.filter((run) => run.replacementOfRunId === null);
      const childIds = new Set(
        chain.flatMap((run) => (run.replacementOfRunId === null ? [] : [run.replacementOfRunId])),
      );
      const childByParentId = new Map(
        chain.flatMap((run) =>
          run.replacementOfRunId === null ? [] : [[run.replacementOfRunId, run] as const],
        ),
      );
      const reachableRunIds = new Set<string>();
      let reachableRun = rootRuns[0];
      while (reachableRun !== undefined && !reachableRunIds.has(reachableRun.runId)) {
        reachableRunIds.add(reachableRun.runId);
        reachableRun = childByParentId.get(reachableRun.runId);
      }
      const terminalRuns = chain.filter(
        (run) => !chain.some((candidate) => candidate.replacementOfRunId === run.runId),
      );
      const requestCount = chain.reduce((total, run) => total + run.providerRequestCount, 0);
      const tokenCount = chain.reduce((total, run) => total + run.providerTokenCount, 0);
      const costMinor = chain.reduce((total, run) => total + run.providerCostMinor, 0);
      if (
        chain.length === 0 ||
        rootRuns.length !== 1 ||
        reachableRunIds.size !== chain.length ||
        childIds.size !== chain.filter((run) => run.replacementOfRunId !== null).length ||
        terminalRuns.length !== 1 ||
        terminalRuns[0]?.terminalOutcome !== result.terminalOutcome ||
        requestCount !== result.providerRequestCount ||
        tokenCount !== result.providerTokenCount ||
        costMinor !== result.providerCostMinor
      ) {
        context.addIssue({
          code: "custom",
          path: ["runArchives"],
          message: "task Results must aggregate the exact linked Run Archive chain",
        });
      }
    }
    for (const interruption of evidence.interruptions) {
      const interruptedRun = runById.get(interruption.interruptedRunId);
      const replacementRun = runById.get(interruption.replacementRunId);
      if (
        resultByTaskId.get(interruption.taskId) === undefined ||
        interruptedRun?.taskId !== interruption.taskId ||
        (interruptedRun.terminalOutcome !== "INCOMPLETE" &&
          interruptedRun.terminalOutcome !== "CANCELLED") ||
        replacementRun?.taskId !== interruption.taskId ||
        replacementRun.replacementOfRunId !== interruption.interruptedRunId ||
        replacementRun.archiveFingerprint !== interruption.replacementArchiveFingerprint ||
        replacementRun.terminalOutcome !== interruption.resumeOutcome
      ) {
        context.addIssue({
          code: "custom",
          path: ["interruptions"],
          message: "forced interruptions must bind an exact linked replacement Run Archive",
        });
      }
    }
    if (
      evidence.taskResults.some((result) => {
        const oracle = oracleById.get(result.taskId);
        if (oracle === undefined) return true;
        return (
          result.repositoryFingerprint !== oracle.repositoryFingerprint ||
          result.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
          result.sourceFingerprint !== oracle.sourceFingerprint ||
          result.mode !== oracle.mode ||
          result.oracleOutcome !== oracle.expectedOutcome ||
          JSON.stringify(result.acceptanceCheckIds) !== JSON.stringify(oracle.acceptanceCheckIds) ||
          JSON.stringify(result.acceptanceCheckDefinitionFingerprints) !==
            JSON.stringify(oracle.acceptanceCheckDefinitionFingerprints)
        );
      }) ||
      oracleIds.some((taskId) => !resultIds.includes(taskId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["taskResults"],
        message: "task results must bind the exact frozen oracle set",
      });
    }
    if (
      evidence.pairedComparators.some((comparator) => {
        const oracle = oracleById.get(comparator.taskId);
        if (oracle === undefined) return true;
        return (
          comparator.repositoryFingerprint !== oracle.repositoryFingerprint ||
          comparator.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
          comparator.sourceFingerprint !== oracle.sourceFingerprint ||
          comparator.mode !== oracle.mode ||
          JSON.stringify(comparator.acceptanceCheckIds) !==
            JSON.stringify(oracle.acceptanceCheckIds) ||
          JSON.stringify(comparator.acceptanceCheckDefinitionFingerprints) !==
            JSON.stringify(oracle.acceptanceCheckDefinitionFingerprints) ||
          (() => {
            const result = evidence.taskResults.find(
              (candidate) => candidate.taskId === comparator.taskId,
            );
            if (result === undefined) return true;
            return (
              result.repositoryFingerprint !== comparator.repositoryFingerprint ||
              result.targetReferenceFingerprint !== comparator.targetReferenceFingerprint ||
              result.sourceFingerprint !== comparator.sourceFingerprint ||
              result.mode !== comparator.mode ||
              JSON.stringify(result.acceptanceCheckIds) !==
                JSON.stringify(comparator.acceptanceCheckIds) ||
              JSON.stringify(result.acceptanceCheckDefinitionFingerprints) !==
                JSON.stringify(comparator.acceptanceCheckDefinitionFingerprints) ||
              result.applicableFactCount !== comparator.applicableFactCount ||
              result.capturedFactCount !== comparator.hunterCapturedFactCount ||
              result.manualInterventions !== comparator.hunterManualInterventions ||
              result.hunterOverheadMinutes !== comparator.hunterAdditionalOverheadMinutes ||
              result.rawPiCapturedFactCount !== comparator.rawPiCapturedFactCount ||
              result.rawPiManualInterventions !== comparator.rawPiManualInterventions
            );
          })()
        );
      }) ||
      new Set(comparatorIds).size !== 3
    ) {
      context.addIssue({
        code: "custom",
        path: ["pairedComparators"],
        message:
          "comparators must bind three distinct frozen task oracles with exact repository, source, mode, and acceptance identities",
      });
    }
    if (new Set(evidence.taskOracles.map((oracle) => oracle.repositoryFingerprint)).size < 2) {
      context.addIssue({
        code: "custom",
        path: ["taskOracles"],
        message: "the pilot must cover at least two distinct repository identities",
      });
    }
    if (
      evidence.installation.sourceFingerprint !== evidence.machine.sourceFingerprint ||
      evidence.installation.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint
    ) {
      context.addIssue({
        code: "custom",
        path: ["installation"],
        message: "fresh-install Evidence must bind the exact tested source and release artifact",
      });
    }
    if (
      evidence.ci.sourceFingerprint !== evidence.machine.sourceFingerprint ||
      evidence.ci.windows.sourceFingerprint !== evidence.ci.sourceFingerprint ||
      evidence.ci.ubuntu.sourceFingerprint !== evidence.ci.sourceFingerprint ||
      evidence.ci.windows.platform !== "WINDOWS" ||
      evidence.ci.ubuntu.platform !== "UBUNTU" ||
      evidence.ci.windows.runFingerprint === evidence.ci.ubuntu.runFingerprint ||
      evidence.ci.windows.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint ||
      evidence.ci.ubuntu.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint ||
      evidence.ci.windows.engineReleaseFingerprint !== evidence.machine.engineReleaseFingerprint ||
      evidence.ci.ubuntu.engineReleaseFingerprint !== evidence.machine.engineReleaseFingerprint
    ) {
      context.addIssue({
        code: "custom",
        path: ["ci"],
        message: "Windows and Ubuntu CI Evidence must bind the exact tested source",
      });
    }
  });
export type PilotEvidenceV6 = z.infer<typeof pilotEvidenceV6Schema>;

const pilotResolvedTaskBindingShape = {
  taskId: stableIdSchema,
  repositoryFingerprint: fingerprintSchema,
  targetReferenceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  taskDefinitionFingerprint: fingerprintSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
  acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
} as const;

const pilotProviderUsageShape = {
  providerSendAcknowledged: z.boolean(),
  providerRequestCount: nonnegativeIntegerSchema,
  providerTokenCount: nonnegativeIntegerSchema,
  providerCostMinor: nonnegativeIntegerSchema,
} as const;

const pilotHunterTaskMeasurementShape = {
  sourcePreserved: z.boolean(),
  rawSecretLeakage: z.boolean(),
  applicableFactCount: z.number().int().positive(),
  capturedFactCount: nonnegativeIntegerSchema,
  manualInterventions: nonnegativeIntegerSchema,
  hunterOverheadMinutes: nonnegativeNumberSchema,
} as const;

const pilotTaskMeasurementShape = {
  ...pilotHunterTaskMeasurementShape,
  rawPiCapturedFactCount: nonnegativeIntegerSchema,
  rawPiManualInterventions: nonnegativeIntegerSchema,
} as const;

export const pilotTaskOracleSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...pilotResolvedTaskBindingShape,
    mode: z.literal("QUICK"),
    expectedExecutionObservation: z.literal("RETURNED"),
    expectedAcceptanceObservation: z.literal("PASS"),
  }),
  z.strictObject({
    ...pilotResolvedTaskBindingShape,
    mode: z.literal("MANAGED"),
    expectedOutcome: pilotOutcomeSchema,
  }),
]);
export type PilotTaskOracle = z.infer<typeof pilotTaskOracleSchema>;

export const pilotTaskResultSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({
      ...pilotResolvedTaskBindingShape,
      ...pilotProviderUsageShape,
      ...pilotTaskMeasurementShape,
      mode: z.literal("QUICK"),
      quickReceiptId: stableIdSchema,
      executionObservation: pilotQuickExecutionObservationSchema,
      oracleExecutionObservation: pilotQuickExecutionObservationSchema,
      acceptanceObservation: pilotQuickAcceptanceObservationSchema,
      oracleAcceptanceObservation: pilotQuickAcceptanceObservationSchema,
      verifiedChangeClaimed: z.literal(false),
      correct: z.boolean(),
    }),
    z.strictObject({
      ...pilotResolvedTaskBindingShape,
      ...pilotProviderUsageShape,
      ...pilotTaskMeasurementShape,
      mode: z.literal("MANAGED"),
      terminalOutcome: pilotOutcomeSchema,
      oracleOutcome: pilotOutcomeSchema,
      correct: z.boolean(),
    }),
  ])
  .superRefine((result, context) => {
    if (result.capturedFactCount > result.applicableFactCount) {
      context.addIssue({
        code: "custom",
        path: ["capturedFactCount"],
        message: "captured workflow facts cannot exceed applicable facts",
      });
    }
    if (result.providerSendAcknowledged !== result.providerRequestCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["providerRequestCount"],
        message: "Provider send acknowledgement must match the observed request count",
      });
    }
    const correct =
      result.mode === "QUICK"
        ? result.executionObservation === result.oracleExecutionObservation &&
          result.acceptanceObservation === result.oracleAcceptanceObservation
        : result.terminalOutcome === result.oracleOutcome;
    if (result.correct !== correct) {
      context.addIssue({
        code: "custom",
        path: ["correct"],
        message: "task correctness must be derived from the frozen mode-specific oracle",
      });
    }
  });
export type PilotTaskResult = z.infer<typeof pilotTaskResultSchema>;

export const pilotQuickTaskReceiptSchema = z
  .strictObject({
    receiptId: stableIdSchema,
    ...pilotResolvedTaskBindingShape,
    ...pilotProviderUsageShape,
    ...pilotHunterTaskMeasurementShape,
    mode: z.literal("QUICK"),
    executionObservation: pilotQuickExecutionObservationSchema,
    acceptanceObservation: pilotQuickAcceptanceObservationSchema,
    verifiedChangeClaimed: z.literal(false),
    processReceiptFingerprint: fingerprintSchema,
    acceptanceReceiptFingerprint: fingerprintSchema,
    runtimeConfigurationFingerprint: fingerprintSchema,
    processFinality: z.literal("FINAL"),
    processTreeState: z.literal("EMPTY"),
    outputState: z.literal("CLOSED"),
    leaseState: z.literal("RELEASED"),
  })
  .superRefine((receipt, context) => {
    if (receipt.capturedFactCount > receipt.applicableFactCount) {
      context.addIssue({
        code: "custom",
        path: ["capturedFactCount"],
        message: "captured workflow facts cannot exceed applicable facts",
      });
    }
    if (receipt.providerSendAcknowledged !== receipt.providerRequestCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["providerRequestCount"],
        message: "Quick Provider send acknowledgement must match exact observed usage",
      });
    }
  });
export type PilotQuickTaskReceipt = z.infer<typeof pilotQuickTaskReceiptSchema>;

export const pilotRunRecoveryLinkSchema = z.strictObject({
  interruptionId: stableIdSchema,
  kind: pilotPlanInterruptionTaskSchema.shape.kind,
  checkpointId: stableIdSchema,
  interruptedAttemptId: stableIdSchema,
  recoveryAttemptId: stableIdSchema,
  actionableWithinFiveMinutes: z.boolean(),
});
export type PilotRunRecoveryLink = z.infer<typeof pilotRunRecoveryLinkSchema>;

export const pilotRunArchiveReceiptSchema = z.strictObject({
  runId: stableIdSchema,
  taskId: stableIdSchema,
  archiveId: stableIdSchema,
  archiveFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  terminalOutcome: pilotOutcomeSchema,
  providerRequestCount: nonnegativeIntegerSchema,
  providerTokenCount: nonnegativeIntegerSchema,
  providerCostMinor: nonnegativeIntegerSchema,
  recoveryLinks: z.array(pilotRunRecoveryLinkSchema).max(3),
});
export type PilotRunArchiveReceipt = z.infer<typeof pilotRunArchiveReceiptSchema>;

export const pilotInterruptionSchema = z.strictObject({
  interruptionId: stableIdSchema,
  taskId: stableIdSchema,
  kind: pilotPlanInterruptionTaskSchema.shape.kind,
  runId: stableIdSchema,
  archiveFingerprint: fingerprintSchema,
  checkpointId: stableIdSchema,
  interruptedAttemptId: stableIdSchema,
  recoveryAttemptId: stableIdSchema,
  historyPreserved: z.boolean(),
  sourcePreserved: z.boolean(),
  resumeOutcome: pilotOutcomeSchema,
  actionableWithinFiveMinutes: z.boolean(),
});
export type PilotInterruption = z.infer<typeof pilotInterruptionSchema>;

export const pilotComparatorSchema = z
  .strictObject({
    ...pilotResolvedTaskBindingShape,
    mode: pilotModeSchema,
    comparatorConfigurationFingerprint: fingerprintSchema,
    workflowFactChecklistFingerprint: fingerprintSchema,
    processReceiptFingerprint: fingerprintSchema,
    acceptanceReceiptFingerprint: fingerprintSchema,
    executionObservation: pilotQuickExecutionObservationSchema,
    acceptanceObservation: pilotQuickAcceptanceObservationSchema,
    processFinality: z.literal("FINAL"),
    processTreeState: z.literal("EMPTY"),
    outputState: z.literal("CLOSED"),
    leaseState: z.literal("RELEASED"),
    coreExtensionCount: z.literal(0),
    applicableFactCount: z.number().int().positive(),
    rawPiCapturedFactCount: nonnegativeIntegerSchema,
    hunterCapturedFactCount: nonnegativeIntegerSchema,
    rawPiManualInterventions: nonnegativeIntegerSchema,
    hunterManualInterventions: nonnegativeIntegerSchema,
    hunterAdditionalOverheadMinutes: nonnegativeNumberSchema,
    containedFalseCompletion: z.boolean(),
    rawPiProviderRequestCount: positiveIntegerSchema,
    rawPiProviderTokenCount: nonnegativeIntegerSchema,
    rawPiProviderCostMinor: nonnegativeIntegerSchema,
  })
  .superRefine((comparator, context) => {
    if (
      comparator.rawPiCapturedFactCount > comparator.applicableFactCount ||
      comparator.hunterCapturedFactCount > comparator.applicableFactCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["applicableFactCount"],
        message: "paired captured facts cannot exceed applicable facts",
      });
    }
  });
export type PilotComparator = z.infer<typeof pilotComparatorSchema>;

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameResolvedTaskBinding(
  left: z.infer<typeof pilotTaskOracleSchema>,
  right:
    | z.infer<typeof pilotTaskResultSchema>
    | z.infer<typeof pilotQuickTaskReceiptSchema>
    | z.infer<typeof pilotComparatorSchema>,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.repositoryFingerprint === right.repositoryFingerprint &&
    left.targetReferenceFingerprint === right.targetReferenceFingerprint &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.taskDefinitionFingerprint === right.taskDefinitionFingerprint &&
    left.mode === right.mode &&
    sameStringArray(left.acceptanceCheckIds, right.acceptanceCheckIds) &&
    sameStringArray(
      left.acceptanceCheckDefinitionFingerprints,
      right.acceptanceCheckDefinitionFingerprints,
    )
  );
}

export const pilotEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-evidence.v7"),
    captureProvenance: pilotCaptureProvenanceSchema,
    planFingerprint: fingerprintSchema,
    operatorScope: pilotOperatorScopeSchema,
    machine: pilotMachineProfileSchema,
    installation: pilotInstallationSchema,
    taskOracles: z.array(pilotTaskOracleSchema).length(10),
    taskResults: z.array(pilotTaskResultSchema).length(10),
    quickTaskReceipts: z.array(pilotQuickTaskReceiptSchema).max(10),
    runArchives: z.array(pilotRunArchiveReceiptSchema).max(100),
    interruptions: z.array(pilotInterruptionSchema).length(3),
    discardedWarmups: z.literal(5),
    warmStartSamplesMs: z.array(nonnegativeNumberSchema).min(20),
    acknowledgementSamplesMs: z.array(nonnegativeNumberSchema).min(30),
    updateRollbackCycles: z.array(pilotUpdateRollbackCycleSchema).length(2),
    pluginFixtures: z.array(pilotPluginFixtureSchema).length(5),
    memorySamplesMiB: z.array(nonnegativeNumberSchema).min(30),
    storageGate: z.boolean(),
    manualStateEditingRequired: z.boolean(),
    privacyGate: z.boolean(),
    providerLatencySeparated: z.boolean(),
    reviewP0P1Count: nonnegativeIntegerSchema,
    ci: z.strictObject({
      sourceFingerprint: fingerprintSchema,
      windows: pilotCiReceiptSchema,
      ubuntu: pilotCiReceiptSchema,
    }),
    pairedComparators: z.array(pilotComparatorSchema).length(3),
    observedAt: timestampSchema,
  })
  .superRefine((evidence, context) => {
    const addIdentityIssue = (path: string, message: string): void => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    const oracleById = new Map(evidence.taskOracles.map((item) => [item.taskId, item]));
    const resultById = new Map(evidence.taskResults.map((item) => [item.taskId, item]));
    const quickByTaskId = new Map(evidence.quickTaskReceipts.map((item) => [item.taskId, item]));
    const runByTaskId = new Map(evidence.runArchives.map((item) => [item.taskId, item]));
    const runById = new Map(evidence.runArchives.map((item) => [item.runId, item]));
    const comparatorByTaskId = new Map(
      evidence.pairedComparators.map((item) => [item.taskId, item]),
    );
    if (oracleById.size !== evidence.taskOracles.length) {
      addIdentityIssue("taskOracles", "task oracle identities must be unique");
    }
    if (resultById.size !== evidence.taskResults.length) {
      addIdentityIssue("taskResults", "task result identities must be unique");
    }
    if (
      quickByTaskId.size !== evidence.quickTaskReceipts.length ||
      new Set(evidence.quickTaskReceipts.map((item) => item.receiptId)).size !==
        evidence.quickTaskReceipts.length
    ) {
      addIdentityIssue("quickTaskReceipts", "Quick receipt identities must be unique");
    }
    if (
      runByTaskId.size !== evidence.runArchives.length ||
      runById.size !== evidence.runArchives.length ||
      new Set(evidence.runArchives.map((item) => item.archiveId)).size !==
        evidence.runArchives.length
    ) {
      addIdentityIssue("runArchives", "Managed Run Archive identities must be unique per task");
    }
    if (comparatorByTaskId.size !== evidence.pairedComparators.length) {
      addIdentityIssue("pairedComparators", "comparator task identities must be unique");
    }

    for (const oracle of evidence.taskOracles) {
      const result = resultById.get(oracle.taskId);
      if (result === undefined || !sameResolvedTaskBinding(oracle, result)) {
        addIdentityIssue("taskResults", "task results must bind the exact frozen oracle set");
        continue;
      }
      if (oracle.mode === "QUICK") {
        const receipt = quickByTaskId.get(oracle.taskId);
        if (
          result.mode !== "QUICK" ||
          receipt === undefined ||
          !sameResolvedTaskBinding(oracle, receipt) ||
          result.quickReceiptId !== receipt.receiptId ||
          result.oracleExecutionObservation !== oracle.expectedExecutionObservation ||
          result.oracleAcceptanceObservation !== oracle.expectedAcceptanceObservation ||
          result.executionObservation !== receipt.executionObservation ||
          result.acceptanceObservation !== receipt.acceptanceObservation ||
          result.providerRequestCount !== receipt.providerRequestCount ||
          result.providerTokenCount !== receipt.providerTokenCount ||
          result.providerCostMinor !== receipt.providerCostMinor ||
          result.sourcePreserved !== receipt.sourcePreserved ||
          result.rawSecretLeakage !== receipt.rawSecretLeakage ||
          result.applicableFactCount !== receipt.applicableFactCount ||
          result.capturedFactCount !== receipt.capturedFactCount ||
          result.manualInterventions !== receipt.manualInterventions ||
          result.hunterOverheadMinutes !== receipt.hunterOverheadMinutes ||
          runByTaskId.has(oracle.taskId)
        ) {
          addIdentityIssue(
            "quickTaskReceipts",
            "Quick results must derive from one exact non-Run product receipt",
          );
        }
      } else {
        const run = runByTaskId.get(oracle.taskId);
        if (
          result.mode !== "MANAGED" ||
          run === undefined ||
          quickByTaskId.has(oracle.taskId) ||
          result.oracleOutcome !== oracle.expectedOutcome ||
          run.sourceFingerprint !== oracle.sourceFingerprint ||
          run.terminalOutcome !== result.terminalOutcome ||
          run.providerRequestCount !== result.providerRequestCount ||
          run.providerTokenCount !== result.providerTokenCount ||
          run.providerCostMinor !== result.providerCostMinor
        ) {
          addIdentityIssue(
            "runArchives",
            "Managed results must derive from one exact canonical Run Archive",
          );
        }
      }
    }

    if (
      quickByTaskId.size !== evidence.taskOracles.filter((item) => item.mode === "QUICK").length ||
      runByTaskId.size !== evidence.taskOracles.filter((item) => item.mode === "MANAGED").length
    ) {
      addIdentityIssue(
        "taskResults",
        "every frozen task requires exactly one mode-appropriate product receipt",
      );
    }

    const interruptionIds = evidence.interruptions.map((item) => item.interruptionId);
    const interruptionKinds = evidence.interruptions.map((item) => item.kind);
    if (
      new Set(interruptionIds).size !== 3 ||
      new Set(interruptionKinds).size !== 3 ||
      evidence.interruptions.some((item) => {
        const oracle = oracleById.get(item.taskId);
        const run = runById.get(item.runId);
        const link = run?.recoveryLinks.find(
          (candidate) => candidate.interruptionId === item.interruptionId,
        );
        return (
          oracle?.mode !== "MANAGED" ||
          run?.taskId !== item.taskId ||
          run.archiveFingerprint !== item.archiveFingerprint ||
          run.terminalOutcome !== item.resumeOutcome ||
          link?.checkpointId !== item.checkpointId ||
          link.kind !== item.kind ||
          link.interruptedAttemptId !== item.interruptedAttemptId ||
          link.recoveryAttemptId !== item.recoveryAttemptId ||
          link.actionableWithinFiveMinutes !== item.actionableWithinFiveMinutes
        );
      })
    ) {
      addIdentityIssue(
        "interruptions",
        "interruptions must bind three exact same-Run Checkpoint recovery links",
      );
    }

    for (const comparator of evidence.pairedComparators) {
      const oracle = oracleById.get(comparator.taskId);
      const result = resultById.get(comparator.taskId);
      if (
        oracle === undefined ||
        result === undefined ||
        !sameResolvedTaskBinding(oracle, comparator) ||
        comparator.applicableFactCount !== result.applicableFactCount ||
        comparator.rawPiCapturedFactCount !== result.rawPiCapturedFactCount ||
        comparator.hunterCapturedFactCount !== result.capturedFactCount ||
        comparator.rawPiManualInterventions !== result.rawPiManualInterventions ||
        comparator.hunterManualInterventions !== result.manualInterventions ||
        comparator.hunterAdditionalOverheadMinutes !== result.hunterOverheadMinutes
      ) {
        addIdentityIssue(
          "pairedComparators",
          "raw Pi comparators must bind the exact frozen task and Hunter result",
        );
      }
    }

    if (new Set(evidence.taskOracles.map((item) => item.repositoryFingerprint)).size < 2) {
      addIdentityIssue("taskOracles", "the pilot must cover at least two distinct repositories");
    }
    if (
      evidence.installation.sourceFingerprint !== evidence.machine.sourceFingerprint ||
      evidence.installation.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint
    ) {
      addIdentityIssue(
        "installation",
        "fresh-install Evidence must bind the exact tested source and release artifact",
      );
    }
    if (
      evidence.ci.sourceFingerprint !== evidence.machine.sourceFingerprint ||
      evidence.ci.windows.sourceFingerprint !== evidence.ci.sourceFingerprint ||
      evidence.ci.ubuntu.sourceFingerprint !== evidence.ci.sourceFingerprint ||
      evidence.ci.windows.platform !== "WINDOWS" ||
      evidence.ci.ubuntu.platform !== "UBUNTU" ||
      evidence.ci.windows.runFingerprint === evidence.ci.ubuntu.runFingerprint ||
      evidence.ci.windows.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint ||
      evidence.ci.ubuntu.artifactFingerprint !== evidence.machine.hunterReleaseFingerprint ||
      evidence.ci.windows.engineReleaseFingerprint !== evidence.machine.engineReleaseFingerprint ||
      evidence.ci.ubuntu.engineReleaseFingerprint !== evidence.machine.engineReleaseFingerprint
    ) {
      addIdentityIssue("ci", "Windows and Ubuntu CI Evidence must bind the exact tested source");
    }
  });
export type PilotEvidence = z.infer<typeof pilotEvidenceSchema>;

export const pilotMetricsSchema = z.strictObject({
  taskCount: z.number().int().nonnegative(),
  correctTaskCount: z.number().int().nonnegative(),
  interruptionCount: z.number().int().nonnegative(),
  resumedInterruptionCount: z.number().int().nonnegative(),
  warmStartP95Ms: nonnegativeNumberSchema,
  acknowledgementP95Ms: nonnegativeNumberSchema,
  memoryP95MiB: nonnegativeNumberSchema,
  comparatorFactScore: z.number().min(0).max(1),
  rawPiManualInterventions: nonnegativeIntegerSchema,
  hunterManualInterventions: nonnegativeIntegerSchema,
  manualInterventionReductionRatio: z.number(),
  hunterAdditionalOverheadMedianMinutes: nonnegativeNumberSchema,
});
export type PilotMetrics = z.infer<typeof pilotMetricsSchema>;

export const pilotDecisionSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-decision.v2"),
  evidenceFingerprint: fingerprintSchema,
  outcome: z.enum(["GO", "REVISE", "STOP", "NOT_PROVEN"]),
  reasons: z.array(nonEmptyTextSchema).min(1),
  metrics: pilotMetricsSchema,
  observedAt: timestampSchema,
});
export type PilotDecision = z.infer<typeof pilotDecisionSchema>;
