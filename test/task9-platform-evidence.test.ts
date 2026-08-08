import { describe, expect, it } from "vitest";

import { compareTask9PlatformEvidence } from "../tools/compare-task9-platform-evidence.js";
import {
  TASK9_TEMPORARY_CLEANUP_POLICY,
  task9ContractFailureDiagnostic,
  task9FinalityDiagnostic,
} from "../tools/task9-platform-probe.js";
import {
  TASK9_CONTRACT_DEFINITION_FINGERPRINT,
  TASK9_CONTRACT_TEST_COUNT,
  TASK9_CONTRACT_TEST_FILES,
  TASK9_PLATFORM_CHECKS,
  TASK9_SOURCE_PATHSPEC,
  TASK9_VERIFIER_PATHSPEC,
  task9CheckFingerprint,
  task9PlatformFactsSchema,
  task9PlatformReceiptSchema,
} from "../tools/task9-platform-evidence.js";

const fingerprint = `sha256:${"a".repeat(64)}` as const;

function receipt(os: "WINDOWS" | "UBUNTU") {
  const facts = task9PlatformFactsSchema.parse({
    contractMatrix: {
      status: "PASS",
      definitionFingerprint: TASK9_CONTRACT_DEFINITION_FINGERPRINT,
      testFileCount: 8,
      testCount: TASK9_CONTRACT_TEST_COUNT,
      passedTestCount: os === "WINDOWS" ? TASK9_CONTRACT_TEST_COUNT : TASK9_CONTRACT_TEST_COUNT - 1,
      skippedTestCount: os === "WINDOWS" ? 0 : 1,
      windowsPathAlias: os === "WINDOWS" ? "PASS" : "NOT_APPLICABLE",
      forcedTerminationRecovery: "PASS",
      secondDeviceProjection: "PASS",
    },
    process: {
      terminalFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "NOT_REQUIRED",
      receiptFingerprint: fingerprint,
    },
    writerLease: {
      state: "RELEASED",
      workspaceMatches: true,
      receiptFingerprint: fingerprint,
    },
    attemptFinality: {
      terminalFinality: "FINAL",
      processCount: 1,
      releasedWriterLeaseCount: 1,
      evidenceCount: 1,
      receiptFingerprint: fingerprint,
    },
    durableReplay: {
      processReceiptMatches: true,
      evidenceReceiptMatches: true,
      attemptFinalityMatches: true,
    },
    privacy: {
      scan: "PASS",
      pathFree: true,
      credentialFree: true,
    },
  });
  return task9PlatformReceiptSchema.parse({
    schemaVersion: "hpi-task9-platform-receipt.v2",
    kind: "hunter-pi/task9-platform-receipt",
    status: "PASS",
    platform: { os, architecture: "x64", nodeMajor: 24 },
    source: {
      commit: "a".repeat(40),
      state: "CLEAN",
      pathspec: TASK9_SOURCE_PATHSPEC,
      fingerprint,
    },
    verifier: {
      version: "task9-platform-verifier.v2",
      pathspec: TASK9_VERIFIER_PATHSPEC,
      fingerprint,
      commandFingerprint: fingerprint,
    },
    facts,
    checks: TASK9_PLATFORM_CHECKS.map(({ id }) => ({
      id,
      status: "PASS",
      fingerprint: task9CheckFingerprint(id, facts),
    })),
    observedAt: "2026-08-08T00:00:00.000Z",
  });
}

