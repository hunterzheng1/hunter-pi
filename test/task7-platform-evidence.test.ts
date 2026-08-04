import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertTask7WorktreeClean, runTask7ProbeCommand } from "../tools/task7-platform-probe.js";
import {
  compareTask7PlatformEvidence,
  task7PlatformConsistencyV1Schema,
} from "../tools/compare-task7-platform-evidence.js";
import {
  TASK7_PLATFORM_CHECKS,
  TASK7_SOURCE_PATHSPEC,
  TASK7_VERIFIER_PATHSPEC,
  assertTask7EvidencePrivacy,
  parseTask7VitestReport,
  prepareTask7Output,
  readTask7EvidenceInput,
  resolveTask7OutputPath,
  task7PlatformFailureReceiptV1Schema,
  task7PlatformReceiptSchema,
  task7PlatformReceiptV1Schema,
} from "../tools/task7-platform-evidence.js";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function passingReport(platform: "win32" | "linux"): Record<string, unknown> {
  const assertions = TASK7_PLATFORM_CHECKS.map((check) => ({
    ancestorTitles: ["local managed process platform"],
    title: check.title,
    status: check.platforms.includes(platform) ? "passed" : "pending",
  }));
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const pending = assertions.length - passed;
  return {
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: TASK7_PLATFORM_CHECKS.length,
    numPassedTests: passed,
    numFailedTests: 0,
    numPendingTests: pending,
    testResults: [
      {
        assertionResults: assertions,
      },
    ],
  };
}

