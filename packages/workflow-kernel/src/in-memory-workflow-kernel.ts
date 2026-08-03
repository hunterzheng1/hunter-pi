import {
  attemptSchema,
  resourceBudgetsSchema,
  runIdSchema,
  runSchema,
  type Attempt,
  type Checkpoint,
  type CheckpointId,
  type ChangeLifecycle,
  type HumanReceipt,
  type Observation,
  type PlanRevision,
  type ReviewReceipt,
  type ResourceBudgets,
  type ResourceUsage,
  type Run,
  type RunId,
  type VerificationOutcome,
  type VerificationReceipt,
  type VerificationStatus,
} from "@hunter-pi/domain";

import {
  recoveryDecisionSchema,
  runProjectionSchema,
  workflowCommandSchema,
  workflowDecisionSchema,
  workflowEventSchema,
  type CheckProjection,
  type RecoveryDecision,
  type RunProjection,
  type WorkflowCommand,
  type WorkflowDecision,
  type WorkflowEvent,
  type WorkflowKernel,
} from "./contracts.js";

export class WorkflowTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowTransitionError";
  }
}

const budgetUsagePairs = [
  ["maxAgentTurns", "agentTurns"],
  ["maxExternalOperations", "externalOperations"],
  ["maxCommands", "commands"],
  ["maxOutputBytes", "outputBytes"],
  ["maxTokens", "tokens"],
  ["maxCostMinorUnits", "costMinorUnits"],
] as const;

const terminalRunLifecycles = new Set<ChangeLifecycle>([
  "READY",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INCOMPLETE",
]);

function remainingBudgetsAfter(
  budgets: ResourceBudgets,
  usage: ResourceUsage,
  previousRemainingBudgets?: ResourceBudgets,
): ResourceBudgets {
  const remaining: Record<string, number> = {};
  for (const [budgetKey, usageKey] of budgetUsagePairs) {
    const limit = budgets[budgetKey];
    if (limit === undefined) {
      continue;
    }
    const consumed = usage[usageKey];
    if (consumed === undefined) {
      throw new WorkflowTransitionError(
        `resource usage for ${usageKey} is required by the Plan Revision`,
      );
    }
    if (consumed >= limit) {
      throw new WorkflowTransitionError(`resource budget ${budgetKey} is exhausted`);
    }
    const nextRemaining = limit - consumed;
    const previousRemaining = previousRemainingBudgets?.[budgetKey];
    if (previousRemaining !== undefined && nextRemaining > previousRemaining) {
      throw new WorkflowTransitionError(`resource usage for ${usageKey} cannot move backwards`);
    }
    remaining[budgetKey] = nextRemaining;
  }
  return resourceBudgetsSchema.parse(remaining);
}

interface ProjectionState {
  change: RunProjection["change"];
  planRevision: PlanRevision;
  run: Run;
  attempts: Attempt[];
  observations: Observation[];
  verificationReceipts: VerificationReceipt[];
  humanReceipts: HumanReceipt[];
  reviewReceipts: ReviewReceipt[];
  checkpoints: Checkpoint[];
}

function findAttempt(state: ProjectionState, attemptId: string): Attempt {
  const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) {
    throw new WorkflowTransitionError(`unknown Attempt ${attemptId}`);
  }
  return attempt;
}

function replaceAttempt(state: ProjectionState, updated: Attempt): void {
  const index = state.attempts.findIndex((attempt) => attempt.attemptId === updated.attemptId);
  if (index < 0) {
    throw new WorkflowTransitionError(`unknown Attempt ${updated.attemptId}`);
  }
  state.attempts[index] = updated;
}

function verificationStatusFor(
  plan: PlanRevision,
  attempt: Attempt,
  receipts: readonly VerificationReceipt[],
): VerificationStatus {
  const requiredChecks = plan.checks.filter((check) => check.required);
  const latestByCheck = new Map<string, VerificationOutcome>();
  for (const receipt of receipts) {
    if (receipt.attemptId === attempt.attemptId) {
      latestByCheck.set(receipt.checkId, receipt.outcome);
    }
  }
  const outcomes = requiredChecks.map((check) => latestByCheck.get(check.checkId));
  if (outcomes.includes("FAIL")) {
    return "FAILED";
  }
  if (outcomes.includes("BLOCKED")) {
    return "BLOCKED";
  }
  if (outcomes.includes("NOT_PROVEN")) {
    return "NOT_PROVEN";
  }
  if (outcomes.every((outcome) => outcome === "PASS")) {
    return "PASSED";
  }
  return attempt.executionStatus === "RETURNED" ||
    attempt.executionStatus === "INCOMPLETE" ||
    attempt.executionStatus === "INTERRUPTED"
    ? "PENDING"
    : "NOT_READY";
}

