import { describe, expect, it } from "vitest";

import {
  humanReceiptSchema,
  planRevisionSchema,
  reviewReceiptSchema,
  verificationReceiptSchema,
  type PlanRevision,
} from "@hunter-pi/domain";
import {
  validateVerificationAdequacy,
  type VerificationAdequacyRequest,
} from "@hunter-pi/verification";

const timestamp = "2026-08-05T00:00:00.000Z";
const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;
const sourceFingerprint = fingerprint("a");
const workspaceFingerprint = fingerprint("b");
const environmentFingerprint = fingerprint("c");
const checkDefinitionFingerprint = fingerprint("d");
const checkConfigurationFingerprint = fingerprint("e");
const humanContentHash = fingerprint("f");
const humanResultFingerprint = fingerprint("0");

function createPlan(): PlanRevision {
  return planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: "plan_task8",
    changeId: "chg_task8",
    revision: 1,
    workspaceId: "workspace_task8",
    workspaceFingerprint,
    sourceFingerprint,
    goal: "Prove verification adequacy before readiness",
    nonGoals: ["Run a real Provider"],
    constraints: ["Use only deterministic receipts"],
    steps: [
      {
        stepId: "step_task8-agent",
        kind: "agent",
        title: "Prepare the bounded change",
        dependsOn: [],
        required: true,
        inputContractFingerprint: sourceFingerprint,
        outputContractFingerprint: workspaceFingerprint,
      },
      {
        stepId: "step_task8-human",
        kind: "human_gate",
        title: "Confirm the exact result",
        dependsOn: ["step_task8-agent"],
        required: true,
        inputContractFingerprint: workspaceFingerprint,
        outputContractFingerprint: humanResultFingerprint,
        expectedContentHash: humanContentHash,
        allowedDecisions: ["APPROVED", "REJECTED"],
      },
      {
        stepId: "step_task8-review",
        kind: "review",
        title: "Review the bounded change",
        dependsOn: ["step_task8-human"],
        required: true,
        inputContractFingerprint: workspaceFingerprint,
        outputContractFingerprint: sourceFingerprint,
        inputFingerprint: workspaceFingerprint,
        reviewDefinitionFingerprint: sourceFingerprint,
        configurationFingerprint: environmentFingerprint,
      },
    ],
    checks: [
      {
        checkId: "check_task8-a",
        version: 1,
        label: "Focused check A",
        kind: "command",
        required: true,
        definition: {
          executable: "node",
          argv: ["check-a.mjs"],
          workingDirectoryReference: "fixture-repository",
        },
        definitionFingerprint: checkDefinitionFingerprint,
        configurationFingerprint: checkConfigurationFingerprint,
      },
      {
        checkId: "check_task8-b",
        version: 1,
        label: "Focused check B",
        kind: "command",
        required: true,
        definition: {
          executable: "node",
          argv: ["check-b.mjs"],
          workingDirectoryReference: "fixture-repository",
        },
        definitionFingerprint: checkDefinitionFingerprint,
        configurationFingerprint: checkConfigurationFingerprint,
      },
    ],
    loopPolicy: {
      maxIterations: 2,
      maxElapsedMs: 60_000,
      repeatedFailureLimit: 2,
      resourceBudgets: { maxCommands: 4 },
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt: timestamp,
  });
}

function createVerificationReceipt(
  checkId: "check_task8-a" | "check_task8-b",
  overrides: Record<string, unknown> = {},
) {
  return verificationReceiptSchema.parse({
    schemaVersion: "1.0.0",
    verificationReceiptId: `verify_task8-${checkId.slice(-1)}`,
    runId: "run_task8",
    attemptId: "att_task8-1",
    checkId,
    checkVersion: 1,
    checkDefinitionFingerprint,
    resultFingerprint: fingerprint(checkId.endsWith("a") ? "1" : "2"),
    outcome: "PASS",
    startedAt: timestamp,
    endedAt: "2026-08-05T00:00:01.000Z",
    observedAt: "2026-08-05T00:00:02.000Z",
    inputFingerprint: sourceFingerprint,
    configFingerprint: checkConfigurationFingerprint,
    workspaceFingerprint,
    sourceFingerprint,
    environmentFingerprint,
    resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
    output: {
      stdoutDigest: fingerprint("3"),
      stderrDigest: fingerprint("4"),
      artifactDigests: [],
      capturedBytes: 16,
      stdoutTruncated: false,
      stderrTruncated: false,
      redaction: { applied: true, fieldsRemoved: 1 },
    },
    evidenceIds: [`evidence_task8-${checkId.slice(-1)}`],
    ...overrides,
  });
}

