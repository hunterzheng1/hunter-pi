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

function executionStatusAfterObservation(
  currentStatus: Attempt["executionStatus"],
  observationKind: Observation["kind"],
): Attempt["executionStatus"] {
  if (observationKind === "AGENT_RETURNED") {
    return "RETURNED";
  }
  if (observationKind === "PROCESS_EXITED" && currentStatus !== "RETURNED") {
    return "INCOMPLETE";
  }
  return currentStatus;
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
  if (state.run.lifecycle === "CANCELLED") {
    return "CANCELLED";
  }
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

export function assertRunProjectionIntegrity(input: RunProjection): void {
  const projection = runProjectionSchema.parse(input);
  if (
    projection.change.changeId !== projection.planRevision.changeId ||
    projection.change.changeId !== projection.run.changeId ||
    projection.planRevision.planRevisionId !== projection.run.planRevisionId ||
    projection.planRevision.workspaceId !== projection.run.workspaceId ||
    projection.planRevision.workspaceFingerprint !== projection.run.workspaceFingerprint ||
    projection.planRevision.sourceFingerprint !== projection.run.sourceFingerprint
  ) {
    throw new WorkflowTransitionError("Run projection identities do not match");
  }
  if (projection.attempts.length > projection.planRevision.loopPolicy.maxIterations) {
    throw new WorkflowTransitionError("Run projection exceeds its Attempt iteration budget");
  }

  const attemptIds = new Set<string>();
  for (const [index, attempt] of projection.attempts.entries()) {
    const previous = projection.attempts[index - 1];
    if (
      attemptIds.has(attempt.attemptId) ||
      attempt.runId !== projection.run.runId ||
      attempt.planRevisionId !== projection.planRevision.planRevisionId ||
      attempt.sequence !== index + 1 ||
      (index === 0 && attempt.previousAttemptId !== undefined) ||
      (index > 0 && attempt.previousAttemptId !== previous?.attemptId)
    ) {
      throw new WorkflowTransitionError("Run projection contains an invalid Attempt identity");
    }
    attemptIds.add(attempt.attemptId);
  }

  const observationIds = new Set<string>();
  const expectedExecution = new Map<string, Attempt["executionStatus"]>(
    projection.attempts.map((attempt) => [attempt.attemptId, "RUNNING"]),
  );
  for (const observation of projection.observations) {
    if (
      observationIds.has(observation.observationId) ||
      observation.runId !== projection.run.runId ||
      !attemptIds.has(observation.attemptId) ||
      (observation.stepId !== undefined &&
        !projection.planRevision.steps.some((step) => step.stepId === observation.stepId))
    ) {
      throw new WorkflowTransitionError("Run projection contains an invalid Observation");
    }
    observationIds.add(observation.observationId);
    expectedExecution.set(
      observation.attemptId,
      executionStatusAfterObservation(
        expectedExecution.get(observation.attemptId) ?? "RUNNING",
        observation.kind,
      ),
    );
  }
  for (const [index, attempt] of projection.attempts.entries()) {
    const previous = projection.attempts[index - 1];
    if (previous === undefined) {
      continue;
    }
    if (
      projection.planRevision.loopPolicy.stopOnUserInput &&
      (attempt.retryStopConditions?.userInputRequired === true ||
        projection.observations.some(
          (observation) =>
            observation.attemptId === previous.attemptId && observation.kind === "INPUT_REQUESTED",
        ))
    ) {
      throw new WorkflowTransitionError("Run projection retry crossed required user input");
    }
    if (
      projection.planRevision.loopPolicy.stopOnWorkspaceDrift &&
      attempt.retryStopConditions?.workspaceDriftDetected === true
    ) {
      throw new WorkflowTransitionError("Run projection retry crossed workspace drift");
    }
  }

  const verificationIds = new Set<string>();
  const verificationPairs = new Set<string>();
  for (const receipt of projection.verificationReceipts) {
    const check = projection.planRevision.checks.find(
      (candidate) => candidate.checkId === receipt.checkId,
    );
    const pair = `${receipt.attemptId}\0${receipt.checkId}`;
    if (
      verificationIds.has(receipt.verificationReceiptId) ||
      verificationPairs.has(pair) ||
      receipt.runId !== projection.run.runId ||
      !attemptIds.has(receipt.attemptId) ||
      receipt.checkVersion !== check?.version ||
      receipt.checkDefinitionFingerprint !== check.definitionFingerprint ||
      receipt.configFingerprint !== check.configurationFingerprint ||
      receipt.workspaceFingerprint !== projection.planRevision.workspaceFingerprint ||
      receipt.sourceFingerprint !== projection.planRevision.sourceFingerprint
    ) {
      throw new WorkflowTransitionError(
        "Run projection contains a duplicate or unbound Verification Receipt",
      );
    }
    verificationIds.add(receipt.verificationReceiptId);
    verificationPairs.add(pair);
  }

  const humanIds = new Set<string>();
  const humanPairs = new Set<string>();
  for (const receipt of projection.humanReceipts) {
    const step = projection.planRevision.steps.find(
      (candidate) => candidate.stepId === receipt.stepId,
    );
    const pair = `${receipt.attemptId}\0${receipt.stepId}`;
    if (
      humanIds.has(receipt.humanReceiptId) ||
      humanPairs.has(pair) ||
      receipt.runId !== projection.run.runId ||
      !attemptIds.has(receipt.attemptId) ||
      step?.kind !== "human_gate" ||
      receipt.contentHash !== step.expectedContentHash ||
      !step.allowedDecisions.includes(receipt.decision)
    ) {
      throw new WorkflowTransitionError(
        "Run projection contains a duplicate or unbound Human Receipt",
      );
    }
    humanIds.add(receipt.humanReceiptId);
    humanPairs.add(pair);
  }

  const reviewIds = new Set<string>();
  const reviewPairs = new Set<string>();
  for (const receipt of projection.reviewReceipts) {
    const step = projection.planRevision.steps.find(
      (candidate) => candidate.stepId === receipt.stepId,
    );
    const pair = `${receipt.attemptId}\0${receipt.stepId}`;
    if (
      reviewIds.has(receipt.reviewReceiptId) ||
      reviewPairs.has(pair) ||
      receipt.runId !== projection.run.runId ||
      !attemptIds.has(receipt.attemptId) ||
      step?.kind !== "review" ||
      receipt.inputFingerprint !== step.inputFingerprint ||
      receipt.reviewDefinitionFingerprint !== step.reviewDefinitionFingerprint ||
      receipt.configurationFingerprint !== step.configurationFingerprint ||
      receipt.workspaceFingerprint !== projection.planRevision.workspaceFingerprint ||
      receipt.sourceFingerprint !== projection.planRevision.sourceFingerprint
    ) {
      throw new WorkflowTransitionError(
        "Run projection contains a duplicate or unbound Review Receipt",
      );
    }
    reviewIds.add(receipt.reviewReceiptId);
    reviewPairs.add(pair);
  }

  const checkpointIds = new Set<string>();
  for (const checkpoint of projection.checkpoints) {
    if (
      checkpointIds.has(checkpoint.checkpointId) ||
      checkpoint.runId !== projection.run.runId ||
      checkpoint.planRevisionId !== projection.planRevision.planRevisionId ||
      checkpoint.workspaceId !== projection.planRevision.workspaceId ||
      checkpoint.workspaceFingerprint !== projection.planRevision.workspaceFingerprint ||
      checkpoint.sourceFingerprint !== projection.planRevision.sourceFingerprint ||
      checkpoint.eventCursor >= projection.eventCursor ||
      (checkpoint.attemptId !== undefined && !attemptIds.has(checkpoint.attemptId))
    ) {
      throw new WorkflowTransitionError("Run projection contains an invalid Checkpoint");
    }
    checkpointIds.add(checkpoint.checkpointId);
  }

  const projectedAttempts = projection.attempts.map((attempt) => {
    const executionStatus = expectedExecution.get(attempt.attemptId);
    if (executionStatus === undefined) {
      throw new WorkflowTransitionError("Run projection lost an Attempt execution status");
    }
    const withExecution = attemptSchema.parse({ ...attempt, executionStatus });
    const verificationStatus = verificationStatusFor(
      projection.planRevision,
      withExecution,
      projection.verificationReceipts,
    );
    if (
      attempt.executionStatus !== executionStatus ||
      attempt.verificationStatus !== verificationStatus
    ) {
      throw new WorkflowTransitionError(
        "Run projection Attempt status is not derived from its exact facts",
      );
    }
    return attemptSchema.parse({ ...withExecution, verificationStatus });
  });
  const expectedChecks = checkProjectionsFor(
    projection.planRevision,
    projectedAttempts.at(-1),
    projection.verificationReceipts,
  );
  if (JSON.stringify(projection.checks) !== JSON.stringify(expectedChecks)) {
    throw new WorkflowTransitionError(
      "Run projection check statuses are not derived from Receipts",
    );
  }
  const expectedEventCursor =
    1 +
    projection.attempts.length +
    projection.observations.length +
    projection.verificationReceipts.length +
    projection.humanReceipts.length +
    projection.reviewReceipts.length +
    projection.checkpoints.length +
    (projection.run.lifecycle === "CANCELLED" ? 1 : 0) +
    (projection.run.archiveStatus === "ARCHIVED" ? 1 : 0);
  if (projection.eventCursor !== expectedEventCursor) {
    throw new WorkflowTransitionError("Run projection event cursor does not match its facts");
  }
  const state: ProjectionState = {
    change: projection.change,
    planRevision: projection.planRevision,
    run: projection.run,
    attempts: projectedAttempts,
    observations: projection.observations,
    verificationReceipts: projection.verificationReceipts,
    humanReceipts: projection.humanReceipts,
    reviewReceipts: projection.reviewReceipts,
    checkpoints: projection.checkpoints,
  };
  const expectedLifecycle = lifecycleFor(state);
  if (
    projection.run.lifecycle !== expectedLifecycle ||
    projection.change.lifecycle !== expectedLifecycle
  ) {
    throw new WorkflowTransitionError("Run projection lifecycle is not derived from its facts");
  }
}

function sameResourceBudgets(left: ResourceBudgets, right: ResourceBudgets): boolean {
  return budgetUsagePairs.every(([budgetKey]) => left[budgetKey] === right[budgetKey]);
}

function validateReplaySemantics(events: readonly WorkflowEvent[]): void {
  const created = events[0];
  if (created?.type !== "RUN_CREATED") {
    throw new WorkflowTransitionError("a Run must begin with RUN_CREATED");
  }
  if (
    created.change.changeId !== created.planRevision.changeId ||
    created.change.changeId !== created.run.changeId ||
    created.planRevision.planRevisionId !== created.run.planRevisionId ||
    created.planRevision.workspaceId !== created.run.workspaceId ||
    created.planRevision.workspaceFingerprint !== created.run.workspaceFingerprint ||
    created.planRevision.sourceFingerprint !== created.run.sourceFingerprint ||
    created.run.lifecycle !== "PLANNED"
  ) {
    throw new WorkflowTransitionError(
      "replayed Change, Plan Revision, and Run identities do not match",
    );
  }

  const attempts: Attempt[] = [];
  const observations: Observation[] = [];
  const verificationReceipts: VerificationReceipt[] = [];
  const humanReceipts: HumanReceipt[] = [];
  const reviewReceipts: ReviewReceipt[] = [];
  const checkpointIds = new Set<string>();
  const checkpoints = new Map<string, Checkpoint>();
  let cancelled = false;
  let archived = false;
  const requireAttempt = (attemptId: string): Attempt => {
    const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) {
      throw new WorkflowTransitionError(`replayed fact uses unknown Attempt ${attemptId}`);
    }
    return attempt;
  };

  for (const event of events.slice(1)) {
    if (archived || (cancelled && event.type !== "RUN_ARCHIVED")) {
      throw new WorkflowTransitionError("no workflow fact may follow Run cancellation");
    }
    switch (event.type) {
      case "RUN_CREATED":
        throw new WorkflowTransitionError("a Run cannot be created twice");
      case "ATTEMPT_STARTED": {
        const attempt = event.attempt;
        const previous = attempts.at(-1);
        if (
          attempt.runId !== created.run.runId ||
          attempt.planRevisionId !== created.planRevision.planRevisionId ||
          attempt.sequence !== attempts.length + 1 ||
          attempts.some((candidate) => candidate.attemptId === attempt.attemptId) ||
          attempt.executionStatus !== "RUNNING" ||
          attempt.verificationStatus !== "NOT_READY"
        ) {
          throw new WorkflowTransitionError("replayed Attempt does not bind the active Run");
        }
        if (previous === undefined) {
          if (
            attempt.elapsedMsAtStart !== 0 ||
            !sameResourceBudgets(
              attempt.remainingResourceBudgets,
              created.planRevision.loopPolicy.resourceBudgets,
            )
          ) {
            throw new WorkflowTransitionError("replayed first Attempt has invalid budgets");
          }
        } else {
          const previousExecutionStatus = observations
            .filter((observation) => observation.attemptId === previous.attemptId)
            .reduce<Attempt["executionStatus"]>(
              (status, observation) => executionStatusAfterObservation(status, observation.kind),
              previous.executionStatus,
            );
          const projectedPrevious = attemptSchema.parse({
            ...previous,
            executionStatus: previousExecutionStatus,
          });
          const previousVerificationStatus = verificationStatusFor(
            created.planRevision,
            projectedPrevious,
            verificationReceipts,
          );
          const hasGateFailure =
            humanReceipts.some(
              (receipt) =>
                receipt.attemptId === previous.attemptId &&
                receipt.decision !== "APPROVED" &&
                created.planRevision.steps.some(
                  (step) =>
                    step.kind === "human_gate" && step.required && step.stepId === receipt.stepId,
                ),
            ) ||
            reviewReceipts.some(
              (receipt) =>
                receipt.attemptId === previous.attemptId &&
                created.planRevision.steps.some(
                  (step) =>
                    step.kind === "review" && step.required && step.stepId === receipt.stepId,
                ) &&
                (receipt.outcome !== "PASS" ||
                  receipt.findings.some(
                    (finding) => finding.severity === "P0" || finding.severity === "P1",
                  )),
            );
          if (
            created.planRevision.loopPolicy.stopOnUserInput &&
            (attempt.retryStopConditions?.userInputRequired === true ||
              observations.some(
                (observation) =>
                  observation.attemptId === previous.attemptId &&
                  observation.kind === "INPUT_REQUESTED",
              ))
          ) {
            throw new WorkflowTransitionError("replayed retry crossed required user input");
          }
          if (
            created.planRevision.loopPolicy.stopOnWorkspaceDrift &&
            attempt.retryStopConditions?.workspaceDriftDetected === true
          ) {
            throw new WorkflowTransitionError("replayed retry crossed workspace drift");
          }
          if (
            attempt.previousAttemptId !== previous.attemptId ||
            !["RETURNED", "INTERRUPTED", "INCOMPLETE"].includes(previousExecutionStatus) ||
            (attempt.recoveryCheckpointId === undefined &&
              !["FAILED", "BLOCKED", "NOT_PROVEN"].includes(previousVerificationStatus) &&
              !hasGateFailure) ||
            attempts.length >= created.planRevision.loopPolicy.maxIterations ||
            attempt.elapsedMsAtStart >= created.planRevision.loopPolicy.maxElapsedMs ||
            attempts.filter(
              (candidate) =>
                candidate.precedingFailureFingerprint === attempt.precedingFailureFingerprint,
            ).length +
              1 >=
              created.planRevision.loopPolicy.repeatedFailureLimit ||
            attempt.elapsedMsAtStart < previous.elapsedMsAtStart ||
            Date.parse(attempt.startedAt) < Date.parse(previous.startedAt) ||
            !budgetUsagePairs.every(([budgetKey]) => {
              const declared = created.planRevision.loopPolicy.resourceBudgets[budgetKey];
              const next = attempt.remainingResourceBudgets[budgetKey];
              const prior = previous.remainingResourceBudgets[budgetKey];
              return declared === undefined
                ? next === undefined && prior === undefined
                : next !== undefined && prior !== undefined && next <= prior;
            })
          ) {
            throw new WorkflowTransitionError("replayed retry Attempt is not monotonic");
          }
          const failureEvidence = new Set([
            ...verificationReceipts
              .filter(
                (receipt) =>
                  receipt.attemptId === previous.attemptId &&
                  receipt.outcome !== "PASS" &&
                  receipt.resultFingerprint === attempt.precedingFailureFingerprint,
              )
              .flatMap((receipt) => receipt.evidenceIds),
            ...humanReceipts
              .filter(
                (receipt) =>
                  receipt.attemptId === previous.attemptId &&
                  receipt.decision !== "APPROVED" &&
                  receipt.resultFingerprint === attempt.precedingFailureFingerprint &&
                  created.planRevision.steps.some(
                    (step) =>
                      step.kind === "human_gate" && step.required && step.stepId === receipt.stepId,
                  ),
              )
              .flatMap((receipt) => receipt.evidenceIds),
            ...reviewReceipts
              .filter(
                (receipt) =>
                  receipt.attemptId === previous.attemptId &&
                  receipt.resultFingerprint === attempt.precedingFailureFingerprint &&
                  created.planRevision.steps.some(
                    (step) =>
                      step.kind === "review" && step.required && step.stepId === receipt.stepId,
                  ) &&
                  (receipt.outcome !== "PASS" ||
                    receipt.findings.some(
                      (finding) => finding.severity === "P0" || finding.severity === "P1",
                    )),
              )
              .flatMap((receipt) => [
                ...receipt.evidenceIds,
                ...receipt.findings.flatMap((finding) => finding.evidenceIds),
              ]),
          ]);
          if (
            attempt.recoveryCheckpointId === undefined &&
            (failureEvidence.size === 0 ||
              attempt.failureEvidenceIds?.some((evidenceId) => !failureEvidence.has(evidenceId)))
          ) {
            throw new WorkflowTransitionError(
              "replayed retry Evidence is not bound to the preceding failure",
            );
          }
        }
        if (attempt.recoveryCheckpointId !== undefined) {
          const recoveryCheckpoint = checkpoints.get(attempt.recoveryCheckpointId);
          if (previous === undefined || recoveryCheckpoint?.attemptId !== previous.attemptId) {
            throw new WorkflowTransitionError(
              "replayed recovery Attempt does not bind its Checkpoint to the preceding Attempt",
            );
          }
        }
        attempts.push(attempt);
        break;
      }
      case "OBSERVATION_RECORDED":
        requireAttempt(event.observation.attemptId);
        if (
          event.observation.runId !== created.run.runId ||
          observations.some(
            (observation) => observation.observationId === event.observation.observationId,
          ) ||
          (event.observation.stepId !== undefined &&
            !created.planRevision.steps.some((step) => step.stepId === event.observation.stepId))
        ) {
          throw new WorkflowTransitionError("replayed Observation is not predeclared or unique");
        }
        observations.push(event.observation);
        break;
      case "VERIFICATION_RECORDED": {
        const receipt = event.receipt;
        requireAttempt(receipt.attemptId);
        const check = created.planRevision.checks.find(
          (candidate) => candidate.checkId === receipt.checkId,
        );
        if (
          receipt.runId !== created.run.runId ||
          verificationReceipts.some(
            (candidate) =>
              candidate.verificationReceiptId === receipt.verificationReceiptId ||
              (candidate.attemptId === receipt.attemptId && candidate.checkId === receipt.checkId),
          ) ||
          receipt.checkVersion !== check?.version ||
          receipt.checkDefinitionFingerprint !== check.definitionFingerprint ||
          receipt.configFingerprint !== check.configurationFingerprint ||
          receipt.workspaceFingerprint !== created.planRevision.workspaceFingerprint ||
          receipt.sourceFingerprint !== created.planRevision.sourceFingerprint
        ) {
          throw new WorkflowTransitionError(
            "replayed Verification Receipt does not bind the active check and source identity",
          );
        }
        verificationReceipts.push(receipt);
        break;
      }
      case "HUMAN_RECEIPT_RECORDED": {
        const receipt = event.receipt;
        requireAttempt(receipt.attemptId);
        const step = created.planRevision.steps.find(
          (candidate) => candidate.stepId === receipt.stepId,
        );
        if (
          receipt.runId !== created.run.runId ||
          humanReceipts.some(
            (candidate) =>
              candidate.humanReceiptId === receipt.humanReceiptId ||
              (candidate.attemptId === receipt.attemptId && candidate.stepId === receipt.stepId),
          ) ||
          step?.kind !== "human_gate" ||
          receipt.contentHash !== step.expectedContentHash ||
          !step.allowedDecisions.includes(receipt.decision)
        ) {
          throw new WorkflowTransitionError(
            "replayed Human Receipt does not bind the predeclared gate",
          );
        }
        humanReceipts.push(receipt);
        break;
      }
      case "REVIEW_RECEIPT_RECORDED": {
        const receipt = event.receipt;
        requireAttempt(receipt.attemptId);
        const step = created.planRevision.steps.find(
          (candidate) => candidate.stepId === receipt.stepId,
        );
        if (
          receipt.runId !== created.run.runId ||
          reviewReceipts.some(
            (candidate) =>
              candidate.reviewReceiptId === receipt.reviewReceiptId ||
              (candidate.attemptId === receipt.attemptId && candidate.stepId === receipt.stepId),
          ) ||
          step?.kind !== "review" ||
          receipt.inputFingerprint !== step.inputFingerprint ||
          receipt.reviewDefinitionFingerprint !== step.reviewDefinitionFingerprint ||
          receipt.configurationFingerprint !== step.configurationFingerprint ||
          receipt.workspaceFingerprint !== created.planRevision.workspaceFingerprint ||
          receipt.sourceFingerprint !== created.planRevision.sourceFingerprint
        ) {
          throw new WorkflowTransitionError(
            "replayed Review Receipt does not bind the predeclared review",
          );
        }
        reviewReceipts.push(receipt);
        break;
      }
      case "CHECKPOINT_RECORDED": {
        const checkpoint = event.checkpoint;
        if (checkpoint.attemptId !== undefined) {
          requireAttempt(checkpoint.attemptId);
        }
        if (
          checkpointIds.has(checkpoint.checkpointId) ||
          checkpoint.runId !== created.run.runId ||
          checkpoint.planRevisionId !== created.planRevision.planRevisionId ||
          checkpoint.workspaceId !== created.planRevision.workspaceId ||
          checkpoint.workspaceFingerprint !== created.planRevision.workspaceFingerprint ||
          checkpoint.sourceFingerprint !== created.planRevision.sourceFingerprint ||
          checkpoint.eventCursor !== event.cursor - 1
        ) {
          throw new WorkflowTransitionError("replayed Checkpoint does not bind the durable Run");
        }
        checkpointIds.add(checkpoint.checkpointId);
        checkpoints.set(checkpoint.checkpointId, checkpoint);
        break;
      }
      case "RUN_CANCELLED": {
        const previous = attempts.at(-1);
        const previousExecutionStatus =
          previous === undefined
            ? undefined
            : observations
                .filter((observation) => observation.attemptId === previous.attemptId)
                .reduce<Attempt["executionStatus"]>(
                  (status, observation) =>
                    executionStatusAfterObservation(status, observation.kind),
                  previous.executionStatus,
                );
        if (
          event.runId !== created.run.runId ||
          (previousExecutionStatus !== undefined &&
            ["PENDING", "STARTING", "RUNNING", "WAITING_INPUT"].includes(
              previousExecutionStatus,
            )) ||
          Date.parse(event.endedAt) < Date.parse(created.run.startedAt)
        ) {
          throw new WorkflowTransitionError("replayed cancellation does not bind finality");
        }
        cancelled = true;
        break;
      }
      case "RUN_ARCHIVED": {
        const projectedAttempts = attempts.map((attempt) => {
          const executionStatus = observations
            .filter((observation) => observation.attemptId === attempt.attemptId)
            .reduce<Attempt["executionStatus"]>(
              (status, observation) => executionStatusAfterObservation(status, observation.kind),
              attempt.executionStatus,
            );
          const withExecution = attemptSchema.parse({ ...attempt, executionStatus });
          return attemptSchema.parse({
            ...withExecution,
            verificationStatus: verificationStatusFor(
              created.planRevision,
              withExecution,
              verificationReceipts,
            ),
          });
        });
        const partialState: ProjectionState = {
          change: created.change,
          planRevision: created.planRevision,
          run: created.run,
          attempts: projectedAttempts,
          observations,
          verificationReceipts,
          humanReceipts,
          reviewReceipts,
          checkpoints: [...checkpoints.values()],
        };
        const lifecycle = cancelled ? "CANCELLED" : lifecycleFor(partialState);
        if (
          event.runId !== created.run.runId ||
          created.run.archiveStatus !== "UNARCHIVED" ||
          !terminalRunLifecycles.has(lifecycle) ||
          Date.parse(event.archivedAt) < Date.parse(created.run.startedAt)
        ) {
          throw new WorkflowTransitionError("replayed Archive does not bind terminal Run finality");
        }
        archived = true;
        break;
      }
    }
  }
}