function checkProjectionsFor(
  plan: PlanRevision,
  attempt: Attempt | undefined,
  receipts: readonly VerificationReceipt[],
): CheckProjection[] {
  return plan.checks.map((check) => {
    const receipt = [...receipts]
      .reverse()
      .find(
        (candidate) =>
          candidate.attemptId === attempt?.attemptId && candidate.checkId === check.checkId,
      );
    return {
      schemaVersion: "1.0.0",
      checkId: check.checkId,
      required: check.required,
      status: receipt?.outcome ?? "NOT_RUN",
    };
  });
}

function hasSatisfiedHumanGates(
  plan: PlanRevision,
  attempt: Attempt,
  receipts: readonly HumanReceipt[],
): boolean {
  return plan.steps.every((step) => {
    if (step.kind !== "human_gate" || !step.required) {
      return true;
    }
    return receipts.some(
      (receipt) =>
        receipt.attemptId === attempt.attemptId &&
        receipt.stepId === step.stepId &&
        receipt.contentHash === step.expectedContentHash &&
        step.allowedDecisions.includes(receipt.decision) &&
        receipt.decision === "APPROVED",
    );
  });
}

function hasSatisfiedReview(
  plan: PlanRevision,
  attempt: Attempt,
  receipts: readonly ReviewReceipt[],
): boolean {
  return plan.steps.every((step) => {
    if (step.kind !== "review" || !step.required) {
      return true;
    }
    const receipt = [...receipts]
      .reverse()
      .find(
        (candidate) =>
          candidate.attemptId === attempt.attemptId &&
          candidate.stepId === step.stepId &&
          candidate.inputFingerprint === step.inputFingerprint &&
          candidate.reviewDefinitionFingerprint === step.reviewDefinitionFingerprint &&
          candidate.configurationFingerprint === step.configurationFingerprint &&
          candidate.workspaceFingerprint === plan.workspaceFingerprint &&
          candidate.sourceFingerprint === plan.sourceFingerprint,
      );
    return (
      receipt?.outcome === "PASS" &&
      !receipt.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1")
    );
  });
}

function exhaustedGateFailureLifecycle(
  plan: PlanRevision,
  attempt: Attempt,
  humanReceipts: readonly HumanReceipt[],
  reviewReceipts: readonly ReviewReceipt[],
): Extract<ChangeLifecycle, "BLOCKED" | "FAILED" | "INCOMPLETE"> | undefined {
  let failed = false;
  let incomplete = false;

  for (const step of plan.steps) {
    if (!step.required) {
      continue;
    }
    if (step.kind === "human_gate") {
      const receipt = humanReceipts.find(
        (candidate) =>
          candidate.attemptId === attempt.attemptId &&
          candidate.stepId === step.stepId &&
          candidate.contentHash === step.expectedContentHash &&
          step.allowedDecisions.includes(candidate.decision),
      );
      if (receipt?.decision === "BLOCKED") {
        return "BLOCKED";
      }
      if (receipt?.decision === "REJECTED") {
        failed = true;
      }
      continue;
    }
    if (step.kind !== "review") {
      continue;
    }
    const receipt = reviewReceipts.find(
      (candidate) =>
        candidate.attemptId === attempt.attemptId &&
        candidate.stepId === step.stepId &&
        candidate.inputFingerprint === step.inputFingerprint &&
        candidate.reviewDefinitionFingerprint === step.reviewDefinitionFingerprint &&
        candidate.configurationFingerprint === step.configurationFingerprint &&
        candidate.workspaceFingerprint === plan.workspaceFingerprint &&
        candidate.sourceFingerprint === plan.sourceFingerprint,
    );
    if (receipt?.outcome === "BLOCKED") {
      return "BLOCKED";
    }
    if (receipt?.outcome === "NOT_PROVEN") {
      incomplete = true;
    }
    if (
      receipt?.outcome === "FAIL" ||
      receipt?.findings.some((finding) => finding.severity === "P0" || finding.severity === "P1")
    ) {
      failed = true;
    }
  }

  return failed ? "FAILED" : incomplete ? "INCOMPLETE" : undefined;
}

