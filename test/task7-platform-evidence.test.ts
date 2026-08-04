import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareTask7PlatformEvidence } from "../tools/compare-task7-platform-evidence.js";
import {
  TASK7_PLATFORM_CHECKS,
  assertTask7EvidencePrivacy,
  parseTask7VitestReport,
  prepareTask7Output,
  readTask7EvidenceInput,
  resolveTask7OutputPath,
  task7PlatformReceiptSchema,
} from "../tools/task7-platform-evidence.js";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function passingReport(): Record<string, unknown> {
  return {
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: TASK7_PLATFORM_CHECKS.length,
    numPassedTests: TASK7_PLATFORM_CHECKS.length,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        assertionResults: TASK7_PLATFORM_CHECKS.map((check) => ({
          ancestorTitles: ["local managed process platform"],
          title: check.title,
          status: "passed",
        })),
      },
    ],
  };
}

function receipt(platform: "win32" | "linux") {
  const expectedContainment = platform === "win32" ? "WINDOWS_JOB_OBJECT" : "POSIX_PROCESS_GROUP";
  return task7PlatformReceiptSchema.parse({
    schemaVersion: "hpi-task7-platform-receipt.v1",
    kind: "hunter-pi/task7-platform-receipt",
    observedAt: "2026-08-04T10:00:00.000Z",
    status: "PASS",
    source: {
      repository: "hunter-pi",
      commit: "a".repeat(40),
      digest: digest("1"),
      pathspec: [
        "package-lock.json",
        "package.json",
        "packages/domain/src",
        "packages/execution/src",
        "packages/workspace/src",
        "test/file-lease-manager.test.ts",
        "test/git-workspace-manager.test.ts",
        "test/managed-process-host.test.ts",
        "test/managed-process-platform.test.ts",
      ],
    },
    environment: {
      platform,
      platformLabel: platform === "win32" ? "WINDOWS" : "UBUNTU",
      architecture: "x64",
      nodeVersion: "v24.15.0",
      gitVersion: platform === "win32" ? "2.50.1.windows.1" : "2.34.1",
    },
    execution: {
      commandFingerprint: digest("2"),
      testFileFingerprint: digest("3"),
      startedAt: "2026-08-04T09:59:56.000Z",
      endedAt: "2026-08-04T10:00:00.000Z",
      durationMs: 4000,
      exitCode: 0,
      reportStatus: "COMPLETE",
      stdoutDigest: digest("4"),
      stderrDigest: digest("5"),
      observedBytes: 2048,
    },
    containment: { expected: expectedContainment, status: "PASS" },
    checks: TASK7_PLATFORM_CHECKS.map((check) => ({ id: check.id, status: "PASS" })),
    boundaries: {
      fixturePolicy: "AUTOMATIC_TEMPORARY_ONLY",
      providerRequests: "NOT_RUN",
      realRepositories: "NOT_RUN",
      privateData: "EXCLUDED",
      remoteCi: "PENDING",
    },
  });
}

describe("Task 7 platform Evidence", () => {
  it("accepts exactly the six passing platform assertions and rejects missing or skipped cases", () => {
    expect(parseTask7VitestReport(passingReport())).toEqual(
      TASK7_PLATFORM_CHECKS.map((check) => ({ id: check.id, status: "PASS" })),
    );

    const missing = passingReport();
    const result = missing["testResults"] as { assertionResults: unknown[] }[];
    result[0]?.assertionResults.pop();
    expect(() => parseTask7VitestReport(missing)).toThrow(/exact Task 7 platform matrix/u);

    const skipped = passingReport();
    const skippedResults = skipped["testResults"] as {
      assertionResults: { status: string }[];
    }[];
    if (skippedResults[0]?.assertionResults[0] !== undefined) {
      skippedResults[0].assertionResults[0].status = "pending";
    }
    expect(() => parseTask7VitestReport(skipped)).toThrow(/did not pass/u);
  });

  it("compares exact Windows and Ubuntu identities without converting pending CI into PASS", () => {
    const windows = receipt("win32");
    const ubuntu = receipt("linux");
    const compared = compareTask7PlatformEvidence(windows, ubuntu, "2026-08-04T10:01:00.000Z");

    expect(compared).toMatchObject({
      schemaVersion: "hpi-task7-platform-consistency.v1",
      status: "PASS",
      platforms: ["win32", "linux"],
      sourceDigest: digest("1"),
      checks: TASK7_PLATFORM_CHECKS.map((check) => ({ id: check.id, status: "PASS" })),
      remoteCi: "PENDING",
    });
    expect(() =>
      compareTask7PlatformEvidence(windows, {
        ...ubuntu,
        source: { ...ubuntu.source, digest: digest("9") },
      }),
    ).toThrow(/same source digest/u);
  });

  it("rejects device-local paths and credential-shaped content even inside schema-valid text", () => {
    const safe = receipt("win32");
    expect(() => {
      assertTask7EvidencePrivacy(safe);
    }).not.toThrow();
    expect(() => {
      assertTask7EvidencePrivacy({ ...safe, observedAt: "C:\\Users\\private\\receipt" });
    }).toThrow(/privacy scan/u);
    expect(() => {
      assertTask7EvidencePrivacy({ ...safe, observedAt: "Bearer secret-value" });
    }).toThrow(/privacy scan/u);
  });

  it("writes only a new flat JSON file under an approved physical Evidence root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpi-t7-evidence-output-"));
    cleanupRoots.push(root);
    await writeFile(join(root, "package.json"), '{"name":"hunter-pi"}\n', "utf8");
    const approved = resolveTask7OutputPath(
      root,
      "docs/validation/evidence/task7/windows-local.json",
    );
    await expect(prepareTask7Output(root, approved)).resolves.toBeUndefined();
    expect(() => resolveTask7OutputPath(root, "outside.json")).toThrow(/approved Evidence root/u);

    await mkdir(join(root, "docs", "validation", "evidence", "task7"), { recursive: true });
    await writeFile(approved, '{"status":"preserve"}\n', "utf8");
    await expect(
      readTask7EvidenceInput(root, "docs/validation/evidence/task7/windows-local.json"),
    ).resolves.toEqual({ status: "preserve" });
    await expect(readTask7EvidenceInput(root, "outside.json")).rejects.toThrow(
      /approved Evidence root/u,
    );
    await expect(prepareTask7Output(root, approved)).rejects.toThrow(/must not already exist/u);
  });

  it("rejects linked output files and redirected Evidence roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpi-t7-evidence-links-"));
    cleanupRoots.push(root);
    const evidenceParent = join(root, "docs", "validation", "evidence");
    const outside = join(root, "outside");
    await Promise.all([mkdir(evidenceParent, { recursive: true }), mkdir(outside)]);
    await symlink(
      outside,
      join(evidenceParent, "task7"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const redirected = resolveTask7OutputPath(
      root,
      "docs/validation/evidence/task7/redirected.json",
    );
    await expect(prepareTask7Output(root, redirected)).rejects.toThrow(/links or reparse/u);

    await rm(join(evidenceParent, "task7"), { force: true, recursive: true });
    await mkdir(join(evidenceParent, "task7"));
    const source = join(outside, "source.json");
    const linked = join(evidenceParent, "task7", "linked.json");
    await writeFile(source, "{}\n", "utf8");
    await link(source, linked);
    await expect(prepareTask7Output(root, linked)).rejects.toThrow(/single-link/u);
  });
});
