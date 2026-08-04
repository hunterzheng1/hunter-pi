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
  it("preserves the exact GO result while remaining portable and credential-free", async () => {
    const raw = await readFile(artifactUrl, "utf8");
    const artifact = task6ManagedChangeEvidenceSchema.parse(JSON.parse(raw));

    expect(sha256(raw)).toBe(
      "sha256:6fc88c7e86bdcd5605c98adba12e9a2a007f7a45f138ed29a38b4b221a4ee718",
    );
    expect(artifact).toMatchObject({
      taskResult: "GO",
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
      zeroFalseReady: true,
      sourceLoss: false,
      secretLeak: false,
      failedAttemptPreserved: true,
      fixbackPass: true,
      unplannedInterventions: 0,
      overheadWithinLimit: true,
      summaryComplete: true,
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
});
