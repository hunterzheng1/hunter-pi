import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";

import { pilotFingerprint } from "./serialization.js";

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
const stableIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "pilot identities must be stable and path-free");
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nonnegativeNumberSchema = z.number().nonnegative();

export const pilotMachineProfileSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-machine.v2"),
  platform: z.literal("win32"),
  architecture: z.literal("x64"),
  osBuild: stableIdSchema,
  cpuModel: nonEmptyTextSchema,
  logicalCores: z.number().int().positive(),
  memoryMiB: z.number().int().positive(),
  storage: z.enum(["SSD", "HDD", "UNKNOWN"]),
  terminal: stableIdSchema,
  gitVersion: nonEmptyTextSchema,
  securitySoftwareState: stableIdSchema,
  powerMode: stableIdSchema,
  networkCondition: stableIdSchema,
  sourceFingerprint: fingerprintSchema,
  hunterReleaseFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
});
export type PilotMachineProfile = z.infer<typeof pilotMachineProfileSchema>;

export const pilotModeSchema = z.enum(["QUICK", "MANAGED"]);
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
  credentialScopeFingerprint: fingerprintSchema.nullable(),
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
  "PILOT_PLAN_FIELDS_INVALID",
  "PILOT_PLAN_SCHEMA_INVALID",
  "PILOT_PLAN_COMPILATION_FAILED",
]);
export type PilotPreflightReason = z.infer<typeof pilotPreflightReasonSchema>;

const pilotPlanBodyShape = {
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
  tasks: z
    .array(
      z.strictObject({
        taskId: stableIdSchema,
        targetId: stableIdSchema,
        sourceFingerprint: fingerprintSchema,
        mode: pilotModeSchema,
        expectedOutcome: pilotOutcomeSchema,
        acceptanceCheckIds: z.array(stableIdSchema).min(1),
      }),
    )
    .length(10),
  pluginFixtures: z.array(pilotPlanPluginFixtureSchema).length(5),
  updateCandidates: z.array(pilotPlanUpdateCandidateSchema).length(2),
  pairedTaskIds: z.array(stableIdSchema).length(3),
} as const;

function validatePilotPlanBody(
  body: z.infer<z.ZodObject<typeof pilotPlanBodyShape>>,
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
      providerScope.credentialScopeFingerprint === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["operatorScope"],
        message: "explicit Provider requests require endpoint and credential scope fingerprints",
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
    providerScope.credentialScopeFingerprint !== null ||
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

type PilotPlanBody = z.infer<z.ZodObject<typeof pilotPlanBodyShape>>;

export const pilotPlanInputSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-plan-input.v1"),
    ...pilotPlanBodyShape,
  })
  .superRefine((input, context) => {
    validatePilotPlanBody(input, context);
  });
export type PilotPlanInput = z.infer<typeof pilotPlanInputSchema>;

export const pilotExecutionPlanSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-execution-plan.v1"),
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

export const pilotTaskOracleSchema = z.strictObject({
  taskId: stableIdSchema,
  repositoryFingerprint: fingerprintSchema,
  targetReferenceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  mode: pilotModeSchema,
  expectedOutcome: pilotOutcomeSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
  acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
});
export type PilotTaskOracle = z.infer<typeof pilotTaskOracleSchema>;

export const pilotTaskResultSchema = z
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
  });
export type PilotTaskResult = z.infer<typeof pilotTaskResultSchema>;

export const pilotInstallationSchema = z.strictObject({
  status: z.literal("PASS"),
  sourceFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  cleanProfileFingerprint: fingerprintSchema,
});
export type PilotInstallation = z.infer<typeof pilotInstallationSchema>;

export const pilotInterruptionSchema = z.strictObject({
  interruptionId: stableIdSchema,
  kind: z.enum(["FORCED_PROCESS_KILL", "TERMINAL_CLOSE", "POWER_INTERRUPTION"]),
  historyPreserved: z.boolean(),
  sourcePreserved: z.boolean(),
  resumeOutcome: pilotOutcomeSchema,
  actionableWithinFiveMinutes: z.boolean(),
});
export type PilotInterruption = z.infer<typeof pilotInterruptionSchema>;

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

export const pilotComparatorSchema = z
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
export type PilotComparator = z.infer<typeof pilotComparatorSchema>;

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

export const pilotEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-evidence.v3"),
    planFingerprint: fingerprintSchema,
    operatorScope: pilotOperatorScopeSchema,
    machine: pilotMachineProfileSchema,
    installation: pilotInstallationSchema,
    taskOracles: z.array(pilotTaskOracleSchema).length(10),
    taskResults: z.array(pilotTaskResultSchema).length(10),
    interruptions: z.array(pilotInterruptionSchema).length(3),
    discardedWarmups: z.literal(5),
    warmStartSamplesMs: z.array(nonnegativeNumberSchema).min(20),
    acknowledgementSamplesMs: z.array(nonnegativeNumberSchema).min(30),
    updateRollbackCycles: z.array(pilotUpdateRollbackCycleSchema).length(2),
    pluginFixtures: z.array(pilotPluginFixtureSchema).length(5),
    memorySamplesMiB: z.array(nonnegativeNumberSchema).min(30),
    storageGate: z.boolean(),
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