function createHumanReceipt(overrides: Record<string, unknown> = {}) {
  return humanReceiptSchema.parse({
    schemaVersion: "1.0.0",
    humanReceiptId: "human_task8-1",
    runId: "run_task8",
    attemptId: "att_task8-1",
    stepId: "step_task8-human",
    contentHash: humanContentHash,
    resultFingerprint: humanResultFingerprint,
    decision: "APPROVED",
    actorReference: "owner",
    recordedAt: "2026-08-05T00:00:03.000Z",
    evidenceIds: [],
    ...overrides,
  });
}

function createReviewReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceiptSchema.parse({
    schemaVersion: "1.0.0",
    reviewReceiptId: "review_task8-1",
    runId: "run_task8",
    attemptId: "att_task8-1",
    stepId: "step_task8-review",
    inputFingerprint: workspaceFingerprint,
    reviewDefinitionFingerprint: sourceFingerprint,
    configurationFingerprint: environmentFingerprint,
    workspaceFingerprint,
    sourceFingerprint,
    resultFingerprint: fingerprint("5"),
    outcome: "PASS",
    observedAt: "2026-08-05T00:00:04.000Z",
    findings: [],
    evidenceIds: [],
    ...overrides,
  });
}

function createRequest(
  overrides: Partial<VerificationAdequacyRequest> = {},
): VerificationAdequacyRequest {
  return {
    schemaVersion: "1.0.0",
    planRevision: createPlan(),
    runId: "run_task8",
    attemptId: "att_task8-1",
    environmentFingerprint,
    selectedCheckIds: ["check_task8-a", "check_task8-b"],
    nodes: [
      { nodeId: "check_task8-a", kind: "CHECK", required: true, dependsOn: [] },
      { nodeId: "check_task8-b", kind: "CHECK", required: true, dependsOn: ["check_task8-a"] },
      {
        nodeId: "step_task8-human",
        kind: "HUMAN_GATE",
        required: true,
        dependsOn: ["check_task8-b"],
      },
      {
        nodeId: "step_task8-review",
        kind: "REVIEW",
        required: true,
        dependsOn: ["step_task8-human"],
      },
    ],
    resourceLocks: [
      { nodeId: "check_task8-a", lockNames: ["fixture-repository"] },
      { nodeId: "check_task8-b", lockNames: ["fixture-repository"] },
    ],
    verificationReceipts: [
      createVerificationReceipt("check_task8-a"),
      createVerificationReceipt("check_task8-b"),
    ],
    humanGateExpectations: [
      {
        stepId: "step_task8-human",
        contentHash: humanContentHash,
        resultFingerprint: humanResultFingerprint,
      },
    ],
    humanReceipts: [createHumanReceipt()],
    reviewReceipts: [createReviewReceipt()],
    skippedCheckIds: [],
    ...overrides,
  };
}

