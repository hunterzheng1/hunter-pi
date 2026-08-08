import { describe, expect, it } from "vitest";

import {
  attemptIdSchema,
  checkpointIdSchema,
  checkpointSchema,
  evidenceIdSchema,
  humanReceiptSchema,
  managedChangeSchema,
  observationSchema,
  planRevisionSchema,
  runSchema,
  reviewReceiptSchema,
  verificationReceiptSchema,
  type CheckpointId,
  type RunId,
  type VerificationOutcome,
} from "@hunter-pi/domain";
import {
  InMemoryWorkflowKernel as ProductionWorkflowKernel,
  archiveRunCommandSchema,
  workflowDecisionSchema,
  type WorkflowCommand,
  type WorkflowDecision,
} from "@hunter-pi/workflow-kernel";

type WithoutSchemaVersion<Command> = Command extends unknown
  ? Omit<Command, "schemaVersion">
  : never;
type UnversionedWorkflowCommand = WithoutSchemaVersion<WorkflowCommand>;

class TestWorkflowKernel {
  readonly #kernel = new ProductionWorkflowKernel();

  public dispatch(command: UnversionedWorkflowCommand): Promise<WorkflowDecision> {
    return this.#kernel.dispatch({ schemaVersion: "1.0.0", ...command });
  }

  public project(runId: RunId) {
    return this.#kernel.project(runId);
  }

