import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptIdSchema,
  checkpointIdSchema,
  checkpointSchema,
  evidenceIdSchema,
  observationSchema,
  verificationReceiptSchema,
} from "@hunter-pi/domain";
import {
  FileWorkflowEventStore,
  LocalStorageController,
  type AtomicWriteBoundary,
} from "@hunter-pi/evidence";
import {
  DurableWorkflowKernel,
  InMemoryWorkflowKernel,
  replayWorkflowEvents,
  workflowEventSchema,
} from "@hunter-pi/workflow-kernel";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";
import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createRoot(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-durable-kernel-");
  roots.push(root);
  return root;
}

function createStore(
  root: string,
  faultInjector?: (boundary: AtomicWriteBoundary) => void,
): FileWorkflowEventStore {
  return new FileWorkflowEventStore({
    stateRoot: root,
    storage: new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    }),
    now: () => fixtureTimestamp,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

async function createAndStart(
  kernel: DurableWorkflowKernel,
  options: Parameters<typeof createWorkflowDomainFixture>[0] = {},
) {
  const fixture = createWorkflowDomainFixture(options);
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "CREATE_RUN",
    ...fixture,
  });
  await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "START_ATTEMPT",
    runId: fixture.run.runId,
    attemptId: attemptIdSchema.parse(`att_replay${options.suffix ?? ""}`),
    startedAt: fixtureTimestamp,
  });
  return fixture;
}

function createCheckpoint(
  fixture: ReturnType<typeof createWorkflowDomainFixture>,
  attemptId: string,
  eventCursor: number,
  checkpointId = "checkpoint_replay",
) {
  return checkpointSchema.parse({
    schemaVersion: "1.0.0",
    checkpointId,
    runId: fixture.run.runId,
    attemptId,
    planRevisionId: fixture.planRevision.planRevisionId,
    distributionReleaseId: "release_replay",
    workspaceId: fixture.planRevision.workspaceId,
    repositoryFingerprint: fixtureFingerprint,
    workspaceFingerprint: fixtureFingerprint,
    sourceFingerprint: fixtureFingerprint,
    eventCursor,
    createdAt: fixtureTimestamp,
    engine: {
      engineReleaseId: "engine-release_replay",
      engineReleaseFingerprint: fixtureFingerprint,
      resumeCapability: "NOT_PROVEN",
    },
    activeOperationReceiptIds: [],
    unknownOperationIds: [],
    heldWriterLeaseIds: [],
    processReferences: [],
    remainingResourceBudgets: { maxExternalOperations: 4 },
  });
}

