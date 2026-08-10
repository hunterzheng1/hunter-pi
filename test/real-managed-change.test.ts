import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectHpiPilotTarget } from "@hunter-pi/cli";
import type { EngineHost } from "@hunter-pi/engine-contracts";
import { createFileLeaseManager, type LeaseManager } from "@hunter-pi/execution";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  realManagedChangeEvidenceSchema,
  realManagedChangeEvidenceV2Schema,
  realManagedChangePilotExecutionBindingSchema,
  realManagedChangeRequestSchema,
  realManagedChangeVerificationHistoryEntrySchema,
  runRealManagedChange,
  type RealManagedChangeTarget,
} from "@hunter-pi/managed-change";
import { createRealManagedChangePilotExecutionRuntime } from "@hunter-pi/managed-change/internal-pilot-execution";
import { Task6PiEngineHost, type PiProviderUsage } from "@hunter-pi/pi-host";
import { FileRunArchiveStore, FileWorkflowEventStore } from "@hunter-pi/evidence";
import { DurableWorkflowKernel } from "@hunter-pi/workflow-kernel";
import {
  FilePilotCaptureCoordinator,
  PilotPlanCompiler,
  pilotQuickWorkflowFactChecklistFingerprint,
  type PilotExecutionPlan,
} from "@hunter-pi/pilot";
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
  await writeFile(join(repository, ".gitignore"), "ignored-private.txt\n", "utf8");
  await writeFile(
    join(repository, "verify.mjs"),
    "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('result.txt', 'utf8') === 'READY\\n' ? 0 : 1);\n",
    "utf8",
  );
  runGit(repository, ["add", "--", ".gitignore", "result.txt", "verify.mjs"]);
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
    runProcess: async (request, boundary) => {
      await boundary?.beforeExternalOperation();
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

function createInterruptedMutationHost(): EngineHost {
  return new Task6PiEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve({
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: workspace,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      }),
    runProcess: async (request, boundary) => {
      await boundary?.beforeExternalOperation();
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      const interrupted = request.forcedInterruption === "AFTER_AGENT_END";
      return {
        exitCode: interrupted ? 1 : 0,
        timedOut: false,
        framingValid: true,
        eventTypes: interrupted ? ["message_end"] : ["message_end", "agent_end"],
        recordCount: interrupted ? 1 : 2,
        stdoutDigest: fingerprintA,
        stderrDigest: fingerprintB,
        capturedBytes: 128,
        outputTruncated: false,
        providerUsage: fixturePiProviderUsage,
        ...(interrupted ? { interruption: "FORCED_PROCESS_KILL_AFTER_AGENT_END" as const } : {}),
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
    forcedInterruption: "AFTER_AGENT_END",
  });
}

function pilotExecutionBindingFor(
  plan: PilotExecutionPlan,
  taskId: string,
  captureSessionId: string,
  captureOperationId: string,
  targetId?: string,
) {
  const scope = plan.operatorScope;
  if (
    scope.providerEndpointFingerprint === null ||
    scope.providerModelFingerprint === null ||
    scope.credentialScopeFingerprint === null
  ) {
    throw new Error("pilot Provider runtime fixture is incomplete");
  }
  const task = plan.tasks.find((candidate) => candidate.taskId === taskId);
  const acceptanceCheckId = task?.acceptanceCheckIds[0];
  if (task?.acceptanceCheckIds.length !== 1 || acceptanceCheckId === undefined) {
    throw new Error("pilot Managed check identity fixture is incomplete");
  }
  return realManagedChangePilotExecutionBindingSchema.parse({
    schemaVersion: "hpi-real-managed-change-pilot-execution-binding.v1" as const,
    planFingerprint: plan.planFingerprint,
    taskId,
    targetId: targetId ?? task.targetId,
    captureSessionId,
    captureOperationId,
    acceptanceCheckId,
    runtimeBinding: {
      schemaVersion: "hpi-pilot-runtime-binding.v1" as const,
      sourceFingerprint: plan.sourceFingerprint,
      artifactFingerprint: plan.artifactFingerprint,
      engineReleaseFingerprint: plan.engineReleaseFingerprint,
      providerEndpointFingerprint: scope.providerEndpointFingerprint,
      providerModelFingerprint: scope.providerModelFingerprint,
      credentialScopeFingerprint: scope.credentialScopeFingerprint,
    },
    workflowFactChecklistFingerprint: plan.workflowFactChecklistFingerprint,
    deliberateFixback: plan.deliberateFixbackTaskId === taskId,
  });
}

function pilotExecutionRuntimeFor(options: {
  readonly coordinator: FilePilotCaptureCoordinator;
  readonly engineHost: EngineHost;
  readonly plan: PilotExecutionPlan;
  readonly taskId: string;
  readonly sessionId: string;
  readonly operationId: string;
}): unknown {
  return createRealManagedChangePilotExecutionRuntime({
    binding: pilotExecutionBindingFor(
      options.plan,
      options.taskId,
      options.sessionId,
      options.operationId,
    ),
    engineHost: options.engineHost,
    assertDurablePreSendRetryable: () =>
      options.coordinator.assertManagedProviderOperationRetryable({
        schemaVersion: "hpi-pilot-managed-provider-reservation.v1",
        sessionId: options.sessionId,
        operationId: options.operationId,
        taskId: options.taskId,
        planFingerprint: options.plan.planFingerprint,
      }),
    beforeProviderSend: () =>
      options.coordinator.reserveManagedProviderOperation({
        schemaVersion: "hpi-pilot-managed-provider-reservation.v1",
        sessionId: options.sessionId,
        operationId: options.operationId,
        taskId: options.taskId,
        planFingerprint: options.plan.planFingerprint,
      }),
  });
}

describe("real-project Managed Change runner", { timeout: 30_000 }, () => {
  it("preserves the canonical NOT_PROVEN Verification outcome and rejects projection-only NOT_RUN", () => {
    const entry = {
      attemptId: "att_real-1",
      verificationReceiptId: "verify_real-1",
      checkId: "check_real-command",
      resultFingerprint: fingerprintA,
    };

    expect(
      realManagedChangeVerificationHistoryEntrySchema.safeParse({
        ...entry,
        outcome: "NOT_PROVEN",
      }).success,
    ).toBe(true);
    expect(
      realManagedChangeVerificationHistoryEntrySchema.safeParse({
        ...entry,
        outcome: "NOT_RUN",
      }).success,
    ).toBe(false);
  });

  it("uses the frozen pilot task binding in deterministic Managed Run identities", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Keep repeated pilot tasks distinct",
      goal: "Apply the same bounded change under two different frozen pilot task identities.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });

    const runTask = async (taskId: string, operationId: string) => {
      const engineHost = createMutationHost();
      return runRealManagedChange({
        repository,
        request,
        engineHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
          binding: pilotExecutionBindingFor(
            plan,
            taskId,
            "pilot-distinct-session",
            operationId,
            target.targetId,
          ),
          engineHost,
          assertDurablePreSendRetryable: () => Promise.resolve(),
          beforeProviderSend: () => Promise.resolve({ requests: 2, tokens: 2_000, costMinor: 20 }),
        }),
        now: () => "2026-08-06T00:00:10.000Z",
      });
    };

    const first = await runTask("pilot-task-08", "capture-distinct-task-08");
    runGit(repository, ["restore", "--", "result.txt"]);
    const second = await runTask("pilot-task-09", "capture-distinct-task-09");

    expect(second.projection.run.runId).not.toBe(first.projection.run.runId);
    expect(second.projection.planRevision.planRevisionId).not.toBe(
      first.projection.planRevision.planRevisionId,
    );
  });

  it("resumes the exact durable pre-send Attempt after authorization becomes available", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Resume a pre-send Managed Attempt",
      goal: "Apply the bounded result change after the pilot capture session becomes available.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });
    const stateRoot = join(root, "durable-retry");
    const archive = {
      stateRoot,
      archiveId: "archive_real-retryable-presend",
      distributionReleaseId: "release_hunter-pi-0.1.0",
      operationId: "op_real-retryable-presend-archive",
    } as const;
    const common = {
      repository,
      request,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" as const },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      durableArchive: archive,
    };
    const binding = pilotExecutionBindingFor(
      plan,
      "pilot-task-08",
      "pilot-retryable-session",
      "capture-retryable-task-08",
      target.targetId,
    );
    const firstHost = createMutationHost();

    await expect(
      runRealManagedChange({
        ...common,
        engineHost: firstHost,
        pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
          binding,
          engineHost: firstHost,
          assertDurablePreSendRetryable: () => Promise.resolve(),
          beforeProviderSend: () => Promise.reject(new Error("capture session is not open")),
        }),
        now: () => "2026-08-06T00:00:10.000Z",
      }),
    ).rejects.toThrow("capture session is not open");
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("NOT_READY\n");
    const eventStore = new FileWorkflowEventStore({ stateRoot: join(stateRoot, "workflow") });
    const [runId] = await eventStore.listRunIds();
    if (runId === undefined) throw new Error("durable pre-send Run was not recorded");
    expect(await eventStore.read(runId)).toHaveLength(2);

    const resumedHost = createMutationHost();
    const artifact = await runRealManagedChange({
      ...common,
      engineHost: resumedHost,
      pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
        binding,
        engineHost: resumedHost,
        assertDurablePreSendRetryable: () => Promise.resolve(),
        beforeProviderSend: () => Promise.resolve({ requests: 2, tokens: 2_000, costMinor: 20 }),
      }),
      now: () => "2026-08-06T00:00:11.000Z",
    });

    expect(artifact.taskResult).toBe("GO");
    expect(artifact.projection.run.runId).toBe(runId);
    expect(artifact.plan.planFingerprint).toBe(
      `sha256:${createHash("sha256")
        .update(JSON.stringify(artifact.projection.planRevision))
        .digest("hex")}`,
    );
    const events = await eventStore.read(artifact.projection.run.runId);
    expect(events.filter((event) => event.type === "RUN_CREATED")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ATTEMPT_STARTED")).toHaveLength(1);
  });

  it("requires durable proof that pilot authorization never crossed before resuming", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Block an ambiguous post-authorization replay",
      goal: "Do not repeat a Provider request after its authorization boundary crossed.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });
    const stateRoot = join(root, "durable-post-authorization");
    const archive = {
      stateRoot,
      archiveId: "archive_real-post-authorization",
      distributionReleaseId: "release_hunter-pi-0.1.0",
      operationId: "op_real-post-authorization-archive",
    } as const;
    const common = {
      repository,
      request,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" as const },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      durableArchive: archive,
    };
    const binding = pilotExecutionBindingFor(
      plan,
      "pilot-task-08",
      "pilot-post-authorization-session",
      "capture-post-authorization-task-08",
      target.targetId,
    );
    let authorizationCrossed = false;
    let processRuns = 0;
    const firstHost = new Task6PiEngineHost({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: [],
          cwd: workspace,
          environment: {},
        }),
      runProcess: async (_processRequest, boundary) => {
        processRuns += 1;
        await boundary?.beforeExternalOperation();
        throw new Error("simulated loss of process finality after authorization");
      },
      now: () => "2026-08-06T00:00:10.000Z",
      processTimeoutMs: 30_000,
      maximumOutputBytes: 229_376,
      requireQualifiedProcess: true,
    });

    await expect(
      runRealManagedChange({
        ...common,
        engineHost: firstHost,
        pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
          binding,
          engineHost: firstHost,
          assertDurablePreSendRetryable: () => Promise.resolve(),
          beforeProviderSend: () => {
            authorizationCrossed = true;
            return Promise.resolve({ requests: 2, tokens: 2_000, costMinor: 20 });
          },
        }),
        now: () => "2026-08-06T00:00:10.000Z",
      }),
    ).rejects.toThrow("loss of process finality");

    const resumedHost = createMutationHost(undefined, () => {
      processRuns += 1;
    });
    await expect(
      runRealManagedChange({
        ...common,
        engineHost: resumedHost,
        pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
          binding,
          engineHost: resumedHost,
          assertDurablePreSendRetryable: () =>
            authorizationCrossed
              ? Promise.reject(new Error("Provider usage reconciliation is required"))
              : Promise.resolve(),
          beforeProviderSend: () => Promise.resolve({ requests: 2, tokens: 2_000, costMinor: 20 }),
        }),
        now: () => "2026-08-06T00:00:11.000Z",
      }),
    ).rejects.toThrow("Provider usage reconciliation is required");
    expect(processRuns).toBe(1);
  });

  it("fails closed instead of inferring that an observation-free durable non-pilot Attempt was unsent", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Do not replay an ambiguous durable send",
      goal: "Fail closed when durable history cannot prove whether the Provider request was sent.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const stateRoot = join(root, "durable-ambiguous-send");
    const common = {
      repository,
      request,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" as const },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      durableArchive: {
        stateRoot,
        archiveId: "archive_real-ambiguous-send",
        distributionReleaseId: "release_hunter-pi-0.1.0",
        operationId: "op_real-ambiguous-send-archive",
      },
      now: () => "2026-08-06T00:00:10.000Z",
    } as const;
    let firstProcessRuns = 0;

    await expect(
      runRealManagedChange({
        ...common,
        engineHost: createMutationHost(undefined, () => {
          firstProcessRuns += 1;
          throw new Error("simulated crash after an untracked Provider request");
        }),
      }),
    ).rejects.toThrow("simulated crash after an untracked Provider request");
    expect(firstProcessRuns).toBe(1);
    const eventStore = new FileWorkflowEventStore({ stateRoot: join(stateRoot, "workflow") });
    const [runId] = await eventStore.listRunIds();
    if (runId === undefined) throw new Error("ambiguous durable Run was not recorded");
    expect(await eventStore.read(runId)).toHaveLength(2);
    let replayProcessRuns = 0;

    await expect(
      runRealManagedChange({
        ...common,
        engineHost: createMutationHost(undefined, () => {
          replayProcessRuns += 1;
        }),
      }),
    ).rejects.toMatchObject({ reasonCode: "WORKSPACE_DRIFT" });
    expect(replayProcessRuns).toBe(0);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("NOT_READY\n");
  });

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

  it("rejects a caller-authored pilot runtime before any Engine operation", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const beforeMutation = vi.fn();
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject a forged pilot runtime",
      goal: "Do not accept caller-authored pilot execution facts.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: createMutationHost(undefined, beforeMutation),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        pilotExecutionRuntime: { binding: "caller-authored" },
      }),
    ).rejects.toMatchObject({ reasonCode: "PILOT_RUNTIME_BINDING_REQUIRED" });
    expect(beforeMutation).not.toHaveBeenCalled();
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("NOT_READY\n");
  });

  it("rejects an internally shaped pilot runtime bound to a different target identity", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject a pilot target alias",
      goal: "Do not execute a frozen task against a differently named target.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const plan = new PilotPlanCompiler().compile({
      ...completePilotPlanInput(),
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    });
    const beforeMutation = vi.fn();
    const engineHost = createMutationHost(undefined, beforeMutation);
    const binding = pilotExecutionBindingFor(
      plan,
      "pilot-task-08",
      "pilot-target-alias-session",
      "capture-target-alias-task-08",
      "repository-alias",
    );

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        pilotExecutionRuntime: createRealManagedChangePilotExecutionRuntime({
          binding,
          engineHost,
          assertDurablePreSendRetryable: () => Promise.resolve(),
          beforeProviderSend: () => Promise.resolve({ requests: 1, tokens: 1_000, costMinor: 10 }),
        }),
      }),
    ).rejects.toMatchObject({ reasonCode: "TARGET_IDENTITY_MISMATCH" });
    expect(beforeMutation).not.toHaveBeenCalled();
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
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      repositoryTargets,
      acceptanceChecks: input.acceptanceChecks.map((check, index) =>
        index === 0
          ? {
              ...check,
              definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(request),
            }
          : check,
      ),
      tasks: input.tasks.map((task, index) => {
        if (task.targetId !== target.targetId) return task;
        if (index === 0 && task.mode === "QUICK") {
          const {
            expectedExecutionObservation: _execution,
            expectedAcceptanceObservation: _acceptance,
            ...binding
          } = task;
          void _execution;
          void _acceptance;
          return {
            ...binding,
            sourceFingerprint: target.sourceFingerprint,
            taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
            mode: "MANAGED" as const,
            expectedOutcome: "READY" as const,
          };
        }
        return {
          ...task,
          sourceFingerprint: target.sourceFingerprint,
          ...(index === 0
            ? { taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request) }
            : {}),
        };
      }),
    });

    const captureSessionId = "pilot-real-managed-session";
    const captureOperationId = "capture-real-managed-task-01";
    const coordinator = new FilePilotCaptureCoordinator({
      stateRoot: join(root, "pilot-capture"),
      archiveStateRoot: join(root, "pilot-archive"),
      managedRunStateRoot: stateRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    await coordinator.open({
      schemaVersion: "hpi-pilot-capture-open.v1",
      sessionId: captureSessionId,
      archiveId: "pilot-real-managed-archive",
      plan,
    });
    let reservationObservedBeforeProcess = false;
    const engineHost = createMutationHost(undefined, async () => {
      const intent = JSON.parse(
        await readFile(
          join(
            root,
            "pilot-capture",
            "sessions",
            captureSessionId,
            `provider-${captureOperationId}.intent.json`,
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(intent).toMatchObject({
        kind: "MANAGED_TASK",
        operationId: captureOperationId,
        taskId: "pilot-task-01",
      });
      reservationObservedBeforeProcess = true;
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      pilotExecutionRuntime: pilotExecutionRuntimeFor({
        coordinator,
        engineHost,
        plan,
        taskId: "pilot-task-01",
        sessionId: captureSessionId,
        operationId: captureOperationId,
      }),
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
    expect(reservationObservedBeforeProcess).toBe(true);
    expect(artifact.plan.checkId).toBe(plan.tasks[0]?.acceptanceCheckIds[0]);
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
      schemaVersion: "hpi-real-managed-change-task-receipt.v4",
      interruptionKind: null,
      runId: artifact.projection.run.runId,
      repositoryFingerprint: target.repositoryFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
      sourceFingerprint: artifact.repository.sourceFingerprint,
      taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
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
      pilotExecutionBinding: {
        captureSessionId,
        captureOperationId,
        acceptanceCheckId: plan.tasks[0]?.acceptanceCheckIds[0],
      },
      verificationHistory: [{ checkId: plan.tasks[0]?.acceptanceCheckIds[0] }],
    });
    const taskCapture = await coordinator.recordManagedTask({
      schemaVersion: "hpi-pilot-capture-managed-task.v2",
      sessionId: captureSessionId,
      operationId: captureOperationId,
      taskId: "pilot-task-01",
      archiveIds: ["archive_real-pilot-01"],
    });
    expect(taskCapture).toMatchObject({
      outcome: "RECORDED",
      status: {
        counts: { taskChains: 1, runArchives: 1 },
        providerUsage: { requests: 1, tokens: 165, costMinor: 1 },
      },
    });
  });

  it("preserves a predeclared failed Verification before a successful Managed fixback", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const stateRoot = join(root, "managed-fixback-state");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Prove one deliberate fixback",
      goal: "Fail the first independent check, then repair result.txt in the second bounded Attempt.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const input = completePilotPlanInput();
    const plan = new PilotPlanCompiler().compile({
      ...input,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      repositoryTargets: input.repositoryTargets.map((candidate) =>
        candidate.targetId === target.targetId
          ? {
              ...candidate,
              repositoryFingerprint: target.repositoryFingerprint,
              sourceFingerprint: target.sourceFingerprint,
              targetReferenceFingerprint: target.targetReferenceFingerprint,
            }
          : candidate,
      ),
      acceptanceChecks: input.acceptanceChecks.map((check, index) =>
        index === 3
          ? {
              ...check,
              definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(request),
            }
          : check,
      ),
      tasks: input.tasks.map((task) =>
        task.taskId === "pilot-task-04"
          ? {
              ...task,
              sourceFingerprint: target.sourceFingerprint,
              taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
            }
          : task.targetId === target.targetId
            ? { ...task, sourceFingerprint: target.sourceFingerprint }
            : task,
      ),
    });
    const captureSessionId = "pilot-fixback-session";
    const captureOperationId = "capture-pilot-fixback-task-04";
    const capture = new FilePilotCaptureCoordinator({
      stateRoot: join(root, "pilot-fixback-capture"),
      archiveStateRoot: join(root, "pilot-fixback-archive"),
      managedRunStateRoot: stateRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    await capture.open({
      schemaVersion: "hpi-pilot-capture-open.v1",
      sessionId: captureSessionId,
      archiveId: "pilot-fixback-evidence",
      plan,
    });
    let agentCalls = 0;
    const engineHost = createMutationHost(async (workspace) => {
      agentCalls += 1;
      if (agentCalls === 1) {
        await writeFile(join(workspace, "result.txt"), "NOT_READY\n", "utf8");
      }
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      pilotExecutionRuntime: pilotExecutionRuntimeFor({
        coordinator: capture,
        engineHost,
        plan,
        taskId: "pilot-task-04",
        sessionId: captureSessionId,
        operationId: captureOperationId,
      }),
      now: () => "2026-08-06T00:00:10.000Z",
      durableArchive: {
        stateRoot,
        archiveId: "archive_real-pilot-fixback-04",
        distributionReleaseId: "release_hunter-pi-0.1.0",
        operationId: "op_real-pilot-fixback-04",
      },
    });

    expect(agentCalls).toBe(2);
    expect(artifact.taskResult).toBe("GO");
    expect(artifact.projection.attempts).toMatchObject([
      { attemptId: "att_real-1", verificationStatus: "FAILED" },
      {
        attemptId: "att_real-2",
        previousAttemptId: "att_real-1",
        verificationStatus: "PASSED",
      },
    ]);
    expect(artifact.projection.verificationReceipts.map((receipt) => receipt.outcome)).toEqual([
      "FAIL",
      "PASS",
    ]);

    const eventStore = new FileWorkflowEventStore({ stateRoot: join(stateRoot, "workflow") });
    const archiveStore = new FileRunArchiveStore({
      stateRoot: join(stateRoot, "archive"),
      kernel: new DurableWorkflowKernel(eventStore),
    });
    const package_ = await archiveStore.readCanonicalPackage("archive_real-pilot-fixback-04");
    const taskReceiptEvidence = package_.evidence.find(
      (candidate) => candidate.evidenceId === "evidence_real-task-receipt",
    );
    expect(JSON.parse(taskReceiptEvidence?.capture.capturedText ?? "null")).toMatchObject({
      schemaVersion: "hpi-real-managed-change-task-receipt.v4",
      pilotExecutionBinding: {
        planFingerprint: plan.planFingerprint,
        taskId: "pilot-task-04",
        deliberateFixback: true,
      },
      verificationHistory: [{ outcome: "FAIL" }, { outcome: "PASS" }],
      failedAttemptPreserved: true,
      fixbackPass: true,
    });

    await expect(
      capture.recordManagedTask({
        schemaVersion: "hpi-pilot-capture-managed-task.v2",
        sessionId: captureSessionId,
        operationId: captureOperationId,
        taskId: "pilot-task-04",
        archiveIds: ["archive_real-pilot-fixback-04"],
      }),
    ).resolves.toMatchObject({ outcome: "RECORDED" });
  });

  it("blocks a second Managed Provider send when the frozen pilot request budget is one", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const stateRoot = join(root, "managed-one-request-state");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Bound one deliberate fixback",
      goal: "Do not send a second Provider request outside the frozen pilot budget.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const input = completePilotPlanInput();
    const plan = new PilotPlanCompiler().compile({
      ...input,
      operatorScope: { ...input.operatorScope, maxProviderRequests: 1 },
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      repositoryTargets: input.repositoryTargets.map((candidate) =>
        candidate.targetId === target.targetId
          ? {
              ...candidate,
              repositoryFingerprint: target.repositoryFingerprint,
              sourceFingerprint: target.sourceFingerprint,
              targetReferenceFingerprint: target.targetReferenceFingerprint,
            }
          : candidate,
      ),
      acceptanceChecks: input.acceptanceChecks.map((check, index) =>
        index === 3
          ? {
              ...check,
              definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(request),
            }
          : check,
      ),
      tasks: input.tasks.map((task) =>
        task.taskId === "pilot-task-04"
          ? {
              ...task,
              sourceFingerprint: target.sourceFingerprint,
              taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
            }
          : task.targetId === target.targetId
            ? { ...task, sourceFingerprint: target.sourceFingerprint }
            : task,
      ),
    });
    const sessionId = "pilot-one-request-session";
    const operationId = "capture-one-request-task-04";
    const capture = new FilePilotCaptureCoordinator({
      stateRoot: join(root, "pilot-one-request-capture"),
      archiveStateRoot: join(root, "pilot-one-request-archive"),
      managedRunStateRoot: stateRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    await capture.open({
      schemaVersion: "hpi-pilot-capture-open.v1",
      sessionId,
      archiveId: "pilot-one-request-evidence",
      plan,
    });
    let agentCalls = 0;
    const engineHost = createMutationHost(async (workspace) => {
      agentCalls += 1;
      await writeFile(join(workspace, "result.txt"), "NOT_READY\n", "utf8");
    });

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        pilotExecutionRuntime: pilotExecutionRuntimeFor({
          coordinator: capture,
          engineHost,
          plan,
          taskId: "pilot-task-04",
          sessionId,
          operationId,
        }),
        durableArchive: {
          stateRoot,
          archiveId: "archive_one-request-task-04",
          distributionReleaseId: "release_hunter-pi-0.1.0",
          operationId: "op_one-request-task-04",
        },
        now: () => "2026-08-06T00:00:10.000Z",
      }),
    ).rejects.toMatchObject({ reasonCode: "PILOT_PROVIDER_BUDGET_EXHAUSTED" });
    expect(agentCalls).toBe(1);
    await expect(capture.status(sessionId)).rejects.toMatchObject({
      code: "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
    });
  });

  it("recovers an exact interrupted Managed task in the same Run and archives one history", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const stateRoot = join(root, "pilot-task-state");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Recover one interrupted Managed task",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });
    const pilotInput = completePilotPlanInput();
    const pilotPlan = new PilotPlanCompiler().compile({
      ...pilotInput,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      repositoryTargets: pilotInput.repositoryTargets.map((candidate) =>
        candidate.targetId === "repository-alpha"
          ? {
              ...candidate,
              repositoryFingerprint: target.repositoryFingerprint,
              sourceFingerprint: target.sourceFingerprint,
              targetReferenceFingerprint: target.targetReferenceFingerprint,
            }
          : candidate,
      ),
      acceptanceChecks: pilotInput.acceptanceChecks.map((check, index) =>
        index === 1
          ? {
              ...check,
              definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(request),
            }
          : check,
      ),
      tasks: pilotInput.tasks.map((task) =>
        task.taskId === "pilot-task-02"
          ? {
              ...task,
              sourceFingerprint: target.sourceFingerprint,
              taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(request),
            }
          : task.targetId === "repository-alpha"
            ? { ...task, sourceFingerprint: target.sourceFingerprint }
            : task,
      ),
    });
    const common = {
      repository,
      request,
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" as const },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      now: () => "2026-08-06T00:00:10.000Z",
    };

    const captureSessionId = "pilot-interruption-session";
    const captureOperationId = "capture-pilot-interruption-task-02";
    const capture = new FilePilotCaptureCoordinator({
      stateRoot: join(root, "pilot-interruption-capture"),
      archiveStateRoot: join(root, "pilot-interruption-archive"),
      managedRunStateRoot: stateRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    await capture.open({
      schemaVersion: "hpi-pilot-capture-open.v1",
      sessionId: captureSessionId,
      archiveId: "pilot-interruption-evidence",
      plan: pilotPlan,
    });
    const interruptedHost = createInterruptedMutationHost();

    const interrupted = await runRealManagedChange({
      ...common,
      engineHost: interruptedHost,
      pilotInterruption: {
        runIdentity: "pilot-task-01-interrupted",
        forcedInterruption: "FORCED_PROCESS_KILL_AFTER_AGENT_END",
      },
      pilotExecutionRuntime: pilotExecutionRuntimeFor({
        coordinator: capture,
        engineHost: interruptedHost,
        plan: pilotPlan,
        taskId: "pilot-task-02",
        sessionId: captureSessionId,
        operationId: captureOperationId,
      }),
      durableArchive: {
        stateRoot,
        archiveId: "archive_pilot-task-01-interrupted",
        distributionReleaseId: "release_hunter-pi-0.1.0",
        operationId: "op_pilot-task-01-interrupted",
      },
    });
    expect(interrupted.projection).toMatchObject({
      run: { lifecycle: "READY" },
      change: { lifecycle: "READY" },
      attempts: [
        { attemptId: "att_real-1" },
        {
          attemptId: "att_real-2",
          previousAttemptId: "att_real-1",
        },
      ],
    });
    expect(interrupted.projection.attempts[1]?.recoveryCheckpointId).toMatch(/^checkpoint_/u);
    expect(interrupted.projection.checkpoints).toHaveLength(1);
    expect(interrupted.projection.attemptFinalityReceipts).toHaveLength(1);
    expect(interrupted.scorecard.failedAttemptPreserved).toBe(true);
    expect(interrupted.taskResult).toBe("GO");

    const eventStore = new FileWorkflowEventStore({ stateRoot: join(stateRoot, "workflow") });
    const archiveStore = new FileRunArchiveStore({
      stateRoot: join(stateRoot, "archive"),
      kernel: new DurableWorkflowKernel(eventStore),
    });
    const interruptedPackage = await archiveStore.readCanonicalPackage(
      "archive_pilot-task-01-interrupted",
    );
    const receiptFor = (package_: typeof interruptedPackage) => {
      const evidence = package_.evidence.find(
        (candidate) => candidate.evidenceId === "evidence_real-task-receipt",
      );
      return JSON.parse(evidence?.capture.capturedText ?? "null") as Record<string, unknown>;
    };
    expect(receiptFor(interruptedPackage)).toMatchObject({
      mode: "MANAGED",
      terminalOutcome: "READY",
      taskResult: "GO",
      providerUsage: { status: "PASS", requestCount: 2 },
    });
    expect(interruptedPackage.projection.run.predecessorRunId).toBeUndefined();

    await expect(
      capture.recordManagedTask({
        schemaVersion: "hpi-pilot-capture-managed-task.v2",
        sessionId: captureSessionId,
        operationId: captureOperationId,
        taskId: "pilot-task-02",
        archiveIds: ["archive_pilot-task-01-interrupted"],
      }),
    ).resolves.toMatchObject({
      outcome: "RECORDED",
      status: {
        counts: { taskChains: 1, runArchives: 1, interruptions: 1 },
        providerUsage: { requests: 2, tokens: 330, costMinor: 2 },
      },
    });

    await expect(
      runRealManagedChange({
        ...common,
        engineHost: createMutationHost(),
        durableArchive: {
          stateRoot,
          archiveId: "archive_pilot-task-01-untrusted-retry",
          distributionReleaseId: "release_hunter-pi-0.1.0",
          operationId: "op_pilot-task-01-untrusted-retry",
        },
      }),
    ).rejects.toMatchObject({ reasonCode: "DIRTY_WORKTREE" });
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

  it("returns STOP when the Agent changes an ignored path outside the explicit allowed scope", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject an ignored out-of-scope mutation",
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
        writeFile(join(workspace, "ignored-private.txt"), "unsafe\n", "utf8"),
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
    expect(artifact.review.changedPaths).toEqual(["ignored-private.txt", "result.txt"]);
    expect(artifact.review.findings).toMatchObject([
      { severity: "P1", scope: "workspace-out-of-scope-paths" },
    ]);
  });

  it("fails closed before the Provider operation when ignored content exceeds the hash-byte budget", async () => {
    const { root, repository } = await createRepository();
    await writeFile(join(repository, "ignored-private.txt"), Buffer.alloc(2_048, "x"));
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let providerOperationStarted = false;
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Bound ignored-content hashing",
      goal: "Reject an ignored-content snapshot that exceeds its explicit byte budget.",
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
        engineHost: createMutationHost(undefined, () => {
          providerOperationStarted = true;
        }),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        workingTreeInspectionLimits: {
          maximumHashedBytes: 1_024,
          maximumElapsedMs: 30_000,
        },
      }),
    ).rejects.toThrow(/WORKING_TREE_INSPECTION_BUDGET_EXCEEDED/u);
    expect(providerOperationStarted).toBe(false);
  });

  it("fails closed before the Provider operation when ignored-content inspection exceeds its elapsed budget", async () => {
    const { root, repository } = await createRepository();
    await writeFile(join(repository, "ignored-private.txt"), "bounded\n", "utf8");
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    let providerOperationStarted = false;
    const monotonicSamples = [0, 0, 2];
    let monotonicSampleIndex = 0;
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Bound ignored-content inspection time",
      goal: "Reject an ignored-content snapshot that exceeds its explicit elapsed budget.",
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
        engineHost: createMutationHost(undefined, () => {
          providerOperationStarted = true;
        }),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
        monotonicNow: () => {
          const sample = monotonicSamples.at(monotonicSampleIndex) ?? 2;
          monotonicSampleIndex += 1;
          return sample;
        },
        workingTreeInspectionLimits: {
          maximumHashedBytes: 1_024 * 1_024,
          maximumElapsedMs: 1,
        },
      }),
    ).rejects.toThrow(/WORKING_TREE_INSPECTION_BUDGET_EXCEEDED/u);
    expect(providerOperationStarted).toBe(false);
  });

  it("returns STOP when the Agent switches to another branch at the frozen commit", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject final target-reference drift",
      goal: "Keep the final repository bound to the explicitly selected branch.",
      nonGoals: [],
      constraints: ["The selected target reference must not change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
      target,
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(() => {
        runGit(repository, ["checkout", "--quiet", "-b", "same-commit-drift"]);
        return Promise.resolve();
      }),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.projection.change.lifecycle).not.toBe("READY");
    expect(artifact.review.baseCommitUnchanged).toBe(true);
    expect(artifact.review.findings).toMatchObject([
      { severity: "P0", scope: "workspace-target-reference-drift" },
    ]);
  });

  it("returns STOP when a passing Verification command mutates an allowed path", async () => {
    const { root, repository } = await createRepository();
    await writeFile(
      join(repository, "verify.mjs"),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('result.txt', 'VERIFIER_MUTATION\\n');\n",
      "utf8",
    );
    runGit(repository, ["add", "--", "verify.mjs"]);
    runGit(repository, ["commit", "--quiet", "-m", "Add mutating Verification fixture"]);
    const writerLease = await createWriterLease(root);
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v2",
      title: "Reject a mutating Verification command",
      goal: "Make the declared project check pass without trusting its side effects.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Mutating project check", executable: "node", argv: ["verify.mjs"] },
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
    expect(artifact.scorecard.changedPathsWithinScope).toBe(true);
    expect(artifact.review.findings).toMatchObject([
      { severity: "P1", scope: "verification-workspace-mutation" },
    ]);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("VERIFIER_MUTATION\n");
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