function receipt(platform: "win32" | "linux") {
  const expectedContainment =
    platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE";
  return task7PlatformReceiptSchema.parse({
    schemaVersion: "hpi-task7-platform-receipt.v2",
    kind: "hunter-pi/task7-platform-receipt",
    observedAt: "2026-08-04T10:00:00.000Z",
    status: "PASS",
    source: {
      repository: "hunter-pi",
      commit: "a".repeat(40),
      digest: digest("1"),
      pathspec: TASK7_SOURCE_PATHSPEC,
      verifierPathspec: TASK7_VERIFIER_PATHSPEC,
      verifierFingerprint: digest("6"),
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
    checks: TASK7_PLATFORM_CHECKS.map((check) => ({
      id: check.id,
      status: check.platforms.includes(platform) ? "PASS" : "NOT_RUN",
    })),
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
  it("accepts exactly the platform-applicable matrix and rejects missing or wrongly skipped cases", () => {
    expect(parseTask7VitestReport(passingReport("linux"), "linux")).toEqual(
      TASK7_PLATFORM_CHECKS.map((check) => ({
        id: check.id,
        status: check.platforms.includes("linux") ? "PASS" : "NOT_RUN",
      })),
    );

    const missing = passingReport("win32");
    const result = missing["testResults"] as { assertionResults: unknown[] }[];
    result[0]?.assertionResults.pop();
    expect(() => parseTask7VitestReport(missing, "win32")).toThrow(/exact Task 7 platform matrix/u);

    const skipped = passingReport("win32");
    const skippedResults = skipped["testResults"] as {
      assertionResults: { status: string }[];
    }[];
    if (skippedResults[0]?.assertionResults[0] !== undefined) {
      skippedResults[0].assertionResults[0].status = "pending";
    }
    expect(() => parseTask7VitestReport(skipped, "win32")).toThrow(/did not pass/u);
  });

  it("compares exact Windows and Ubuntu identities without converting pending CI into PASS", () => {
    const windows = receipt("win32");
    const ubuntu = receipt("linux");
    const compared = compareTask7PlatformEvidence(windows, ubuntu, "2026-08-04T10:01:00.000Z");

    expect(compared).toMatchObject({
      schemaVersion: "hpi-task7-platform-consistency.v2",
      status: "PASS",
      platforms: ["win32", "linux"],
      sourceCommit: "a".repeat(40),
      sourceDigest: digest("1"),
      verifierFingerprint: digest("6"),
      remoteCi: "PENDING",
    });
    expect(() =>
      compareTask7PlatformEvidence(windows, {
        ...ubuntu,
        source: { ...ubuntu.source, digest: digest("9") },
      }),
    ).toThrow(/same source digest/u);
    expect(() =>
      compareTask7PlatformEvidence(windows, {
        ...ubuntu,
        source: { ...ubuntu.source, commit: "b".repeat(40) },
      }),
    ).toThrow(/same source commit/u);
    expect(() =>
      compareTask7PlatformEvidence(windows, {
        ...ubuntu,
        source: { ...ubuntu.source, verifierFingerprint: digest("9") },
      }),
    ).toThrow(/same verifier fingerprint/u);
  });

  it("rejects an unrelated untracked file before hashing the Task 7 input set", async () => {
    const root = await mkdtemp(join(tmpdir(), "hpi-t7-clean-fixture-"));
    cleanupRoots.push(root);
    await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
    for (const args of [
      ["init"],
      ["add", "tracked.txt"],
      [
        "-c",
        "user.name=Hunter Pi Test",
        "-c",
        "user.email=hunter-pi@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const result = await runTask7ProbeCommand("git", args, root);
      expect(result.exitCode).toBe(0);
    }
    await expect(assertTask7WorktreeClean(root)).resolves.toBeUndefined();
    await writeFile(join(root, "unrelated.txt"), "must block\n", "utf8");
    await expect(assertTask7WorktreeClean(root)).rejects.toThrow(/entire worktree is not clean/u);
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
    expect(() => {
      assertTask7EvidencePrivacy({ ...safe, observedAt: `ghp_${"x".repeat(36)}` });
    }).toThrow(/privacy scan/u);
  });

  it("hashes full probe output while retaining only a bounded diagnostic prefix", async () => {
    const stdoutBytes = 1_200_000;
    const stderrBytes = 1_300_000;
    const result = await runTask7ProbeCommand(
      process.execPath,
      [
        "-e",
        `process.stdout.write("x".repeat(${String(stdoutBytes)}));process.stderr.write("y".repeat(${String(stderrBytes)}));`,
      ],
      process.cwd(),
    );

    expect(result).toMatchObject({
      exitCode: 0,
      observedBytes: stdoutBytes + stderrBytes,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result.stdout).toHaveLength(1_048_576);
    expect(result.stderr).toHaveLength(1_048_576);
    expect(result.stdoutDigest).toBe(
      `sha256:${createHash("sha256").update("x".repeat(stdoutBytes)).digest("hex")}`,
    );
    expect(result.stderrDigest).toBe(
      `sha256:${createHash("sha256").update("y".repeat(stderrBytes)).digest("hex")}`,
    );

    const exactBoundary = await runTask7ProbeCommand(
      process.execPath,
      ["-e", "process.stdout.write('z'.repeat(1048576))"],
      process.cwd(),
    );
    expect(exactBoundary.stdout).toHaveLength(1_048_576);
    expect(exactBoundary.stdoutTruncated).toBe(false);
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

  it("keeps the failed probe history and validates the exact local cross-platform receipts", async () => {
    const evidenceRoot = join(process.cwd(), "docs", "validation", "evidence", "task7");
    const readJson = async (name: string): Promise<unknown> =>
      JSON.parse(await readFile(join(evidenceRoot, name), "utf8")) as unknown;
    const [
      failed,
      preliminary,
      windows,
      hardenedWindows,
      ubuntu,
      consistency,
      hardenedConsistency,
    ] = await Promise.all([
      readJson("windows-local.json"),
      readJson("windows-local-attempt-2.json"),
      readJson("windows-local-attempt-3.json"),
      readJson("windows-local-attempt-4.json"),
      readJson("ubuntu-wsl-attempt-1.json"),
      readJson("local-consistency.json"),
      readJson("local-consistency-attempt-2.json"),
    ]);

    expect(task7PlatformFailureReceiptV1Schema.parse(failed)).toMatchObject({
      status: "NOT_PROVEN",
      stage: "REPORT_PARSE",
      exitCode: 0,
    });
    expect(task7PlatformReceiptV1Schema.parse(preliminary)).toMatchObject({
      status: "PASS",
      source: { commit: "bdf1b01a3ffb9c9b7a2bd6a6a485588071456841" },
    });
    const parsedWindows = task7PlatformReceiptV1Schema.parse(windows);
    const parsedUbuntu = task7PlatformReceiptV1Schema.parse(ubuntu);
    expect(parsedWindows.source.commit).toBe("760518c28cbd7a4b49cdd5e7e9b8b2db3cf71d10");
    expect(parsedUbuntu.source.commit).toBe(parsedWindows.source.commit);
    const parsedConsistency = task7PlatformConsistencyV1Schema.parse(consistency);
    expect(parsedConsistency.sourceDigest).toBe(parsedWindows.source.digest);
    const parsedHardenedWindows = task7PlatformReceiptV1Schema.parse(hardenedWindows);
    const parsedHardenedConsistency = task7PlatformConsistencyV1Schema.parse(hardenedConsistency);
    expect(parsedHardenedConsistency.sourceDigest).toBe(parsedHardenedWindows.source.digest);
    expect(() => compareTask7PlatformEvidence(parsedWindows, parsedUbuntu)).toThrow();
    for (const value of [
      failed,
      preliminary,
      windows,
      hardenedWindows,
      ubuntu,
      consistency,
      hardenedConsistency,
    ]) {
      expect(() => {
        assertTask7EvidencePrivacy(value);
      }).not.toThrow();
    }
  });
});