function lifecycleFor(state: ProjectionState): ChangeLifecycle {
  const attempt = state.attempts.at(-1);
  if (attempt === undefined) {
    return "PLANNED";
  }
  if (
    attempt.executionStatus === "PENDING" ||
    attempt.executionStatus === "STARTING" ||
    attempt.executionStatus === "RUNNING" ||
    attempt.executionStatus === "WAITING_INPUT"
  ) {
    return "RUNNING";
  }
  if (attempt.verificationStatus === "PASSED") {
    if (
      hasSatisfiedHumanGates(state.planRevision, attempt, state.humanReceipts) &&
      hasSatisfiedReview(state.planRevision, attempt, state.reviewReceipts)
    ) {
      return "READY";
    }
    if (state.attempts.length >= state.planRevision.loopPolicy.maxIterations) {
      const exhaustedGateFailure = exhaustedGateFailureLifecycle(
        state.planRevision,
        attempt,
        state.humanReceipts,
        state.reviewReceipts,
      );
      if (exhaustedGateFailure !== undefined) {
        return exhaustedGateFailure;
      }
    }
    return "REVIEWING";
  }
  if (attempt.verificationStatus === "BLOCKED") {
    return "BLOCKED";
  }
  if (
    attempt.verificationStatus === "FAILED" &&
    state.attempts.length >= state.planRevision.loopPolicy.maxIterations
  ) {
    return "FAILED";
  }
  if (
    attempt.verificationStatus === "NOT_PROVEN" &&
    state.attempts.length >= state.planRevision.loopPolicy.maxIterations
  ) {
    return "INCOMPLETE";
  }
  return "VERIFYING";
}

function applyEvents(events: readonly WorkflowEvent[]): RunProjection {
  const created = events[0];
  if (created?.type !== "RUN_CREATED") {
    throw new WorkflowTransitionError("a Run must begin with RUN_CREATED");
  }
  const state: ProjectionState = {
    change: created.change,
    planRevision: created.planRevision,
    run: created.run,
    attempts: [],
    observations: [],
    verificationReceipts: [],
    humanReceipts: [],
    reviewReceipts: [],
    checkpoints: [],
  };

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "ATTEMPT_STARTED":
        state.attempts.push(event.attempt);
        break;
      case "OBSERVATION_RECORDED": {
        state.observations.push(event.observation);
        const attempt = findAttempt(state, event.observation.attemptId);
        const executionStatus =
          event.observation.kind === "AGENT_RETURNED"
            ? "RETURNED"
            : event.observation.kind === "PROCESS_EXITED"
              ? "INCOMPLETE"
              : attempt.executionStatus;
        replaceAttempt(state, attemptSchema.parse({ ...attempt, executionStatus }));
        break;
      }
      case "VERIFICATION_RECORDED":
        state.verificationReceipts.push(event.receipt);
        break;
      case "HUMAN_RECEIPT_RECORDED":
        state.humanReceipts.push(event.receipt);
        break;
      case "REVIEW_RECEIPT_RECORDED":
        state.reviewReceipts.push(event.receipt);
        break;
      case "CHECKPOINT_RECORDED":
        state.checkpoints.push(event.checkpoint);
        break;
      case "RUN_CREATED":
        throw new WorkflowTransitionError("a Run cannot be created twice");
    }
  }

  for (const attempt of [...state.attempts]) {
    replaceAttempt(
      state,
      attemptSchema.parse({
        ...attempt,
        verificationStatus: verificationStatusFor(
          state.planRevision,
          attempt,
          state.verificationReceipts,
        ),
      }),
    );
  }
  const currentAttempt = state.attempts.at(-1);
  state.run = runSchema.parse({
    ...state.run,
    lifecycle: lifecycleFor(state),
  });
  state.change = managedChangeWithLifecycle(state, state.run.lifecycle);

  return runProjectionSchema.parse({
    schemaVersion: "1.0.0",
    ...state,
    checks: checkProjectionsFor(state.planRevision, currentAttempt, state.verificationReceipts),
    eventCursor: events.at(-1)?.cursor,
  });
}

function managedChangeWithLifecycle(
  state: ProjectionState,
  lifecycle: ChangeLifecycle,
): ProjectionState["change"] {
  return { ...state.change, lifecycle };
}

