import {
  recoveryDecisionSchema,
  runProjectionSchema,
  workflowCommandSchema,
  workflowDecisionSchema,
  type RecoveryDecision,
  type RunProjection,
  type WorkflowCommand,
  type WorkflowDecision,
  type WorkflowEventStore,
  type WorkflowKernel,
} from "./contracts.js";
import {
  InMemoryWorkflowKernel,
  WorkflowTransitionError,
  replayWorkflowEvents,
} from "./in-memory-workflow-kernel.js";

import { runIdSchema, type CheckpointId, type RunId } from "@hunter-pi/domain";

function commandRunId(command: WorkflowCommand): RunId {
  switch (command.type) {
    case "CREATE_RUN":
      return command.run.runId;
    case "START_ATTEMPT":
    case "RETRY_ATTEMPT":
      return command.runId;
    case "RECORD_OBSERVATION":
      return command.observation.runId;
    case "RECORD_VERIFICATION":
    case "RECORD_HUMAN_RECEIPT":
    case "RECORD_REVIEW_RECEIPT":
      return command.receipt.runId;
    case "RECORD_CHECKPOINT":
      return command.checkpoint.runId;
  }
}

export class DurableWorkflowKernel implements WorkflowKernel {
  readonly #store: WorkflowEventStore;

  public constructor(store: WorkflowEventStore) {
    this.#store = store;
  }

  public async dispatch(command: WorkflowCommand): Promise<WorkflowDecision> {
    const parsed = workflowCommandSchema.parse(command);
    if (parsed.type === "CREATE_RUN") {
      await this.#store.assertMutatingRunAllowed();
    }
    const runId = commandRunId(parsed);
    const durableEvents = await this.#store.read(runId);
    const inMemory = new InMemoryWorkflowKernel(durableEvents.length === 0 ? [] : [durableEvents]);
    const decision = await inMemory.dispatch(parsed);
    const expectedCursor = durableEvents.at(-1)?.cursor ?? 0;
    await this.#store.append({
      schemaVersion: "1.0.0",
      runId,
      expectedCursor,
      events: [...decision.events],
    });
    const replayedEvents = await this.#store.read(runId);
    return workflowDecisionSchema.parse({
      schemaVersion: "1.0.0",
      status: "ACCEPTED",
      events: decision.events,
      projection: replayWorkflowEvents(replayedEvents),
    });
  }

  public async project(runId: RunId): Promise<RunProjection> {
    const parsedRunId = runIdSchema.parse(runId);
    const events = await this.#store.read(parsedRunId);
    if (events.length === 0) {
      throw new WorkflowTransitionError(`unknown Run ${parsedRunId}`);
    }
    return runProjectionSchema.parse(replayWorkflowEvents(events));
  }

  public async recover(checkpointId: CheckpointId): Promise<RecoveryDecision> {
    const matches: {
      projection: RunProjection;
      checkpoint: RunProjection["checkpoints"][number];
    }[] = [];
    for (const runId of await this.#store.listRunIds()) {
      const projection = await this.project(runId);
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.checkpointId === checkpointId,
      );
      if (checkpoint !== undefined) {
        matches.push({ projection, checkpoint });
      }
    }
    if (matches.length > 1) {
      return recoveryDecisionSchema.parse({
        schemaVersion: "1.0.0",
        status: "BLOCKED",
        checkpointId,
        reasons: ["CHECKPOINT_ID_AMBIGUOUS"],
      });
    }
    const match = matches[0];
    if (match !== undefined) {
      return recoveryDecisionSchema.parse({
        schemaVersion: "1.0.0",
        status: "NOT_PROVEN",
        checkpoint: match.checkpoint,
        projection: match.projection,
        reasons: [
          "DISTRIBUTION_RELEASE_NOT_REVALIDATED",
          "WORKSPACE_NOT_REVALIDATED",
          "ENGINE_STATE_NOT_RECONCILED",
        ],
      });
    }
    return recoveryDecisionSchema.parse({ schemaVersion: "1.0.0", status: "NOT_FOUND" });
  }
}
