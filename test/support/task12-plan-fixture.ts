import { PilotPlanCompiler, type PilotExecutionPlan, type PilotPlanInput } from "@hunter-pi/pilot";

import { fixtureFingerprint } from "./workflow-domain-fixture.js";

export const firstRepositoryFingerprint = `sha256:${"a".repeat(64)}`;
export const secondRepositoryFingerprint = `sha256:${"b".repeat(64)}`;
export const firstSourceFingerprint = `sha256:${"c".repeat(64)}`;
export const secondSourceFingerprint = `sha256:${"d".repeat(64)}`;
export const artifactFingerprint = fixtureFingerprint;
export const engineFingerprint = fixtureFingerprint;
const fixtureHexDigits = ["a", "b", "c", "d", "e", "f", "0", "1", "2", "3"];

function indexedFingerprint(index: number): `sha256:${string}` {
  const hexDigit = fixtureHexDigits[index];
  if (hexDigit === undefined) throw new Error("fixture fingerprint index missing");
  return `sha256:${hexDigit.repeat(64)}`;
}

export function completePilotPlanInput(): PilotPlanInput {
  const repositoryTargets = [
    {
      targetId: "repository-alpha",
      repositoryFingerprint: firstRepositoryFingerprint,
      sourceFingerprint: firstSourceFingerprint,
      targetReferenceFingerprint: `sha256:${"1".repeat(64)}`,
      selectionMode: "EXPLICIT_OPERATOR_SELECTED" as const,
    },
    {
      targetId: "repository-beta",
      repositoryFingerprint: secondRepositoryFingerprint,
      sourceFingerprint: secondSourceFingerprint,
      targetReferenceFingerprint: `sha256:${"2".repeat(64)}`,
      selectionMode: "EXPLICIT_OPERATOR_SELECTED" as const,
    },
  ];
  return {
    schemaVersion: "hpi-pilot-plan-input.v3",
    platform: "win32",
    architecture: "x64",
    sourceFingerprint: firstSourceFingerprint,
    artifactFingerprint,
    engineReleaseFingerprint: engineFingerprint,
    machineProfile: {
      schemaVersion: "hpi-pilot-machine.v2",
      platform: "win32",
      architecture: "x64",
      osBuild: "fixture-windows-build",
      cpuModel: "fixture-cpu",
      logicalCores: 8,
      memoryMiB: 32_768,
      storage: "SSD",
      terminal: "PowerShell",
      gitVersion: "2.49.0",
      securitySoftwareState: "FIXTURE_DECLARED",
      powerMode: "BALANCED",
      networkCondition: "FIXTURE_CONTROLLED",
      sourceFingerprint: firstSourceFingerprint,
      hunterReleaseFingerprint: artifactFingerprint,
      engineReleaseFingerprint: engineFingerprint,
    },
    comparatorConfigurationFingerprint: fixtureFingerprint,
    workflowFactChecklistFingerprint: `sha256:${"7".repeat(64)}`,
    acceptanceChecks: Array.from({ length: 10 }, (_, index) => ({
      checkId: `check-${String(index + 1).padStart(2, "0")}`,
      definitionFingerprint: indexedFingerprint(index),
    })),
    operatorScope: {
      repositorySelection: "EXPLICIT_OPERATOR_SELECTED",
      providerRequestPolicy: "EXPLICIT_OPERATOR_AUTHORIZED",
      providerEndpointFingerprint: fixtureFingerprint,
      providerModelFingerprint: fixtureFingerprint,
      credentialScopeFingerprint: `sha256:${"3".repeat(64)}`,
      maxProviderRequests: 20,
      maxProviderTokens: 20_000,
      maxProviderCostMinor: 500,
      acknowledged: true,
      workspacePolicy: "DISPOSABLE_PILOT_WORKTREES",
    },
    repositoryTargets,
    tasks: Array.from({ length: 10 }, (_, index) => {
      const target = repositoryTargets[index < 5 ? 0 : 1];
      if (target === undefined) throw new Error("fixture target missing");
      return {
        taskId: `pilot-task-${String(index + 1).padStart(2, "0")}`,
        targetId: target.targetId,
        sourceFingerprint: target.sourceFingerprint,
        taskDefinitionFingerprint: indexedFingerprint(index),
        ...(index % 2 === 0
          ? {
              mode: "QUICK" as const,
              expectedExecutionObservation: "RETURNED" as const,
              expectedAcceptanceObservation: "PASS" as const,
            }
          : { mode: "MANAGED" as const, expectedOutcome: "READY" as const }),
        acceptanceCheckIds: [`check-${String(index + 1).padStart(2, "0")}`],
      };
    }),
    pluginFixtures: [
      "THROWING_INITIALIZATION",
      "RESERVED_COLLISION",
      "BUILTIN_OVERRIDE",
      "SECRET_PATH_LEAKAGE",
      "OVERSIZED_OUTPUT",
    ].map((fixtureId, index) => ({
      fixtureId: fixtureId as
        | "THROWING_INITIALIZATION"
        | "RESERVED_COLLISION"
        | "BUILTIN_OVERRIDE"
        | "SECRET_PATH_LEAKAGE"
        | "OVERSIZED_OUTPUT",
      definitionFingerprint: indexedFingerprint(index + 5),
    })),
    updateCandidates: [
      {
        candidateId: "release-candidate-01",
        artifactFingerprint: `sha256:${"9".repeat(64)}`,
        qualificationFingerprint: `sha256:${"0".repeat(64)}`,
      },
      {
        candidateId: "release-candidate-02",
        artifactFingerprint: `sha256:${"a".repeat(64)}`,
        qualificationFingerprint: `sha256:${"b".repeat(64)}`,
      },
    ],
    pairedTaskIds: ["pilot-task-01", "pilot-task-06", "pilot-task-07"],
    interruptionTasks: [
      {
        interruptionId: "pilot-interruption-1",
        taskId: "pilot-task-02",
        kind: "FORCED_PROCESS_KILL",
      },
      {
        interruptionId: "pilot-interruption-2",
        taskId: "pilot-task-06",
        kind: "TERMINAL_CLOSE_SIMULATION",
      },
      {
        interruptionId: "pilot-interruption-3",
        taskId: "pilot-task-10",
        kind: "POWER_LOSS_SIMULATION",
      },
    ],
  };
}

export function completePilotExecutionPlan(): PilotExecutionPlan {
  return new PilotPlanCompiler().compile(completePilotPlanInput());
}
