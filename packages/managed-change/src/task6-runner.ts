import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  attemptIdSchema,
  checkIdSchema,
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  fingerprintSchema,
  managedChangeSchema,
  observationIdSchema,
  operationIdSchema,
  planRevisionSchema,
  reviewReceiptSchema,
  runSchema,
  stepIdSchema,
  verificationReceiptIdSchema,
  type EvidenceEnvelope,
  type Fingerprint,
  type ReviewFinding,
} from "@hunter-pi/domain";
import {
  capabilityReceiptSchema,
  engineInputSchema,
  startAttemptRequestSchema,
  supportsEngineCapability,
  type EngineHost,
} from "@hunter-pi/engine-contracts";
import { createPortableEvidenceEnvelope, createRunSummaryEvidence } from "@hunter-pi/evidence";
import { runDeclaredCommandVerification } from "@hunter-pi/verification";
import { InMemoryWorkflowKernel, type RunProjection } from "@hunter-pi/workflow-kernel";
import {
  captureTask6QuickSessionPromotion,
  createTask6DisposableFixture,
  inspectTask6FixtureForReview,
  removeTask6DisposableFixture,
  type Task6DisposableFixture,
} from "./fixture.js";
import {
  task6ManagedChangeEvidenceSchema,
  type Task6ManagedChangeEvidence,
} from "./task6-evidence.js";

