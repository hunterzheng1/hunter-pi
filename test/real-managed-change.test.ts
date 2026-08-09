import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectHpiPilotTarget } from "@hunter-pi/cli";
import type { EngineHost } from "@hunter-pi/engine-contracts";
import { createFileLeaseManager, type LeaseManager } from "@hunter-pi/execution";
import {
  realManagedChangeEvidenceSchema,
  realManagedChangeEvidenceV2Schema,
  realManagedChangeRequestSchema,
  runRealManagedChange,
  type RealManagedChangeTarget,
} from "@hunter-pi/managed-change";
import { Task6PiEngineHost, type PiProviderUsage } from "@hunter-pi/pi-host";
import { FileRunArchiveStore, FileWorkflowEventStore } from "@hunter-pi/evidence";
import { DurableWorkflowKernel } from "@hunter-pi/workflow-kernel";
import { FilePilotCaptureCoordinator, PilotPlanCompiler } from "@hunter-pi/pilot";
import { fixturePiProviderUsage } from "./support/pi-provider-usage-fixture.js";
import { completePilotPlanInput } from "./support/task12-plan-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];
const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runGit(repository: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Git fixture command failed: ${arguments_.join(" ")}`);
  }
  return result.stdout;
}

async function createRepository(): Promise<{ readonly root: string; readonly repository: string }> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-real-change-");
  cleanupRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  runGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  runGit(repository, ["config", "user.name", "Hunter Pi Test"]);
  runGit(repository, ["config", "user.email", "hunter-pi-test@example.invalid"]);
  await writeFile(join(repository, "result.txt"), "NOT_READY\n", "utf8");
  await writeFile(
    join(repository, "verify.mjs"),
    "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('result.txt', 'utf8') === 'READY\\n' ? 0 : 1);\n",
    "utf8",
  );
  runGit(repository, ["add", "--", "result.txt", "verify.mjs"]);
  runGit(repository, ["commit", "--quiet", "-m", "Initialize real-project fixture"]);
  return { root, repository };
}

async function targetFor(repository: string): Promise<RealManagedChangeTarget> {
  const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");
  if (
    receipt.status !== "READY" ||
    receipt.repositoryFingerprint === null ||
    receipt.sourceFingerprint === null ||
    receipt.targetReferenceFingerprint === null
  ) {
    throw new Error(`target fixture was not ready: ${JSON.stringify(receipt)}`);
  }
  return {
    targetId: receipt.targetId,
    selectionMode: receipt.selectionMode,
    repositoryFingerprint: receipt.repositoryFingerprint,
    sourceFingerprint: receipt.sourceFingerprint,
    targetReferenceFingerprint: receipt.targetReferenceFingerprint,
  };
}

async function createWriterLease(root: string): Promise<{
  readonly manager: LeaseManager;
  readonly ownerFingerprint: typeof fingerprintB;
}> {
  const leaseRoot = join(root, "leases");
  await mkdir(leaseRoot);
  return {
    manager: await createFileLeaseManager({ leaseRoot }),
    ownerFingerprint: fingerprintB,
  };
}

function createMutationHost(
  extraMutation?: (workspace: string) => Promise<void>,
  beforeMutation?: () => void | Promise<void>,
  providerUsage: PiProviderUsage = fixturePiProviderUsage,
): EngineHost {
  return new Task6PiEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve({
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: workspace,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      }),
    runProcess: async (request) => {
      await beforeMutation?.();
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      await extraMutation?.(request.plan.cwd);
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: fingerprintA,
        stderrDigest: fingerprintB,
        capturedBytes: 128,
        outputTruncated: false,
        providerUsage,
        containment:
          process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
      };
    },
    now: () => "2026-08-06T00:00:10.000Z",
    processTimeoutMs: 30_000,
    maximumOutputBytes: 229_376,
    requireQualifiedProcess: true,
  });
}

describe("real-project Managed Change runner", { timeout: 30_000 }, () => {
  it("rejects control characters in the independent check definition", () => {
    expect(
      realManagedChangeRequestSchema.safeParse({
        schemaVersion: "hpi-managed-change-request.v2",
        title: "Reject control characters",
        goal: "The declared check must be terminal-safe.",
        nonGoals: [],
        constraints: [],
        allowedPaths: ["result.txt"],
        check: {
          label: "Project result check",
          executable: "node",
          argv: ["verify.mjs\n"],
        },
        target: {
          targetId: "repository-alpha",
          selectionMode: "EXPLICIT_OPERATOR_SELECTED",
          repositoryFingerprint: fingerprintA,
          sourceFingerprint: fingerprintA,
          targetReferenceFingerprint: fingerprintA,
        },
      }).success,
    ).toBe(false);
  });

  it("runs against an explicitly selected Git repository, verifies the result, and leaves the change for review", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Make the real-project check pass",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: {
        label: "Project result check",
        executable: "node",
        argv: ["verify.mjs"],
      },
      target,
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      now: () => "2026-08-06T00:00:10.000Z",
      monotonicNow: (() => {
        let value = 0;
        return () => ++value;
      })(),
    });

    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v3",
      taskResult: "GO",
      repository: { scope: "EXPLICIT_OPERATOR_SELECTED" },
      productSource: { state: "CLEAN" },
      provider: {
        id: "openai-codex",
        requestStatus: "DETECTED",
        usage: {
          status: "PASS",
          requestCount: 1,
          tokenCount: 165,
          costMinorUnits: 1,
          reasons: [],
        },
      },
      resourceAccounting: {
        status: "PASS",
        consumed: { tokens: 165, costMinorUnits: 1 },
        unprovenReasons: [],
      },
      cleanup: { status: "NOT_APPLICABLE" },
    });
    expect(artifact.projection.change.lifecycle).toBe("READY");
    expect(artifact.review.changedPaths).toEqual(["result.txt"]);
    expect(artifact.repository.target).toEqual(target);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(runGit(repository, ["status", "--porcelain=v1"]).trim()).toBe("M result.txt");

    const historicalProvider: Record<string, unknown> = { ...artifact.provider };
    Reflect.deleteProperty(historicalProvider, "usage");
    const historicalBudgets: Record<string, unknown> = {
      ...artifact.resourceAccounting.budgets,
    };
    Reflect.deleteProperty(historicalBudgets, "maxTokens");
    Reflect.deleteProperty(historicalBudgets, "maxCostMinorUnits");
    const historicalConsumed: Record<string, unknown> = {
      ...artifact.resourceAccounting.consumed,
    };
    Reflect.deleteProperty(historicalConsumed, "tokens");
    Reflect.deleteProperty(historicalConsumed, "costMinorUnits");
    const historicalV2 = {
      ...artifact,
      schemaVersion: "hpi-managed-change.v2",
      provider: historicalProvider,
      resourceAccounting: {
        ...artifact.resourceAccounting,
        budgets: historicalBudgets,
        consumed: historicalConsumed,
      },
    };
    expect(realManagedChangeEvidenceV2Schema.parse(historicalV2)).toEqual(historicalV2);
    expect(realManagedChangeEvidenceSchema.safeParse(historicalV2).success).toBe(false);
    expect(
      realManagedChangeEvidenceSchema.safeParse({
        ...artifact,
        resourceAccounting: {
          ...artifact.resourceAccounting,
          consumed: {
            ...artifact.resourceAccounting.consumed,
            tokens: (artifact.resourceAccounting.consumed.tokens ?? 0) + 1,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("persists a real run through the durable workflow and immutable Task 9 Archive", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const stateRoot = join(root, "managed-run-state");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Archive the real-project result",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: {
        label: "Project result check",
        executable: "node",
        argv: ["verify.mjs"],
      },
      target,
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      now: () => "2026-08-06T00:00:10.000Z",
      durableArchive: {
        stateRoot,
        archiveId: "archive_real-pilot-01",
        distributionReleaseId: "release_hunter-pi-0.1.0",
        operationId: "op_real-pilot-archive-01",
      },
    });

    const eventStore = new FileWorkflowEventStore({ stateRoot: join(stateRoot, "workflow") });
    const kernel = new DurableWorkflowKernel(eventStore);
    const archiveStore = new FileRunArchiveStore({
      stateRoot: join(stateRoot, "archive"),
      kernel,
    });
    const manifest = await archiveStore.read("archive_real-pilot-01");
    expect(manifest).toMatchObject({
      schemaVersion: "hpi-archive.v1",
      archiveId: "archive_real-pilot-01",
      runId: artifact.projection.run.runId,
      outcome: "READY",
      archiveStatus: "ARCHIVED",
      sourceFingerprint: artifact.repository.sourceFingerprint,
    });
    expect((await kernel.project(artifact.projection.run.runId)).run).toMatchObject({
      archiveStatus: "ARCHIVED",
      archiveId: "archive_real-pilot-01",
    });
    expect(await eventStore.read(artifact.projection.run.runId)).toHaveLength(
      artifact.projection.eventCursor + 1,
    );
    const package_ = await archiveStore.readCanonicalPackage("archive_real-pilot-01");
    expect(package_.projection.run.predecessorRunId).toBeUndefined();
    const taskReceiptEvidence = package_.evidence.find(
      (evidence) => evidence.evidenceId === "evidence_real-task-receipt",
    );
    expect(taskReceiptEvidence?.capture.capturedText).toBeDefined();
    expect(JSON.parse(taskReceiptEvidence?.capture.capturedText ?? "null")).toMatchObject({
      schemaVersion: "hpi-real-managed-change-task-receipt.v1",
      runId: artifact.projection.run.runId,
      repositoryFingerprint: target.repositoryFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
      sourceFingerprint: artifact.repository.sourceFingerprint,
      mode: "MANAGED",
      acceptanceCheckDefinitionFingerprints: [artifact.plan.checkDefinitionFingerprint],
      terminalOutcome: "READY",
      taskResult: "GO",
      sourcePreserved: true,
      rawSecretLeakage: false,
      providerUsage: {
        status: "PASS",
        requestCount: 1,
        tokenCount: 165,
        costMinorUnits: 1,
      },
      reviewP0P1Count: 0,
    });

    const input = completePilotPlanInput();
    const repositoryTargets = input.repositoryTargets.map((candidate) =>
      candidate.targetId === target.targetId
        ? {
            ...candidate,
            repositoryFingerprint: target.repositoryFingerprint,
            sourceFingerprint: target.sourceFingerprint,
            targetReferenceFingerprint: target.targetReferenceFingerprint,
          }
        : candidate,
    );
    const plan = new PilotPlanCompiler().compile({
      ...input,
      repositoryTargets,
      acceptanceChecks: input.acceptanceChecks.map((check, index) =>
        index === 0
          ? { ...check, definitionFingerprint: artifact.plan.checkDefinitionFingerprint }
          : check,
      ),
      tasks: input.tasks.map((task, index) =>
        task.targetId === target.targetId
          ? {
              ...task,
              sourceFingerprint: target.sourceFingerprint,
              mode: index === 0 ? ("MANAGED" as const) : task.mode,
            }
          : task,
      ),
    });
    const coordinator = new FilePilotCaptureCoordinator({
      stateRoot: join(root, "pilot-capture"),
      archiveStateRoot: join(root, "pilot-archive"),
      managedRunStateRoot: stateRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    await coordinator.open({
      schemaVersion: "hpi-pilot-capture-open.v1",
      sessionId: "pilot-real-managed-session",
      archiveId: "pilot-real-managed-archive",
      plan,
    });
    const taskCapture = await coordinator.recordManagedTask({
      schemaVersion: "hpi-pilot-capture-managed-task.v1",
      sessionId: "pilot-real-managed-session",
      operationId: "capture-real-managed-task-01",
      taskId: "pilot-task-01",
      archiveIds: ["archive_real-pilot-01"],
      metrics: {
        applicableFactCount: 20,
        capturedFactCount: 20,
        manualInterventions: 1,
        rawPiCapturedFactCount: 15,
        rawPiManualInterventions: 3,
      },
    });
    expect(taskCapture).toMatchObject({
      outcome: "RECORDED",
      status: {
        counts: { taskChains: 1, runArchives: 1 },
        providerUsage: { requests: 1, tokens: 165, costMinor: 1 },
      },
    });
  });

  it("returns STOP when the Engine cannot prove exact Provider usage", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject unaccounted Provider usage",
      goal: "Change result.txt only when Provider usage remains measurable.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(undefined, undefined, {
        status: "NOT_PROVEN",
        requestCount: null,
        tokenCount: null,
        costMinorUnits: null,
        reasons: ["ASSISTANT_USAGE_MISSING"],
      }),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact).toMatchObject({
      taskResult: "STOP",
      provider: {
        requestStatus: "NOT_PROVEN",
        usage: {
          status: "NOT_PROVEN",
          requestCount: null,
          tokenCount: null,
          costMinorUnits: null,
          reasons: ["ENGINE_PROVIDER_USAGE_MISSING"],
        },
      },
      resourceAccounting: {
        status: "NOT_PROVEN",
        unprovenReasons: ["ENGINE_PROVIDER_USAGE_MISSING"],
      },
    });
  });

  it("does not start a fixback Provider request after unaccounted first-attempt usage", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let providerCalls = 0;
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Do not retry unaccounted usage",
      goal: "Preserve the failed attempt without starting an unaccounted fixback request.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(
        (workspace) => writeFile(join(workspace, "result.txt"), "NOT_READY\n", "utf8"),
        () => {
          providerCalls += 1;
        },
        {
          status: "NOT_PROVEN",
          requestCount: null,
          tokenCount: null,
          costMinorUnits: null,
          reasons: ["ASSISTANT_USAGE_MISSING"],
        },
      ),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(providerCalls).toBe(1);
    expect(artifact).toMatchObject({
      taskResult: "STOP",
      resourceAccounting: {
        status: "NOT_PROVEN",
        unprovenReasons: ["ENGINE_PROVIDER_USAGE_MISSING"],
      },
    });
    expect(artifact.projection.attempts).toHaveLength(1);
    expect(artifact.projection.verificationReceipts).toHaveLength(1);
    expect(artifact.projection.verificationReceipts[0]?.outcome).toBe("FAIL");
  });

  it("returns a structured STOP without a fixback request when the retry reserve is exhausted", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let providerCalls = 0;
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reserve the fixback Provider budget",
      goal: "Do not start a fixback request when its finite token reserve is unavailable.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(
        (workspace) => writeFile(join(workspace, "result.txt"), "NOT_READY\n", "utf8"),
        () => {
          providerCalls += 1;
        },
        {
          status: "PASS",
          requestCount: 1,
          tokenCount: 200_000,
          costMinorUnits: 1_000,
          reasons: [],
        },
      ),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(providerCalls).toBe(1);
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v3",
      taskResult: "STOP",
      provider: { usage: { status: "PASS", tokenCount: 200_000, costMinorUnits: 1_000 } },
      resourceAccounting: {
        status: "PASS",
        consumed: { tokens: 200_000, costMinorUnits: 1_000 },
      },
    });
    expect(artifact.projection.attempts).toHaveLength(1);
    expect(artifact.projection.verificationReceipts[0]?.outcome).toBe("FAIL");
  });

  it("returns STOP when measured Provider tokens exceed the finite per-change budget", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Enforce the Provider token budget",
      goal: "Change result.txt without exceeding the finite Provider token budget.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(undefined, undefined, {
        status: "PASS",
        requestCount: 1,
        tokenCount: 200_001,
        costMinorUnits: 1,
        reasons: [],
      }),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact).toMatchObject({
      taskResult: "STOP",
      provider: { usage: { status: "PASS", tokenCount: 200_001 } },
      resourceAccounting: {
        status: "EXCEEDED",
        budgets: { maxTokens: 200_000, maxCostMinorUnits: 1_000 },
        consumed: { tokens: 200_001, costMinorUnits: 1 },
      },
    });
  });

  it("returns a bounded STOP artifact when the declared independent check cannot start", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Report an unavailable project check",
      goal: "Change result.txt while preserving a blocked independent check result.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: {
        label: "Unavailable project check",
        executable: "hpi-check-executable-that-does-not-exist",
        argv: ["--version"],
      },
      target,
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.projection.change.lifecycle).toBe("BLOCKED");
    expect(artifact.projection.verificationReceipts[0]?.outcome).toBe("BLOCKED");
    expect(artifact.review.findings).toEqual([]);
    expect(artifact.cleanup.targetWorkingTree).toBe("PRESERVED_CHANGED");
  });

  it("blocks a frozen target identity mismatch before starting the Agent", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject a changed pilot target",
      goal: "Do not run when the frozen target identity no longer matches the selected repository.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target: {
        targetId: "repository-alpha",
        selectionMode: "EXPLICIT_OPERATOR_SELECTED",
        repositoryFingerprint: fingerprintA,
        sourceFingerprint: fingerprintA,
        targetReferenceFingerprint: fingerprintA,
      },
    });
    let providerStarted = false;

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: createMutationHost(() => {
          providerStarted = true;
          return Promise.resolve();
        }),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/TARGET_IDENTITY_MISMATCH/u);
    expect(providerStarted).toBe(false);
  });

  it("blocks a repository-configured external Git filter without executing it", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const filterScript = join(root, "unexpected-filter.mjs");
    const marker = join(root, "filter-executed.marker");
    await writeFile(
      filterScript,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    runGit(repository, ["config", "filter.hpiunsafe.process", `node "${filterScript}"`]);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject an external Git filter",
      goal: "Do not execute repository-configured external code during target inspection.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: createMutationHost(),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/EXTERNAL_FILTER_CONFIGURED/u);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("rechecks the frozen target before a fixback Agent starts", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let processCalls = 0;
    const host = createMutationHost(
      async (workspace) => {
        if (processCalls === 1) {
          await writeFile(join(workspace, "result.txt"), "NOT_READY\n", "utf8");
          runGit(repository, ["checkout", "--quiet", "-b", "unexpected-target"]);
        }
      },
      () => {
        processCalls += 1;
      },
    );
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Stop fixback after target drift",
      goal: "Do not start a fixback Agent after the selected branch changes.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: host,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/TARGET_IDENTITY_MISMATCH/u);
    expect(processCalls).toBe(1);
  });

  it("rechecks the frozen target after the Engine capability probe", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const baseHost = createMutationHost();
    let startCalls = 0;
    const host: EngineHost = {
      probe: async (input) => {
        const receipt = await baseHost.probe(input);
        runGit(repository, ["checkout", "--quiet", "-b", "probe-drift"]);
        return receipt;
      },
      start: async (input) => {
        startCalls += 1;
        return baseHost.start(input);
      },
      send: (handle, input) => baseHost.send(handle, input),
      observe: (handle, cursor) => baseHost.observe(handle, cursor),
      interrupt: (handle, input) => baseHost.interrupt(handle, input),
      checkpoint: (handle, input) => baseHost.checkpoint(handle, input),
      reconcile: (input) => baseHost.reconcile(input),
      close: (handle, input) => baseHost.close(handle, input),
    };
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Stop after probe-time target drift",
      goal: "Do not start an Agent after the selected branch changes during capability probing.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: host,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/TARGET_IDENTITY_MISMATCH/u);
    expect(startCalls).toBe(0);
  });

  it("blocks a concurrent Managed Change on the same physical repository before a second Provider send", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let markProviderStarted = (): void => undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let releaseFirstProvider = (): void => undefined;
    const firstProviderStarted = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Hold the selected repository change",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const first = runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(undefined, async () => {
        markProviderStarted();
        await firstProviderStarted;
      }),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });
    await providerStarted;

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: createMutationHost(),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: fingerprintA,
      }),
    ).rejects.toThrow(/WORKSPACE_BUSY/u);

    releaseFirstProvider();
    await expect(first).resolves.toMatchObject({ taskResult: "GO" });
  });

  it("fails closed before the Provider operation when the explicitly selected repository is dirty", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    await writeFile(join(repository, "unrelated.txt"), "operator work\n", "utf8");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Should not run on dirty source",
      goal: "Make the declared project check pass.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    let providerOperationStarted = false;
    const host = createMutationHost();
    const guardedHost: EngineHost = {
      probe: (input) => host.probe(input),
      start: (input) => host.start(input),
      send: async (...args) => {
        providerOperationStarted = true;
        return host.send(...args);
      },
      observe: (handle, cursor) => host.observe(handle, cursor),
      interrupt: (handle, input) => host.interrupt(handle, input),
      checkpoint: (handle, input) => host.checkpoint(handle, input),
      reconcile: (input) => host.reconcile(input),
      close: (handle, input) => host.close(handle, input),
    };

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: guardedHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/DIRTY_WORKTREE/u);
    expect(providerOperationStarted).toBe(false);
  });

  it("returns STOP when the Agent changes a path outside the explicit allowed scope", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject an out-of-scope mutation",
      goal: "Make the declared project check pass.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost((workspace) =>
        writeFile(join(workspace, "unexpected.txt"), "unexpected\n", "utf8"),
      ),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.projection.change.lifecycle).toBe("REVIEWING");
    expect(artifact.review.findings).toMatchObject([
      { severity: "P1", scope: "workspace-out-of-scope-paths" },
    ]);
    expect(JSON.stringify(artifact)).not.toContain(root);
  });

  it("refuses private path material in a plan before starting the Agent", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Private path must not enter the plan",
      goal: `Do not echo ${repository} in the Provider prompt.`,
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    let started = false;
    const host = createMutationHost();
    const guardedHost: EngineHost = {
      probe: (input) => host.probe(input),
      start: async (input) => {
        started = true;
        return host.start(input);
      },
      send: (handle, input) => host.send(handle, input),
      observe: (handle, cursor) => host.observe(handle, cursor),
      interrupt: (handle, input) => host.interrupt(handle, input),
      checkpoint: (handle, input) => host.checkpoint(handle, input),
      reconcile: (input) => host.reconcile(input),
      close: (handle, input) => host.close(handle, input),
    };

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: guardedHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/PLAN_CONTENT_NOT_PORTABLE/u);
    expect(started).toBe(false);
    expect(request.goal).toContain(repository);
  });
});