export class InMemoryWorkflowKernel implements WorkflowKernel {
  readonly #eventsByRun = new Map<RunId, WorkflowEvent[]>();

  public async dispatch(command: WorkflowCommand): Promise<WorkflowDecision> {
    const parsed = workflowCommandSchema.parse(command);
    if (parsed.type === "CREATE_RUN") {
      this.#validateCreate(parsed);
      const event = workflowEventSchema.parse({
        schemaVersion: "1.0.0",
        cursor: 1,
        type: "RUN_CREATED",
        change: parsed.change,
        planRevision: parsed.planRevision,
        run: parsed.run,
      });
      this.#eventsByRun.set(parsed.run.runId, [event]);
      return this.#accepted(parsed.run.runId, [event]);
    }

    const runId = this.#runIdFor(parsed);
    const current = await this.project(runId);
    if (terminalRunLifecycles.has(current.run.lifecycle)) {
      throw new WorkflowTransitionError(
        `Run ${runId} has terminal ${current.run.lifecycle} outcome; create a replacement Run`,
      );
    }
    const event = this.#decide(parsed, current);
    this.#eventsFor(runId).push(event);
    return this.#accepted(runId, [event]);
  }

  public project(runId: RunId): Promise<RunProjection> {
    return Promise.resolve(applyEvents(this.#eventsFor(runId)));
  }

  public async recover(checkpointId: CheckpointId): Promise<RecoveryDecision> {
    for (const [runId] of this.#eventsByRun) {
      const projection = await this.project(runId);
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.checkpointId === checkpointId,
      );
      if (checkpoint !== undefined) {
        return recoveryDecisionSchema.parse({
          schemaVersion: "1.0.0",
          status: "NOT_PROVEN",
          checkpoint,
          projection,
          reasons: [
            "IN_MEMORY_STATE_NOT_DURABLE",
            "WORKSPACE_NOT_REVALIDATED",
            "ENGINE_STATE_NOT_RECONCILED",
          ],
        });
      }
    }
    return recoveryDecisionSchema.parse({ schemaVersion: "1.0.0", status: "NOT_FOUND" });
  }

  #validateCreate(command: Extract<WorkflowCommand, { type: "CREATE_RUN" }>): void {
    if (this.#eventsByRun.has(command.run.runId)) {
      throw new WorkflowTransitionError(`Run ${command.run.runId} already exists`);
    }
    if (
      command.change.changeId !== command.planRevision.changeId ||
      command.change.changeId !== command.run.changeId ||
      command.planRevision.planRevisionId !== command.run.planRevisionId ||
      command.planRevision.workspaceId !== command.run.workspaceId ||
      command.planRevision.workspaceFingerprint !== command.run.workspaceFingerprint ||
      command.planRevision.sourceFingerprint !== command.run.sourceFingerprint
    ) {
      throw new WorkflowTransitionError("Change, Plan Revision, and Run identities do not match");
    }
    if (command.run.lifecycle !== "PLANNED") {
      throw new WorkflowTransitionError("a new Run must be PLANNED");
    }
  }

