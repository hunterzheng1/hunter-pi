import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FilePilotArchiveStore,
  PilotPlanCompiler,
  PilotEvaluator,
  nearestRank,
  pilotEvidenceSchema,
} from "@hunter-pi/pilot";

import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";
import {
  completePilotExecutionPlan,
  completePilotPlanInput,
  firstSourceFingerprint,
  secondRepositoryFingerprint,
  secondSourceFingerprint,
} from "./support/task12-plan-fixture.js";
import { completePilotEvidence as completeEvidence } from "./support/task12-evidence-fixture.js";
import { testPilotEvidenceCapture } from "./support/task12-test-capture.js";

const archiveRoots: string[] = [];

afterEach(() => {
  for (const root of archiveRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function trustedArchiveFor(
  evidence: ReturnType<typeof completeEvidence>,
  plan: ReturnType<typeof completePilotExecutionPlan>,
  archiveId: string,
) {
  const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-evaluator-"));
  archiveRoots.push(root);
  return new FilePilotArchiveStore({ stateRoot: root }).write({
    archiveId,
    planFingerprint: plan.planFingerprint,
    capture: testPilotEvidenceCapture(evidence),
    observedAt: evidence.observedAt,
  });
}

describe("Task 12 Windows daily-use pilot evaluator", () => {
  it("does not grant GO to bare fixture-shaped JSON without a trusted pilot Archive", () => {
    const decision = new PilotEvaluator().evaluate(
      completeEvidence(),
      completePilotExecutionPlan(),
    );

    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/Archive|trusted|immutable/u);
  });

  it("grants GO only when the trusted Archive binds the exact Evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-evaluator-"));
    archiveRoots.push(root);
    const plan = completePilotExecutionPlan();
    const evidence = completeEvidence(plan, "LIVE_WINDOWS_PILOT");
    const trustedArchive = new FilePilotArchiveStore({ stateRoot: root }).write({
      archiveId: "pilot-archive-evaluator-test",
      planFingerprint: plan.planFingerprint,
      capture: testPilotEvidenceCapture(evidence),
      observedAt: evidence.observedAt,
    });

    const decision = new PilotEvaluator().evaluate(evidence, plan, trustedArchive);

    expect(decision.outcome).toBe("GO");
  });

  it("does not trust a structurally forged Archive handle", () => {
    const plan = completePilotExecutionPlan();
    const evidence = completeEvidence(plan, "LIVE_WINDOWS_PILOT");
    const trustedArchive = trustedArchiveFor(evidence, plan, "pilot-archive-forged-handle-test");
    const forgedArchive = { archive: trustedArchive.archive } as never;
    const runtimeConstructor = (trustedArchive as object).constructor;

    expect(() => {
      Reflect.construct(runtimeConstructor, [trustedArchive.archive]);
    }).toThrow(/trust/u);

    const decision = new PilotEvaluator().evaluate(evidence, plan, forgedArchive);

    expect(decision.outcome).toBe("NOT_PROVEN");
    expect(decision.reasons.join(" ")).toMatch(/trusted.*handle|store/u);
  });

  it("stops when linked Provider usage exceeds the frozen request/token/cost budget", () => {
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      operatorScope: {
        ...completePilotPlanInput().operatorScope,
        maxProviderRequests: 12,
        maxProviderTokens: 1_200,
        maxProviderCostMinor: 12,
      },
    });
    const evidence = completeEvidence(plan, "LIVE_WINDOWS_PILOT");
    const decision = new PilotEvaluator().evaluate(
      evidence,
      plan,
      trustedArchiveFor(evidence, plan, "pilot-archive-provider-budget-test"),
    );

    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/Provider.*budget|maximum.*request|token|cost/u);
  });

  it("counts only READY linked replacement Runs as successful interruptions", () => {
    const plan = completePilotExecutionPlan();
    const evidence = completeEvidence(plan, "LIVE_WINDOWS_PILOT");
    const failedRecoveryEvidence = pilotEvidenceSchema.parse({
      ...evidence,
      taskResults: evidence.taskResults.map((result, index) =>
        index === 0 ? { ...result, terminalOutcome: "FAILED" as const, correct: false } : result,
      ),
      runArchives: evidence.runArchives.map((run) =>
        run.runId === "run-pilot-01-replacement"
          ? { ...run, terminalOutcome: "FAILED" as const }
          : run,
      ),
      interruptions: evidence.interruptions.map((interruption, index) =>
        index === 0 ? { ...interruption, resumeOutcome: "FAILED" as const } : interruption,
      ),
    });
    const decision = new PilotEvaluator().evaluate(
      failedRecoveryEvidence,
      plan,
      trustedArchiveFor(failedRecoveryEvidence, plan, "pilot-archive-recovery-count-test"),
    );

    expect(decision.metrics.resumedInterruptionCount).toBe(2);
    expect(decision.outcome).toBe("GO");
  });

  it("rejects a detached Run cycle that is not part of the single linked chain", () => {
    const evidence = completeEvidence();
    const task = evidence.taskOracles[0];
    if (task === undefined) throw new Error("fixture task oracle missing");

    const parsed = pilotEvidenceSchema.safeParse({
      ...evidence,
      runArchives: [
        ...evidence.runArchives,
        {
          runId: "run-pilot-detached-cycle-a",
          taskId: task.taskId,
          replacementOfRunId: "run-pilot-detached-cycle-b",
          archiveId: "archive-pilot-detached-cycle-a",
          archiveFingerprint: fixtureFingerprint,
          sourceFingerprint: task.sourceFingerprint,
          terminalOutcome: "READY",
          providerRequestCount: 0,
          providerTokenCount: 0,
          providerCostMinor: 0,
        },
        {
          runId: "run-pilot-detached-cycle-b",
          taskId: task.taskId,
          replacementOfRunId: "run-pilot-detached-cycle-a",
          archiveId: "archive-pilot-detached-cycle-b",
          archiveFingerprint: fixtureFingerprint,
          sourceFingerprint: task.sourceFingerprint,
          terminalOutcome: "READY",
          providerRequestCount: 0,
          providerTokenCount: 0,
          providerCostMinor: 0,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects multiple interruption receipts that reuse one replacement Run", () => {
    const evidence = completeEvidence();
    const first = evidence.interruptions[0];
    const second = evidence.interruptions[1];
    const third = evidence.interruptions[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("fixture interruption missing");
    }

    const parsed = pilotEvidenceSchema.safeParse({
      ...evidence,
      interruptions: [
        first,
        {
          ...second,
          taskId: first.taskId,
          interruptedRunId: first.interruptedRunId,
          replacementRunId: first.replacementRunId,
          replacementArchiveFingerprint: first.replacementArchiveFingerprint,
        },
        third,
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an interruption whose predecessor was already READY", () => {
    const evidence = completeEvidence();
    const parsed = pilotEvidenceSchema.safeParse({
      ...evidence,
      runArchives: evidence.runArchives.map((run) =>
        run.runId === "run-pilot-01" ? { ...run, terminalOutcome: "READY" as const } : run,
      ),
    });

    expect(parsed.success).toBe(false);
  });

  it("uses nearest-rank p95 and returns GO only for a complete passing evidence set", () => {
    expect(nearestRank([3, 1, 2], 2)).toBe(2);
    const plan = completePilotExecutionPlan();
    const evidence = completeEvidence(plan, "LIVE_WINDOWS_PILOT");
    const decision = new PilotEvaluator().evaluate(
      evidence,
      plan,
      trustedArchiveFor(evidence, plan, "pilot-archive-p95-test"),
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
    const evidence = completeEvidence(completePilotExecutionPlan(), "LIVE_WINDOWS_PILOT");
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

  it("stops when Evidence claims a Provider send under a no-request scope", () => {
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      operatorScope: {
        repositorySelection: "EXPLICIT_OPERATOR_SELECTED",
        providerRequestPolicy: "NO_PROVIDER_REQUESTS",
        providerEndpointFingerprint: null,
        providerModelFingerprint: null,
        credentialScopeFingerprint: null,
        maxProviderRequests: null,
        maxProviderTokens: null,
        maxProviderCostMinor: null,
        acknowledged: false,
        workspacePolicy: "DISPOSABLE_PILOT_WORKTREES",
      },
    });

    const decision = new PilotEvaluator().evaluate(completeEvidence(plan), plan);

    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/Provider.*request|no-request/u);
  });

  it("uses the frozen plan policy when Evidence forges an authorized Provider scope", () => {
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      operatorScope: {
        repositorySelection: "EXPLICIT_OPERATOR_SELECTED",
        providerRequestPolicy: "NO_PROVIDER_REQUESTS",
        providerEndpointFingerprint: null,
        providerModelFingerprint: null,
        credentialScopeFingerprint: null,
        maxProviderRequests: null,
        maxProviderTokens: null,
        maxProviderCostMinor: null,
        acknowledged: false,
        workspacePolicy: "DISPOSABLE_PILOT_WORKTREES",
      },
    });
    const evidence = completeEvidence(plan);
    const forgedEvidence = {
      ...evidence,
      operatorScope: completePilotExecutionPlan().operatorScope,
    };

    const decision = new PilotEvaluator().evaluate(forgedEvidence, plan);

    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/Provider.*request|no-request/u);
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

  it("returns STOP for a false READY instead of treating it as a quantitative miss", () => {
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      tasks: completePilotPlanInput().tasks.map((task, index) =>
        index === 0 ? { ...task, expectedOutcome: "BLOCKED" as const } : task,
      ),
    });
    const decision = new PilotEvaluator().evaluate(completeEvidence(plan), plan);
    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/false READY|zero-tolerance/u);
  });

  it("requires an explicit no-manual-state-edit receipt before evaluating daily-use readiness", () => {
    const evidence = {
      ...completeEvidence(),
      schemaVersion: "hpi-pilot-evidence.v5" as const,
      manualStateEditingRequired: false,
    };
    expect(() => pilotEvidenceSchema.parse(evidence)).not.toThrow();

    const decision = new PilotEvaluator().evaluate(
      { ...evidence, manualStateEditingRequired: true },
      completePilotExecutionPlan(),
    );
    expect(decision.outcome).toBe("STOP");
    expect(decision.reasons.join(" ")).toMatch(/manual.*state|zero-tolerance/u);
  });

  it("rejects legacy Evidence and incomplete v4 receipts fail closed", () => {
    const evidence = completeEvidence();
    expect(() =>
      pilotEvidenceSchema.parse({ ...evidence, schemaVersion: "hpi-pilot-evidence.v4" }),
    ).toThrow(/schemaVersion|v4/u);

    const withoutManualStateReceipt: Record<string, unknown> = { ...evidence };
    delete withoutManualStateReceipt["manualStateEditingRequired"];
    expect(() => pilotEvidenceSchema.parse(withoutManualStateReceipt)).toThrow(
      /manualStateEditingRequired/u,
    );
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
    const evidence = completeEvidence(completePilotExecutionPlan(), "LIVE_WINDOWS_PILOT");
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
    const overheadPlan = completePilotExecutionPlan();
    const overheadEvidence = pilotEvidenceSchema.parse({
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
    });
    const overheadMiss = new PilotEvaluator().evaluate(
      overheadEvidence,
      overheadPlan,
      trustedArchiveFor(overheadEvidence, overheadPlan, "pilot-archive-overhead-test"),
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
