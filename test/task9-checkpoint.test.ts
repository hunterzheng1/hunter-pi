import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  attemptIdSchema,
  checkpointIdSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  observationIdSchema,
} from "@hunter-pi/domain";
import { FileWorkflowEventStore } from "@hunter-pi/evidence";
import {
  CheckpointCoordinator,
  DurableWorkflowKernel,
  type CheckpointSnapshot,
} from "@hunter-pi/workflow-kernel";

import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

function snapshotFor(
  checkpointId: string,
  projection: Awaited<ReturnType<DurableWorkflowKernel["project"]>>,
  now: string,
): CheckpointSnapshot {
  const attempt = projection.attempts.at(-1);
  if (attempt === undefined) {
    throw new Error("checkpoint fixture requires an active Attempt");
  }
  return {
    checkpointId: checkpointIdSchema.parse(checkpointId),
    distributionReleaseId: distributionReleaseIdSchema.parse("release_task9"),
    repositoryFingerprint: fixtureFingerprint,
    engine: {
      engineReleaseId: engineReleaseIdSchema.parse("engine-release_task9"),
      engineReleaseFingerprint: fixtureFingerprint,
      sessionReference: { namespace: "pi-session", reference: "session_task9" },
      resumeCapability: "SUPPORTED",
    },
    activeOperationReceiptIds: [],
    unknownOperationIds: [],
    heldWriterLeaseIds: [],
    processReferences: [],
    remainingResourceBudgets: attempt.remainingResourceBudgets,
    createdAt: now,
  };
}

describe("Task 9 durable CheckpointCoordinator", () => {
  it("records at event/time thresholds and stays idempotent after reopening the store", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-checkpoint-");
    const fixture = createWorkflowDomainFixture({ suffix: "task9-checkpoint" });
    const eventStore = new FileWorkflowEventStore({ stateRoot: join(root, "workflow") });
    const firstKernel = new DurableWorkflowKernel(eventStore);
    await firstKernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change: fixture.change,
      planRevision: fixture.planRevision,
      run: fixture.run,
    });
    await firstKernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_task9-checkpoint"),
      startedAt: fixtureTimestamp,
    });
    const capture = vi
      .fn(
        ({
          projection,
          now,
        }: {
          projection: Awaited<ReturnType<DurableWorkflowKernel["project"]>>;
          now: string;
        }) => Promise.resolve(snapshotFor("checkpoint_task9-periodic-1", projection, now)),
      )
      .mockImplementationOnce(
        ({
          projection,
          now,
        }: {
          projection: Awaited<ReturnType<DurableWorkflowKernel["project"]>>;
          now: string;
        }) => Promise.resolve(snapshotFor("checkpoint_task9-periodic-1", projection, now)),
      )
      .mockImplementationOnce(
        ({
          projection,
          now,
        }: {
          projection: Awaited<ReturnType<DurableWorkflowKernel["project"]>>;
          now: string;
        }) => Promise.resolve(snapshotFor("checkpoint_task9-periodic-2", projection, now)),
      );
    const coordinator = new CheckpointCoordinator({
      kernel: firstKernel,
      policy: { everyEvents: 1, everyElapsedMs: 1_000 },
      capture: { capture },
      now: () => "2026-08-03T00:00:01.000Z",
    });

    await expect(coordinator.maybeRecord(fixture.run.runId)).resolves.toMatchObject({
      outcome: "RECORDED",
      checkpointId: "checkpoint_task9-periodic-1",
    });
    await expect(coordinator.maybeRecord(fixture.run.runId)).resolves.toMatchObject({
      outcome: "NOOP",
      reason: "ALREADY_CURRENT",
    });
    await firstKernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_task9-checkpoint-progress"),
        runId: fixture.run.runId,
        attemptId: attemptIdSchema.parse("att_task9-checkpoint"),
        kind: "OUTPUT_CAPTURED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      },
    });
    await expect(coordinator.maybeRecord(fixture.run.runId)).resolves.toMatchObject({
      outcome: "RECORDED",
      checkpointId: "checkpoint_task9-periodic-2",
    });

    const reopened = new DurableWorkflowKernel(
      new FileWorkflowEventStore({ stateRoot: join(root, "workflow") }),
    );
    await expect(reopened.project(fixture.run.runId)).resolves.toMatchObject({
      checkpoints: [
        expect.objectContaining({ checkpointId: "checkpoint_task9-periodic-1" }),
        expect.objectContaining({ checkpointId: "checkpoint_task9-periodic-2" }),
      ],
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("does not capture a checkpoint before either threshold is reached", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task9-checkpoint-gate-");
    const fixture = createWorkflowDomainFixture({ suffix: "task9-checkpoint-gate" });
    const kernel = new DurableWorkflowKernel(
      new FileWorkflowEventStore({ stateRoot: join(root, "workflow") }),
    );
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change: fixture.change,
      planRevision: fixture.planRevision,
      run: fixture.run,
    });
    const capture = vi.fn();
    const coordinator = new CheckpointCoordinator({
      kernel,
      policy: { everyEvents: 10, everyElapsedMs: 60_000 },
      capture: { capture },
      now: () => fixtureTimestamp,
    });

    await expect(coordinator.maybeRecord(fixture.run.runId)).resolves.toMatchObject({
      outcome: "NOOP",
      reason: "THRESHOLD_NOT_REACHED",
    });
    expect(capture).not.toHaveBeenCalled();
  });
});