  #runIdFor(command: Exclude<WorkflowCommand, { type: "CREATE_RUN" }>): RunId {
    if (command.type === "RECORD_OBSERVATION") {
      return command.observation.runId;
    }
    if (command.type === "RECORD_VERIFICATION") {
      return command.receipt.runId;
    }
    if (command.type === "RECORD_HUMAN_RECEIPT") {
      return command.receipt.runId;
    }
    if (command.type === "RECORD_REVIEW_RECEIPT") {
      return command.receipt.runId;
    }
    if (command.type === "RECORD_CHECKPOINT") {
      return command.checkpoint.runId;
    }
    return command.runId;
  }

  #decide(
    command: Exclude<WorkflowCommand, { type: "CREATE_RUN" }>,
    current: RunProjection,
  ): WorkflowEvent {
    const cursor = current.eventCursor + 1;
    switch (command.type) {
      case "START_ATTEMPT": {
        if (current.attempts.length > 0) {
          throw new WorkflowTransitionError("use RETRY_ATTEMPT after the first try");
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "ATTEMPT_STARTED",
          attempt: {
            schemaVersion: "1.0.0",
            attemptId: command.attemptId,
            runId: command.runId,
            planRevisionId: current.planRevision.planRevisionId,
            sequence: 1,
            elapsedMsAtStart: 0,
            remainingResourceBudgets: current.planRevision.loopPolicy.resourceBudgets,
            executionStatus: "RUNNING",
            verificationStatus: "NOT_READY",
            startedAt: command.startedAt,
          },
        });
      }
      case "RECORD_OBSERVATION":
        this.#requireAttempt(current, command.observation.attemptId);
        if (
          current.observations.some(
            (observation) => observation.observationId === command.observation.observationId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Observation ${command.observation.observationId} already exists`,
          );
        }
        if (
          command.observation.stepId !== undefined &&
          !current.planRevision.steps.some((step) => step.stepId === command.observation.stepId)
        ) {
          throw new WorkflowTransitionError("Observation Step is not predeclared");
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "OBSERVATION_RECORDED",
          observation: command.observation,
        });
      case "RECORD_VERIFICATION":
        this.#validateVerification(current, command.receipt);
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "VERIFICATION_RECORDED",
          receipt: command.receipt,
        });
      case "RECORD_HUMAN_RECEIPT": {
        this.#requireAttempt(current, command.receipt.attemptId);
        if (
          current.humanReceipts.some(
            (receipt) => receipt.humanReceiptId === command.receipt.humanReceiptId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Human Receipt ${command.receipt.humanReceiptId} already exists`,
          );
        }
        if (
          current.humanReceipts.some(
            (receipt) =>
              receipt.attemptId === command.receipt.attemptId &&
              receipt.stepId === command.receipt.stepId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Attempt ${command.receipt.attemptId} already has a Human Receipt for ${command.receipt.stepId}`,
          );
        }
        const humanGate = current.planRevision.steps.find(
          (step) => step.stepId === command.receipt.stepId,
        );
        if (humanGate?.kind !== "human_gate") {
          throw new WorkflowTransitionError("Human Receipt is not predeclared");
        }
        if (
          command.receipt.contentHash !== humanGate.expectedContentHash ||
          !humanGate.allowedDecisions.includes(command.receipt.decision)
        ) {
          throw new WorkflowTransitionError(
            "Human Receipt does not bind the predeclared content and decision",
          );
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "HUMAN_RECEIPT_RECORDED",
          receipt: command.receipt,
        });
      }
      case "RECORD_REVIEW_RECEIPT": {
        this.#requireAttempt(current, command.receipt.attemptId);
        if (
          current.reviewReceipts.some(
            (receipt) => receipt.reviewReceiptId === command.receipt.reviewReceiptId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Review Receipt ${command.receipt.reviewReceiptId} already exists`,
          );
        }
        if (
          current.reviewReceipts.some(
            (receipt) =>
              receipt.attemptId === command.receipt.attemptId &&
              receipt.stepId === command.receipt.stepId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Attempt ${command.receipt.attemptId} already has a Review Receipt for ${command.receipt.stepId}`,
          );
        }
        const reviewStep = current.planRevision.steps.find(
          (step) => step.stepId === command.receipt.stepId,
        );
        if (reviewStep?.kind !== "review") {
          throw new WorkflowTransitionError("Review Receipt is not predeclared");
        }
        if (
          command.receipt.inputFingerprint !== reviewStep.inputFingerprint ||
          command.receipt.reviewDefinitionFingerprint !== reviewStep.reviewDefinitionFingerprint ||
          command.receipt.configurationFingerprint !== reviewStep.configurationFingerprint ||
          command.receipt.workspaceFingerprint !== current.planRevision.workspaceFingerprint ||
          command.receipt.sourceFingerprint !== current.planRevision.sourceFingerprint
        ) {
          throw new WorkflowTransitionError(
            "Review Receipt does not bind the predeclared review and source identity",
          );
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "REVIEW_RECEIPT_RECORDED",
          receipt: command.receipt,
        });
      }
      case "RETRY_ATTEMPT": {
        const previous = this.#requireAttempt(current, command.previousAttemptId);
        if (current.attempts.at(-1)?.attemptId !== previous.attemptId) {
          throw new WorkflowTransitionError("retry must follow the latest Attempt");
        }
        if (!["RETURNED", "INTERRUPTED", "INCOMPLETE"].includes(previous.executionStatus)) {
          throw new WorkflowTransitionError(
            "retry cannot start while the previous Attempt execution is still active",
          );
        }
        const hasGateFailure =
          current.humanReceipts.some(
            (receipt) =>
              receipt.attemptId === previous.attemptId &&
              receipt.decision !== "APPROVED" &&
              current.planRevision.steps.some(
                (step) =>
                  step.kind === "human_gate" && step.required && step.stepId === receipt.stepId,
              ),
          ) ||
          current.reviewReceipts.some(
            (receipt) =>
              receipt.attemptId === previous.attemptId &&
              current.planRevision.steps.some(
                (step) => step.kind === "review" && step.required && step.stepId === receipt.stepId,
              ) &&
              (receipt.outcome !== "PASS" ||
                receipt.findings.some(
                  (finding) => finding.severity === "P0" || finding.severity === "P1",
                )),
          );
        if (
          !["FAILED", "BLOCKED", "NOT_PROVEN"].includes(previous.verificationStatus) &&
          !hasGateFailure
        ) {
          throw new WorkflowTransitionError(
            "retry requires a failed, blocked, or not-proven Verification or gate result",
          );
        }
        if (current.attempts.length >= current.planRevision.loopPolicy.maxIterations) {
          throw new WorkflowTransitionError("iteration budget is exhausted");
        }
        if (command.elapsedMs >= current.planRevision.loopPolicy.maxElapsedMs) {
          throw new WorkflowTransitionError("elapsed budget is exhausted");
        }
        if (command.elapsedMs < previous.elapsedMsAtStart) {
          throw new WorkflowTransitionError("elapsed usage cannot move backwards");
        }
        if (Date.parse(command.startedAt) < Date.parse(previous.startedAt)) {
          throw new WorkflowTransitionError("Attempt start time cannot move backwards");
        }
        if (current.planRevision.loopPolicy.stopOnUserInput && command.userInputRequired) {
          throw new WorkflowTransitionError("retry stopped for required user input");
        }
        if (
          current.planRevision.loopPolicy.stopOnWorkspaceDrift &&
          command.workspaceDriftDetected
        ) {
          throw new WorkflowTransitionError("retry stopped for workspace drift");
        }
        const repeatedFailureCount =
          current.attempts.filter(
            (attempt) => attempt.precedingFailureFingerprint === command.failureFingerprint,
          ).length + 1;
        if (repeatedFailureCount >= current.planRevision.loopPolicy.repeatedFailureLimit) {
          throw new WorkflowTransitionError("repeated failure fingerprint limit reached");
        }
        const matchingVerificationReceipts = current.verificationReceipts.filter(
          (receipt) =>
            receipt.attemptId === previous.attemptId &&
            receipt.outcome !== "PASS" &&
            receipt.resultFingerprint === command.failureFingerprint,
        );
        const matchingHumanReceipts = current.humanReceipts.filter(
          (receipt) =>
            receipt.attemptId === previous.attemptId &&
            receipt.decision !== "APPROVED" &&
            receipt.resultFingerprint === command.failureFingerprint &&
            current.planRevision.steps.some(
              (step) =>
                step.kind === "human_gate" && step.required && step.stepId === receipt.stepId,
            ),
        );
        const matchingReviewReceipts = current.reviewReceipts.filter(
          (receipt) =>
            receipt.attemptId === previous.attemptId &&
            receipt.resultFingerprint === command.failureFingerprint &&
            current.planRevision.steps.some(
              (step) => step.kind === "review" && step.required && step.stepId === receipt.stepId,
            ) &&
            (receipt.outcome !== "PASS" ||
              receipt.findings.some(
                (finding) => finding.severity === "P0" || finding.severity === "P1",
              )),
        );
        const precedingFailureEvidence = new Set([
          ...matchingVerificationReceipts.flatMap((receipt) => receipt.evidenceIds),
          ...matchingHumanReceipts.flatMap((receipt) => receipt.evidenceIds),
          ...matchingReviewReceipts.flatMap((receipt) => [
            ...receipt.evidenceIds,
            ...receipt.findings.flatMap((finding) => finding.evidenceIds),
          ]),
        ]);
        if (
          matchingVerificationReceipts.length +
            matchingHumanReceipts.length +
            matchingReviewReceipts.length ===
            0 ||
          command.failureEvidenceIds.some((evidenceId) => !precedingFailureEvidence.has(evidenceId))
        ) {
          throw new WorkflowTransitionError(
            "retry Evidence is not bound to the preceding failed Attempt",
          );
        }
        if (current.attempts.some((attempt) => attempt.attemptId === command.attemptId)) {
          throw new WorkflowTransitionError("Attempt identity must be unique");
        }
        const remainingResourceBudgets = remainingBudgetsAfter(
          current.planRevision.loopPolicy.resourceBudgets,
          command.consumedResources,
          previous.remainingResourceBudgets,
        );
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "ATTEMPT_STARTED",
          attempt: {
            schemaVersion: "1.0.0",
            attemptId: command.attemptId,
            runId: command.runId,
            planRevisionId: current.planRevision.planRevisionId,
            sequence: current.attempts.length + 1,
            previousAttemptId: command.previousAttemptId,
            failureEvidenceIds: command.failureEvidenceIds,
            retryReason: command.reason,
            precedingFailureFingerprint: command.failureFingerprint,
            elapsedMsAtStart: command.elapsedMs,
            remainingResourceBudgets,
            executionStatus: "RUNNING",
            verificationStatus: "NOT_READY",
            startedAt: command.startedAt,
          },
        });
      }
      case "RECORD_CHECKPOINT":
        if (command.checkpoint.planRevisionId !== current.planRevision.planRevisionId) {
          throw new WorkflowTransitionError("Checkpoint uses a different Plan Revision");
        }
        if (
          command.checkpoint.workspaceId !== current.planRevision.workspaceId ||
          command.checkpoint.workspaceFingerprint !== current.planRevision.workspaceFingerprint ||
          command.checkpoint.sourceFingerprint !== current.planRevision.sourceFingerprint
        ) {
          throw new WorkflowTransitionError(
            "Checkpoint does not bind the active workspace and source",
          );
        }
        if (command.checkpoint.eventCursor !== current.eventCursor) {
          throw new WorkflowTransitionError(
            "Checkpoint event cursor does not match the durable projection",
          );
        }
        if (command.checkpoint.attemptId !== undefined) {
          this.#requireAttempt(current, command.checkpoint.attemptId);
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "CHECKPOINT_RECORDED",
          checkpoint: command.checkpoint,
        });
    }
  }

  #validateVerification(current: RunProjection, receipt: VerificationReceipt): void {
    this.#requireAttempt(current, receipt.attemptId);
    if (
      current.verificationReceipts.some(
        (candidate) => candidate.verificationReceiptId === receipt.verificationReceiptId,
      )
    ) {
      throw new WorkflowTransitionError(
        `Verification Receipt ${receipt.verificationReceiptId} already exists`,
      );
    }
    if (
      current.verificationReceipts.some(
        (candidate) =>
          candidate.attemptId === receipt.attemptId && candidate.checkId === receipt.checkId,
      )
    ) {
      throw new WorkflowTransitionError(
        `Attempt ${receipt.attemptId} already has a Verification Receipt for ${receipt.checkId}`,
      );
    }
    const check = current.planRevision.checks.find(
      (candidate) => candidate.checkId === receipt.checkId,
    );
    if (check === undefined) {
      throw new WorkflowTransitionError("Verification check is not predeclared");
    }
    if (
      receipt.checkVersion !== check.version ||
      receipt.checkDefinitionFingerprint !== check.definitionFingerprint ||
      receipt.configFingerprint !== check.configurationFingerprint ||
      receipt.workspaceFingerprint !== current.planRevision.workspaceFingerprint ||
      receipt.sourceFingerprint !== current.planRevision.sourceFingerprint
    ) {
      throw new WorkflowTransitionError(
        "Verification Receipt does not bind the active check and source identity",
      );
    }
  }

  #requireAttempt(current: RunProjection, attemptId: string): Attempt {
    const attempt = current.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) {
      throw new WorkflowTransitionError(`unknown Attempt ${attemptId}`);
    }
    return attempt;
  }

  #eventsFor(runId: RunId): WorkflowEvent[] {
    const parsedRunId = runIdSchema.parse(runId);
    const events = this.#eventsByRun.get(parsedRunId);
    if (events === undefined) {
      throw new WorkflowTransitionError(`unknown Run ${parsedRunId}`);
    }
    return events;
  }

  async #accepted(runId: RunId, events: readonly WorkflowEvent[]): Promise<WorkflowDecision> {
    return workflowDecisionSchema.parse({
      schemaVersion: "1.0.0",
      status: "ACCEPTED",
      events: events.map((event) => workflowEventSchema.parse(event)),
      projection: await this.project(runId),
    });
  }
}