describe("verification adequacy validator", () => {
  it("returns READY only when the complete bound DAG and all receipts pass", () => {
    const result = validateVerificationAdequacy(createRequest());

    expect(result.status).toBe("READY");
    expect(result.decision).toBe("READY");
    expect(result.findings).toEqual([]);
    expect(result.accounting).toMatchObject({
      selected: 2,
      collected: 2,
      executed: 2,
      passed: 2,
      skipped: 0,
      notRun: 0,
      duplicates: 0,
      filtered: 0,
      staleReuse: 0,
      timedOut: 0,
      truncated: 0,
    });
  });

  it("rejects missing, filtered, skipped, and duplicate checks", () => {
    const request = createRequest({
      selectedCheckIds: ["check_task8-a", "check_task8-a"],
      skippedCheckIds: ["check_task8-b"],
      verificationReceipts: [
        createVerificationReceipt("check_task8-a"),
        createVerificationReceipt("check_task8-a", {
          verificationReceiptId: "verify_task8-a-duplicate",
        }),
      ],
    });

    const result = validateVerificationAdequacy(request);

    expect(result.status).not.toBe("READY");
    expect(result.accounting.duplicates).toBeGreaterThan(0);
    expect(result.accounting.skipped).toBe(1);
    expect(result.accounting.filtered).toBe(1);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "CHECK_DUPLICATE",
        "CHECK_FILTERED",
        "CHECK_SKIPPED",
        "CHECK_NOT_RUN",
      ]),
    );
  });

  it("invalidates stale receipt reuse across attempt, source, and environment identities", () => {
    const result = validateVerificationAdequacy(
      createRequest({
        verificationReceipts: [
          createVerificationReceipt("check_task8-a", {
            attemptId: "att_task8-old",
            sourceFingerprint: fingerprint("9"),
            environmentFingerprint: fingerprint("8"),
          }),
        ],
      }),
    );

    expect(result.status).not.toBe("READY");
    expect(result.accounting.staleReuse).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CHECK_STALE_REUSE", severity: "P0" }),
      ]),
    );
  });

  it("rejects timeout, truncation, missing redaction, and blocking review findings", () => {
    const result = validateVerificationAdequacy(
      createRequest({
        verificationReceipts: [
          createVerificationReceipt("check_task8-a", {
            outcome: "FAIL",
            resultStatus: { kind: "EXIT_CODE", exitCode: 124, timedOut: true },
            output: {
              stdoutDigest: fingerprint("3"),
              stderrDigest: fingerprint("4"),
              artifactDigests: [],
              capturedBytes: 16,
              stdoutTruncated: true,
              stderrTruncated: false,
              redaction: { applied: false, fieldsRemoved: 0 },
            },
          }),
          createVerificationReceipt("check_task8-b"),
        ],
        reviewReceipts: [
          createReviewReceipt({
            findings: [
              {
                severity: "P1",
                scope: "change",
                rationale: "The change is not safe to release",
                evidenceIds: ["evidence_task8-review"],
                confidence: 1,
              },
            ],
          }),
        ],
      }),
    );

    expect(result.status).not.toBe("READY");
    expect(result.accounting.timedOut).toBe(1);
    expect(result.accounting.truncated).toBe(1);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "CHECK_TIMEOUT",
        "CHECK_TRUNCATED",
        "OUTPUT_NOT_REDACTED",
        "REVIEW_BLOCKING_FINDING",
      ]),
    );
  });

  it("requires an exact Human Receipt and a linked fixback batch", () => {
    const result = validateVerificationAdequacy(
      createRequest({
        humanReceipts: [createHumanReceipt({ resultFingerprint: fingerprint("7") })],
        fixbackBatch: {
          previousAttemptId: "att_task8-1",
          newAttemptId: "att_task8-1",
          precedingFailureFingerprint: fingerprint("6"),
          failureEvidenceIds: ["evidence_task8-a"],
          focusedCheckIds: ["check_task8-a"],
          invalidatedCheckIds: ["check_task8-a"],
        },
      }),
    );

    expect(result.status).not.toBe("READY");
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["HUMAN_RECEIPT_MISMATCH", "FIXBACK_INVALID"]),
    );
  });

  it("detects a cyclic verification DAG and unordered resource-lock conflict", () => {
    const result = validateVerificationAdequacy(
      createRequest({
        nodes: [
          { nodeId: "check_task8-a", kind: "CHECK", required: true, dependsOn: ["check_task8-b"] },
          { nodeId: "check_task8-b", kind: "CHECK", required: true, dependsOn: ["check_task8-a"] },
          {
            nodeId: "step_task8-human",
            kind: "HUMAN_GATE",
            required: true,
            dependsOn: [],
          },
          {
            nodeId: "step_task8-review",
            kind: "REVIEW",
            required: true,
            dependsOn: ["step_task8-human"],
          },
        ],
        resourceLocks: [
          { nodeId: "check_task8-a", lockNames: ["shared" ] },
          { nodeId: "check_task8-b", lockNames: ["shared" ] },
        ],
      }),
    );

    expect(result.status).not.toBe("READY");
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["DAG_CYCLE", "RESOURCE_LOCK_CONFLICT"]),
    );
  });
});