describe("DurableWorkflowKernel", () => {
  it("rebuilds the exact projection from a new process-local Kernel instance", async () => {
    const root = await createRoot();
    const first = new DurableWorkflowKernel(createStore(root));
    const fixture = await createAndStart(first);
    await first.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_replay-return",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        stepId: "step_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });
    const beforeRestart = await first.project(fixture.run.runId);

    const reopened = new DurableWorkflowKernel(createStore(root));
    const afterRestart = await reopened.project(fixture.run.runId);

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.eventCursor).toBe(3);
    expect(afterRestart.attempts[0]).toMatchObject({
      executionStatus: "RETURNED",
      verificationStatus: "PENDING",
    });
    expect(afterRestart.run.lifecycle).toBe("VERIFYING");
  });

  it("replays a durable Checkpoint but keeps external recovery facts NOT_PROVEN", async () => {
    const root = await createRoot();
    const first = new DurableWorkflowKernel(createStore(root));
    const fixture = await createAndStart(first);
    const beforeCheckpoint = await first.project(fixture.run.runId);
    const checkpoint = createCheckpoint(fixture, "att_replay", beforeCheckpoint.eventCursor);
    await first.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_CHECKPOINT",
      checkpoint,
    });

    const reopened = new DurableWorkflowKernel(createStore(root));
    await expect(reopened.recover(checkpoint.checkpointId)).resolves.toMatchObject({
      schemaVersion: "1.0.0",
      status: "NOT_PROVEN",
      checkpoint,
      reasons: [
        "DISTRIBUTION_RELEASE_NOT_REVALIDATED",
        "WORKSPACE_NOT_REVALIDATED",
        "ENGINE_STATE_NOT_RECONCILED",
      ],
    });
  });

  it("rejects a duplicate Checkpoint identity before appending another event", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const kernel = new DurableWorkflowKernel(store);
    const fixture = await createAndStart(kernel);
    const beforeCheckpoint = await kernel.project(fixture.run.runId);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_CHECKPOINT",
      checkpoint: createCheckpoint(fixture, "att_replay", beforeCheckpoint.eventCursor),
    });
    const afterCheckpoint = await kernel.project(fixture.run.runId);

    await expect(
      kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_CHECKPOINT",
        checkpoint: createCheckpoint(fixture, "att_replay", afterCheckpoint.eventCursor),
      }),
    ).rejects.toThrow(/already exists/u);
    await expect(store.read(fixture.run.runId)).resolves.toHaveLength(afterCheckpoint.eventCursor);
  });

  it("rejects a structurally valid replay whose PASS Receipt does not bind the Plan", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const kernel = new DurableWorkflowKernel(store);
    const fixture = await createAndStart(kernel);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_replay-semantic-return",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        stepId: "step_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: verificationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        verificationReceiptId: "verify_replay-semantic",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        checkId: "check_replay",
        checkVersion: 1,
        checkDefinitionFingerprint: fixtureFingerprint,
        resultFingerprint: fixtureFingerprint,
        outcome: "PASS",
        startedAt: fixtureTimestamp,
        endedAt: fixtureTimestamp,
        observedAt: fixtureTimestamp,
        inputFingerprint: fixtureFingerprint,
        configFingerprint: fixtureFingerprint,
        workspaceFingerprint: fixtureFingerprint,
        sourceFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
        output: {
          stdoutDigest: fixtureFingerprint,
          stderrDigest: fixtureFingerprint,
          artifactDigests: [],
          capturedBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          redaction: { applied: false, fieldsRemoved: 0 },
        },
        evidenceIds: ["evidence_replay-semantic"],
      }),
    });
    const events = [...(await store.read(fixture.run.runId))];
    const receiptIndex = events.findIndex((event) => event.type === "VERIFICATION_RECORDED");
    const receiptEvent = events[receiptIndex];
    if (receiptEvent?.type !== "VERIFICATION_RECORDED") {
      throw new Error("expected a Verification event");
    }
    events[receiptIndex] = workflowEventSchema.parse({
      ...receiptEvent,
      receipt: { ...receiptEvent.receipt, checkVersion: 2 },
    });

    expect(() => replayWorkflowEvents(events)).toThrow(/active check/u);
    expect(() => new InMemoryWorkflowKernel([events])).toThrow(/active check/u);
  });

  it("rejects a replayed retry when the preceding Attempt never ended", async () => {
    const root = await createRoot();
    const store = createStore(root);
    const kernel = new DurableWorkflowKernel(store);
    const fixture = await createAndStart(kernel);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_replay-retry-return",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: verificationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        verificationReceiptId: "verify_replay-retry-failed",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        checkId: "check_replay",
        checkVersion: 1,
        checkDefinitionFingerprint: fixtureFingerprint,
        resultFingerprint: fixtureFingerprint,
        outcome: "FAIL",
        startedAt: fixtureTimestamp,
        endedAt: fixtureTimestamp,
        observedAt: fixtureTimestamp,
        inputFingerprint: fixtureFingerprint,
        configFingerprint: fixtureFingerprint,
        workspaceFingerprint: fixtureFingerprint,
        sourceFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        resultStatus: { kind: "EXIT_CODE", exitCode: 1, timedOut: false },
        output: {
          stdoutDigest: fixtureFingerprint,
          stderrDigest: fixtureFingerprint,
          artifactDigests: [],
          capturedBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          redaction: { applied: false, fieldsRemoved: 0 },
        },
        evidenceIds: ["evidence_replay-retry-failed"],
      }),
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RETRY_ATTEMPT",
      runId: fixture.run.runId,
      previousAttemptId: attemptIdSchema.parse("att_replay"),
      attemptId: attemptIdSchema.parse("att_replay-retry"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_replay-retry-failed")],
      failureFingerprint: fixtureFingerprint,
      reason: "Retry the failed durable fixture",
      elapsedMs: 1_000,
      consumedResources: { externalOperations: 1 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: fixtureTimestamp,
    });
    const forged = (await store.read(fixture.run.runId))
      .filter(
        (event) =>
          event.type !== "OBSERVATION_RECORDED" ||
          event.observation.observationId !== "obs_replay-retry-return",
      )
      .map((event, index) => workflowEventSchema.parse({ ...event, cursor: index + 1 }));

    expect(() => replayWorkflowEvents(forged)).toThrow(/retry Attempt is not monotonic/u);
    expect(() => new InMemoryWorkflowKernel([forged])).toThrow(/retry Attempt is not monotonic/u);

    const events = await store.read(fixture.run.runId);
    const retryEvent = events.at(-1);
    if (retryEvent?.type !== "ATTEMPT_STARTED") {
      throw new Error("expected a retry Attempt event");
    }
    const beforeRetry = events.slice(0, -1);
    const inputRequested = workflowEventSchema.parse({
      schemaVersion: "1.0.0",
      cursor: beforeRetry.length + 1,
      type: "OBSERVATION_RECORDED",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_replay-retry-input",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        kind: "INPUT_REQUESTED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });
    const retryAfterInput = workflowEventSchema.parse({
      ...retryEvent,
      cursor: inputRequested.cursor + 1,
    });
    const forgedPastInputStop = [...beforeRetry, inputRequested, retryAfterInput];

    expect(() => replayWorkflowEvents(forgedPastInputStop)).toThrow(/user input/u);
    expect(() => new InMemoryWorkflowKernel([forgedPastInputStop])).toThrow(/user input/u);

    const forgedPastWorkspaceDrift = [
      ...beforeRetry,
      workflowEventSchema.parse({
        ...retryEvent,
        attempt: {
          ...retryEvent.attempt,
          retryStopConditions: {
            ...retryEvent.attempt.retryStopConditions,
            workspaceDriftDetected: true,
          },
        },
      }),
    ];
    expect(() => replayWorkflowEvents(forgedPastWorkspaceDrift)).toThrow(/workspace drift/u);
    expect(() => new InMemoryWorkflowKernel([forgedPastWorkspaceDrift])).toThrow(
      /workspace drift/u,
    );
  });

  it("fails closed when one Checkpoint identity exists in multiple Runs", async () => {
    const root = await createRoot();
    const kernel = new DurableWorkflowKernel(createStore(root));
    for (const suffix of ["-a", "-b"] as const) {
      const fixture = await createAndStart(kernel, { suffix });
      const projection = await kernel.project(fixture.run.runId);
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_CHECKPOINT",
        checkpoint: createCheckpoint(
          fixture,
          `att_replay${suffix}`,
          projection.eventCursor,
          "checkpoint_duplicate",
        ),
      });
    }

    await expect(kernel.recover(checkpointIdSchema.parse("checkpoint_duplicate"))).resolves.toEqual(
      {
        schemaVersion: "1.0.0",
        status: "BLOCKED",
        checkpointId: "checkpoint_duplicate",
        reasons: ["CHECKPOINT_ID_AMBIGUOUS"],
      },
    );
  });

  it("blocks a new mutating Run when the emergency reserve is corrupt", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    await storage.assertNonCriticalGrowth(0);
    await rm(join(root, ".critical-reserve"), { force: true });
    await mkdir(join(root, ".critical-reserve"));
    const store = new FileWorkflowEventStore({ stateRoot: root, storage });
    const kernel = new DurableWorkflowKernel(store);
    const fixture = createWorkflowDomainFixture({ suffix: "-blocked" });

    await expect(
      kernel.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture }),
    ).rejects.toMatchObject({ code: "RESERVE_REQUIRED" });
    expect(await store.listRunIds()).toEqual([]);
  });

  it("blocks a new mutating Run when no atomic-write headroom is available", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(0),
    });
    const store = new FileWorkflowEventStore({ stateRoot: root, storage });
    const kernel = new DurableWorkflowKernel(store);
    const fixture = createWorkflowDomainFixture({ suffix: "-no-space" });

    await expect(
      kernel.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture }),
    ).rejects.toMatchObject({ code: "RESERVE_REQUIRED" });
    expect(await store.listRunIds()).toEqual([]);
  });

  it.each([["BEFORE_TEMP_WRITE", 0]] as const)(
    "accepts no partial Attempt after a %s dispatch fault",
    async (faultBoundary, expectedAttempts) => {
      const root = await createRoot();
      const clean = new DurableWorkflowKernel(createStore(root));
      const fixture = createWorkflowDomainFixture();
      await clean.dispatch({
        schemaVersion: "1.0.0",
        type: "CREATE_RUN",
        ...fixture,
      });
      const faulting = new DurableWorkflowKernel(
        createStore(root, (boundary) => {
          if (boundary === faultBoundary) {
            throw new Error(`fixture fault at ${faultBoundary}`);
          }
        }),
      );

      await expect(
        faulting.dispatch({
          schemaVersion: "1.0.0",
          type: "START_ATTEMPT",
          runId: fixture.run.runId,
          attemptId: attemptIdSchema.parse("att_replay"),
          startedAt: fixtureTimestamp,
        }),
      ).rejects.toMatchObject({ code: "FAULT_INJECTED" });

      const reopened = new DurableWorkflowKernel(createStore(root));
      expect((await reopened.project(fixture.run.runId)).attempts).toHaveLength(expectedAttempts);
    },
  );

  it("confirms an exact Attempt committed before an AFTER_PUBLISH fault", async () => {
    const root = await createRoot();
    const clean = new DurableWorkflowKernel(createStore(root));
    const fixture = createWorkflowDomainFixture();
    await clean.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture });
    let injected = false;
    const faulting = new DurableWorkflowKernel(
      createStore(root, (boundary) => {
        if (!injected && boundary === "AFTER_PUBLISH") {
          injected = true;
          throw new Error("fixture fault after publish");
        }
      }),
    );

    await expect(
      faulting.dispatch({
        schemaVersion: "1.0.0",
        type: "START_ATTEMPT",
        runId: fixture.run.runId,
        attemptId: attemptIdSchema.parse("att_replay"),
        startedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ status: "ACCEPTED", projection: { eventCursor: 2 } });
    const reopened = new DurableWorkflowKernel(createStore(root));
    expect((await reopened.project(fixture.run.runId)).attempts).toHaveLength(1);
  });
});
