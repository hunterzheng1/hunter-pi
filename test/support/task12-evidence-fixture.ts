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
    const binding = {
      taskId: task.taskId,
      targetId: task.targetId,
      repositoryFingerprint: target.repositoryFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
      sourceFingerprint: task.sourceFingerprint,
      taskDefinitionFingerprint: task.taskDefinitionFingerprint,
      mode: task.mode,
      acceptanceCheckIds: task.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: task.acceptanceCheckIds.map((checkId) => {
        const fingerprint = acceptanceCheckById.get(checkId);
        if (fingerprint === undefined) throw new Error("fixture acceptance check missing");
        return fingerprint;
      }),
    };
    return task.mode === "QUICK"
      ? {
          ...binding,
          mode: "QUICK" as const,
          expectedExecutionObservation: task.expectedExecutionObservation,
          expectedAcceptanceObservation: task.expectedAcceptanceObservation,
        }
      : { ...binding, mode: "MANAGED" as const, expectedOutcome: task.expectedOutcome };
  });
  const interruptionByTaskId = new Map(plan.interruptionTasks.map((item) => [item.taskId, item]));
  const taskIndexById = new Map(plan.tasks.map((task, index) => [task.taskId, index]));
  const bindingFor = (oracle: (typeof taskOracles)[number]) => ({
    taskId: oracle.taskId,
    targetId: oracle.targetId,
    repositoryFingerprint: oracle.repositoryFingerprint,
    targetReferenceFingerprint: oracle.targetReferenceFingerprint,
    sourceFingerprint: oracle.sourceFingerprint,
    taskDefinitionFingerprint: oracle.taskDefinitionFingerprint,
    acceptanceCheckIds: oracle.acceptanceCheckIds,
    acceptanceCheckDefinitionFingerprints: oracle.acceptanceCheckDefinitionFingerprints,
  });
  return pilotEvidenceSchema.parse({
    schemaVersion: "hpi-pilot-evidence.v7",
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
    taskResults: taskOracles.map((oracle) => {
      const interrupted = interruptionByTaskId.has(oracle.taskId);
      const measurements = {
        sourcePreserved: true,
        rawSecretLeakage: false,
        providerSendAcknowledged: true,
        providerRequestCount: interrupted ? 2 : 1,
        providerTokenCount: interrupted ? 200 : 100,
        providerCostMinor: interrupted ? 2 : 1,
        applicableFactCount: 20,
        capturedFactCount: 20,
        manualInterventions: 1,
        hunterOverheadMinutes: 4,
        rawPiCapturedFactCount: 15,
        rawPiManualInterventions: 3,
      };
      return oracle.mode === "QUICK"
        ? {
            ...bindingFor(oracle),
            ...measurements,
            mode: "QUICK" as const,
            quickReceiptId: `quick-receipt-${oracle.taskId}`,
            executionObservation: "RETURNED" as const,
            oracleExecutionObservation: oracle.expectedExecutionObservation,
            acceptanceObservation: "PASS" as const,
            oracleAcceptanceObservation: oracle.expectedAcceptanceObservation,
            verifiedChangeClaimed: false as const,
            correct: true,
          }
        : {
            ...bindingFor(oracle),
            ...measurements,
            mode: "MANAGED" as const,
            terminalOutcome: "READY" as const,
            oracleOutcome: oracle.expectedOutcome,
            correct: oracle.expectedOutcome === "READY",
          };
    }),
    quickTaskReceipts: taskOracles.flatMap((oracle) =>
      oracle.mode === "QUICK"
        ? [
            {
              ...bindingFor(oracle),
              receiptId: `quick-receipt-${oracle.taskId}`,
              mode: "QUICK" as const,
              executionObservation: "RETURNED" as const,
              acceptanceObservation: "PASS" as const,
              verifiedChangeClaimed: false as const,
              processReceiptFingerprint: fixtureFingerprint,
              acceptanceReceiptFingerprint: fixtureFingerprint,
              runtimeConfigurationFingerprint: plan.comparatorConfigurationFingerprint,
              processFinality: "FINAL" as const,
              processTreeState: "EMPTY" as const,
              outputState: "CLOSED" as const,
              leaseState: "RELEASED" as const,
              sourcePreserved: true,
              rawSecretLeakage: false,
              providerSendAcknowledged: true,
              providerRequestCount: 1,
              providerTokenCount: 100,
              providerCostMinor: 1,
              applicableFactCount: 20,
              capturedFactCount: 20,
              manualInterventions: 1,
              hunterOverheadMinutes: 4,
            },
          ]
        : [],
    ),
    runArchives: taskOracles.flatMap((oracle) => {
      if (oracle.mode !== "MANAGED") return [];
      const index = taskIndexById.get(oracle.taskId);
      if (index === undefined) throw new Error("fixture task index missing");
      const interruption = interruptionByTaskId.get(oracle.taskId);
      return [
        {
          runId: `run-pilot-${String(index + 1).padStart(2, "0")}`,
          taskId: oracle.taskId,
          archiveId: `archive-pilot-${String(index + 1).padStart(2, "0")}`,
          archiveFingerprint: fixtureFingerprint,
          sourceFingerprint: oracle.sourceFingerprint,
          terminalOutcome: "READY" as const,
          providerRequestCount: interruption === undefined ? 1 : 2,
          providerTokenCount: interruption === undefined ? 100 : 200,
          providerCostMinor: interruption === undefined ? 1 : 2,
          recoveryLinks:
            interruption === undefined
              ? []
              : [
                  {
                    interruptionId: interruption.interruptionId,
                    kind: interruption.kind,
                    checkpointId: `checkpoint-${oracle.taskId}`,
                    interruptedAttemptId: `attempt-${oracle.taskId}-interrupted`,
                    recoveryAttemptId: `attempt-${oracle.taskId}-recovered`,
                    actionableWithinFiveMinutes: true,
                  },
                ],
        },
      ];
    }),
    interruptions: plan.interruptionTasks.map((interruption) => {
      const index = taskIndexById.get(interruption.taskId);
      if (index === undefined) throw new Error("fixture interruption task missing");
      return {
        interruptionId: interruption.interruptionId,
        taskId: interruption.taskId,
        kind: interruption.kind,
        runId: `run-pilot-${String(index + 1).padStart(2, "0")}`,
        archiveFingerprint: fixtureFingerprint,
        checkpointId: `checkpoint-${interruption.taskId}`,
        interruptedAttemptId: `attempt-${interruption.taskId}-interrupted`,
        recoveryAttemptId: `attempt-${interruption.taskId}-recovered`,
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
    pairedComparators: [0, 3, 6].map((taskIndex) => {
      const oracle = taskOracles[taskIndex];
      if (oracle === undefined) throw new Error("fixture comparator task missing");
      return {
        ...bindingFor(oracle),
        mode: oracle.mode,
        comparatorConfigurationFingerprint: plan.comparatorConfigurationFingerprint,
        workflowFactChecklistFingerprint: plan.workflowFactChecklistFingerprint,
        processReceiptFingerprint: fixtureFingerprint,
        acceptanceReceiptFingerprint: fixtureFingerprint,
        executionObservation: "RETURNED" as const,
        acceptanceObservation: "PASS" as const,
        processFinality: "FINAL" as const,
        processTreeState: "EMPTY" as const,
        outputState: "CLOSED" as const,
        leaseState: "RELEASED" as const,
        coreExtensionCount: 0 as const,
        applicableFactCount: 20,
        rawPiCapturedFactCount: 15,
        hunterCapturedFactCount: 20,
        rawPiManualInterventions: 3,
        hunterManualInterventions: 1,
        hunterAdditionalOverheadMinutes: 4,
        containedFalseCompletion: false,
        rawPiProviderRequestCount: 1,
        rawPiProviderTokenCount: 100,
        rawPiProviderCostMinor: 1,
      };
    }),
    observedAt: fixtureTimestamp,
  });
}
