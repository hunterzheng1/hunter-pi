import { describe, expect, it } from "vitest";

import { attemptIdSchema, observationIdSchema } from "@hunter-pi/domain";
import { InMemoryWorkflowKernel } from "@hunter-pi/workflow-kernel";

import {
  createWorkflowDomainFixture,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";

describe("Task 9 cancellation facts", () => {
  it("records a durable cancellation only after execution finality is observed", async () => {
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
    });
  });
});
