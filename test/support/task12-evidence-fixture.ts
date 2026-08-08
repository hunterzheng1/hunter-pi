import { pilotEvidenceSchema, type PilotEvidence, type PilotExecutionPlan } from "@hunter-pi/pilot";

import { fixtureFingerprint, fixtureTimestamp } from "./workflow-domain-fixture.js";
import {
  completePilotExecutionPlan,
  firstSourceFingerprint,
  secondRepositoryFingerprint,
} from "./task12-plan-fixture.js";

export function completePilotEvidence(
  plan: PilotExecutionPlan = completePilotExecutionPlan(),
  captureProvenance: "FIXTURE" | "LIVE_WINDOWS_PILOT" = "FIXTURE",
): PilotEvidence {
  const targetById = new Map(plan.repositoryTargets.map((target) => [target.targetId, target]));
  const acceptanceCheckById = new Map(
    plan.acceptanceChecks.map((check) => [check.checkId, check.definitionFingerprint]),
  );
  const taskOracles = plan.tasks.map((task) => {
    const target = targetById.get(task.targetId);
    if (target === undefined) throw new Error("fixture target missing");
    return {
      taskId: task.taskId,
      repositoryFingerprint: target.repositoryFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
      sourceFingerprint: task.sourceFingerprint,
      mode: task.mode,
      expectedOutcome: task.expectedOutcome,
      acceptanceCheckIds: task.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: task.acceptanceCheckIds.map((checkId) => {
        const fingerprint = acceptanceCheckById.get(checkId);
        if (fingerprint === undefined) throw new Error("fixture acceptance check missing");
        return fingerprint;
      }),
    };
  });
  return pilotEvidenceSchema.parse({
    schemaVersion: "hpi-pilot-evidence.v5",
    captureProvenance,
    planFingerprint: plan.planFingerprint,
    operatorScope: plan.operatorScope,
    machine: plan.machineProfile,
    installation: {
      status: "PASS",
      sourceFingerprint: plan.sourceFingerprint,
      artifactFingerprint: plan.artifactFingerprint,
      cleanProfileFingerprint: fixtureFingerprint,
    },
    taskOracles,
    taskResults: taskOracles.map((oracle, index) => ({
      taskId: oracle.taskId,
      repositoryFingerprint: oracle.repositoryFingerprint,
      targetReferenceFingerprint: oracle.targetReferenceFingerprint,
      sourceFingerprint: oracle.sourceFingerprint,
      mode: oracle.mode,
      acceptanceCheckIds: oracle.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: oracle.acceptanceCheckDefinitionFingerprints,
      terminalOutcome: "READY" as const,
      oracleOutcome: oracle.expectedOutcome,
      correct: oracle.expectedOutcome === "READY",
      sourcePreserved: true,
      rawSecretLeakage: false,
      providerSendAcknowledged: true,
      providerRequestCount: [0, 5, 6].includes(index) ? 2 : 1,
      providerTokenCount: [0, 5, 6].includes(index) ? 200 : 100,
      providerCostMinor: [0, 5, 6].includes(index) ? 2 : 1,
      applicableFactCount: 20,
      capturedFactCount: 20,
      manualInterventions: 1,
      hunterOverheadMinutes: 4,
      rawPiCapturedFactCount: 15,
      rawPiManualInterventions: 3,
    })),
    runArchives: [
      ...taskOracles.map((oracle, index) => ({
        runId: `run-pilot-${String(index + 1).padStart(2, "0")}`,
        taskId: oracle.taskId,
        replacementOfRunId: null,
        archiveId: `archive-pilot-${String(index + 1).padStart(2, "0")}`,
        archiveFingerprint: fixtureFingerprint,
        sourceFingerprint: oracle.sourceFingerprint,
        terminalOutcome: "READY" as const,
        providerRequestCount: 1,
        providerTokenCount: 100,
        providerCostMinor: 1,
      })),
      ...[0, 5, 6].map((index) => {
        const oracle = taskOracles[index];
        if (oracle === undefined) throw new Error("fixture task oracle missing");
        return {
          runId: `run-pilot-${String(index + 1).padStart(2, "0")}-replacement`,
          taskId: oracle.taskId,
          replacementOfRunId: `run-pilot-${String(index + 1).padStart(2, "0")}`,
          archiveId: `archive-pilot-${String(index + 1).padStart(2, "0")}-replacement`,
          archiveFingerprint: secondRepositoryFingerprint,
          sourceFingerprint: oracle.sourceFingerprint,
          terminalOutcome: "READY" as const,
          providerRequestCount: 1,
          providerTokenCount: 100,
          providerCostMinor: 1,
        };
      }),
    ],
    interruptions: Array.from({ length: 3 }, (_, index) => {
      const pairedTaskIndex = [0, 5, 6][index] ?? 0;
      const taskOracle = taskOracles[pairedTaskIndex];
      if (taskOracle === undefined) throw new Error("fixture interruption task missing");
      const runNumber = pairedTaskIndex + 1;
      return {
        interruptionId: `pilot-interruption-${String(index + 1)}`,
        taskId: taskOracle.taskId,
        kind: "FORCED_PROCESS_KILL" as const,
        interruptedRunId: `run-pilot-${String(runNumber).padStart(2, "0")}`,
        replacementRunId: `run-pilot-${String(runNumber).padStart(2, "0")}-replacement`,
        replacementArchiveFingerprint: secondRepositoryFingerprint,
        historyPreserved: true,
        sourcePreserved: true,
        resumeOutcome: "READY" as const,
        actionableWithinFiveMinutes: true,
      };
    }),
    discardedWarmups: 5,
    warmStartSamplesMs: Array.from({ length: 20 }, () => 1_000),
    acknowledgementSamplesMs: Array.from({ length: 30 }, () => 100),
    updateRollbackCycles: Array.from({ length: 2 }, (_, index) => ({
      cycleId: `pilot-update-cycle-${String(index + 1)}`,
      candidateId: plan.updateCandidates[index]?.candidateId ?? "release-candidate-01",
      artifactFingerprint: plan.updateCandidates[index]?.artifactFingerprint ?? fixtureFingerprint,
      qualificationFingerprint:
        plan.updateCandidates[index]?.qualificationFingerprint ?? fixtureFingerprint,
      applyOutcome: "APPLIED" as const,
      rollbackOutcome: "APPLIED" as const,
      statePreserved: true,
      usableKnownGood: true,
    })),
    pluginFixtures: [
      "THROWING_INITIALIZATION",
      "RESERVED_COLLISION",
      "BUILTIN_OVERRIDE",
      "SECRET_PATH_LEAKAGE",
      "OVERSIZED_OUTPUT",
    ].map((fixtureId) => ({
      fixtureId: fixtureId as
        | "THROWING_INITIALIZATION"
        | "RESERVED_COLLISION"
        | "BUILTIN_OVERRIDE"
        | "SECRET_PATH_LEAKAGE"
        | "OVERSIZED_OUTPUT",
      definitionFingerprint:
        plan.pluginFixtures.find((fixture) => fixture.fixtureId === fixtureId)
          ?.definitionFingerprint ?? fixtureFingerprint,
      safeMode: true,
      userCodeEvaluated: false,
    })),
    memorySamplesMiB: Array.from({ length: 30 }, () => 512),
    storageGate: true,
    manualStateEditingRequired: false,
    privacyGate: true,
    providerLatencySeparated: true,
    reviewP0P1Count: 0,
    ci: {
      sourceFingerprint: firstSourceFingerprint,
      windows: {
        platform: "WINDOWS" as const,
        status: "PASS",
        sourceFingerprint: firstSourceFingerprint,
        runFingerprint: fixtureFingerprint,
        artifactFingerprint: fixtureFingerprint,
        engineReleaseFingerprint: fixtureFingerprint,
      },
      ubuntu: {
        platform: "UBUNTU" as const,
        status: "PASS",
        sourceFingerprint: firstSourceFingerprint,
        runFingerprint: secondRepositoryFingerprint,
        artifactFingerprint: fixtureFingerprint,
        engineReleaseFingerprint: fixtureFingerprint,
      },
    },
    pairedComparators: [0, 5, 6].map((taskIndex) => ({
      taskId: taskOracles[taskIndex]?.taskId ?? "pilot-task-01",
      repositoryFingerprint: taskOracles[taskIndex]?.repositoryFingerprint ?? fixtureFingerprint,
      targetReferenceFingerprint:
        taskOracles[taskIndex]?.targetReferenceFingerprint ?? fixtureFingerprint,
      sourceFingerprint: taskOracles[taskIndex]?.sourceFingerprint ?? firstSourceFingerprint,
      mode: taskOracles[taskIndex]?.mode ?? "QUICK",
      acceptanceCheckIds: taskOracles[taskIndex]?.acceptanceCheckIds ?? ["check-01"],
      acceptanceCheckDefinitionFingerprints: taskOracles[taskIndex]
        ?.acceptanceCheckDefinitionFingerprints ?? [fixtureFingerprint],
      applicableFactCount: 20,
      rawPiCapturedFactCount: 15,
      hunterCapturedFactCount: 20,
      rawPiManualInterventions: 3,
      hunterManualInterventions: 1,
      hunterAdditionalOverheadMinutes: 4,
      containedFalseCompletion: false,
    })),
    observedAt: fixtureTimestamp,
  });
}