export function replayWorkflowEvents(events: readonly WorkflowEvent[]): RunProjection {
  const parsedEvents = events.map((event) => workflowEventSchema.parse(event));
  if (parsedEvents.some((event, index) => event.cursor !== index + 1)) {
    throw new WorkflowTransitionError(
      "workflow event cursors must begin at 1 and remain contiguous",
    );
  }
  const created = parsedEvents[0];
  if (created?.type !== "RUN_CREATED") {
    throw new WorkflowTransitionError("a Run must begin with RUN_CREATED");
  }
  validateReplaySemantics(parsedEvents);
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

  for (const event of parsedEvents.slice(1)) {
    switch (event.type) {
      case "ATTEMPT_STARTED":
        state.attempts.push(event.attempt);
        break;
      case "OBSERVATION_RECORDED": {
        state.observations.push(event.observation);
        const attempt = findAttempt(state, event.observation.attemptId);
        const executionStatus = executionStatusAfterObservation(
          attempt.executionStatus,
          event.observation.kind,
        );
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
      case "RUN_CANCELLED":
        state.run = runSchema.parse({
          ...state.run,
          lifecycle: "CANCELLED",
          endedAt: event.endedAt,
          terminalReason: event.reason,
        });
        break;
      case "RUN_ARCHIVED":
        state.run = runSchema.parse({
          ...state.run,
          archiveStatus: "ARCHIVED",
          archiveId: event.archiveId,
        });
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
    eventCursor: parsedEvents.at(-1)?.cursor,
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

  public constructor(initialEventStreams: readonly (readonly WorkflowEvent[])[] = []) {
    for (const stream of initialEventStreams) {
      const events = stream.map((event) => workflowEventSchema.parse(event));
      const projection = replayWorkflowEvents(events);
      if (this.#eventsByRun.has(projection.run.runId)) {
        throw new WorkflowTransitionError(`Run ${projection.run.runId} was seeded more than once`);
      }
      this.#eventsByRun.set(projection.run.runId, events);
    }
  }

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
    if (terminalRunLifecycles.has(current.run.lifecycle) && parsed.type !== "ARCHIVE_RUN") {
      throw new WorkflowTransitionError(
        `Run ${runId} has terminal ${current.run.lifecycle} outcome; create a replacement Run`,
      );
    }
    const event = this.#decide(parsed, current);
    this.#eventsFor(runId).push(event);
    return this.#accepted(runId, [event]);
  }

  public project(runId: RunId): Promise<RunProjection> {
    return Promise.resolve(replayWorkflowEvents(this.#eventsFor(runId)));
  }

  public async recover(checkpointId: CheckpointId): Promise<RecoveryDecision> {
    const matches: { projection: RunProjection; checkpoint: Checkpoint }[] = [];
    for (const [runId] of this.#eventsByRun) {
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
          "IN_MEMORY_STATE_NOT_DURABLE",
          "WORKSPACE_NOT_REVALIDATED",
          "ENGINE_STATE_NOT_RECONCILED",
        ],
      });
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
    if (command.run.archiveStatus !== "UNARCHIVED" || command.run.archiveId !== undefined) {
      throw new WorkflowTransitionError(
        "a new Run must begin unarchived without an Archive identity",
      );
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
      case "ARCHIVE_RUN":
        if (current.run.archiveStatus !== "UNARCHIVED") {
          throw new WorkflowTransitionError("Run is already archived");
        }
        if (!terminalRunLifecycles.has(current.run.lifecycle)) {
          throw new WorkflowTransitionError("only a terminal Run can be archived");
        }
        if (Date.parse(command.archivedAt) < Date.parse(current.run.startedAt)) {
          throw new WorkflowTransitionError("Archive time cannot precede Run start");
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "RUN_ARCHIVED",
          runId: command.runId,
          archiveId: command.archiveId,
          operationId: command.operationId,
          operationFingerprint: command.operationFingerprint,
          archivedAt: command.archivedAt,
        });
      case "CANCEL_RUN": {
        const previous = current.attempts.at(-1);
        if (
          previous !== undefined &&
          ["PENDING", "STARTING", "RUNNING", "WAITING_INPUT"].includes(previous.executionStatus)
        ) {
          throw new WorkflowTransitionError(
            "cannot cancel while the latest Attempt has an active execution",
          );
        }
        if (Date.parse(command.endedAt) < Date.parse(current.run.startedAt)) {
          throw new WorkflowTransitionError("cancellation time cannot precede Run start");
        }
        return workflowEventSchema.parse({
          schemaVersion: "1.0.0",
          cursor,
          type: "RUN_CANCELLED",
          runId: command.runId,
          reason: command.reason,
          endedAt: command.endedAt,
        });
      }
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
      case "RETRY_ATTEMPT":
      case "RECOVER_ATTEMPT": {
        const recoveryCheckpointId =
          command.type === "RECOVER_ATTEMPT" ? command.checkpointId : undefined;
        const isRecovery = recoveryCheckpointId !== undefined;
        const previous = this.#requireAttempt(current, command.previousAttemptId);
        if (current.attempts.at(-1)?.attemptId !== previous.attemptId) {
          throw new WorkflowTransitionError("retry must follow the latest Attempt");
        }
        if (
          isRecovery &&
          current.checkpoints.find((checkpoint) => checkpoint.checkpointId === recoveryCheckpointId)
            ?.attemptId !== previous.attemptId
        ) {
          throw new WorkflowTransitionError(
            "recovery Attempt must bind a Checkpoint for the preceding Attempt",
          );
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
          !isRecovery &&
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
        if (
          current.planRevision.loopPolicy.stopOnUserInput &&
          (command.userInputRequired ||
            current.observations.some(
              (observation) =>
                observation.attemptId === previous.attemptId &&
                observation.kind === "INPUT_REQUESTED",
            ))
        ) {
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
          !isRecovery &&
          (matchingVerificationReceipts.length +
            matchingHumanReceipts.length +
            matchingReviewReceipts.length ===
            0 ||
            command.failureEvidenceIds.some(
              (evidenceId) => !precedingFailureEvidence.has(evidenceId),
            ))
        ) {
          throw new WorkflowTransitionError(
            "retry Evidence is not bound to the preceding failed Attempt",
          );
        }
        if (isRecovery) {
          const recoveryEvidenceBound = current.observations.some(
            (observation) =>
              observation.attemptId === previous.attemptId &&
              observation.kind === "PROCESS_EXITED" &&
              command.failureEvidenceIds.every((evidenceId) =>
                observation.evidenceIds.includes(evidenceId),
              ),
          );
          if (!recoveryEvidenceBound) {
            throw new WorkflowTransitionError(
              "recovery Evidence must be bound to a PROCESS_EXITED observation for the preceding Attempt",
            );
          }
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
            ...(recoveryCheckpointId === undefined ? {} : { recoveryCheckpointId }),
            ...(command.type === "RECOVER_ATTEMPT"
              ? {
                  recoveryOperationId: command.operationId,
                  recoveryOperationFingerprint: command.operationFingerprint,
                }
              : {}),
            retryStopConditions: {
              userInputRequired: command.userInputRequired,
              workspaceDriftDetected: command.workspaceDriftDetected,
            },
            elapsedMsAtStart: command.elapsedMs,
            remainingResourceBudgets,
            executionStatus: "RUNNING",
            verificationStatus: "NOT_READY",
            startedAt: command.startedAt,
          },
        });
      }
      case "RECORD_CHECKPOINT": {
        if (
          current.checkpoints.some(
            (checkpoint) => checkpoint.checkpointId === command.checkpoint.checkpointId,
          )
        ) {
          throw new WorkflowTransitionError(
            `Checkpoint ${command.checkpoint.checkpointId} already exists`,
          );
        }
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
        const latestCheckpoint = current.checkpoints.at(-1);
        if (
          latestCheckpoint !== undefined &&
          Date.parse(command.checkpoint.createdAt) < Date.parse(latestCheckpoint.createdAt)
        ) {
          throw new WorkflowTransitionError("Checkpoint time cannot move backwards");
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