describe("Task 9 platform Evidence", () => {
  it("reduces failed contract reports to bounded path-free CI diagnostics", () => {
    const diagnostic = task9ContractFailureDiagnostic({
      numTotalTests: 90,
      numPassedTests: 89,
      numFailedTests: 1,
      testResults: [
        {
          name: "C:/Users/private/repository/test/atomic-write.test.ts",
          assertionResults: [
            { fullName: "private fixture password=do-not-log", status: "failed", duration: 5_001 },
          ],
        },
      ],
    });

    expect(diagnostic).toEqual({
      schemaVersion: "hpi-task9-contract-diagnostic.v1",
      totals: { failed: 1, passed: 89, tests: 90 },
      failures: [
        {
          assertionIndex: 0,
          durationMs: 5_001,
          status: "failed",
          testFile: "test/atomic-write.test.ts",
        },
      ],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Users|password|do-not-log|repository/iu);
  });

  it("uses bounded Windows cleanup retries and stage-only finality diagnostics", () => {
    expect(TASK9_TEMPORARY_CLEANUP_POLICY).toEqual({ maxRetries: 10, retryDelayMs: 250 });
    const diagnostic = task9FinalityDiagnostic("CLEANUP");
    expect(diagnostic).toEqual({
      schemaVersion: "hpi-task9-finality-diagnostic.v1",
      checkpoint: "CLEANUP",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Users|home|password|token/iu);
  });

  it("accepts the exact contract, finality, lease, replay, and privacy matrix", () => {
    expect(receipt("WINDOWS").status).toBe("PASS");
    expect(TASK9_CONTRACT_TEST_FILES).toHaveLength(8);
    expect(TASK9_SOURCE_PATHSPEC).toEqual(
      expect.arrayContaining([
        "vitest.config.ts",
        "packages/evidence/package.json",
        "packages/execution/package.json",
      ]),
    );
    expect(TASK9_VERIFIER_PATHSPEC).toEqual(
      expect.arrayContaining([
        "vitest.config.ts",
        "packages/evidence/package.json",
        "packages/execution/package.json",
        "test/support",
        "test/support/atomic-write-interruption-child.ts",
        "test/vitest.global-setup.ts",
      ]),
    );
  });

  it("rejects a partial or reordered check matrix", () => {
    const valid = receipt("WINDOWS");
    expect(() =>
      task9PlatformReceiptSchema.parse({ ...valid, checks: valid.checks.slice(1) }),
    ).toThrow(/checks/u);
    expect(() =>
      task9PlatformReceiptSchema.parse({ ...valid, checks: [...valid.checks].reverse() }),
    ).toThrow(/checks/u);
  });

  it("rejects a PASS that contains non-final process, lease, or replay facts", () => {
    const valid = receipt("WINDOWS");
    expect(() =>
      task9PlatformReceiptSchema.parse({
        ...valid,
        facts: {
          ...valid.facts,
          durableReplay: { ...valid.facts.durableReplay, evidenceReceiptMatches: false },
        },
      }),
    ).toThrow(/expected true|PASS/u);
  });

  it("rejects a partial, skipped, or platform-mismatched daily-use contract matrix", () => {
    const windows = receipt("WINDOWS");
    expect(() =>
      task9PlatformReceiptSchema.parse({
        ...windows,
        facts: {
          ...windows.facts,
          contractMatrix: { ...windows.facts.contractMatrix, passedTestCount: 86 },
        },
      }),
    ).toThrow(/contract|test|Windows/iu);

    const ubuntu = receipt("UBUNTU");
    expect(() =>
      task9PlatformReceiptSchema.parse({
        ...ubuntu,
        facts: {
          ...ubuntu.facts,
          contractMatrix: { ...ubuntu.facts.contractMatrix, windowsPathAlias: "PASS" },
        },
      }),
    ).toThrow(/contract|alias|Ubuntu/iu);
  });

  it("rejects private-path or credential-shaped serialized Evidence", () => {
    const valid = receipt("WINDOWS");
    expect(() =>
      task9PlatformReceiptSchema.parse({
        ...valid,
        verifier: { ...valid.verifier, version: "C:\\Users\\private\\token" },
      }),
    ).toThrow();
  });

  it("compares distinct Windows and Ubuntu receipts only at the exact source/verifier identity", () => {
    const result = compareTask9PlatformEvidence(receipt("WINDOWS"), receipt("UBUNTU"));

    expect(result).toMatchObject({
      schemaVersion: "hpi-task9-platform-consistency.v2",
      kind: "hunter-pi/task9-platform-consistency",
      status: "PASS",
      sourceCommit: "a".repeat(40),
      sourceFingerprint: fingerprint,
      verifierFingerprint: fingerprint,
    });
    expect(result.checks).toEqual(TASK9_PLATFORM_CHECKS.map(({ id }) => ({ id, status: "PASS" })));
  });

  it("rejects duplicate platforms or different source identities", () => {
    expect(() => compareTask9PlatformEvidence(receipt("WINDOWS"), receipt("WINDOWS"))).toThrow(
      /Windows.*Ubuntu/u,
    );
    const ubuntu = receipt("UBUNTU");
    expect(() =>
      compareTask9PlatformEvidence(receipt("WINDOWS"), {
        ...ubuntu,
        source: { ...ubuntu.source, commit: "b".repeat(40) },
      }),
    ).toThrow(/source commit/u);
  });

  it("rejects cross-platform semantic count or lease-finality drift", () => {
    const ubuntu = receipt("UBUNTU");
    const facts = task9PlatformFactsSchema.parse({
      ...ubuntu.facts,
      attemptFinality: { ...ubuntu.facts.attemptFinality, processCount: 2 },
    });
    const drifted = task9PlatformReceiptSchema.parse({
      ...ubuntu,
      facts,
      checks: TASK9_PLATFORM_CHECKS.map(({ id }) => ({
        id,
        status: "PASS",
        fingerprint: task9CheckFingerprint(id, facts),
      })),
    });

    expect(() => compareTask9PlatformEvidence(receipt("WINDOWS"), drifted)).toThrow(
      /semantic facts/u,
    );
  });
});
