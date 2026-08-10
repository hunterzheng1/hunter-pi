import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as pilotPublicPackage from "@hunter-pi/pilot";
import {
  FilePilotCaptureCoordinator,
  PilotCaptureCoordinatorError,
  PilotEvaluator,
  PilotPlanCompiler,
  isTrustedPilotArchive,
  pilotQuickWorkflowFactChecklistFingerprint,
  type PilotCaptureObservation,
  type PilotEvidence,
  type PilotExecutionPlan,
} from "@hunter-pi/pilot";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  realManagedChangeRequestSchema,
} from "@hunter-pi/managed-change";
import {
  createPilotCaptureProductExecutionRuntime,
  createPilotCaptureProductObservationRuntime,
} from "../packages/pilot/src/capture-session.js";
import { completePilotEvidence } from "./support/task12-evidence-fixture.js";
import {
  completePilotExecutionPlan,
  completePilotPlanInput,
} from "./support/task12-plan-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";
import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";

const cleanupRoots: string[] = [];
const sessionId = "pilot-session-daily-01";
const archiveId = "pilot-archive-daily-01";
const productObservationRuntime = createPilotCaptureProductObservationRuntime();

function quickCaptureFixture() {
  const input = completePilotPlanInput();
  const target = input.repositoryTargets[0];
  if (target === undefined) throw new Error("pilot Quick target fixture missing");
  const request = realManagedChangeRequestSchema.parse({
    schemaVersion: "hpi-managed-change-request.v2",
    title: "Capture one bounded Quick result",
    goal: "Create result.txt with the accepted fixture value.",
    nonGoals: ["Do not commit the result."],
    constraints: ["Modify only result.txt."],
    allowedPaths: ["result.txt"],
    check: { label: "result check", executable: "node", argv: ["check.mjs"] },
    target: {
      targetId: target.targetId,
      selectionMode: target.selectionMode,
      repositoryFingerprint: target.repositoryFingerprint,
      sourceFingerprint: target.sourceFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
    },
  });
  const plan = new PilotPlanCompiler().compile({
    ...input,
    workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    acceptanceChecks: input.acceptanceChecks.map((check) =>
      check.checkId === "check_pilot-01"
        ? { ...check, definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(request) }
        : check,
    ),
    tasks: input.tasks.map((task) =>
      task.taskId === "pilot-task-01"
        ? {
            ...task,
            taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
          }
        : task,
    ),
  });
  const receipt = completePilotEvidence(plan).quickTaskReceipts.find(
    (candidate) => candidate.taskId === "pilot-task-01",
  );
  if (receipt === undefined) throw new Error("pilot Quick receipt fixture missing");
  if (
    plan.operatorScope.providerEndpointFingerprint === null ||
    plan.operatorScope.providerModelFingerprint === null ||
    plan.operatorScope.credentialScopeFingerprint === null
  ) {
    throw new Error("pilot Provider scope fixture missing");
  }
  return {
    plan,
    request: {
      schemaVersion: "hpi-pilot-capture-quick-task.v2" as const,
      sessionId,
      operationId: "capture-operation-quick-01",
      taskId: "pilot-task-01",
      repository: "C:\\fixture-repository",
      request,
      runtimeBinding: {
        schemaVersion: "hpi-pilot-runtime-binding.v1" as const,
        sourceFingerprint: plan.sourceFingerprint,
        artifactFingerprint: plan.artifactFingerprint,
        engineReleaseFingerprint: plan.engineReleaseFingerprint,
        providerEndpointFingerprint: plan.operatorScope.providerEndpointFingerprint,
        providerModelFingerprint: plan.operatorScope.providerModelFingerprint,
        credentialScopeFingerprint: plan.operatorScope.credentialScopeFingerprint,
      },
    },
    receipt,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createCoordinator(plan: PilotExecutionPlan = completePilotExecutionPlan()): Promise<{
  readonly root: string;
  readonly captureRoot: string;
  readonly archiveRoot: string;
  readonly coordinator: FilePilotCaptureCoordinator;
  readonly plan: PilotExecutionPlan;
}> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-pilot-capture-");
  cleanupRoots.push(root);
  const captureRoot = join(root, "capture");
  const archiveRoot = join(root, "archive");
  const coordinator = new FilePilotCaptureCoordinator({
    stateRoot: captureRoot,
    archiveStateRoot: archiveRoot,
    now: () => "2026-08-10T01:00:00.000Z",
  });
  await coordinator.open({
    schemaVersion: "hpi-pilot-capture-open.v1",
    sessionId,
    archiveId,
    plan,
  });
  return { root, captureRoot, archiveRoot, coordinator, plan };
}

function observationsFromEvidence(evidence: PilotEvidence): PilotCaptureObservation[] {
  const taskObservations: PilotCaptureObservation[] = evidence.taskResults.map((result) => {
    if (result.mode === "QUICK") {
      const receipt = evidence.quickTaskReceipts.find(
        (candidate) => candidate.receiptId === result.quickReceiptId,
      );
      if (receipt === undefined) throw new Error("pilot Quick receipt fixture missing");
      return { kind: "QUICK_TASK", receipt };
    }
    const run = evidence.runArchives.find((candidate) => candidate.taskId === result.taskId);
    if (run === undefined) throw new Error("pilot Managed Archive fixture missing");
    return {
      kind: "MANAGED_TASK",
      taskId: result.taskId,
      terminalOutcome: result.terminalOutcome,
      sourcePreserved: result.sourcePreserved,
      rawSecretLeakage: result.rawSecretLeakage,
      applicableFactCount: result.applicableFactCount,
      capturedFactCount: result.capturedFactCount,
      manualInterventions: result.manualInterventions,
      hunterOverheadMinutes: result.hunterOverheadMinutes,
      rawPiCapturedFactCount: result.rawPiCapturedFactCount,
      rawPiManualInterventions: result.rawPiManualInterventions,
      run: {
        runId: run.runId,
        archiveId: run.archiveId,
        archiveFingerprint: run.archiveFingerprint,
        terminalOutcome: run.terminalOutcome,
        providerRequestCount: run.providerRequestCount,
        providerTokenCount: run.providerTokenCount,
        providerCostMinor: run.providerCostMinor,
        recoveryLinks: run.recoveryLinks,
      },
    };
  });
  const observations: PilotCaptureObservation[] = [
    {
      kind: "INSTALLATION",
      cleanProfileFingerprint: evidence.installation.cleanProfileFingerprint,
    },
    ...taskObservations,
    {
      kind: "WARM_START_SAMPLES",
      discardedWarmups: evidence.discardedWarmups,
      samplesMs: evidence.warmStartSamplesMs,
    },
    {
      kind: "ACKNOWLEDGEMENT_SAMPLES",
      samplesMs: evidence.acknowledgementSamplesMs,
    },
    ...evidence.updateRollbackCycles.map((cycle) => ({
      kind: "UPDATE_ROLLBACK" as const,
      cycleId: cycle.cycleId,
      candidateId: cycle.candidateId,
      applyOutcome: cycle.applyOutcome,
      rollbackOutcome: cycle.rollbackOutcome,
      statePreserved: cycle.statePreserved,
      usableKnownGood: cycle.usableKnownGood,
    })),
    ...evidence.pluginFixtures.map((fixture) => ({
      kind: "PLUGIN_FIXTURE" as const,
      fixtureId: fixture.fixtureId,
      safeMode: fixture.safeMode,
      userCodeEvaluated: fixture.userCodeEvaluated,
    })),
    {
      kind: "MEMORY_SAMPLES",
      samplesMiB: evidence.memorySamplesMiB,
    },
    {
      kind: "GATES",
      storageGate: evidence.storageGate,
      manualStateEditingRequired: evidence.manualStateEditingRequired,
      privacyGate: evidence.privacyGate,
      providerLatencySeparated: evidence.providerLatencySeparated,
      reviewP0P1Count: evidence.reviewP0P1Count,
    },
    {
      kind: "CI",
      platform: evidence.ci.windows.platform,
      status: evidence.ci.windows.status,
      runFingerprint: evidence.ci.windows.runFingerprint,
    },
    {
      kind: "CI",
      platform: evidence.ci.ubuntu.platform,
      status: evidence.ci.ubuntu.status,
      runFingerprint: evidence.ci.ubuntu.runFingerprint,
    },
    ...evidence.pairedComparators.map((comparator) => ({
      kind: "RAW_PI_COMPARATOR" as const,
      comparator,
    })),
  ];
  return observations;
}

async function recordObservations(
  coordinator: FilePilotCaptureCoordinator,
  observations: readonly PilotCaptureObservation[],
): Promise<void> {
  for (const [index, observation] of observations.entries()) {
    const input = {
      schemaVersion: "hpi-pilot-capture-record.v1",
      sessionId,
      operationId: `capture-operation-${String(index + 1).padStart(3, "0")}`,
      observation,
    };
    if (
      observation.kind === "MANAGED_TASK" ||
      observation.kind === "QUICK_TASK" ||
      observation.kind === "RAW_PI_COMPARATOR"
    ) {
      await coordinator.recordProductObservation(productObservationRuntime, input);
    } else {
      await coordinator.record(input);
    }
  }
}

describe("Task 12 durable pilot capture coordinator", { timeout: 30_000 }, () => {
  it("opens or resumes one exact plan-bound session and reports path-free next actions", async () => {
    const { root, coordinator, plan } = await createCoordinator();
    const status = await coordinator.status(sessionId);

    expect(status).toMatchObject({
      schemaVersion: "hpi-pilot-capture-status.v1",
      sessionId,
      archiveId,
      planFingerprint: plan.planFingerprint,
      state: "COLLECTING",
      counts: { taskChains: 0, interruptions: 0, rawPiComparators: 0 },
      providerUsage: { requests: 0, tokens: 0, costMinor: 0 },
    });
    expect(status.nextActions).toContain("RECORD_INSTALLATION");
    expect(JSON.stringify(status)).not.toContain(root);

    await expect(
      coordinator.open({
        schemaVersion: "hpi-pilot-capture-open.v1",
        sessionId,
        archiveId,
        plan,
      }),
    ).resolves.toEqual(status);

    const otherInput = completePilotPlanInput();
    const otherPlan = new PilotPlanCompiler().compile({
      ...otherInput,
      comparatorConfigurationFingerprint: `sha256:${"e".repeat(64)}`,
    });
    await expect(
      coordinator.open({
        schemaVersion: "hpi-pilot-capture-open.v1",
        sessionId,
        archiveId,
        plan: otherPlan,
      }),
    ).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
  });

  it("replays one operation idempotently and rejects operation or fact identity conflicts", async () => {
    const { coordinator } = await createCoordinator();
    const request = {
      schemaVersion: "hpi-pilot-capture-record.v1" as const,
      sessionId,
      operationId: "capture-operation-installation",
      observation: {
        kind: "INSTALLATION" as const,
        cleanProfileFingerprint: fixtureFingerprint,
      },
    };
    const recorded = await coordinator.record(request);
    const replayed = await coordinator.record(request);
    expect(recorded.outcome).toBe("RECORDED");
    expect(replayed).toMatchObject({ outcome: "REPLAYED", sequence: recorded.sequence });

    await expect(
      coordinator.record({
        ...request,
        observation: {
          ...request.observation,
          cleanProfileFingerprint: `sha256:${"f".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await expect(
      coordinator.record({
        ...request,
        operationId: "capture-operation-installation-again",
        observation: {
          ...request.observation,
          cleanProfileFingerprint: `sha256:${"f".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: "FACT_CONFLICT" });
  });

  it("detects an edited append-only event before reporting status", async () => {
    const { captureRoot, coordinator } = await createCoordinator();
    await coordinator.record({
      schemaVersion: "hpi-pilot-capture-record.v1",
      sessionId,
      operationId: "capture-operation-installation",
      observation: { kind: "INSTALLATION", cleanProfileFingerprint: fixtureFingerprint },
    });
    const eventsDirectory = join(captureRoot, "sessions", sessionId, "events");
    const [eventFilename] = await readdir(eventsDirectory);
    if (eventFilename === undefined) throw new Error("capture event fixture missing");
    const eventPath = join(eventsDirectory, eventFilename);
    const event = JSON.parse(await readFile(eventPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      eventPath,
      `${JSON.stringify({ ...event, observedAt: "2026-08-10T02:00:00.000Z" })}\n`,
    );

    await expect(coordinator.status(sessionId)).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
  });

  it("rejects cumulative raw Pi usage that crosses the frozen Provider budget", async () => {
    const planInput = completePilotPlanInput();
    const plan = new PilotPlanCompiler().compile({
      ...planInput,
      operatorScope: {
        ...planInput.operatorScope,
        maxProviderRequests: 13,
        maxProviderTokens: 1_300,
        maxProviderCostMinor: 13,
      },
    });
    const { coordinator } = await createCoordinator(plan);
    const observations = observationsFromEvidence(completePilotEvidence(plan));
    const taskChains = observations.filter(
      (observation) => observation.kind === "MANAGED_TASK" || observation.kind === "QUICK_TASK",
    );
    await recordObservations(coordinator, taskChains);
    expect((await coordinator.status(sessionId)).providerUsage).toEqual({
      requests: 13,
      tokens: 1_300,
      costMinor: 13,
    });
    const comparator = observations.find((observation) => observation.kind === "RAW_PI_COMPARATOR");
    if (comparator === undefined) throw new Error("raw Pi comparator fixture missing");
    await expect(
      coordinator.recordProductObservation(productObservationRuntime, {
        schemaVersion: "hpi-pilot-capture-record.v1",
        sessionId,
        operationId: "capture-operation-raw-pi-over-budget",
        observation: comparator,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_EXCEEDED" });
    expect((await coordinator.status(sessionId)).counts.rawPiComparators).toBe(0);
  });

  it("rejects a caller-authored complete Evidence object and cannot finalize an incomplete session", async () => {
    const { coordinator } = await createCoordinator();
    expect("createPilotCaptureProductObservationRuntime" in pilotPublicPackage).toBe(false);
    const task = observationsFromEvidence(completePilotEvidence()).find(
      (observation) => observation.kind === "MANAGED_TASK",
    );
    if (task === undefined) throw new Error("pilot task fixture missing");
    await expect(
      coordinator.record({
        schemaVersion: "hpi-pilot-capture-record.v1",
        sessionId,
        operationId: "capture-operation-forged-task",
        observation: task,
      }),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
    await expect(
      coordinator.record({
        schemaVersion: "hpi-pilot-capture-record.v1",
        sessionId,
        operationId: "capture-operation-forged-evidence",
        observation: completePilotEvidence() as unknown as PilotCaptureObservation,
      }),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
    await expect(coordinator.finalize(sessionId)).rejects.toMatchObject({ code: "INCOMPLETE" });
  });

  it("does not expose a public executor callback that can mint a Quick receipt", async () => {
    const fixture = quickCaptureFixture();
    const { coordinator } = await createCoordinator(fixture.plan);
    expect("createPilotCaptureProductExecutionRuntime" in pilotPublicPackage).toBe(false);
    expect("PilotCaptureQuickTaskExecutor" in pilotPublicPackage).toBe(false);

    await expect(
      coordinator.recordQuickTask(() => Promise.resolve(fixture.receipt), fixture.request),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
    expect((await coordinator.status(sessionId)).counts.taskChains).toBe(0);
  });

  it("persists a full Provider budget reservation before send and never retries unknown usage", async () => {
    const fixture = quickCaptureFixture();
    const { captureRoot, coordinator } = await createCoordinator(fixture.plan);
    let firstExecutionCount = 0;
    const interruptedRuntime = createPilotCaptureProductExecutionRuntime({
      quickTask: async (context) => {
        firstExecutionCount += 1;
        await context.authorizeProviderSend();
        throw new Error("simulated crash after Provider send");
      },
    });

    await expect(
      coordinator.recordQuickTask(interruptedRuntime, fixture.request),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
    expect(firstExecutionCount).toBe(1);
    const intent = JSON.parse(
      await readFile(
        join(
          captureRoot,
          "sessions",
          sessionId,
          `provider-${fixture.request.operationId}.intent.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(intent).toMatchObject({
      schemaVersion: "hpi-pilot-provider-operation-intent.v1",
      operationId: fixture.request.operationId,
      eventCountBefore: 0,
      usageBefore: { requests: 0, tokens: 0, costMinor: 0 },
      reservation: {
        requests: fixture.plan.operatorScope.maxProviderRequests,
        tokens: fixture.plan.operatorScope.maxProviderTokens,
        costMinor: fixture.plan.operatorScope.maxProviderCostMinor,
      },
    });
    await expect(coordinator.status(sessionId)).rejects.toMatchObject({
      code: "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
    });

    let retryExecutionCount = 0;
    const retryRuntime = createPilotCaptureProductExecutionRuntime({
      quickTask: async (context) => {
        retryExecutionCount += 1;
        await context.authorizeProviderSend();
        return fixture.receipt;
      },
    });
    await expect(coordinator.recordQuickTask(retryRuntime, fixture.request)).rejects.toMatchObject({
      code: "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
    });
    expect(retryExecutionCount).toBe(0);
  });

  it("proves a durable Managed retry only while no Provider intent exists", async () => {
    const { coordinator, plan } = await createCoordinator();
    const proof = {
      schemaVersion: "hpi-pilot-managed-provider-reservation.v1" as const,
      sessionId,
      operationId: "capture-operation-managed-retry-proof",
      taskId: "pilot-task-02",
      planFingerprint: plan.planFingerprint,
    };

    await expect(
      coordinator.assertManagedProviderOperationRetryable(proof),
    ).resolves.toBeUndefined();
    await expect(coordinator.reserveManagedProviderOperation(proof)).resolves.toMatchObject({
      requests: plan.operatorScope.maxProviderRequests,
      tokens: plan.operatorScope.maxProviderTokens,
      costMinor: plan.operatorScope.maxProviderCostMinor,
    });
    await expect(coordinator.assertManagedProviderOperationRetryable(proof)).rejects.toMatchObject({
      code: "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
    });
  });

  it("resolves a Provider intent only through its exact durable product event", async () => {
    const fixture = quickCaptureFixture();
    const { coordinator } = await createCoordinator(fixture.plan);
    let executionCount = 0;
    const runtime = createPilotCaptureProductExecutionRuntime({
      quickTask: async (context) => {
        executionCount += 1;
        await context.authorizeProviderSend();
        return fixture.receipt;
      },
    });

    const recorded = await coordinator.recordQuickTask(runtime, fixture.request);
    const replayed = await coordinator.recordQuickTask(runtime, fixture.request);
    expect(recorded.outcome).toBe("RECORDED");
    expect(replayed.outcome).toBe("REPLAYED");
    expect(executionCount).toBe(1);
    expect((await coordinator.status(sessionId)).providerUsage).toEqual({
      requests: fixture.receipt.providerRequestCount,
      tokens: fixture.receipt.providerTokenCount,
      costMinor: fixture.receipt.providerCostMinor,
    });
  });

  it("keeps the capture session usable when local Quick preflight fails before Provider send", async () => {
    const fixture = quickCaptureFixture();
    const { captureRoot, coordinator } = await createCoordinator(fixture.plan);
    const preflightFailureRuntime = createPilotCaptureProductExecutionRuntime({
      quickTask: () => Promise.reject(new Error("local repository preflight failed")),
    });

    await expect(
      coordinator.recordQuickTask(preflightFailureRuntime, fixture.request),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
    await expect(
      readFile(
        join(
          captureRoot,
          "sessions",
          sessionId,
          `provider-${fixture.request.operationId}.intent.json`,
        ),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(coordinator.status(sessionId)).resolves.toMatchObject({
      state: "COLLECTING",
      providerUsage: { requests: 0, tokens: 0, costMinor: 0 },
    });
  });

  it("keeps historical managed-task v1 parse support out of live capture", async () => {
    const { coordinator } = await createCoordinator();
    await expect(
      coordinator.recordManagedTask({
        schemaVersion: "hpi-pilot-capture-managed-task.v1",
        sessionId,
        operationId: "capture-operation-managed-v1",
        taskId: "pilot-task-02",
        archiveIds: ["archive-historical-v1"],
        metrics: {
          applicableFactCount: 20,
          capturedFactCount: 20,
          manualInterventions: 0,
          rawPiCapturedFactCount: 0,
          rawPiManualInterventions: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "OBSERVATION_INVALID" });
  });

  it("projects a complete session into one immutable trusted Archive and recovers publication", async () => {
    const { captureRoot, coordinator, plan } = await createCoordinator();
    const evidence = completePilotEvidence(plan);
    await recordObservations(coordinator, observationsFromEvidence(evidence));
    const ready = await coordinator.status(sessionId);
    expect(ready).toMatchObject({
      state: "READY_TO_FINALIZE",
      counts: {
        installation: 1,
        taskChains: 10,
        interruptions: 3,
        updateCycles: 2,
        pluginFixtures: 5,
        rawPiComparators: 3,
        ciReceipts: 2,
      },
      providerUsage: { requests: 16, tokens: 1_600, costMinor: 16 },
      nextActions: ["FINALIZE_ARCHIVE"],
    });

    if (process.platform !== "win32") {
      await expect(coordinator.finalize(sessionId)).rejects.toMatchObject({
        code: "WINDOWS_REQUIRED",
      });
      expect(await coordinator.status(sessionId)).toMatchObject({
        state: "FINALIZING",
        nextActions: ["RETRY_FINALIZE"],
      });
      return;
    }

    const trusted = await coordinator.finalize(sessionId);
    expect(isTrustedPilotArchive(trusted)).toBe(true);
    expect(trusted.archive).toMatchObject({
      archiveId,
      planFingerprint: plan.planFingerprint,
      evidence: { schemaVersion: "hpi-pilot-evidence.v7", captureProvenance: "LIVE_WINDOWS_PILOT" },
    });
    expect(new PilotEvaluator().evaluate(trusted.archive.evidence, plan, trusted).outcome).toBe(
      "GO",
    );
    expect(await coordinator.status(sessionId)).toMatchObject({
      state: "ARCHIVED",
      archiveFingerprint: trusted.archive.archiveFingerprint,
      nextActions: ["COMPLETE"],
    });

    await rm(join(captureRoot, "sessions", sessionId, "finalization-commit.json"));
    const recovered = await coordinator.finalize(sessionId);
    expect(recovered.archive.archiveFingerprint).toBe(trusted.archive.archiveFingerprint);
    expect((await coordinator.status(sessionId)).state).toBe("ARCHIVED");
  });

  it("uses fixed redacted coordinator errors", () => {
    const error = new PilotCaptureCoordinatorError("SESSION_CORRUPT", "capture session is corrupt");
    expect(error).toMatchObject({ code: "SESSION_CORRUPT" });
  });
});
