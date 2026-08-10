import { spawnSync } from "node:child_process";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileLeaseManager } from "@hunter-pi/execution";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  type RealManagedChangeRequest,
} from "@hunter-pi/managed-change";
import {
  createPilotRepositoryTargetReceipt,
  pilotQuickWorkflowFactChecklistFingerprint,
  runPilotRawComparator,
  runPilotQuickTask,
  type PilotTaskResult,
  type PilotTaskOracle,
} from "@hunter-pi/pilot";
import type { Task6PiProcessResult } from "@hunter-pi/pi-host";
import type { ProcessRunner } from "@hunter-pi/verification";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";
import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(repository: string, argv: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...argv], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Git fixture command failed: ${argv.join(" ")}`);
  }
  return result.stdout.trim();
}

async function createFixture(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly leaseRoot: string;
  readonly request: RealManagedChangeRequest;
  readonly oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }>;
}> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hpi-quick-task-");
  cleanupRoots.push(root);
  const repository = join(root, "repository");
  const leaseRoot = join(root, "leases");
  await Promise.all([mkdir(repository), mkdir(leaseRoot)]);
  git(repository, ["init", "--initial-branch=main"]);
  await writeFile(join(repository, "README.md"), "fixture\n", "utf8");
  await writeFile(join(repository, ".gitignore"), "ignored-side-effect.txt\n", "utf8");
  git(repository, ["add", "README.md", ".gitignore"]);
  git(repository, [
    "-c",
    "user.name=Hunter Pi",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const target = createPilotRepositoryTargetReceipt({
    targetId: "quick-target",
    canonicalRepositoryIdentity: repository,
    branch: "main",
    baseCommit: git(repository, ["rev-parse", "HEAD"]),
    baseTree: git(repository, ["rev-parse", "HEAD^{tree}"]),
    dirty: false,
  });
  if (
    target.status !== "READY" ||
    target.repositoryFingerprint === null ||
    target.sourceFingerprint === null ||
    target.targetReferenceFingerprint === null
  ) {
    throw new Error("Quick target fixture was not ready");
  }
  const request: RealManagedChangeRequest = {
    schemaVersion: "hpi-managed-change-request.v2",
    title: "Add a bounded result",
    goal: "Create result.txt with the accepted fixture value.",
    nonGoals: ["Do not commit the result."],
    constraints: ["Modify only result.txt."],
    allowedPaths: ["result.txt"],
    check: { label: "result check", executable: "node", argv: ["check.mjs"] },
    target: {
      targetId: target.targetId,
      selectionMode: target.selectionMode,
      repositoryFingerprint: target.repositoryFingerprint,
      sourceFingerprint: target.sourceFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
    },
  };
  const oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }> = {
    taskId: "quick-task-01",
    repositoryFingerprint: target.repositoryFingerprint,
    targetReferenceFingerprint: target.targetReferenceFingerprint,
    sourceFingerprint: target.sourceFingerprint,
    taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
    acceptanceCheckIds: ["check-quick-01"],
    acceptanceCheckDefinitionFingerprints: [fingerprintRealManagedChangeCheckDefinition(request)],
    mode: "QUICK",
    expectedExecutionObservation: "RETURNED",
    expectedAcceptanceObservation: "PASS",
  };
  return { root, repository, leaseRoot, request, oracle };
}

function qualifiedProcessResult(): Task6PiProcessResult {
  return {
    exitCode: 0,
    timedOut: false,
    framingValid: true,
    eventTypes: ["message_end", "agent_end"],
    recordCount: 2,
    stdoutDigest: fixtureFingerprint,
    stderrDigest: fixtureFingerprint,
    capturedBytes: 100,
    outputTruncated: false,
    providerUsage: {
      status: "PASS",
      requestCount: 1,
      tokenCount: 120,
      costMinorUnits: 2,
      reasons: [],
    },
    containment:
      process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
    terminalFinality: "FINAL",
    processTreeState: "EMPTY",
    leaseState: "RELEASED",
  };
}

function passingCommandRunner(): ProcessRunner {
  return {
    run: vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      processError: false,
      stdout: Buffer.from("accepted\n"),
      stderr: Buffer.alloc(0),
      observedOutputBytes: 9,
      stdoutTruncated: false,
      stderrTruncated: false,
      terminalFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
    }),
  };
}

function commandRunnerWithExitCode(exitCode: number): ProcessRunner {
  return {
    run: vi.fn().mockResolvedValue({
      exitCode,
      timedOut: false,
      processError: false,
      stdout: Buffer.from("observed\n"),
      stderr: Buffer.alloc(0),
      observedOutputBytes: 9,
      stdoutTruncated: false,
      stderrTruncated: false,
      terminalFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
    }),
  };
}

function hunterResult(
  oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }>,
): PilotTaskResult {
  return {
    taskId: oracle.taskId,
    repositoryFingerprint: oracle.repositoryFingerprint,
    targetReferenceFingerprint: oracle.targetReferenceFingerprint,
    sourceFingerprint: oracle.sourceFingerprint,
    taskDefinitionFingerprint: oracle.taskDefinitionFingerprint,
    acceptanceCheckIds: oracle.acceptanceCheckIds,
    acceptanceCheckDefinitionFingerprints: oracle.acceptanceCheckDefinitionFingerprints,
    providerSendAcknowledged: true,
    providerRequestCount: 1,
    providerTokenCount: 100,
    providerCostMinor: 1,
    sourcePreserved: true,
    rawSecretLeakage: false,
    applicableFactCount: 20,
    capturedFactCount: 19,
    manualInterventions: 0,
    hunterOverheadMinutes: 1,
    rawPiCapturedFactCount: 0,
    rawPiManualInterventions: 0,
    mode: "QUICK",
    quickReceiptId: "quick-receipt-fixture",
    executionObservation: "RETURNED",
    oracleExecutionObservation: "RETURNED",
    acceptanceObservation: "PASS",
    oracleAcceptanceObservation: "PASS",
    verifiedChangeClaimed: false,
    correct: true,
  };
}

function isolatedRawArguments(): string[] {
  return [
    "pi-cli.js",
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
}

describe("product-derived Quick task runtime", () => {
  it("returns one non-Run receipt only after scoped mutation and independent acceptance", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const runProcess = vi.fn().mockImplementation(async () => {
      await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
      return qualifiedProcessResult();
    });
    const times = [0, 1_000, 51_000, 60_000];

    const receipt = await runPilotQuickTask({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      launchPlan: {
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: fixture.repository,
        environment: {},
      },
      runProcess,
      commandRunner: passingCommandRunner(),
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      runtimeConfigurationFingerprint: fixtureFingerprint,
      now: () => "2026-08-10T04:00:00.000Z",
      monotonicNow: () => times.shift() ?? 60_000,
    });

    expect(receipt).toMatchObject({
      taskId: fixture.oracle.taskId,
      mode: "QUICK",
      executionObservation: "RETURNED",
      acceptanceObservation: "PASS",
      verifiedChangeClaimed: false,
      providerRequestCount: 1,
      providerTokenCount: 120,
      providerCostMinor: 2,
      sourcePreserved: true,
      applicableFactCount: 20,
      capturedFactCount: 19,
      manualInterventions: 0,
      hunterOverheadMinutes: 1 / 6,
      processFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "RELEASED",
    });
    expect(receipt).not.toHaveProperty("runId");
    expect(receipt).not.toHaveProperty("attemptId");
    expect(receipt).not.toHaveProperty("terminalOutcome");
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("records failed acceptance when the Agent mutates an undeclared path", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });

    const receipt = await runPilotQuickTask({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      launchPlan: {
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "outside.txt"), "unsafe\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner: passingCommandRunner(),
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      runtimeConfigurationFingerprint: fixtureFingerprint,
    });

    expect(receipt.acceptanceObservation).toBe("FAIL");
    expect(receipt.executionObservation).toBe("RETURNED");
  });

  it("records failed acceptance when the acceptance command mutates an undeclared path", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const commandRunner: ProcessRunner = {
      run: vi.fn(async () => {
        await writeFile(join(fixture.repository, "acceptance-side-effect.txt"), "unsafe\n", "utf8");
        return {
          exitCode: 0,
          timedOut: false,
          processError: false,
          stdout: Buffer.from("accepted\n"),
          stderr: Buffer.alloc(0),
          observedOutputBytes: 9,
          stdoutTruncated: false,
          stderrTruncated: false,
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          outputState: "CLOSED" as const,
        };
      }),
    };

    const receipt = await runPilotQuickTask({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      launchPlan: {
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner,
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      runtimeConfigurationFingerprint: fixtureFingerprint,
    });

    expect(receipt.acceptanceObservation).toBe("FAIL");
    expect(receipt.executionObservation).toBe("RETURNED");
  });

  it("records failed acceptance when the acceptance command creates an ignored file", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const commandRunner: ProcessRunner = {
      run: vi.fn(async () => {
        await writeFile(join(fixture.repository, "ignored-side-effect.txt"), "unsafe\n", "utf8");
        return {
          exitCode: 0,
          timedOut: false,
          processError: false,
          stdout: Buffer.from("accepted\n"),
          stderr: Buffer.alloc(0),
          observedOutputBytes: 9,
          stdoutTruncated: false,
          stderrTruncated: false,
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          outputState: "CLOSED" as const,
        };
      }),
    };

    const receipt = await runPilotQuickTask({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      launchPlan: {
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner,
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      runtimeConfigurationFingerprint: fixtureFingerprint,
    });

    expect(receipt.acceptanceObservation).toBe("FAIL");
  });

  it("blocks a frozen target mismatch before any Provider process starts", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const runProcess = vi.fn();

    await expect(
      runPilotQuickTask({
        taskId: fixture.oracle.taskId,
        repository: fixture.repository,
        request: {
          ...fixture.request,
          target: { ...fixture.request.target, repositoryFingerprint: `sha256:${"a".repeat(64)}` },
        },
        oracle: fixture.oracle,
        launchPlan: {
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: fixture.repository,
          environment: {},
        },
        runProcess,
        commandRunner: passingCommandRunner(),
        writerLeaseManager: leaseManager,
        writerLeaseOwnerFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        runtimeConfigurationFingerprint: fixtureFingerprint,
      }),
    ).rejects.toThrow(/frozen pilot binding/u);
    expect(runProcess).not.toHaveBeenCalled();
  });
});

describe("product-derived raw Pi comparator runtime", () => {
  it("captures an extension-free comparator from the same source and independent check", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });

    const comparator = await runPilotRawComparator({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      hunterResult: hunterResult(fixture.oracle),
      launchPlan: {
        executable: process.execPath,
        arguments: isolatedRawArguments(),
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner: passingCommandRunner(),
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      comparatorConfigurationFingerprint: fixtureFingerprint,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });

    expect(comparator).toMatchObject({
      taskId: fixture.oracle.taskId,
      mode: "QUICK",
      executionObservation: "RETURNED",
      acceptanceObservation: "PASS",
      coreExtensionCount: 0,
      applicableFactCount: 20,
      rawPiCapturedFactCount: 15,
      hunterCapturedFactCount: 19,
      rawPiManualInterventions: 0,
      hunterManualInterventions: 0,
      containedFalseCompletion: false,
      rawPiProviderRequestCount: 1,
      processFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "RELEASED",
    });
  });

  it("derives contained false completion when raw Pi returns but acceptance fails", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });

    const comparator = await runPilotRawComparator({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      hunterResult: hunterResult(fixture.oracle),
      launchPlan: {
        executable: process.execPath,
        arguments: isolatedRawArguments(),
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "wrong\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner: commandRunnerWithExitCode(1),
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      comparatorConfigurationFingerprint: fixtureFingerprint,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });

    expect(comparator).toMatchObject({
      executionObservation: "RETURNED",
      acceptanceObservation: "FAIL",
      containedFalseCompletion: true,
    });
  });

  it("derives contained false completion when raw acceptance mutates an undeclared path", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const commandRunner: ProcessRunner = {
      run: vi.fn(async () => {
        await writeFile(join(fixture.repository, "acceptance-side-effect.txt"), "unsafe\n", "utf8");
        return {
          exitCode: 0,
          timedOut: false,
          processError: false,
          stdout: Buffer.from("accepted\n"),
          stderr: Buffer.alloc(0),
          observedOutputBytes: 9,
          stdoutTruncated: false,
          stderrTruncated: false,
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          outputState: "CLOSED" as const,
        };
      }),
    };

    const comparator = await runPilotRawComparator({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      hunterResult: hunterResult(fixture.oracle),
      launchPlan: {
        executable: process.execPath,
        arguments: isolatedRawArguments(),
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner,
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      comparatorConfigurationFingerprint: fixtureFingerprint,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });

    expect(comparator).toMatchObject({
      executionObservation: "RETURNED",
      acceptanceObservation: "FAIL",
      containedFalseCompletion: true,
    });
  });

  it("contains a raw acceptance command that creates an ignored file", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const commandRunner: ProcessRunner = {
      run: vi.fn(async () => {
        await writeFile(join(fixture.repository, "ignored-side-effect.txt"), "unsafe\n", "utf8");
        return {
          exitCode: 0,
          timedOut: false,
          processError: false,
          stdout: Buffer.from("accepted\n"),
          stderr: Buffer.alloc(0),
          observedOutputBytes: 9,
          stdoutTruncated: false,
          stderrTruncated: false,
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          outputState: "CLOSED" as const,
        };
      }),
    };

    const comparator = await runPilotRawComparator({
      taskId: fixture.oracle.taskId,
      repository: fixture.repository,
      request: fixture.request,
      oracle: fixture.oracle,
      hunterResult: hunterResult(fixture.oracle),
      launchPlan: {
        executable: process.execPath,
        arguments: isolatedRawArguments(),
        cwd: fixture.repository,
        environment: {},
      },
      runProcess: async () => {
        await writeFile(join(fixture.repository, "result.txt"), "accepted\n", "utf8");
        return qualifiedProcessResult();
      },
      commandRunner,
      writerLeaseManager: leaseManager,
      writerLeaseOwnerFingerprint: fixtureFingerprint,
      environmentFingerprint: fixtureFingerprint,
      comparatorConfigurationFingerprint: fixtureFingerprint,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });

    expect(comparator).toMatchObject({
      executionObservation: "RETURNED",
      acceptanceObservation: "FAIL",
      containedFalseCompletion: true,
    });
  });

  it("blocks any raw launch carrying an extension before Provider execution", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const runProcess = vi.fn();

    await expect(
      runPilotRawComparator({
        taskId: fixture.oracle.taskId,
        repository: fixture.repository,
        request: fixture.request,
        oracle: fixture.oracle,
        hunterResult: hunterResult(fixture.oracle),
        launchPlan: {
          executable: process.execPath,
          arguments: [...isolatedRawArguments(), "--extension=hunter-core.js"],
          cwd: fixture.repository,
          environment: {},
        },
        runProcess,
        commandRunner: passingCommandRunner(),
        writerLeaseManager: leaseManager,
        writerLeaseOwnerFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        comparatorConfigurationFingerprint: fixtureFingerprint,
        workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      }),
    ).rejects.toThrow(/extension-free/u);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("blocks a raw launch missing any declared isolation surface", async () => {
    const fixture = await createFixture();
    const leaseManager = await createFileLeaseManager({ leaseRoot: fixture.leaseRoot });
    const runProcess = vi.fn();

    await expect(
      runPilotRawComparator({
        taskId: fixture.oracle.taskId,
        repository: fixture.repository,
        request: fixture.request,
        oracle: fixture.oracle,
        hunterResult: hunterResult(fixture.oracle),
        launchPlan: {
          executable: process.execPath,
          arguments: isolatedRawArguments().filter(
            (argument) => argument !== "--no-prompt-templates",
          ),
          cwd: fixture.repository,
          environment: {},
        },
        runProcess,
        commandRunner: passingCommandRunner(),
        writerLeaseManager: leaseManager,
        writerLeaseOwnerFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        comparatorConfigurationFingerprint: fixtureFingerprint,
        workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      }),
    ).rejects.toThrow(/extension-free/u);
    expect(runProcess).not.toHaveBeenCalled();
  });
});
