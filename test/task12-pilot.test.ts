import { describe, expect, it } from "vitest";

import {
  PilotEvaluator,
  nearestRank,
  pilotEvidenceSchema,
  type PilotEvidence,
} from "@hunter-pi/pilot";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";

const secondRepositoryFingerprint = `sha256:${"b".repeat(64)}`;
const firstSourceFingerprint = `sha256:${"c".repeat(64)}`;
const secondSourceFingerprint = `sha256:${"d".repeat(64)}`;

function completeEvidence(): PilotEvidence {
  const taskOracles = Array.from({ length: 10 }, (_, index) => ({
    taskId: `pilot-task-${String(index + 1).padStart(2, "0")}`,
    repositoryFingerprint: index < 5 ? fixtureFingerprint : secondRepositoryFingerprint,
    sourceFingerprint: index < 5 ? firstSourceFingerprint : secondSourceFingerprint,
    mode: index % 2 === 0 ? ("QUICK" as const) : ("MANAGED" as const),
    expectedOutcome: "READY" as const,
    acceptanceCheckIds: [`check-${String(index + 1).padStart(2, "0")}`],
  }));
  return pilotEvidenceSchema.parse({
    schemaVersion: "hpi-pilot-evidence.v2",
    machine: {
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
      hunterReleaseFingerprint: fixtureFingerprint,
      engineReleaseFingerprint: fixtureFingerprint,
    },
    installation: {
      status: "PASS",
      sourceFingerprint: firstSourceFingerprint,
      artifactFingerprint: fixtureFingerprint,
      cleanProfileFingerprint: fixtureFingerprint,
    },
    taskOracles,
    taskResults: taskOracles.map((oracle) => ({
      taskId: oracle.taskId,
      repositoryFingerprint: oracle.repositoryFingerprint,
      sourceFingerprint: oracle.sourceFingerprint,
      mode: oracle.mode,
      acceptanceCheckIds: oracle.acceptanceCheckIds,
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
        status: "PASS",
        sourceFingerprint: firstSourceFingerprint,
        runFingerprint: fixtureFingerprint,
        artifactFingerprint: fixtureFingerprint,
        engineReleaseFingerprint: fixtureFingerprint,
      },
      ubuntu: {
        status: "PASS",
        sourceFingerprint: firstSourceFingerprint,
        runFingerprint: fixtureFingerprint,
        artifactFingerprint: fixtureFingerprint,
        engineReleaseFingerprint: fixtureFingerprint,
      },
    },
    pairedComparators: Array.from({ length: 3 }, (_, index) => ({
      taskId: taskOracles[index]?.taskId ?? "pilot-task-01",
      repositoryFingerprint: taskOracles[index]?.repositoryFingerprint ?? fixtureFingerprint,
      sourceFingerprint: taskOracles[index]?.sourceFingerprint ?? firstSourceFingerprint,
      mode: taskOracles[index]?.mode ?? "QUICK",
      acceptanceCheckIds: taskOracles[index]?.acceptanceCheckIds ?? ["check-01"],
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
    const decision = new PilotEvaluator().evaluate(completeEvidence());
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
    const decision = new PilotEvaluator().evaluate({
      ...evidence,
      ci: {
        ...evidence.ci,
        ubuntu: { ...evidence.ci.ubuntu, status: "PENDING" },
      },
      providerLatencySeparated: false,
    });
    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/CI|latency|Provider/u);
  });

  it("returns STOP for an observed zero-tolerance source-loss failure", () => {
    const evidence = completeEvidence();
    const decision = new PilotEvaluator().evaluate({
      ...evidence,
      taskResults: evidence.taskResults.map((result, index) =>
        index === 0 ? { ...result, sourcePreserved: false } : result,
      ),
    });
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
    const decision = new PilotEvaluator().evaluate(forged);
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
    const noComparatorValue = new PilotEvaluator().evaluate({
      ...evidence,
      taskResults: evidence.taskResults.map((result, index) =>
        index < 3 ? { ...result, manualInterventions: 1, rawPiManualInterventions: 1 } : result,
      ),
      pairedComparators: evidence.pairedComparators.map((comparator) => ({
        ...comparator,
        rawPiManualInterventions: 1,
        hunterManualInterventions: 1,
        containedFalseCompletion: false,
      })),
    });
    expect(noComparatorValue.outcome).toBe("STOP");
    const overheadMiss = new PilotEvaluator().evaluate({
      ...evidence,
      taskResults: evidence.taskResults.map((result, index) =>
        index < 3 ? { ...result, manualInterventions: 3, hunterOverheadMinutes: 11 } : result,
      ),
      pairedComparators: evidence.pairedComparators.map((comparator) => ({
        ...comparator,
        rawPiManualInterventions: 3,
        hunterManualInterventions: 3,
        hunterAdditionalOverheadMinutes: 11,
        containedFalseCompletion: true,
      })),
    });
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
});
