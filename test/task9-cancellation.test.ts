import { describe, expect, it } from "vitest";

import {
  attemptFinalityReceiptIdSchema,
  attemptIdSchema,
  checkpointIdSchema,
  checkpointSchema,
  evidenceIdSchema,
  observationIdSchema,
} from "@hunter-pi/domain";
import { InMemoryWorkflowKernel } from "@hunter-pi/workflow-kernel";

import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";

describe("Task 9 cancellation facts", () => {
  it.each(["AGENT_RETURNED", "PROCESS_EXITED"] as const)(
    "does not treat a raw %s observation as Attempt finality",
    async (kind) => {
      const identityBody = kind.toLowerCase().replace("_", "-");
      const fixture = createWorkflowDomainFixture({
        suffix: `task9-cancel-unbound-${identityBody}`,
      });
      const kernel = new InMemoryWorkflowKernel();
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "CREATE_RUN",
        change: fixture.change,
        planRevision: fixture.planRevision,
        run: fixture.run,
      });
      const attemptId = attemptIdSchema.parse(`att_task9-cancel-unbound-${identityBody}`);
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "START_ATTEMPT",
        runId: fixture.run.runId,
        attemptId,
        startedAt: fixtureTimestamp,
      });
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_OBSERVATION",
        observation: {
          schemaVersion: "1.0.0",
          observationId: observationIdSchema.parse(`obs_task9-cancel-unbound-${identityBody}`),
          runId: fixture.run.runId,
          attemptId,
          kind,
          observedAt: "2026-08-03T00:00:01.000Z",
          evidenceIds: [],
        },
      });

      await expect(
        kernel.dispatch({
          schemaVersion: "1.0.0",
          type: "CANCEL_RUN",
          runId: fixture.run.runId,
          reason: "USER_CANCELLED_AFTER_UNSAFE_INTERRUPTION",
          endedAt: "2026-08-03T00:00:02.000Z",
        }),
      ).rejects.toThrow(/Attempt Finality Receipt/u);
    },
  );

  it("records a durable cancellation only after exact Attempt finality is received", async () => {
    const fixture = createWorkflowDomainFixture({ suffix: "task9-cancel" });
    const kernel = new InMemoryWorkflowKernel();
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change: fixture.change,
      planRevision: fixture.planRevision,
      run: fixture.run,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_task9-cancel"),
      startedAt: fixtureTimestamp,
    });

    await expect(
      kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "CANCEL_RUN",
        runId: fixture.run.runId,
        reason: "USER_CANCELLED_AFTER_UNSAFE_INTERRUPTION",
        endedAt: "2026-08-03T00:00:01.000Z",
      }),
    ).rejects.toThrow(/active execution/u);

    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_task9-cancel-exited"),
        runId: fixture.run.runId,
        attemptId: attemptIdSchema.parse("att_task9-cancel"),
        kind: "PROCESS_EXITED",
        observedAt: "2026-08-03T00:00:01.000Z",
        evidenceIds: [],
      },
    });
    const afterExit = await kernel.project(fixture.run.runId);
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: checkpointIdSchema.parse("checkpoint_task9-cancel-finality"),
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_task9-cancel"),
      planRevisionId: fixture.planRevision.planRevisionId,
      distributionReleaseId: "release_task9-cancel",
      workspaceId: fixture.planRevision.workspaceId,
      repositoryFingerprint: fixtureFingerprint,
      workspaceFingerprint: fixture.planRevision.workspaceFingerprint,
      sourceFingerprint: fixture.planRevision.sourceFingerprint,
      eventCursor: afterExit.eventCursor,
      createdAt: "2026-08-03T00:00:01.000Z",
      engine: {
        engineReleaseId: "engine-release_task9-cancel",
        engineReleaseFingerprint: fixtureFingerprint,
        resumeCapability: "UNSUPPORTED",
      },
      activeOperationReceiptIds: [],
      unknownOperationIds: [],
      heldWriterLeaseIds: [],
      processReferences: [],
      remainingResourceBudgets: fixture.planRevision.loopPolicy.resourceBudgets,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_CHECKPOINT",
      checkpoint,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_ATTEMPT_FINALITY",
      receipt: {
        schemaVersion: "1.0.0",
        attemptFinalityReceiptId: attemptFinalityReceiptIdSchema.parse("finality_task9-cancel"),
        runId: fixture.run.runId,
        attemptId: attemptIdSchema.parse("att_task9-cancel"),
        checkpointId: checkpoint.checkpointId,
        workspaceId: fixture.planRevision.workspaceId,
        workspaceFingerprint: fixture.planRevision.workspaceFingerprint,
        sourceFingerprint: fixture.planRevision.sourceFingerprint,
        processFinalities: [],
        releasedWriterLeaseIds: [],
        terminalFinality: "FINAL",
        evidenceIds: [evidenceIdSchema.parse("evidence_task9-cancel-finality")],
        observedAt: "2026-08-03T00:00:01.000Z",
      },
    });
    const recordedFinality = (await kernel.project(fixture.run.runId)).attemptFinalityReceipts[0];
    if (recordedFinality === undefined) {
      throw new Error("missing recorded Attempt Finality Receipt");
    }
    await expect(
      kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_ATTEMPT_FINALITY",
        receipt: recordedFinality,
      }),
    ).rejects.toThrow(/immutable Attempt Finality Receipt/u);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CANCEL_RUN",
      runId: fixture.run.runId,
      reason: "USER_CANCELLED_AFTER_UNSAFE_INTERRUPTION",
      endedAt: "2026-08-03T00:00:02.000Z",
    });

    await expect(kernel.project(fixture.run.runId)).resolves.toMatchObject({
      run: {
        lifecycle: "CANCELLED",
        terminalReason: "USER_CANCELLED_AFTER_UNSAFE_INTERRUPTION",
        endedAt: "2026-08-03T00:00:02.000Z",
      },
      change: { lifecycle: "CANCELLED" },
      attemptFinalityReceipts: [
        { attemptFinalityReceiptId: "finality_task9-cancel", terminalFinality: "FINAL" },
      ],
    });
  });
});
