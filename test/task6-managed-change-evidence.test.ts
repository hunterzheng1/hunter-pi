import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { task6ManagedChangeEvidenceSchema } from "@hunter-pi/managed-change";

const artifactUrl = new URL(
  "../docs/validation/evidence/task6/managed-change.json",
  import.meta.url,
);

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("committed Task 6 Managed Change Evidence", () => {
  it("preserves the exact real-run facts while downgrading the unproven output budget", async () => {
    const raw = await readFile(artifactUrl, "utf8");
    const artifact = task6ManagedChangeEvidenceSchema.parse(JSON.parse(raw));

    expect(sha256(raw)).toBe(
      "sha256:dc5db8f72124f0b30f430d60cc8c464637f15f50bd39646544169da1047ef195",
    );
    expect(artifact).toMatchObject({
      taskResult: "STOP",
      productSource: {
        commit: "164fc28ac423ac3cdccf91b9a7f0c36ca51612df",
        state: "CLEAN",
      },
      provider: {
        id: "openai-codex",
        authStatus: "DETECTED",
        requestStatus: "DETECTED",
      },
      lifecycleAfterAgentReturn: "VERIFYING",
      cleanup: { status: "PASS" },
      remoteCi: "PENDING",
    });
    expect(artifact.resourceAccounting).toMatchObject({
      status: "NOT_PROVEN",
      capturedOutputBytes: { verificationAttempt1: 17, verificationAttempt2: 13 },
      consumed: { agentTurns: 1, externalOperations: 3, commands: 2 },
      unprovenReasons: ["ENGINE_OUTPUT_BYTES_MISSING", "OUTPUT_CAPTURE_LIMITS_EXCEED_RUN_BUDGET"],
    });
    expect(artifact.resourceAccounting.capturedOutputBytes.engine).toBeUndefined();
    expect(artifact.resourceAccounting.consumed.outputBytes).toBeUndefined();
    expect(artifact.projection.change.lifecycle).toBe("READY");
    expect(artifact.projection.attempts).toMatchObject([
      { executionStatus: "INCOMPLETE", verificationStatus: "FAILED" },
      { executionStatus: "RETURNED", verificationStatus: "PASSED" },
    ]);
    expect(artifact.projection.verificationReceipts.map((receipt) => receipt.outcome)).toEqual([
      "FAIL",
      "PASS",
    ]);
    expect(artifact.projection.reviewReceipts[0]?.findings).toEqual([]);
    expect(artifact.scorecard).toMatchObject({
      zeroFalseReady: false,
      sourceLoss: false,
      secretLeak: false,
      failedAttemptPreserved: true,
      fixbackPass: true,
      unplannedInterventions: 0,
      overheadWithinLimit: true,
      summaryComplete: true,
      resourceBudgetReconciled: false,
    });

    for (const evidence of artifact.evidence) {
      expect(evidence.capture.capturedBytes).toBeLessThanOrEqual(16_384);
      if (
        evidence.capture.retentionStatus === "RETAINED" &&
        evidence.capture.capturedText !== undefined
      ) {
        expect(evidence.contentHash).toBe(sha256(evidence.capture.capturedText));
      }
    }
    expect(raw).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(raw).not.toMatch(/\/(?:home|Users|tmp)\//u);
    expect(raw).not.toContain("In this disposable Git fixture");
    expect(raw).not.toMatch(/\b(?:authorization|cookie|api[_-]?key|access[_-]?token)\s*[:=]/iu);
  });

  it("retains STOP Evidence after READY when cleanup fails, but rejects an unjustified STOP", async () => {
    const raw = await readFile(artifactUrl, "utf8");
    const artifact = task6ManagedChangeEvidenceSchema.parse(JSON.parse(raw));

    expect(
      task6ManagedChangeEvidenceSchema.safeParse({
        ...artifact,
        taskResult: "STOP",
        cleanup: { status: "BLOCKED" },
      }).success,
    ).toBe(true);
    expect(
      task6ManagedChangeEvidenceSchema.safeParse({
        ...artifact,
        taskResult: "STOP",
        resourceAccounting: {
          status: "PASS",
          budgets: artifact.resourceAccounting.budgets,
          captureLimits: {
            engine: 229_376,
            verificationAttempt1: 16_384,
            verificationAttempt2: 16_384,
          },
          capturedOutputBytes: {
            engine: 128,
            verificationAttempt1: 17,
            verificationAttempt2: 13,
          },
          consumed: {
            agentTurns: 1,
            externalOperations: 3,
            commands: 2,
            outputBytes: 158,
          },
          unprovenReasons: [],
        },
        scorecard: {
          ...artifact.scorecard,
          zeroFalseReady: true,
          resourceBudgetReconciled: true,
        },
      }).success,
    ).toBe(false);
  });
});