export interface RunTask6ManagedChangeOptions {
  readonly parentDirectory: string;
  readonly engineHost: EngineHost;
  readonly productSource: {
    readonly commit: string;
    readonly state: "CLEAN" | "DIRTY";
  };
  readonly engineRelease: {
    readonly packageName: string;
    readonly version: string;
  };
  readonly providerId: string;
  readonly environmentFingerprint: Fingerprint;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

const maximumOutputBytes = 262_144;
const task6Attempt1Id = attemptIdSchema.parse("att_task6-1");
const task6Attempt2Id = attemptIdSchema.parse("att_task6-2");
const task6AgentStepId = stepIdSchema.parse("step_task6-agent");
const task6CheckId = checkIdSchema.parse("check_task6-result");
const task6FirstVerificationId = verificationReceiptIdSchema.parse("verify_task6-1");
const task6SecondVerificationId = verificationReceiptIdSchema.parse("verify_task6-2");
const task6FirstVerificationEvidenceId = evidenceIdSchema.parse("evidence_task6-verify-1");
const task6SecondVerificationEvidenceId = evidenceIdSchema.parse("evidence_task6-verify-2");
const task6Prompt =
  "In this disposable Git fixture, change only result.txt so node verify.mjs passes. " +
  "The file must contain exactly READY followed by one newline. Do not use shell commands, " +
  "do not modify scratch.txt, and do not create or modify any other file.";

function sha256(value: string): Fingerprint {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function makeEvidence(options: {
  readonly evidenceId: string;
  readonly kind: "observation" | "verification" | "review";
  readonly runId: string;
  readonly attemptId: string;
  readonly verificationReceiptId?: string;
  readonly createdAt: string;
  readonly sourceFingerprint: Fingerprint;
  readonly summary: string;
  readonly content: string;
  readonly fixture: Task6DisposableFixture;
}): EvidenceEnvelope {
  return evidenceEnvelopeSchema.parse(
    createPortableEvidenceEnvelope(
      {
        schemaVersion: "1.0.0",
        evidenceId: options.evidenceId,
        kind: options.kind,
        scope: {
          runId: options.runId,
          attemptId: options.attemptId,
          ...(options.verificationReceiptId === undefined
            ? {}
            : { verificationReceiptId: options.verificationReceiptId }),
        },
        createdAt: options.createdAt,
        sourceFingerprint: options.sourceFingerprint,
        contentClass: "SUMMARY",
        summary: options.summary,
        content: options.content,
      },
      {
        maxCaptureBytes: 16_384,
        privatePathRoots: [options.fixture.root, options.fixture.repository],
        privatePromptValues: [task6Prompt],
      },
    ),
  );
}

function deadlineFrom(now: string, timeoutMs: number): string {
  return new Date(Date.parse(now) + timeoutMs).toISOString();
}

function finalSummary(projection: RunProjection): Task6ManagedChangeEvidence["finalSummary"] {
  const blockingFindings = projection.reviewReceipts.flatMap((receipt) =>
    receipt.findings
      .filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map((finding) => `${finding.severity}:${finding.scope}`),
  );
  return {
    attempts: projection.attempts.map(
      (attempt) =>
        `${attempt.attemptId}:execution=${attempt.executionStatus},verification=${attempt.verificationStatus}`,
    ),
    checks: projection.checks.map((check) => `${check.checkId}:${check.status}`),
    blockingFindings,
    unresolvedRisks: [
      "Task 6 uses a disposable fixture only; real repositories remain prohibited until Task 7.",
      "The Pi Host has PROCESS_AUTHORITY and Task 7 process-tree containment is NOT_PROVEN.",
      "Interrupt, Checkpoint, reconciliation, and resume remain NOT_PROVEN in the Task 6 JSON Host.",
      "Remote Windows and Ubuntu CI remain PENDING until this exact source is pushed.",
    ],
  };
}

export async function runTask6ManagedChange(
  options: RunTask6ManagedChangeOptions,
): Promise<Task6ManagedChangeEvidence> {
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const overheadStartedAt = monotonicNow();
  let excludedRuntimeMs = 0;
  let fixture: Task6DisposableFixture | undefined;
  let cleanupStatus: "PASS" | "BLOCKED";
  try {
    fixture = await createTask6DisposableFixture(options.parentDirectory);
    const promotion = await captureTask6QuickSessionPromotion(fixture, {
      includePaths: ["result.txt"],
      excludePaths: ["scratch.txt"],
    });
    const createdAt = now();
    const reviewInputFingerprint = sha256(
      JSON.stringify({
        sourceFingerprint: promotion.sourceFingerprint,
        includePaths: promotion.includePaths,
        excludePaths: promotion.excludePaths,
      }),
    );
    const checkDefinitionFingerprint = sha256(
      JSON.stringify({
        executable: "node",
        argv: ["verify.mjs"],
        workingDirectoryReference: "fixture-repository",
      }),
    );
    const checkConfigurationFingerprint = sha256(
      JSON.stringify({
        expectedResult: "READY\\n",
        includePaths: promotion.includePaths,
        excludePaths: promotion.excludePaths,
      }),
    );
    const change = managedChangeSchema.parse({
      schemaVersion: "1.0.0",
      changeId: "chg_task6",
      title: "Verify one disposable Hunter Pi Managed Change",
      goal: "Make result.txt pass the declared independent check",
      nonGoals: ["Mutate a real repository", "Commit, push, publish, or deploy"],
      constraints: [
        "Only result.txt may change",
        "scratch.txt remains explicitly excluded",
        "One real Pi Agent request is permitted",
      ],
      lifecycle: "PLANNED",
      createdAt,
    });
    const planRevision = planRevisionSchema.parse({
      schemaVersion: "1.0.0",
      planRevisionId: "plan_task6",
      changeId: change.changeId,
      revision: 1,
      workspaceId: "workspace_task6",
      workspaceFingerprint: promotion.workspaceFingerprint,
      sourceFingerprint: promotion.sourceFingerprint,
      goal: change.goal,
      nonGoals: change.nonGoals,
      constraints: change.constraints,
      steps: [
        {
          stepId: "step_task6-agent",
          kind: "agent",
          title: "Fix the disposable result through Pi",
          dependsOn: [],
          required: true,
          inputContractFingerprint: sha256("task6-agent-input.v1"),
          outputContractFingerprint: sha256("task6-agent-output.v1"),
        },
        {
          stepId: "step_task6-review",
          kind: "review",
          title: "Review exact fixture mutations",
          dependsOn: ["step_task6-agent"],
          required: true,
          inputContractFingerprint: sha256("task6-review-input-contract.v1"),
          outputContractFingerprint: sha256("task6-review-output-contract.v1"),
          inputFingerprint: reviewInputFingerprint,
          reviewDefinitionFingerprint: sha256("task6-deterministic-review.v1"),
          configurationFingerprint: checkConfigurationFingerprint,
        },
      ],
      checks: [
        {
          checkId: "check_task6-result",
          version: 1,
          label: "Disposable result check",
          kind: "command",
          required: true,
          definition: {
            executable: "node",
            argv: ["verify.mjs"],
            workingDirectoryReference: "fixture-repository",
          },
          definitionFingerprint: checkDefinitionFingerprint,
          configurationFingerprint: checkConfigurationFingerprint,
        },
      ],
      loopPolicy: {
        maxIterations: 2,
        maxElapsedMs: 600_000,
        repeatedFailureLimit: 2,
        resourceBudgets: {
          maxAgentTurns: 1,
          maxExternalOperations: 4,
          maxCommands: 2,
          maxOutputBytes: maximumOutputBytes,
        },
        stopOnUserInput: true,
        stopOnWorkspaceDrift: true,
      },
      createdAt,
    });
    const run = runSchema.parse({
      schemaVersion: "1.0.0",
      runId: "run_task6",
      changeId: change.changeId,
      planRevisionId: planRevision.planRevisionId,
      workspaceId: planRevision.workspaceId,
      workspaceFingerprint: planRevision.workspaceFingerprint,
      sourceFingerprint: planRevision.sourceFingerprint,
      lifecycle: "PLANNED",
      archiveStatus: "UNARCHIVED",
      startedAt: createdAt,
    });
    const kernel = new InMemoryWorkflowKernel();
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change,
      planRevision,
      run,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: task6Attempt1Id,
      startedAt: now(),
    });
    const preparationEvidence = makeEvidence({
      evidenceId: "evidence_task6-preparation",
      kind: "observation",
      runId: run.runId,
      attemptId: "att_task6-1",
      createdAt: now(),
      sourceFingerprint: planRevision.sourceFingerprint,
      summary: "The deliberate failing fixture preparation completed.",
      content: JSON.stringify({
        fixturePolicy: promotion.fixturePolicy,
        dirtyPaths: promotion.dirtyPaths,
        deliberateFailure: true,
      }),
      fixture,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_task6-preparation"),
        runId: run.runId,
        attemptId: task6Attempt1Id,
        kind: "PROCESS_EXITED",
        observedAt: now(),
        summary: "The deliberate fixture preparation process exited; Verification is required.",
        evidenceIds: [preparationEvidence.evidenceId],
      },
    });
    let externalStartedAt = monotonicNow();
    const firstVerification = await runDeclaredCommandVerification({
      planRevision,
      runId: run.runId,
      attemptId: task6Attempt1Id,
      checkId: task6CheckId,
      verificationReceiptId: task6FirstVerificationId,
      evidenceId: task6FirstVerificationEvidenceId,
      repository: fixture.repository,
      environmentFingerprint: fingerprintSchema.parse(options.environmentFingerprint),
      timeoutMs: 30_000,
      maximumOutputBytes,
      now,
    });
    excludedRuntimeMs += monotonicNow() - externalStartedAt;
    const firstVerificationEvidence = makeEvidence({
      evidenceId: "evidence_task6-verify-1",
      kind: "verification",
      runId: run.runId,
      attemptId: "att_task6-1",
      verificationReceiptId: firstVerification.receipt.verificationReceiptId,
      createdAt: now(),
      sourceFingerprint: planRevision.sourceFingerprint,
      summary: "Attempt 1 independent command Verification failed as preregistered.",
      content: JSON.stringify(firstVerification.receipt),
      fixture,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: firstVerification.receipt,
    });
    if (firstVerification.receipt.outcome !== "FAIL") {
      throw new Error("Task 6 deliberate first Verification did not fail");
    }
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RETRY_ATTEMPT",
      runId: run.runId,
      previousAttemptId: task6Attempt1Id,
      attemptId: task6Attempt2Id,
      failureEvidenceIds: [firstVerificationEvidence.evidenceId],
      failureFingerprint: firstVerification.receipt.resultFingerprint,
      reason: "Apply one bounded Pi fixback for the exact failed result check.",
      elapsedMs: 1,
      consumedResources: {
        agentTurns: 0,
        externalOperations: 0,
        commands: 1,
        outputBytes: firstVerification.receipt.output.capturedBytes,
      },
      userInputRequired: false,
      workspaceDriftDetected: false,
      startedAt: now(),
    });

    const capabilityReceipt = capabilityReceiptSchema.parse(
      await options.engineHost.probe({
        schemaVersion: "1.0.0",
        requestedCapabilities: ["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "CLOSE"],
      }),
    );
    for (const capability of ["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "CLOSE"] as const) {
      if (!supportsEngineCapability(capabilityReceipt, capability)) {
        throw new Error(`Task 6 Engine Host capability ${capability} is not supported`);
      }
    }
    const operationNow = now();
    const operationDeadline = deadlineFrom(operationNow, 300_000);
    const startPayload = {
      runId: run.runId,
      attemptId: task6Attempt2Id,
      planRevisionId: planRevision.planRevisionId,
      workspaceReference: fixture.repository,
    };
    const startReceipt = await options.engineHost.start(
      startAttemptRequestSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-start",
        fingerprint: sha256(JSON.stringify(startPayload)),
        expectedTarget: {
          namespace: "workspace",
          reference: fixture.repository,
        },
        deadline: operationDeadline,
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 300_000 },
        ...startPayload,
      }),
    );
    const promptFingerprint = sha256(task6Prompt);
    const engineInput = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-send",
      fingerprint: promptFingerprint,
      expectedTarget: {
        namespace: "engine-handle",
        reference: startReceipt.handle.engineHandleId,
      },
      deadline: operationDeadline,
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 300_000 },
      kind: "USER_INPUT",
      content: task6Prompt,
    });
    externalStartedAt = monotonicNow();
    const sendReceipt = await options.engineHost.send(startReceipt.handle, engineInput);
    excludedRuntimeMs += monotonicNow() - externalStartedAt;
    const engineObservations = [];
    for await (const observation of options.engineHost.observe(startReceipt.handle)) {
      engineObservations.push(observation);
    }
    const closeReceipt = await options.engineHost.close(startReceipt.handle, {
      schemaVersion: "1.0.0",
      operationId: operationIdSchema.parse("op_task6-close"),
      fingerprint: sha256("task6-close-after-one-shot"),
      expectedTarget: {
        namespace: "engine-handle",
        reference: startReceipt.handle.engineHandleId,
      },
      deadline: operationDeadline,
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      reason: "Task 6 one-shot Agent operation returned.",
    });
    const agentEvidence = makeEvidence({
      evidenceId: "evidence_task6-agent",
      kind: "observation",
      runId: run.runId,
      attemptId: "att_task6-2",
      createdAt: now(),
      sourceFingerprint: planRevision.sourceFingerprint,
      summary: "The bounded Pi Agent operation returned provider-neutral observations.",
      content: JSON.stringify({
        startOperation: startReceipt.operationReceipt,
        sendOperation: sendReceipt,
        closeOperation: closeReceipt,
        observationKinds: engineObservations.map((observation) => observation.kind),
      }),
      fixture,
    });
    let lifecycleAfterAgentReturn: "VERIFYING" | "NOT_OBSERVED" = "NOT_OBSERVED";
    for (const observation of engineObservations) {
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_OBSERVATION",
        observation: {
          schemaVersion: "1.0.0",
          observationId: observationIdSchema.parse(`obs_task6-agent-${String(observation.cursor)}`),
          runId: run.runId,
          attemptId: task6Attempt2Id,
          stepId: task6AgentStepId,
          kind: observation.kind,
          observedAt: observation.observedAt,
          ...(observation.summary === undefined ? {} : { summary: observation.summary }),
          evidenceIds: [agentEvidence.evidenceId],
        },
      });
      if (observation.kind === "AGENT_RETURNED") {
        lifecycleAfterAgentReturn = (await kernel.project(run.runId)).change.lifecycle as
          "VERIFYING" | "NOT_OBSERVED";
      }
    }

    externalStartedAt = monotonicNow();
    const secondVerification = await runDeclaredCommandVerification({
      planRevision,
      runId: run.runId,
      attemptId: task6Attempt2Id,
      checkId: task6CheckId,
      verificationReceiptId: task6SecondVerificationId,
      evidenceId: task6SecondVerificationEvidenceId,
      repository: fixture.repository,
      environmentFingerprint: fingerprintSchema.parse(options.environmentFingerprint),
      timeoutMs: 30_000,
      maximumOutputBytes,
      now,
    });
    excludedRuntimeMs += monotonicNow() - externalStartedAt;
    const secondVerificationEvidence = makeEvidence({
      evidenceId: "evidence_task6-verify-2",
      kind: "verification",
      runId: run.runId,
      attemptId: "att_task6-2",
      verificationReceiptId: secondVerification.receipt.verificationReceiptId,
      createdAt: now(),
      sourceFingerprint: planRevision.sourceFingerprint,
      summary: `Attempt 2 independent command Verification returned ${secondVerification.receipt.outcome}.`,
      content: JSON.stringify(secondVerification.receipt),
      fixture,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: secondVerification.receipt,
    });

    const review = await inspectTask6FixtureForReview(fixture, promotion);
    let reviewEvidence: EvidenceEnvelope | undefined;
    if (secondVerification.receipt.outcome === "PASS") {
      const reviewEvidenceId = evidenceIdSchema.parse("evidence_task6-review");
      const findings: ReviewFinding[] = [
        ...review.findings.map((finding) => ({
          ...finding,
          evidenceIds: [reviewEvidenceId],
          confidence: 1,
        })),
        ...(sendReceipt.outcome === "APPLIED" &&
        engineObservations.some((observation) => observation.kind === "AGENT_RETURNED")
          ? []
          : [
              {
                severity: "P1" as const,
                scope: "agent-operation-outcome",
                rationale:
                  "The real Agent operation did not produce both an APPLIED Receipt and AGENT_RETURNED Observation.",
                evidenceIds: [reviewEvidenceId],
                confidence: 1,
              },
            ]),
      ];
      reviewEvidence = makeEvidence({
        evidenceId: reviewEvidenceId,
        kind: "review",
        runId: run.runId,
        attemptId: "att_task6-2",
        createdAt: now(),
        sourceFingerprint: planRevision.sourceFingerprint,
        summary: `Deterministic Task 6 review completed with ${String(findings.length)} blocking finding(s).`,
        content: JSON.stringify({
          dirtyPaths: review.dirtyPaths,
          resultReady: review.resultReady,
          excludedContentUnchanged: review.excludedContentUnchanged,
          baseCommitUnchanged: review.baseCommitUnchanged,
          findings,
        }),
        fixture,
      });
      const reviewStep = planRevision.steps.find(
        (step) => step.stepId === "step_task6-review" && step.kind === "review",
      );
      if (reviewStep?.kind !== "review") throw new Error("Task 6 review Step is missing");
      const reviewReceipt = reviewReceiptSchema.parse({
        schemaVersion: "1.0.0",
        reviewReceiptId: "review_task6",
        runId: run.runId,
        attemptId: "att_task6-2",
        stepId: reviewStep.stepId,
        inputFingerprint: reviewStep.inputFingerprint,
        reviewDefinitionFingerprint: reviewStep.reviewDefinitionFingerprint,
        configurationFingerprint: reviewStep.configurationFingerprint,
        workspaceFingerprint: planRevision.workspaceFingerprint,
        sourceFingerprint: planRevision.sourceFingerprint,
        resultFingerprint: sha256(
          JSON.stringify({
            verificationInputFingerprint: secondVerification.receipt.inputFingerprint,
            findings,
          }),
        ),
        outcome: "PASS",
        observedAt: now(),
        findings,
        evidenceIds: [reviewEvidence.evidenceId],
      });
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_REVIEW_RECEIPT",
        receipt: reviewReceipt,
      });
    }

    const projection = await kernel.project(run.runId);
    const referencedEvidence = [
      preparationEvidence,
      firstVerificationEvidence,
      agentEvidence,
      secondVerificationEvidence,
      ...(reviewEvidence === undefined ? [] : [reviewEvidence]),
    ];
    const summaryEvidence = createRunSummaryEvidence(
      {
        schemaVersion: "1.0.0",
        evidenceId: "evidence_task6-summary",
        projection,
        evidence: referencedEvidence,
        createdAt: now(),
      },
      {
        privatePathRoots: [fixture.root, fixture.repository],
        privatePromptValues: [task6Prompt],
      },
    );
    const evidence = [...referencedEvidence, summaryEvidence];
    const summary = finalSummary(projection);
    const failedAttemptPreserved =
      projection.attempts[0]?.verificationStatus === "FAILED" &&
      projection.verificationReceipts[0]?.outcome === "FAIL";
    const blockingFindings = summary.blockingFindings.length > 0;
    const fixbackPass =
      projection.attempts[1]?.verificationStatus === "PASSED" &&
      projection.verificationReceipts[1]?.outcome === "PASS" &&
      !blockingFindings;
    const zeroFalseReady =
      projection.change.lifecycle !== "READY" ||
      (failedAttemptPreserved && fixbackPass && !review.sourceLoss);
    const summaryComplete =
      summary.attempts.length === projection.attempts.length &&
      summary.checks.length === projection.checks.length;
    const operationReceipts = [startReceipt.operationReceipt, sendReceipt, closeReceipt];
    const portableBeforeScore = {
      schemaVersion: "hpi-task6-managed-change.v1" as const,
      observedAt: now(),
      productSource: options.productSource,
      engineRelease: options.engineRelease,
      provider: {
        id: options.providerId,
        authStatus: "DETECTED" as const,
        requestStatus:
          sendReceipt.outcome === "APPLIED" ? ("DETECTED" as const) : ("NOT_PROVEN" as const),
        promptFingerprint,
      },
      fixture: {
        fixturePolicy: promotion.fixturePolicy,
        baseCommit: promotion.baseCommit,
        includePaths: promotion.includePaths,
        excludePaths: promotion.excludePaths,
        dirtyPaths: promotion.dirtyPaths,
        workspaceFingerprint: promotion.workspaceFingerprint,
        sourceFingerprint: promotion.sourceFingerprint,
        excludedContentFingerprint: promotion.excludedContentFingerprint,
      },
      capabilityReceipt,
      operationReceipts,
      lifecycleAfterAgentReturn,
      projection,
      evidence,
      finalSummary: summary,
      remoteCi: "PENDING" as const,
    };
    const portableText = JSON.stringify(portableBeforeScore);
    const secretLeak =
      portableText.includes(fixture.root) ||
      portableText.includes(fixture.repository) ||
      /\b(?:authorization|cookie|api[_-]?key|access[_-]?token)\s*[:=]/iu.test(portableText);
    const overheadMs = Math.max(0, monotonicNow() - overheadStartedAt - excludedRuntimeMs);
    const overheadWithinLimit = overheadMs <= 600_000;
    const scorecard = {
      zeroFalseReady,
      sourceLoss: review.sourceLoss,
      secretLeak,
      failedAttemptPreserved,
      fixbackPass,
      unplannedInterventions: 0,
      overheadMs,
      overheadWithinLimit,
      summaryComplete,
    };
    const correctnessPassed =
      projection.change.lifecycle === "READY" &&
      zeroFalseReady &&
      !scorecard.sourceLoss &&
      !scorecard.secretLeak &&
      failedAttemptPreserved &&
      fixbackPass &&
      summaryComplete;
    const taskResult = correctnessPassed
      ? overheadWithinLimit && scorecard.unplannedInterventions <= 2
        ? "GO"
        : "REVISE"
      : "STOP";

    try {
      await removeTask6DisposableFixture(fixture);
      cleanupStatus = "PASS";
    } catch {
      cleanupStatus = "BLOCKED";
    }
    return task6ManagedChangeEvidenceSchema.parse({
      ...portableBeforeScore,
      taskResult: cleanupStatus === "PASS" ? taskResult : "STOP",
      scorecard,
      cleanup: { status: cleanupStatus },
    });
  } catch (error: unknown) {
    if (fixture !== undefined) {
      try {
        await removeTask6DisposableFixture(fixture);
      } catch {
        // Preserve the original failure; exact cleanup remains unclaimed.
      }
    }
    throw error;
  }
}
