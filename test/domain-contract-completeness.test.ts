import { describe, expect, it } from "vitest";

import {
  checkpointSchema,
  compatibilityReceiptSchema,
  externalOperationSchema,
  planRevisionSchema,
  pluginAssuranceReceiptSchema,
  verificationReceiptSchema,
} from "@hunter-pi/domain";
import {
  checkProjectionSchema,
  recoveryDecisionSchema,
  workflowCommandSchema,
  workflowEventSchema,
} from "@hunter-pi/workflow-kernel";

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = (character: string) => `sha256:${character.repeat(64)}` as const;

describe("complete public contract boundaries", () => {
  it("requires external operations to bind target, deadline, and cancellation", () => {
    const operation = {
      schemaVersion: "1.0.0",
      operationId: "op_complete",
      fingerprint: fingerprint("a"),
      expectedTarget: {
        namespace: "workspace",
        reference: "workspace_complete",
      },
      deadline: "2099-08-03T00:00:00.000Z",
      cancellationPolicy: {
        mode: "FAIL_CLOSED",
        timeoutMs: 30_000,
      },
    };
    expect(externalOperationSchema.safeParse(operation).success).toBe(true);
    for (const requiredField of ["expectedTarget", "deadline", "cancellationPolicy"] as const) {
      expect(
        externalOperationSchema.safeParse(
          Object.fromEntries(Object.entries(operation).filter(([key]) => key !== requiredField)),
        ).success,
      ).toBe(false);
    }
  });

  it("binds a Plan Revision to workspace, source, exact checks, and required gates", () => {
    const plan = planRevisionSchema.parse({
      schemaVersion: "1.0.0",
      planRevisionId: "plan_complete",
      changeId: "chg_complete",
      revision: 1,
      workspaceId: "workspace_complete",
      workspaceFingerprint: fingerprint("a"),
      sourceFingerprint: fingerprint("b"),
      goal: "Verify one exact source state",
      nonGoals: [],
      constraints: [],
      steps: [
        {
          stepId: "step_execute",
          kind: "agent",
          title: "Implement",
          dependsOn: [],
          required: true,
          inputContractFingerprint: fingerprint("1"),
          outputContractFingerprint: fingerprint("2"),
        },
        {
          stepId: "step_approval",
          kind: "human_gate",
          title: "Approve the exact result",
          dependsOn: ["step_execute"],
          required: false,
          inputContractFingerprint: fingerprint("3"),
          outputContractFingerprint: fingerprint("4"),
          expectedContentHash: fingerprint("e"),
          allowedDecisions: ["APPROVED", "REJECTED"],
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
            argv: ["test", "--", "test/unit.test.ts"],
            workingDirectoryReference: "workspace-root",
          },
          definitionFingerprint: fingerprint("c"),
          configurationFingerprint: fingerprint("d"),
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

    expect(plan.workspaceId).toBe("workspace_complete");
    expect(plan.steps[0]?.inputContractFingerprint).toBe(fingerprint("1"));
    expect(plan.steps[1]?.required).toBe(false);
    expect(plan.checks[0]?.version).toBe(1);
  });

  it("requires a Verification Receipt to bind every declared proof dimension", () => {
    const receipt = {
      schemaVersion: "1.0.0",
      verificationReceiptId: "verify_complete",
      runId: "run_complete",
      attemptId: "att_complete",
      checkId: "check_unit",
      checkVersion: 1,
      checkDefinitionFingerprint: fingerprint("c"),
      resultFingerprint: fingerprint("0"),
      outcome: "PASS",
      startedAt: timestamp,
      endedAt: "2026-08-03T00:00:01.000Z",
      observedAt: "2026-08-03T00:00:01.000Z",
      inputFingerprint: fingerprint("e"),
      configFingerprint: fingerprint("d"),
      workspaceFingerprint: fingerprint("a"),
      sourceFingerprint: fingerprint("b"),
      environmentFingerprint: fingerprint("f"),
      resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
      output: {
        stdoutDigest: fingerprint("1"),
        stderrDigest: fingerprint("2"),
        artifactDigests: [],
        capturedBytes: 128,
        stdoutTruncated: false,
        stderrTruncated: false,
        redaction: { applied: true, fieldsRemoved: 1 },
      },
      evidenceIds: ["evidence_complete"],
    };

    expect(verificationReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const requiredField of [
      "checkVersion",
      "checkDefinitionFingerprint",
      "resultFingerprint",
      "sourceFingerprint",
      "environmentFingerprint",
      "resultStatus",
      "output",
    ] as const) {
      const incomplete = Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== requiredField),
      );
      expect(verificationReceiptSchema.safeParse(incomplete).success, requiredField).toBe(false);
    }
  });

  it("uses the canonical Compatibility, Trust, and Isolation vocabulary", () => {
    const compatibility = compatibilityReceiptSchema.parse({
      schemaVersion: "1.0.0",
      compatibilityReceiptId: "compat_complete",
      pluginId: "plugin_complete",
      pluginVersion: "1.2.3",
      pluginReleaseFingerprint: fingerprint("a"),
      distributionReleaseId: "release_complete",
      engineReleaseId: "engine-release_complete",
      engineReleaseFingerprint: fingerprint("b"),
      platformFingerprint: fingerprint("c"),
      configurationFingerprint: fingerprint("d"),
      outcome: "VERIFIED",
      checkedAt: timestamp,
      evidenceIds: ["evidence_complete"],
    });
    const assurance = pluginAssuranceReceiptSchema.parse({
      schemaVersion: "1.0.0",
      pluginAssuranceReceiptId: "assurance_complete",
      compatibilityReceipt: compatibility,
      compatibility: compatibility.outcome,
      trust: "USER_APPROVED",
      isolation: "PROCESS_AUTHORITY",
      assessedAt: timestamp,
      evidenceIds: ["evidence_complete"],
    });

    expect(assurance).toMatchObject({
      compatibility: "VERIFIED",
      trust: "USER_APPROVED",
      isolation: "PROCESS_AUTHORITY",
    });
  });

  it("captures the identities needed to assess recovery without claiming it", () => {
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: "checkpoint_complete",
      runId: "run_complete",
      attemptId: "att_complete",
      planRevisionId: "plan_complete",
      distributionReleaseId: "release_complete",
      workspaceId: "workspace_complete",
      repositoryFingerprint: fingerprint("1"),
      workspaceFingerprint: fingerprint("a"),
      sourceFingerprint: fingerprint("b"),
      eventCursor: 4,
      createdAt: timestamp,
      engine: {
        engineReleaseId: "engine-release_complete",
        engineReleaseFingerprint: fingerprint("2"),
        sessionReference: {
          namespace: "engine-session",
          reference: "opaque-session-reference",
        },
        resumeCapability: "NOT_PROVEN",
      },
      activeOperationReceiptIds: ["opreceipt_complete"],
      unknownOperationIds: ["op_unknown"],
      heldWriterLeaseIds: ["lease_complete"],
      processReferences: [{ namespace: "managed-process", reference: "opaque-process-reference" }],
      remainingResourceBudgets: { maxExternalOperations: 4 },
    });

    expect(checkpoint.engine.resumeCapability).toBe("NOT_PROVEN");
    expect(checkpoint.unknownOperationIds).toEqual(["op_unknown"]);
  });

  it("versions Workflow Events and projections at runtime", () => {
    const event = {
      schemaVersion: "1.0.0",
      cursor: 1,
      type: "RUN_CREATED",
      change: {
        schemaVersion: "1.0.0",
        changeId: "chg_complete",
        title: "Version events",
        goal: "Make event compatibility explicit",
        nonGoals: [],
        constraints: [],
        lifecycle: "PLANNED",
        createdAt: timestamp,
      },
      planRevision: {
        schemaVersion: "1.0.0",
        planRevisionId: "plan_complete",
        changeId: "chg_complete",
        revision: 1,
        workspaceId: "workspace_complete",
        workspaceFingerprint: fingerprint("a"),
        sourceFingerprint: fingerprint("b"),
        goal: "Make event compatibility explicit",
        nonGoals: [],
        constraints: [],
        steps: [
          {
            stepId: "step_execute",
            kind: "agent",
            title: "Implement",
            dependsOn: [],
            required: true,
            inputContractFingerprint: fingerprint("1"),
            outputContractFingerprint: fingerprint("2"),
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
            definitionFingerprint: fingerprint("c"),
            configurationFingerprint: fingerprint("d"),
          },
        ],
        loopPolicy: {
          maxIterations: 2,
          maxElapsedMs: 60_000,
          repeatedFailureLimit: 2,
          resourceBudgets: { maxExternalOperations: 2 },
          stopOnUserInput: true,
          stopOnWorkspaceDrift: true,
        },
        createdAt: timestamp,
      },
      run: {
        schemaVersion: "1.0.0",
        runId: "run_complete",
        changeId: "chg_complete",
        planRevisionId: "plan_complete",
        workspaceId: "workspace_complete",
        workspaceFingerprint: fingerprint("a"),
        sourceFingerprint: fingerprint("b"),
        lifecycle: "PLANNED",
        archiveStatus: "UNARCHIVED",
        startedAt: timestamp,
      },
    };

    expect(workflowEventSchema.safeParse(event).success).toBe(true);
    expect(workflowEventSchema.safeParse({ ...event, schemaVersion: undefined }).success).toBe(
      false,
    );
    expect(
      checkProjectionSchema.safeParse({
        schemaVersion: "1.0.0",
        checkId: "check_unit",
        required: true,
        status: "NOT_RUN",
      }).success,
    ).toBe(true);
  });

  it("versions strict Workflow commands, decisions, and recovery results", () => {
    const command = {
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: "run_complete",
      attemptId: "att_complete",
      startedAt: timestamp,
    };
    expect(workflowCommandSchema.safeParse(command).success).toBe(true);
    expect(workflowCommandSchema.safeParse({ ...command, schemaVersion: undefined }).success).toBe(
      false,
    );

    expect(
      recoveryDecisionSchema.safeParse({
        schemaVersion: "1.0.0",
        status: "NOT_FOUND",
      }).success,
    ).toBe(true);
  });
});
