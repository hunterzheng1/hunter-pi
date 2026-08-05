import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";

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

export const pilotTaskOracleSchema = z.strictObject({
  taskId: stableIdSchema,
  repositoryFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  mode: pilotModeSchema,
  expectedOutcome: pilotOutcomeSchema,
  acceptanceCheckIds: z.array(stableIdSchema).min(1),
});
export type PilotTaskOracle = z.infer<typeof pilotTaskOracleSchema>;

export const pilotTaskResultSchema = z
  .strictObject({
    taskId: stableIdSchema,
    repositoryFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    mode: pilotModeSchema,
    acceptanceCheckIds: z.array(stableIdSchema).min(1),
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
  applyOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  rollbackOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  statePreserved: z.boolean(),
  usableKnownGood: z.boolean(),
});
export type PilotUpdateRollbackCycle = z.infer<typeof pilotUpdateRollbackCycleSchema>;

export const pilotPluginFixtureSchema = z.strictObject({
  fixtureId: z.enum([
    "THROWING_INITIALIZATION",
    "RESERVED_COLLISION",
    "BUILTIN_OVERRIDE",
    "SECRET_PATH_LEAKAGE",
    "OVERSIZED_OUTPUT",
  ]),
  safeMode: z.boolean(),
  userCodeEvaluated: z.boolean(),
});
export type PilotPluginFixture = z.infer<typeof pilotPluginFixtureSchema>;

export const pilotComparatorSchema = z
  .strictObject({
    taskId: stableIdSchema,
    repositoryFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    mode: pilotModeSchema,
    acceptanceCheckIds: z.array(stableIdSchema).min(1),
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
  status: pilotCiStatusSchema,
  sourceFingerprint: fingerprintSchema,
  runFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
});
export type PilotCiReceipt = z.infer<typeof pilotCiReceiptSchema>;

export const pilotEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-evidence.v2"),
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
          result.sourceFingerprint !== oracle.sourceFingerprint ||
          result.mode !== oracle.mode ||
          result.oracleOutcome !== oracle.expectedOutcome ||
          JSON.stringify(result.acceptanceCheckIds) !== JSON.stringify(oracle.acceptanceCheckIds)
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
          comparator.sourceFingerprint !== oracle.sourceFingerprint ||
          comparator.mode !== oracle.mode ||
          JSON.stringify(comparator.acceptanceCheckIds) !==
            JSON.stringify(oracle.acceptanceCheckIds) ||
          (() => {
            const result = evidence.taskResults.find(
              (candidate) => candidate.taskId === comparator.taskId,
            );
            if (result === undefined) return true;
            return (
              result.repositoryFingerprint !== comparator.repositoryFingerprint ||
              result.sourceFingerprint !== comparator.sourceFingerprint ||
              result.mode !== comparator.mode ||
              JSON.stringify(result.acceptanceCheckIds) !==
                JSON.stringify(comparator.acceptanceCheckIds) ||
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