  public recover(checkpointId: CheckpointId) {
    return this.#kernel.recover(checkpointId);
  }
}

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(64)}`;

function createFixture() {
  const change = managedChangeSchema.parse({
    schemaVersion: "1.0.0",
    changeId: "chg_kernel",
    title: "Exercise the kernel",
    goal: "Prove state transitions without a real engine",
    nonGoals: ["Run a provider"],
    constraints: ["Preserve every failed Attempt"],
    lifecycle: "PLANNED",
    createdAt: timestamp,
  });
  const planRevision = planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: "plan_kernel",
    changeId: change.changeId,
    revision: 1,
    workspaceId: "workspace_kernel",
    workspaceFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    goal: change.goal,
    nonGoals: change.nonGoals,
    constraints: change.constraints,
    steps: [
      {
        stepId: "step_execute",
        kind: "agent",
        title: "Return control to Hunter Pi",
        dependsOn: [],
        required: true,
        inputContractFingerprint: fingerprint,
        outputContractFingerprint: fingerprint,
      },
    ],
    checks: [
      {
        checkId: "check_unit",
        version: 1,
        label: "Unit tests",
        kind: "command",
        required: true,
        definition: {
          executable: "npm",
          argv: ["test"],
          workingDirectoryReference: "workspace-root",
        },
        definitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
      },
    ],
    loopPolicy: {
      maxIterations: 3,
      maxElapsedMs: 60_000,
      repeatedFailureLimit: 2,
      resourceBudgets: { maxExternalOperations: 10 },
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt: timestamp,
  });
  const run = runSchema.parse({
    schemaVersion: "1.0.0",
    runId: "run_kernel",
    changeId: change.changeId,
    planRevisionId: planRevision.planRevisionId,
    workspaceId: planRevision.workspaceId,
    workspaceFingerprint: planRevision.workspaceFingerprint,
    sourceFingerprint: planRevision.sourceFingerprint,
    lifecycle: "PLANNED",
    archiveStatus: "UNARCHIVED",
    startedAt: timestamp,
  });
  return { change, planRevision, run };
}

async function createStartedKernel() {
  const fixture = createFixture();
  const kernel = new TestWorkflowKernel();
  await kernel.dispatch({ type: "CREATE_RUN", ...fixture });
  await kernel.dispatch({
    type: "START_ATTEMPT",
    runId: fixture.run.runId,
    attemptId: attemptIdSchema.parse("att_first"),
    startedAt: timestamp,
  });
  return { ...fixture, kernel };
}

async function recordAgentReturn(
  kernel: TestWorkflowKernel,
  runId: RunId,
  attemptId: string,
  observationId: string,
) {
  await kernel.dispatch({
    type: "RECORD_OBSERVATION",
    observation: observationSchema.parse({
      schemaVersion: "1.0.0",
      observationId,
      runId,
      attemptId,
      stepId: "step_execute",
      kind: "AGENT_RETURNED",
      observedAt: timestamp,
      evidenceIds: [],
    }),
  });
}

function createVerificationReceipt(values: {
  readonly verificationReceiptId: string;
  readonly runId: RunId;
  readonly attemptId?: string;
  readonly outcome: VerificationOutcome;
  readonly evidenceId: string;
  readonly resultFingerprint?: string;
}) {
  return verificationReceiptSchema.parse({
    schemaVersion: "1.0.0",
    verificationReceiptId: values.verificationReceiptId,
    runId: values.runId,
    attemptId: values.attemptId ?? "att_first",
    checkId: "check_unit",
    checkVersion: 1,
    checkDefinitionFingerprint: fingerprint,
    resultFingerprint: values.resultFingerprint ?? fingerprint,
    outcome: values.outcome,
    startedAt: timestamp,
    endedAt: timestamp,
    observedAt: timestamp,
    inputFingerprint: fingerprint,
    configFingerprint: fingerprint,
    workspaceFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    environmentFingerprint: fingerprint,
    resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
    output: {
      stdoutDigest: fingerprint,
      stderrDigest: fingerprint,
      artifactDigests: [],
      capturedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      redaction: { applied: false, fieldsRemoved: 0 },
    },
    evidenceIds: [values.evidenceId],
  });
}

describe("in-memory Workflow Kernel", () => {
  it("requires a versioned command and returns a strict versioned decision", async () => {
    const fixture = createFixture();
    const kernel = new ProductionWorkflowKernel();

    await expect(
      kernel.dispatch({ type: "CREATE_RUN", ...fixture } as unknown as WorkflowCommand),
    ).rejects.toThrow();

    const decision = await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      ...fixture,
    });
    expect(workflowDecisionSchema.parse(decision)).toEqual(decision);
    expect(
      workflowDecisionSchema.safeParse({ ...decision, privateSessionId: "private" }).success,
    ).toBe(false);
  });

  it("binds Archive transitions to an operation fingerprint and rejects archived creation", async () => {
    const fixture = createFixture();
    const kernel = new ProductionWorkflowKernel();
    const archivedRun = runSchema.parse({
      ...fixture.run,
      archiveStatus: "ARCHIVED",
      archiveId: "archive_kernel-illegal-create",
    });

    await expect(
      kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "CREATE_RUN",
        ...fixture,
        run: archivedRun,
      }),
    ).rejects.toThrow(/new Run|archive/u);
    expect(() =>
      archiveRunCommandSchema.parse({
        schemaVersion: "1.0.0",
        type: "ARCHIVE_RUN",
        runId: fixture.run.runId,
        archiveId: "archive_kernel",
        operationId: "op_archive_kernel",
        archivedAt: timestamp,
      }),
    ).toThrow(/operationFingerprint/u);
  });

  it("keeps stored events isolated from returned decision objects", async () => {
    const fixture = createFixture();
    const kernel = new TestWorkflowKernel();
    const decision = await kernel.dispatch({ type: "CREATE_RUN", ...fixture });
    const [created] = decision.events;
    if (created?.type !== "RUN_CREATED") {
      throw new Error("expected RUN_CREATED");
    }

    created.planRevision.goal = "corrupted by a caller";

    expect((await kernel.project(fixture.run.runId)).planRevision.goal).toBe(
      fixture.planRevision.goal,
    );
  });

  it.each(["AGENT_RETURNED", "PROCESS_EXITED", "TERMINAL_IDLE", "WINDOW_OPENED"] as const)(
    "does not treat %s as READY",
    async (kind) => {
      const { kernel, run } = await createStartedKernel();
      await kernel.dispatch({
        type: "RECORD_OBSERVATION",
        observation: observationSchema.parse({
          schemaVersion: "1.0.0",
          observationId: `obs_${kind.toLowerCase().replaceAll("_", "-")}`,
          runId: run.runId,
          attemptId: "att_first",
          stepId: "step_execute",
          kind,
          observedAt: timestamp,
          summary: `${kind} is not verification.`,
          evidenceIds: [],
        }),
      });

      const projection = await kernel.project(run.runId);
      expect(projection.run.lifecycle).not.toBe("READY");
      expect(projection.checks).toEqual([
        {
          schemaVersion: "1.0.0",
          checkId: "check_unit",
          required: true,
          status: "NOT_RUN",
        },
      ]);
    },
  );

  it("preserves RETURNED when PROCESS_EXITED is observed after AGENT_RETURNED", async () => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_ordered-return");
    await kernel.dispatch({
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_ordered-exit",
        runId: run.runId,
        attemptId: "att_first",
        stepId: "step_execute",
        kind: "PROCESS_EXITED",
        observedAt: timestamp,
        evidenceIds: [],
      }),
    });

    const projection = await kernel.project(run.runId);
    expect(projection.attempts[0]?.executionStatus).toBe("RETURNED");
    expect(projection.run.lifecycle).toBe("VERIFYING");
  });

  it("becomes READY only after every required Verification passes", async () => {
    const { kernel, run } = await createStartedKernel();
    await kernel.dispatch({
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_returned",
        runId: run.runId,
        attemptId: "att_first",
        stepId: "step_execute",
        kind: "AGENT_RETURNED",
        observedAt: timestamp,
        evidenceIds: [],
      }),
    });
    expect((await kernel.project(run.runId)).run.lifecycle).toBe("VERIFYING");

    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_unit",
        runId: run.runId,
        outcome: "PASS",
        evidenceId: "evidence_unit",
      }),
    });

    const projection = await kernel.project(run.runId);
    expect(projection.run.lifecycle).toBe("READY");
    expect(projection.attempts[0]?.verificationStatus).toBe("PASSED");
  });

  it("appends a retry without overwriting the failed Attempt", async () => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_retry-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_failed",
        runId: run.runId,
        outcome: "FAIL",
        evidenceId: "evidence_failure",
      }),
    });
    await kernel.dispatch({
      type: "RETRY_ATTEMPT",
      runId: run.runId,
      previousAttemptId: attemptIdSchema.parse("att_first"),
      attemptId: attemptIdSchema.parse("att_retry"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_failure")],
      failureFingerprint: fingerprint,
      reason: "Fix the failed unit test",
      elapsedMs: 1_000,
      consumedResources: { externalOperations: 1 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: timestamp,
    });

    const projection = await kernel.project(run.runId);
    expect(projection.attempts).toHaveLength(2);
    expect(projection.attempts[0]).toMatchObject({
      attemptId: "att_first",
      verificationStatus: "FAILED",
    });
    expect(projection.attempts[1]).toMatchObject({
      attemptId: "att_retry",
      previousAttemptId: "att_first",
      failureEvidenceIds: ["evidence_failure"],
      retryReason: "Fix the failed unit test",
      verificationStatus: "NOT_READY",
    });
    expect(projection.run.lifecycle).toBe("RUNNING");
  });

  it("does not start a retry while the previous Agent execution is still running", async () => {
    const { kernel, run } = await createStartedKernel();
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_running-failure",
        runId: run.runId,
        outcome: "FAIL",
        evidenceId: "evidence_running-failure",
      }),
    });

    await expect(
      kernel.dispatch({
        type: "RETRY_ATTEMPT",
        runId: run.runId,
        previousAttemptId: attemptIdSchema.parse("att_first"),
        attemptId: attemptIdSchema.parse("att_running-retry"),
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_running-failure")],
        failureFingerprint: fingerprint,
        reason: "Do not overlap Attempts in one leased workspace",
        elapsedMs: 1_000,
        consumedResources: { externalOperations: 1 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: timestamp,
      }),
    ).rejects.toThrow(/execution is still active/u);
  });

  it("does not reopen a terminal BLOCKED Run", async () => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_blocked-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_blocked",
        runId: run.runId,
        outcome: "BLOCKED",
        evidenceId: "evidence_blocked",
      }),
    });
    expect((await kernel.project(run.runId)).run.lifecycle).toBe("BLOCKED");

    await expect(
      kernel.dispatch({
        type: "RETRY_ATTEMPT",
        runId: run.runId,
        previousAttemptId: attemptIdSchema.parse("att_first"),
        attemptId: attemptIdSchema.parse("att_blocked-retry"),
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_blocked")],
        failureFingerprint: fingerprint,
        reason: "A terminal outcome requires a replacement Run",
        elapsedMs: 1_000,
        consumedResources: { externalOperations: 1 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: timestamp,
      }),
    ).rejects.toThrow(/terminal BLOCKED/u);
  });

  it("rejects a second Verification for the same Attempt and check", async () => {
    const { kernel, run } = await createStartedKernel();
    const receipt = createVerificationReceipt({
      verificationReceiptId: "verify_failed-once",
      runId: run.runId,
      outcome: "FAIL",
      evidenceId: "evidence_failure",
    });
    await kernel.dispatch({ type: "RECORD_VERIFICATION", receipt });

    await expect(
      kernel.dispatch({
        type: "RECORD_VERIFICATION",
        receipt: verificationReceiptSchema.parse({
          ...receipt,
          verificationReceiptId: "verify_rewrite",
          outcome: "PASS",
        }),
      }),
    ).rejects.toThrow(/already has a Verification Receipt/u);

    const projection = await kernel.project(run.runId);
    expect(projection.attempts[0]?.verificationStatus).toBe("FAILED");
    expect(projection.run.lifecycle).not.toBe("READY");
  });

  it("requires exact automated, human, and review Receipts while optional gates stay optional", async () => {
    const base = createFixture();
    const planRevision = planRevisionSchema.parse({
      ...base.planRevision,
      planRevisionId: "plan_gated",
      steps: [
        ...base.planRevision.steps,
        {
          stepId: "step_required-approval",
          kind: "human_gate",
          title: "Approve the exact content hash",
          dependsOn: ["step_execute"],
          required: true,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
          expectedContentHash: fingerprint,
          allowedDecisions: ["APPROVED", "REJECTED", "BLOCKED"],
        },
        {
          stepId: "step_optional-note",
          kind: "human_gate",
          title: "Optionally record a note",
          dependsOn: ["step_execute"],
          required: false,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
          expectedContentHash: fingerprint,
          allowedDecisions: ["APPROVED", "REJECTED", "BLOCKED"],
        },
        {
          stepId: "step_required-review",
          kind: "review",
          title: "Review blocking findings",
          dependsOn: ["step_execute"],
          required: true,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
          inputFingerprint: fingerprint,
          reviewDefinitionFingerprint: fingerprint,
          configurationFingerprint: fingerprint,
        },
      ],
    });
    const run = runSchema.parse({
      ...base.run,
      runId: "run_gated",
      planRevisionId: planRevision.planRevisionId,
    });
    const kernel = new TestWorkflowKernel();
    await kernel.dispatch({
      type: "CREATE_RUN",
      change: base.change,
      planRevision,
      run,
    });
    await kernel.dispatch({
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: attemptIdSchema.parse("att_gated"),
      startedAt: timestamp,
    });
    await kernel.dispatch({
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_gated-return",
        runId: run.runId,
        attemptId: "att_gated",
        kind: "AGENT_RETURNED",
        observedAt: timestamp,
        evidenceIds: [],
      }),
    });
    const optionalFailureFingerprint = `sha256:${"c".repeat(64)}`;
    await kernel.dispatch({
      type: "RECORD_HUMAN_RECEIPT",
      receipt: humanReceiptSchema.parse({
        schemaVersion: "1.0.0",
        humanReceiptId: "human_optional-rejected",
        runId: run.runId,
        attemptId: "att_gated",
        stepId: "step_optional-note",
        contentHash: fingerprint,
        resultFingerprint: optionalFailureFingerprint,
        decision: "REJECTED",
        actorReference: "local-owner",
        recordedAt: timestamp,
        evidenceIds: ["evidence_optional-rejection"],
      }),
    });
    await expect(
      kernel.dispatch({
        type: "RETRY_ATTEMPT",
        runId: run.runId,
        previousAttemptId: attemptIdSchema.parse("att_gated"),
        attemptId: attemptIdSchema.parse("att_optional-retry"),
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_optional-rejection")],
        failureFingerprint: optionalFailureFingerprint,
        reason: "An optional gate must not control retry",
        elapsedMs: 1_000,
        consumedResources: { externalOperations: 1 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: timestamp,
      }),
    ).rejects.toThrow(/requires a failed/u);
    await expect(
      kernel.dispatch({
        type: "RECORD_HUMAN_RECEIPT",
        receipt: humanReceiptSchema.parse({
          schemaVersion: "1.0.0",
          humanReceiptId: "human_wrong-content",
          runId: run.runId,
          attemptId: "att_gated",
          stepId: "step_required-approval",
          contentHash: `sha256:${"b".repeat(64)}`,
          resultFingerprint: fingerprint,
          decision: "APPROVED",
          actorReference: "local-owner",
          recordedAt: timestamp,
          evidenceIds: [],
        }),
      }),
    ).rejects.toThrow(/predeclared content/u);
    await kernel.dispatch({
      type: "RECORD_HUMAN_RECEIPT",
      receipt: humanReceiptSchema.parse({
        schemaVersion: "1.0.0",
        humanReceiptId: "human_gated",
        runId: run.runId,
        attemptId: "att_gated",
        stepId: "step_required-approval",
        contentHash: fingerprint,
        resultFingerprint: fingerprint,
        decision: "APPROVED",
        actorReference: "local-owner",
        recordedAt: timestamp,
        evidenceIds: [],
      }),
    });
    await expect(
      kernel.dispatch({
        type: "RECORD_HUMAN_RECEIPT",
        receipt: humanReceiptSchema.parse({
          schemaVersion: "1.0.0",
          humanReceiptId: "human_gated-rewrite",
          runId: run.runId,
          attemptId: "att_gated",
          stepId: "step_required-approval",
          contentHash: fingerprint,
          resultFingerprint: fingerprint,
          decision: "REJECTED",
          actorReference: "local-owner",
          recordedAt: timestamp,
          evidenceIds: ["evidence_human-rewrite"],
        }),
      }),
    ).rejects.toThrow(/already has a Human Receipt/u);
    await expect(
      kernel.dispatch({
        type: "RECORD_REVIEW_RECEIPT",
        receipt: reviewReceiptSchema.parse({
          schemaVersion: "1.0.0",
          reviewReceiptId: "review_wrong-definition",
          runId: run.runId,
          attemptId: "att_gated",
          stepId: "step_required-review",
          inputFingerprint: fingerprint,
          reviewDefinitionFingerprint: `sha256:${"b".repeat(64)}`,
          configurationFingerprint: fingerprint,
          workspaceFingerprint: fingerprint,
          sourceFingerprint: fingerprint,
          resultFingerprint: fingerprint,
          outcome: "PASS",
          observedAt: timestamp,
          findings: [],
          evidenceIds: [],
        }),
      }),
    ).rejects.toThrow(/predeclared review/u);
    await kernel.dispatch({
      type: "RECORD_REVIEW_RECEIPT",
      receipt: reviewReceiptSchema.parse({
        schemaVersion: "1.0.0",
        reviewReceiptId: "review_gated",
        runId: run.runId,
        attemptId: "att_gated",
        stepId: "step_required-review",
        inputFingerprint: fingerprint,
        reviewDefinitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
        workspaceFingerprint: fingerprint,
        sourceFingerprint: fingerprint,
        resultFingerprint: fingerprint,
        outcome: "PASS",
        observedAt: timestamp,
        findings: [],
        evidenceIds: [],
      }),
    });
    await expect(
      kernel.dispatch({
        type: "RECORD_REVIEW_RECEIPT",
        receipt: reviewReceiptSchema.parse({
          schemaVersion: "1.0.0",
          reviewReceiptId: "review_gated-rewrite",
          runId: run.runId,
          attemptId: "att_gated",
          stepId: "step_required-review",
          inputFingerprint: fingerprint,
          reviewDefinitionFingerprint: fingerprint,
          configurationFingerprint: fingerprint,
          workspaceFingerprint: fingerprint,
          sourceFingerprint: fingerprint,
          resultFingerprint: fingerprint,
          outcome: "FAIL",
          observedAt: timestamp,
          findings: [],
          evidenceIds: ["evidence_review-rewrite"],
        }),
      }),
    ).rejects.toThrow(/already has a Review Receipt/u);

    expect((await kernel.project(run.runId)).run.lifecycle).toBe("VERIFYING");

    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: verificationReceiptSchema.parse({
        ...createVerificationReceipt({
          verificationReceiptId: "verify_gated",
          runId: run.runId,
          attemptId: "att_gated",
          outcome: "PASS",
          evidenceId: "evidence_gated",
        }),
        checkDefinitionFingerprint: planRevision.checks[0]?.definitionFingerprint,
        configFingerprint: planRevision.checks[0]?.configurationFingerprint,
        workspaceFingerprint: planRevision.workspaceFingerprint,
        sourceFingerprint: planRevision.sourceFingerprint,
      }),
    });

    expect((await kernel.project(run.runId)).run.lifecycle).toBe("READY");

    expect((await kernel.project(run.runId)).run.lifecycle).toBe("READY");
  });

  it("starts a new Attempt from an exact blocking Review without rewriting the old result", async () => {
    const base = createFixture();
    const planRevision = planRevisionSchema.parse({
      ...base.planRevision,
      planRevisionId: "plan_review-fixback",
      steps: [
        ...base.planRevision.steps,
        {
          stepId: "step_review-fixback",
          kind: "review",
          title: "Review the exact bounded result",
          dependsOn: ["step_execute"],
          required: true,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
          inputFingerprint: fingerprint,
          reviewDefinitionFingerprint: fingerprint,
          configurationFingerprint: fingerprint,
        },
      ],
    });
    const run = runSchema.parse({
      ...base.run,
      runId: "run_review-fixback",
      planRevisionId: planRevision.planRevisionId,
    });
    const kernel = new TestWorkflowKernel();
    await kernel.dispatch({ type: "CREATE_RUN", change: base.change, planRevision, run });
    await kernel.dispatch({
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: attemptIdSchema.parse("att_review-first"),
      startedAt: timestamp,
    });
    await recordAgentReturn(kernel, run.runId, "att_review-first", "obs_review-first-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_review-first",
        runId: run.runId,
        attemptId: "att_review-first",
        outcome: "PASS",
        evidenceId: "evidence_review-verification",
      }),
    });
    const failureFingerprint = `sha256:${"b".repeat(64)}`;
    await kernel.dispatch({
      type: "RECORD_REVIEW_RECEIPT",
      receipt: reviewReceiptSchema.parse({
        schemaVersion: "1.0.0",
        reviewReceiptId: "review_blocking",
        runId: run.runId,
        attemptId: "att_review-first",
        stepId: "step_review-fixback",
        inputFingerprint: fingerprint,
        reviewDefinitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
        workspaceFingerprint: fingerprint,
        sourceFingerprint: fingerprint,
        resultFingerprint: failureFingerprint,
        outcome: "PASS",
        observedAt: timestamp,
        findings: [
          {
            severity: "P1",
            scope: "fixture.ts",
            rationale: "The exact review found a blocking defect.",
            evidenceIds: ["evidence_review-blocking"],
            confidence: 1,
          },
        ],
        evidenceIds: ["evidence_review-blocking"],
      }),
    });

    await kernel.dispatch({
      type: "RETRY_ATTEMPT",
      runId: run.runId,
      previousAttemptId: attemptIdSchema.parse("att_review-first"),
      attemptId: attemptIdSchema.parse("att_review-fixback"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_review-blocking")],
      failureFingerprint,
      reason: "Fix the blocking review finding",
      elapsedMs: 1_000,
      consumedResources: { externalOperations: 1 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: timestamp,
    });

    const projection = await kernel.project(run.runId);
    expect(projection.attempts).toHaveLength(2);
    expect(projection.reviewReceipts).toHaveLength(1);
    expect(projection.reviewReceipts[0]?.resultFingerprint).toBe(failureFingerprint);
    expect(projection.attempts[1]?.previousAttemptId).toBe("att_review-first");
    expect(projection.run.lifecycle).toBe("RUNNING");
  });

  it("ends with FAILED when a blocking Review exhausts the final Attempt", async () => {
    const base = createFixture();
    const planRevision = planRevisionSchema.parse({
      ...base.planRevision,
      planRevisionId: "plan_terminal-review",
      steps: [
        ...base.planRevision.steps,
        {
          stepId: "step_terminal-review",
          kind: "review",
          title: "Review the final bounded result",
          dependsOn: ["step_execute"],
          required: true,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
          inputFingerprint: fingerprint,
          reviewDefinitionFingerprint: fingerprint,
          configurationFingerprint: fingerprint,
        },
      ],
      loopPolicy: { ...base.planRevision.loopPolicy, maxIterations: 1 },
    });
    const run = runSchema.parse({
      ...base.run,
      runId: "run_terminal-review",
      planRevisionId: planRevision.planRevisionId,
    });
    const kernel = new TestWorkflowKernel();
    await kernel.dispatch({ type: "CREATE_RUN", change: base.change, planRevision, run });
    await kernel.dispatch({
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: attemptIdSchema.parse("att_terminal-review"),
      startedAt: timestamp,
    });
    await recordAgentReturn(kernel, run.runId, "att_terminal-review", "obs_terminal-review-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_terminal-review",
        runId: run.runId,
        attemptId: "att_terminal-review",
        outcome: "PASS",
        evidenceId: "evidence_terminal-review-verification",
      }),
    });
    await kernel.dispatch({
      type: "RECORD_REVIEW_RECEIPT",
      receipt: reviewReceiptSchema.parse({
        schemaVersion: "1.0.0",
        reviewReceiptId: "review_terminal-blocking",
        runId: run.runId,
        attemptId: "att_terminal-review",
        stepId: "step_terminal-review",
        inputFingerprint: fingerprint,
        reviewDefinitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
        workspaceFingerprint: fingerprint,
        sourceFingerprint: fingerprint,
        resultFingerprint: `sha256:${"b".repeat(64)}`,
        outcome: "PASS",
        observedAt: timestamp,
        findings: [
          {
            severity: "P1",
            scope: "fixture.ts",
            rationale: "The last permitted Attempt still has a blocking defect.",
            evidenceIds: ["evidence_terminal-review-blocking"],
            confidence: 1,
          },
        ],
        evidenceIds: ["evidence_terminal-review-blocking"],
      }),
    });

    expect((await kernel.project(run.runId)).run.lifecycle).toBe("FAILED");
  });

  it("rejects cumulative elapsed and resource usage that move backwards", async () => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_budget-first-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_budget-first",
        runId: run.runId,
        outcome: "FAIL",
        evidenceId: "evidence_budget-first",
      }),
    });
    await kernel.dispatch({
      type: "RETRY_ATTEMPT",
      runId: run.runId,
      previousAttemptId: attemptIdSchema.parse("att_first"),
      attemptId: attemptIdSchema.parse("att_budget-second"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_budget-first")],
      failureFingerprint: fingerprint,
      reason: "Consume part of the bounded budget",
      elapsedMs: 1_000,
      consumedResources: { externalOperations: 5 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: timestamp,
    });
    await recordAgentReturn(kernel, run.runId, "att_budget-second", "obs_budget-second-return");
    const secondFailureFingerprint = `sha256:${"b".repeat(64)}`;
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_budget-second",
        runId: run.runId,
        attemptId: "att_budget-second",
        outcome: "FAIL",
        evidenceId: "evidence_budget-second",
        resultFingerprint: secondFailureFingerprint,
      }),
    });
    const retry = {
      type: "RETRY_ATTEMPT" as const,
      runId: run.runId,
      previousAttemptId: attemptIdSchema.parse("att_budget-second"),
      attemptId: attemptIdSchema.parse("att_budget-third"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_budget-second")],
      failureFingerprint: secondFailureFingerprint,
      reason: "Never restore a consumed budget",
      elapsedMs: 2_000,
      consumedResources: { externalOperations: 4 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: timestamp,
    };

    await expect(kernel.dispatch({ ...retry, elapsedMs: 500 })).rejects.toThrow(
      /elapsed usage cannot move backwards/u,
    );
    await expect(kernel.dispatch(retry)).rejects.toThrow(/resource usage.*cannot move backwards/u);
  });

  it("rejects an Observation that names a Step outside the frozen Plan", async () => {
    const { kernel, run } = await createStartedKernel();
    await expect(
      kernel.dispatch({
        type: "RECORD_OBSERVATION",
        observation: observationSchema.parse({
          schemaVersion: "1.0.0",
          observationId: "obs_dangling-step",
          runId: run.runId,
          attemptId: "att_first",
          stepId: "step_missing",
          kind: "OUTPUT_CAPTURED",
          observedAt: timestamp,
          evidenceIds: [],
        }),
      }),
    ).rejects.toThrow(/Step is not predeclared/u);
  });

  it("stops a repeated failure before the configured limit is exceeded", async () => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_repeat-first-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_first-failure",
        runId: run.runId,
        outcome: "FAIL",
        evidenceId: "evidence_first-failure",
      }),
    });
    await kernel.dispatch({
      type: "RETRY_ATTEMPT",
      runId: run.runId,
      previousAttemptId: attemptIdSchema.parse("att_first"),
      attemptId: attemptIdSchema.parse("att_retry-one"),
      failureEvidenceIds: [evidenceIdSchema.parse("evidence_first-failure")],
      failureFingerprint: fingerprint,
      reason: "First bounded fix",
      elapsedMs: 1_000,
      consumedResources: { externalOperations: 1 },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: timestamp,
    });
    await recordAgentReturn(kernel, run.runId, "att_retry-one", "obs_repeat-retry-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_repeated-failure",
        runId: run.runId,
        attemptId: "att_retry-one",
        outcome: "FAIL",
        evidenceId: "evidence_repeated-failure",
      }),
    });

    await expect(
      kernel.dispatch({
        type: "RETRY_ATTEMPT",
        runId: run.runId,
        previousAttemptId: attemptIdSchema.parse("att_retry-one"),
        attemptId: attemptIdSchema.parse("att_retry-two"),
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_repeated-failure")],
        failureFingerprint: fingerprint,
        reason: "Repeating the same fix is not allowed",
        elapsedMs: 2_000,
        consumedResources: { externalOperations: 2 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: timestamp,
      }),
    ).rejects.toThrow(/repeated failure/u);
  });

  it.each([
    {
      name: "elapsed time",
      patch: { elapsedMs: 60_000 },
      expected: /elapsed budget/u,
    },
    {
      name: "resource usage",
      patch: { consumedResources: { externalOperations: 10 } },
      expected: /resource budget/u,
    },
    {
      name: "required user input",
      patch: { userInputRequired: true },
      expected: /user input/u,
    },
    {
      name: "workspace drift",
      patch: { workspaceDriftDetected: true },
      expected: /workspace drift/u,
    },
  ])("blocks retry when $name reaches a stop condition", async ({ patch, expected }) => {
    const { kernel, run } = await createStartedKernel();
    await recordAgentReturn(kernel, run.runId, "att_first", "obs_stop-condition-return");
    await kernel.dispatch({
      type: "RECORD_VERIFICATION",
      receipt: createVerificationReceipt({
        verificationReceiptId: "verify_stop-condition",
        runId: run.runId,
        outcome: "FAIL",
        evidenceId: "evidence_stop-condition",
      }),
    });

    await expect(
      kernel.dispatch({
        type: "RETRY_ATTEMPT",
        runId: run.runId,
        previousAttemptId: attemptIdSchema.parse("att_first"),
        attemptId: attemptIdSchema.parse("att_blocked-retry"),
        failureEvidenceIds: [evidenceIdSchema.parse("evidence_stop-condition")],
        failureFingerprint: fingerprint,
        reason: "Evaluate a bounded retry",
        elapsedMs: 1_000,
        consumedResources: { externalOperations: 1 },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: timestamp,
        ...patch,
      }),
    ).rejects.toThrow(expected);
  });

  it("records a bound Checkpoint but keeps in-memory recovery NOT_PROVEN", async () => {
    const { kernel, run } = await createStartedKernel();
    const beforeCheckpoint = await kernel.project(run.runId);
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: "checkpoint_kernel",
      runId: run.runId,
      attemptId: "att_first",
      planRevisionId: "plan_kernel",
      distributionReleaseId: "release_kernel",
      workspaceId: "workspace_kernel",
      repositoryFingerprint: fingerprint,
      workspaceFingerprint: fingerprint,
      sourceFingerprint: fingerprint,
      eventCursor: beforeCheckpoint.eventCursor,
      createdAt: timestamp,
      engine: {
        engineReleaseId: "engine-release_kernel",
        engineReleaseFingerprint: fingerprint,
        resumeCapability: "NOT_PROVEN",
      },
      activeOperationReceiptIds: [],
      unknownOperationIds: [],
      heldWriterLeaseIds: [],
      processReferences: [],
      remainingResourceBudgets: { maxExternalOperations: 10 },
    });
    await kernel.dispatch({ type: "RECORD_CHECKPOINT", checkpoint });

    await expect(
      kernel.recover(checkpointIdSchema.parse("checkpoint_kernel")),
    ).resolves.toMatchObject({
      status: "NOT_PROVEN",
      reasons: [
        "IN_MEMORY_STATE_NOT_DURABLE",
        "WORKSPACE_NOT_REVALIDATED",
        "ENGINE_STATE_NOT_RECONCILED",
        "ATTEMPT_FINALITY_NOT_RECONCILED",
      ],
    });
  });

  it("rejects a Checkpoint with a stale event cursor", async () => {
    const { kernel, run } = await createStartedKernel();
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: "checkpoint_stale",
      runId: run.runId,
      attemptId: "att_first",
      planRevisionId: "plan_kernel",
      distributionReleaseId: "release_kernel",
      workspaceId: "workspace_kernel",
      repositoryFingerprint: fingerprint,
      workspaceFingerprint: fingerprint,
      sourceFingerprint: fingerprint,
      eventCursor: 1,
      createdAt: timestamp,
      engine: {
        engineReleaseId: "engine-release_kernel",
        engineReleaseFingerprint: fingerprint,
        resumeCapability: "NOT_PROVEN",
      },
      activeOperationReceiptIds: [],
      unknownOperationIds: [],
      heldWriterLeaseIds: [],
      processReferences: [],
      remainingResourceBudgets: { maxExternalOperations: 10 },
    });

    await expect(kernel.dispatch({ type: "RECORD_CHECKPOINT", checkpoint })).rejects.toThrow(
      /event cursor/u,
    );
  });
});
