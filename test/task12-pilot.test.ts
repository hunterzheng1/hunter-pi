import { describe, expect, it } from "vitest";

import {
  PilotEvaluator,
  nearestRank,
  pilotEvidenceSchema,
  type PilotEvidence,
} from "@hunter-pi/pilot";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import {
  completePilotExecutionPlan,
  firstSourceFingerprint,
  secondRepositoryFingerprint,
  secondSourceFingerprint,
} from "./support/task12-plan-fixture.js";

function completeEvidence(): PilotEvidence {
  const plan = completePilotExecutionPlan();
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
    schemaVersion: "hpi-pilot-evidence.v3",
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
    taskResults: taskOracles.map((oracle) => ({
      taskId: oracle.taskId,
      repositoryFingerprint: oracle.repositoryFingerprint,
      targetReferenceFingerprint: oracle.targetReferenceFingerprint,
      sourceFingerprint: oracle.sourceFingerprint,
      mode: oracle.mode,
      acceptanceCheckIds: oracle.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: oracle.acceptanceCheckDefinitionFingerprints,
      terminalOutcome: "READY" as const,
      oracleOutcome: oracle.expectedOutcome,
      correct: true,
      sourcePreserved: true,
      rawSecretLeakage: false,
      providerSendAcknowledged: true,
      applicableFactCount: 20,
      capturedFactCount: 20,
      manualInterventions: 1,
      hunterOverheadMinutes: 4,
      rawPiCapturedFactCount: 15,
      rawPiManualInterventions: 3,
    })),
    interruptions: Array.from({ length: 3 }, (_, index) => ({
      interruptionId: `pilot-interruption-${String(index + 1)}`,
      kind: "FORCED_PROCESS_KILL" as const,
      historyPreserved: true,
      sourcePreserved: true,
      resumeOutcome: index < 2 ? ("READY" as const) : ("BLOCKED" as const),
      actionableWithinFiveMinutes: true,
    })),
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

describe("Task 12 Windows daily-use pilot evaluator", () => {
  it("uses nearest-rank p95 and returns GO only for a complete passing evidence set", () => {
    expect(nearestRank([3, 1, 2], 2)).toBe(2);
    const decision = new PilotEvaluator().evaluate(
      completeEvidence(),
      completePilotExecutionPlan(),
    );
    expect(decision.outcome).toBe("GO");
    expect(decision.metrics).toMatchObject({
      taskCount: 10,
      correctTaskCount: 10,
      warmStartP95Ms: 1_000,
      acknowledgementP95Ms: 100,
      memoryP95MiB: 512,
      comparatorFactScore: 1,
    });
  });

  it("fails closed as NOT_PROVEN when the real-use or remote evidence is incomplete", () => {
    const evidence = completeEvidence();
    const decision = new PilotEvaluator().evaluate(
      {
        ...evidence,
        ci: {
          ...evidence.ci,
          ubuntu: { ...evidence.ci.ubuntu, status: "PENDING" },
        },
        providerLatencySeparated: false,
      },
      completePilotExecutionPlan(),
    );
    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/CI|latency|Provider/u);
  });

  it("returns STOP for an observed zero-tolerance source-loss failure", () => {
    const evidence = completeEvidence();
    const decision = new PilotEvaluator().evaluate(
      {
        ...evidence,
        taskResults: evidence.taskResults.map((result, index) =>
          index === 0 ? { ...result, sourcePreserved: false } : result,
        ),
      },
      completePilotExecutionPlan(),
    );
    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/source|zero-tolerance/u);
  });

  it("does not allow self-reported correctness or duplicate comparator facts to produce GO", () => {
    const evidence = completeEvidence();
    const forged = {
      ...evidence,
      taskResults: evidence.taskResults.map((result, index) =>
        index === 0 ? { ...result, terminalOutcome: "BLOCKED" as const, correct: true } : result,
      ),
      pairedComparators: evidence.pairedComparators.map((comparator, index) =>
        index === 1
          ? {
              ...comparator,
              taskId: evidence.pairedComparators[0]?.taskId ?? comparator.taskId,
            }
          : comparator,
      ),
    };
    const decision = new PilotEvaluator().evaluate(forged, completePilotExecutionPlan());
    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/strict identity|consistency/u);
  });

  it("binds fresh-install and CI receipts to the exact tested Hunter source", () => {
    const evidence = completeEvidence();
    expect(evidence.installation.sourceFingerprint).toBe(evidence.machine.sourceFingerprint);
    expect(evidence.ci.sourceFingerprint).toBe(evidence.machine.sourceFingerprint);
    expect(evidence.ci.windows.sourceFingerprint).toBe(evidence.machine.sourceFingerprint);
    expect(evidence.ci.ubuntu.sourceFingerprint).toBe(evidence.machine.sourceFingerprint);
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        installation: {
          ...evidence.installation,
          sourceFingerprint: secondSourceFingerprint,
        },
      }),
    ).toThrow(/fresh-install|source/u);
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        ci: { ...evidence.ci, sourceFingerprint: secondSourceFingerprint },
      }),
    ).toThrow(/CI|source/u);
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        ci: {
          ...evidence.ci,
          windows: {
            ...evidence.ci.windows,
            artifactFingerprint: secondSourceFingerprint,
          },
        },
      }),
    ).toThrow(/CI|artifact|release/u);
  });

  it("requires paired comparator facts to bind an exact task result", () => {
    const evidence = completeEvidence();
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        taskResults: evidence.taskResults.map((result, index) =>
          index === 0
            ? {
                ...result,
                acceptanceCheckIds: ["different-check"],
              }
            : result,
        ),
      }),
    ).toThrow(/frozen oracle|acceptance/u);
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        pairedComparators: evidence.pairedComparators.map((comparator, index) =>
          index === 0 ? { ...comparator, hunterCapturedFactCount: 19 } : comparator,
        ),
      }),
    ).toThrow(/comparator|task result|metric/u);
  });

  it("requires intervention reduction or contained ambiguity and never waives overhead", () => {
    const evidence = completeEvidence();
    const noComparatorValue = new PilotEvaluator().evaluate(
      {
        ...evidence,
        taskResults: evidence.taskResults.map((result, index) =>
          [0, 5, 6].includes(index)
            ? { ...result, manualInterventions: 1, rawPiManualInterventions: 1 }
            : result,
        ),
        pairedComparators: evidence.pairedComparators.map((comparator) => ({
          ...comparator,
          rawPiManualInterventions: 1,
          hunterManualInterventions: 1,
          containedFalseCompletion: false,
        })),
      },
      completePilotExecutionPlan(),
    );
    expect(noComparatorValue.outcome).toBe("STOP");
    const overheadMiss = new PilotEvaluator().evaluate(
      {
        ...evidence,
        taskResults: evidence.taskResults.map((result, index) =>
          [0, 5, 6].includes(index)
            ? { ...result, manualInterventions: 3, hunterOverheadMinutes: 11 }
            : result,
        ),
        pairedComparators: evidence.pairedComparators.map((comparator) => ({
          ...comparator,
          rawPiManualInterventions: 3,
          hunterManualInterventions: 3,
          hunterAdditionalOverheadMinutes: 11,
          containedFalseCompletion: true,
        })),
      },
      completePilotExecutionPlan(),
    );
    expect(overheadMiss.outcome).toBe("REVISE");
    expect(overheadMiss.reasons.join(" ")).toMatch(/overhead/u);
  });

  it("rejects captured fact counts that exceed the applicable oracle facts", () => {
    const evidence = completeEvidence();
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        taskResults: evidence.taskResults.map((result, index) =>
          index === 0 ? { ...result, capturedFactCount: result.applicableFactCount + 1 } : result,
        ),
      }),
    ).toThrow(/cannot exceed applicable/u);
  });

  it("requires two distinct frozen repository identities", () => {
    const evidence = completeEvidence();
    const oneRepository = {
      ...evidence,
      taskOracles: evidence.taskOracles.map((oracle) => ({
        ...oracle,
        repositoryFingerprint: fixtureFingerprint,
        sourceFingerprint: firstSourceFingerprint,
      })),
      taskResults: evidence.taskResults.map((result) => ({
        ...result,
        repositoryFingerprint: fixtureFingerprint,
        sourceFingerprint: firstSourceFingerprint,
      })),
      pairedComparators: evidence.pairedComparators.map((comparator) => ({
        ...comparator,
        repositoryFingerprint: fixtureFingerprint,
        sourceFingerprint: firstSourceFingerprint,
      })),
    };
    expect(() => pilotEvidenceSchema.parse(oneRepository)).toThrow(/two distinct repository/u);
  });

  it("binds each paired comparator to the exact frozen source and acceptance checks", () => {
    const evidence = completeEvidence();
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        pairedComparators: evidence.pairedComparators.map((comparator, index) =>
          index === 0 ? { ...comparator, sourceFingerprint: secondSourceFingerprint } : comparator,
        ),
      }),
    ).toThrow(/comparator.*frozen.*source|acceptance/u);
  });

  it("does not produce GO when Evidence is bound to a different frozen plan", () => {
    const evidence = completeEvidence();
    const plan = completePilotExecutionPlan();
    const decision = new PilotEvaluator().evaluate(
      { ...evidence, planFingerprint: `sha256:${"f".repeat(64)}` },
      plan,
    );

    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/plan|fingerprint/u);
  });

  it("binds Plugin and update observations to the frozen definition fingerprints", () => {
    const evidence = completeEvidence();
    const plan = completePilotExecutionPlan();
    const pluginMismatch = new PilotEvaluator().evaluate(
      {
        ...evidence,
        pluginFixtures: evidence.pluginFixtures.map((fixture, index) =>
          index === 0
            ? { ...fixture, definitionFingerprint: secondRepositoryFingerprint }
            : fixture,
        ),
      },
      plan,
    );
    const updateMismatch = new PilotEvaluator().evaluate(
      {
        ...evidence,
        updateRollbackCycles: evidence.updateRollbackCycles.map((cycle, index) =>
          index === 0 ? { ...cycle, artifactFingerprint: secondRepositoryFingerprint } : cycle,
        ),
      },
      plan,
    );

    expect(pluginMismatch.outcome).toBe("NOT_PROVEN");
    expect(pluginMismatch.reasons.join(" ")).toMatch(/Plugin|fixture/u);
    expect(updateMismatch.outcome).toBe("NOT_PROVEN");
    expect(updateMismatch.reasons.join(" ")).toMatch(/update|candidate/u);
  });

  it("binds task observations to the frozen target reference and check definitions", () => {
    const evidence = completeEvidence();
    const plan = completePilotExecutionPlan();
    const forged = {
      ...evidence,
      taskOracles: evidence.taskOracles.map((oracle, index) =>
        index === 0
          ? {
              ...oracle,
              targetReferenceFingerprint: secondRepositoryFingerprint,
              acceptanceCheckDefinitionFingerprints: [secondRepositoryFingerprint],
            }
          : oracle,
      ),
      taskResults: evidence.taskResults.map((result, index) =>
        index === 0
          ? {
              ...result,
              targetReferenceFingerprint: secondRepositoryFingerprint,
              acceptanceCheckDefinitionFingerprints: [secondRepositoryFingerprint],
            }
          : result,
      ),
      pairedComparators: evidence.pairedComparators.map((comparator, index) =>
        index === 0
          ? {
              ...comparator,
              targetReferenceFingerprint: secondRepositoryFingerprint,
              acceptanceCheckDefinitionFingerprints: [secondRepositoryFingerprint],
            }
          : comparator,
      ),
    };

    const decision = new PilotEvaluator().evaluate(forged, plan);
    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/task|oracle/u);
  });

  it("requires platform-specific and distinct Windows/Ubuntu CI receipts", () => {
    const evidence = completeEvidence();
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        ci: {
          ...evidence.ci,
          ubuntu: { ...evidence.ci.ubuntu, platform: "WINDOWS" as const },
        },
      }),
    ).toThrow(/CI|source/u);
    expect(() =>
      pilotEvidenceSchema.parse({
        ...evidence,
        ci: {
          ...evidence.ci,
          ubuntu: { ...evidence.ci.ubuntu, runFingerprint: evidence.ci.windows.runFingerprint },
        },
      }),
    ).toThrow(/CI|source/u);
  });

  it("fails closed for malformed Evidence without fingerprinting arbitrary input", () => {
    expect(() =>
      new PilotEvaluator().evaluate(undefined, completePilotExecutionPlan()),
    ).not.toThrow();
    const decision = new PilotEvaluator().evaluate(undefined, completePilotExecutionPlan());

    expect(decision.outcome).toBe("STOP");
    expect(decision.evidenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decision.reasons.join(" ")).toMatch(/strict|validation/u);
  });
});
