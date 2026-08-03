import { describe, expect, it } from "vitest";

import {
  attemptSchema,
  checkpointSchema,
  compatibilityReceiptSchema,
  evidenceEnvelopeSchema,
  humanReceiptSchema,
  loopPolicySchema,
  managedChangeSchema,
  operationReceiptSchema,
  planRevisionSchema,
  pluginAssuranceReceiptSchema,
  reviewReceiptSchema,
  runSchema,
  verificationReceiptSchema,
} from "@hunter-pi/domain";

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(64)}`;

const boundedLoopPolicy = {
  maxIterations: 3,
  maxElapsedMs: 60_000,
  repeatedFailureLimit: 2,
  resourceBudgets: {
    maxExternalOperations: 10,
  },
  stopOnUserInput: true,
  stopOnWorkspaceDrift: true,
} as const;

function createPlanFixture() {
  return {
    schemaVersion: "1.0.0" as const,
    planRevisionId: "plan_example",
    changeId: "chg_example",
    revision: 1,
    workspaceId: "workspace_example",
    workspaceFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    goal: "Deliver one independently verified change",
    nonGoals: ["Publish a package"],
    constraints: ["Keep provider details outside the domain"],
    steps: [
      {
        stepId: "step_execute",
        kind: "agent" as const,
        title: "Implement the bounded change",
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
        kind: "command" as const,
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
    loopPolicy: boundedLoopPolicy,
    createdAt: timestamp,
  };
}

describe("strict domain schemas", () => {
  it("accepts a bounded managed plan and rejects unknown provider fields", () => {
    const change = managedChangeSchema.parse({
      schemaVersion: "1.0.0",
      changeId: "chg_example",
      title: "Add a verified command",
      goal: "Deliver one independently verified change",
      nonGoals: ["Publish a package"],
      constraints: ["Keep provider details outside the domain"],
      lifecycle: "PLANNED",
      createdAt: timestamp,
    });

    expect(change.changeId).toBe("chg_example");

    const plan = createPlanFixture();

    expect(planRevisionSchema.parse(plan).planRevisionId).toBe("plan_example");
    expect(planRevisionSchema.safeParse({ ...plan, piSessionId: "private" }).success).toBe(false);
    expect(planRevisionSchema.safeParse({ ...plan, ompTaskId: "private" }).success).toBe(false);
    expect(planRevisionSchema.safeParse({ ...plan, providerModel: "private" }).success).toBe(false);
  });

  it("rejects duplicate Plan identities and invalid dependency graphs", () => {
    const plan = createPlanFixture();
    const secondStep = {
      ...plan.steps[0],
      title: "A second step must have its own identity",
    };
    const secondCheck = {
      ...plan.checks[0],
      label: "A second check must have its own identity",
    };

    expect(
      planRevisionSchema.safeParse({ ...plan, steps: [...plan.steps, secondStep] }).success,
    ).toBe(false);
    expect(
      planRevisionSchema.safeParse({ ...plan, checks: [...plan.checks, secondCheck] }).success,
    ).toBe(false);
    expect(
      planRevisionSchema.safeParse({
        ...plan,
        steps: [
          ...plan.steps,
          {
            stepId: "step_dangling",
            kind: "verify",
            title: "Reject a dangling dependency",
            dependsOn: ["step_missing"],
            required: true,
            inputContractFingerprint: fingerprint,
            outputContractFingerprint: fingerprint,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      planRevisionSchema.safeParse({
        ...plan,
        steps: [
          { ...plan.steps[0], dependsOn: ["step_second"] },
          {
            stepId: "step_second",
            kind: "verify",
            title: "Reject a dependency cycle",
            dependsOn: ["step_execute"],
            required: true,
            inputContractFingerprint: fingerprint,
            outputContractFingerprint: fingerprint,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects loop policies without every finite bound", () => {
    expect(loopPolicySchema.safeParse(boundedLoopPolicy).success).toBe(true);
    expect(
      loopPolicySchema.safeParse({
        ...boundedLoopPolicy,
        maxIterations: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
    expect(
      loopPolicySchema.safeParse({
        ...boundedLoopPolicy,
        maxElapsedMs: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
    expect(
      loopPolicySchema.safeParse({
        ...boundedLoopPolicy,
        resourceBudgets: {},
      }).success,
    ).toBe(false);
  });

  it("rejects a Plan Revision without a required automated check", () => {
    const plan = {
      schemaVersion: "1.0.0",
      planRevisionId: "plan_no-required-check",
      changeId: "chg_example",
      revision: 1,
      workspaceId: "workspace_no-required-check",
      workspaceFingerprint: fingerprint,
      sourceFingerprint: fingerprint,
      goal: "Do not infer verification from an empty set",
      nonGoals: [],
      constraints: [],
      steps: [
        {
          stepId: "step_execute",
          kind: "agent",
          title: "Return without verification",
          dependsOn: [],
          required: true,
          inputContractFingerprint: fingerprint,
          outputContractFingerprint: fingerprint,
        },
      ],
      checks: [
        {
          checkId: "check_optional",
          version: 1,
          label: "Optional diagnostic",
          kind: "command",
          required: false,
          definition: {
            executable: "npm",
            argv: ["test"],
            workingDirectoryReference: "workspace-root",
          },
          definitionFingerprint: fingerprint,
          configurationFingerprint: fingerprint,
        },
      ],
      loopPolicy: boundedLoopPolicy,
      createdAt: timestamp,
    };

    expect(planRevisionSchema.safeParse(plan).success).toBe(false);
  });

  it("models execution and verification as independent dimensions", () => {
    const run = runSchema.parse({
      schemaVersion: "1.0.0",
      runId: "run_example",
      changeId: "chg_example",
      planRevisionId: "plan_example",
      workspaceId: "workspace_example",
      workspaceFingerprint: fingerprint,
      sourceFingerprint: fingerprint,
      lifecycle: "RUNNING",
      archiveStatus: "UNARCHIVED",
      startedAt: timestamp,
    });
    const attempt = attemptSchema.parse({
      schemaVersion: "1.0.0",
      attemptId: "att_example",
      runId: run.runId,
      planRevisionId: run.planRevisionId,
      sequence: 1,
      elapsedMsAtStart: 0,
      remainingResourceBudgets: { maxExternalOperations: 10 },
      executionStatus: "RETURNED",
      verificationStatus: "NOT_READY",
      startedAt: timestamp,
    });

    expect(attempt.executionStatus).toBe("RETURNED");
    expect(attempt.verificationStatus).toBe("NOT_READY");
  });

  it("requires failure Evidence for a rejected gate or failed Review", () => {
    expect(
      humanReceiptSchema.safeParse({
        schemaVersion: "1.0.0",
        humanReceiptId: "human_rejected-without-evidence",
        runId: "run_example",
        attemptId: "att_example",
        stepId: "step_approval",
        contentHash: fingerprint,
        resultFingerprint: fingerprint,
        decision: "REJECTED",
        actorReference: "local-owner",
        recordedAt: timestamp,
        evidenceIds: [],
      }).success,
    ).toBe(false);
    expect(
      reviewReceiptSchema.safeParse({
        schemaVersion: "1.0.0",
        reviewReceiptId: "review_failed-without-evidence",
        runId: "run_example",
        attemptId: "att_example",
        stepId: "step_review",
        inputFingerprint: fingerprint,
        reviewDefinitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
        workspaceFingerprint: fingerprint,
        sourceFingerprint: fingerprint,
        resultFingerprint: fingerprint,
        outcome: "FAIL",
        observedAt: timestamp,
        findings: [],
        evidenceIds: [],
      }).success,
    ).toBe(false);
  });

  it("does not permit NOT_RUN as a Verification Receipt outcome", () => {
    const receipt = {
      schemaVersion: "1.0.0",
      verificationReceiptId: "verify_example",
      runId: "run_example",
      attemptId: "att_example",
      checkId: "check_unit",
      checkVersion: 1,
      checkDefinitionFingerprint: fingerprint,
      resultFingerprint: fingerprint,
      outcome: "PASS",
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
      evidenceIds: ["evidence_verify"],
    };

    expect(verificationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(verificationReceiptSchema.safeParse({ ...receipt, outcome: "NOT_RUN" }).success).toBe(
      false,
    );
    expect(
      verificationReceiptSchema.safeParse({
        ...receipt,
        providerRequestId: "private",
      }).success,
    ).toBe(false);
    expect(
      verificationReceiptSchema.safeParse({
        ...receipt,
        resultStatus: { kind: "EXIT_CODE", exitCode: 1, timedOut: false },
      }).success,
    ).toBe(false);
    expect(
      verificationReceiptSchema.safeParse({
        ...receipt,
        resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: true },
      }).success,
    ).toBe(false);
  });

  it("accepts portable Evidence, Checkpoint, plugin, and operation receipts", () => {
    expect(
      evidenceEnvelopeSchema.parse({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_verify",
        kind: "verification",
        createdAt: timestamp,
        sourceFingerprint: fingerprint,
        contentHash: fingerprint,
        summary: "The declared unit-test command passed.",
        redaction: { applied: true, fieldsRemoved: 1 },
      }).evidenceId,
    ).toBe("evidence_verify");

    expect(
      checkpointSchema.parse({
        schemaVersion: "1.0.0",
        checkpointId: "checkpoint_example",
        runId: "run_example",
        attemptId: "att_example",
        planRevisionId: "plan_example",
        distributionReleaseId: "release_example",
        workspaceId: "workspace_example",
        repositoryFingerprint: fingerprint,
        workspaceFingerprint: fingerprint,
        eventCursor: 4,
        createdAt: timestamp,
        sourceFingerprint: fingerprint,
        engine: {
          engineReleaseId: "engine-release_example",
          engineReleaseFingerprint: fingerprint,
          resumeCapability: "NOT_PROVEN",
        },
        activeOperationReceiptIds: ["opreceipt_example"],
        unknownOperationIds: [],
        heldWriterLeaseIds: [],
        processReferences: [],
        remainingResourceBudgets: { maxExternalOperations: 4 },
      }).eventCursor,
    ).toBe(4);

    const compatibility = compatibilityReceiptSchema.parse({
      schemaVersion: "1.0.0",
      compatibilityReceiptId: "compat_example",
      pluginId: "plugin_example",
      pluginVersion: "1.0.0",
      pluginReleaseFingerprint: fingerprint,
      distributionReleaseId: "release_example",
      engineReleaseId: "engine-release_example",
      engineReleaseFingerprint: fingerprint,
      platformFingerprint: fingerprint,
      configurationFingerprint: fingerprint,
      outcome: "VERIFIED",
      checkedAt: timestamp,
      evidenceIds: ["evidence_verify"],
    });
    expect(
      pluginAssuranceReceiptSchema.parse({
        schemaVersion: "1.0.0",
        pluginAssuranceReceiptId: "assurance_example",
        compatibilityReceipt: compatibility,
        compatibility: compatibility.outcome,
        trust: "USER_APPROVED",
        isolation: "NOT_PROVEN",
        assessedAt: timestamp,
        evidenceIds: ["evidence_verify"],
      }).trust,
    ).toBe("USER_APPROVED");
    expect(
      pluginAssuranceReceiptSchema.safeParse({
        schemaVersion: "1.0.0",
        pluginAssuranceReceiptId: "assurance_mismatch",
        compatibilityReceipt: compatibility,
        compatibility: "INCOMPATIBLE",
        trust: "QUARANTINED",
        isolation: "NOT_PROVEN",
        assessedAt: timestamp,
        evidenceIds: ["evidence_verify"],
      }).success,
    ).toBe(false);

    expect(
      operationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        operationReceiptId: "opreceipt_example",
        operationId: "op_example",
        fingerprint,
        outcome: "APPLIED",
        observedEffects: ["fixture-created"],
        observedAt: timestamp,
      }).outcome,
    ).toBe("APPLIED");
    expect(
      operationReceiptSchema.safeParse({
        schemaVersion: "1.0.0",
        operationReceiptId: "opreceipt_unknown",
        operationId: "op_unknown",
        fingerprint,
        outcome: "UNKNOWN",
        observedEffects: ["unproven-effect"],
        observedAt: timestamp,
      }).success,
    ).toBe(false);
  });
});
