import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  engineInputSchema,
  probeRequestSchema,
  reconcileOperationRequestSchema,
  startAttemptRequestSchema,
} from "@hunter-pi/engine-contracts";
import * as piHostModule from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;
const observedAt = "2026-08-04T00:00:00.000Z";
const providerUsagePass = {
  status: "PASS" as const,
  requestCount: 1,
  tokenCount: 165,
  costMinorUnits: 1,
  reasons: [] as const,
};
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

interface PiLaunchPlan {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

interface ProcessRequest {
  readonly plan: PiLaunchPlan;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly forcedInterruption?: "AFTER_AGENT_END";
}

interface ProcessResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly framingValid: boolean;
  readonly eventTypes: readonly string[];
  readonly recordCount: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly capturedBytes: number;
  readonly outputTruncated: boolean;
  readonly providerUsage: {
    readonly status: "PASS" | "NOT_PROVEN";
    readonly requestCount: number | null;
    readonly tokenCount: number | null;
    readonly costMinorUnits: number | null;
    readonly reasons: readonly string[];
  };
  readonly containment?: "WINDOWS_JOB_OBJECT" | "LINUX_SUBREAPER_PROCESS_TREE" | "TEST_CONTAINED";
  readonly terminalFinality?: "FINAL" | "NOT_PROVEN";
  readonly processTreeState?: "EMPTY" | "ACTIVE" | "NOT_PROVEN";
  readonly leaseState?: "RELEASED" | "HELD" | "NOT_REQUIRED" | "NOT_PROVEN";
  readonly interruption?: "FORCED_PROCESS_KILL_AFTER_AGENT_END";
}

interface ExternalOperationBoundary {
  readonly beforeExternalOperation: () => Promise<void>;
}

interface Task6Host {
  probe(request: unknown): Promise<{
    readonly results: readonly {
      readonly capability: string;
      readonly status: string;
    }[];
  }>;
  start(request: unknown): Promise<{
    readonly handle: { readonly engineHandleId: string; readonly attemptId: string };
    readonly operationReceipt: unknown;
  }>;
  send(handle: unknown, input: unknown, boundary?: ExternalOperationBoundary): Promise<unknown>;
  reconcile(request: unknown): Promise<unknown>;
  observe(
    handle: unknown,
    cursor?: number,
  ): AsyncIterable<{
    readonly cursor: number;
    readonly kind: string;
    readonly summary?: string;
    readonly resourceUsage?: {
      readonly outputBytes?: number;
      readonly externalOperations?: number;
      readonly tokens?: number;
      readonly costMinorUnits?: number;
    };
  }>;
}

type Task6HostConstructor = new (options: {
  readonly launchPlanForWorkspace: (workspace: string) => Promise<PiLaunchPlan>;
  readonly runProcess: (
    request: ProcessRequest,
    boundary?: ExternalOperationBoundary,
  ) => Promise<ProcessResult>;
  readonly now: () => string;
  readonly processTimeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly requireQualifiedProcess?: boolean;
  readonly forcedInterruption?: "AFTER_AGENT_END";
}) => Task6Host;

function requireHostConstructor(): Task6HostConstructor {
  const value: unknown = Reflect.get(piHostModule, "Task6PiEngineHost");
  expect(value, "Task6PiEngineHost must be exported").toBeTypeOf("function");
  return value as Task6HostConstructor;
}

describe("Task 6 fixed Pi Engine Host", () => {
  it("runs one bounded JSON Agent operation once and exposes only provider-neutral observations", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-host-");
    cleanupRoots.push(root);
    const resultPath = join(root, "result.txt");
    await writeFile(resultPath, "NOT_READY\n", "utf8");
    let processRuns = 0;
    let authorizations = 0;
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: workspace,
          environment: { HUNTER_PI_MODE: "MANAGED" },
        }),
      runProcess: async (request, boundary) => {
        processRuns += 1;
        expect(boundary).toBeDefined();
        await boundary?.beforeExternalOperation();
        await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
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
          providerUsage: providerUsagePass,
        };
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
    });
    const capabilityReceipt = await host.probe(
      probeRequestSchema.parse({
        schemaVersion: "1.0.0",
        requestedCapabilities: [
          "START_ATTEMPT",
          "SEND_INPUT",
          "OBSERVE",
          "INTERRUPT",
          "CHECKPOINT",
          "RECONCILE",
          "RESUME",
          "CLOSE",
        ],
      }),
    );
    expect(capabilityReceipt.results).toEqual([
      { capability: "START_ATTEMPT", status: "SUPPORTED" },
      { capability: "SEND_INPUT", status: "SUPPORTED" },
      { capability: "OBSERVE", status: "SUPPORTED" },
      { capability: "INTERRUPT", status: "NOT_PROVEN" },
      { capability: "CHECKPOINT", status: "NOT_PROVEN" },
      { capability: "RECONCILE", status: "NOT_PROVEN" },
      { capability: "RESUME", status: "NOT_PROVEN" },
      { capability: "CLOSE", status: "SUPPORTED" },
    ]);

    const start = await host.start(
      startAttemptRequestSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-start",
        fingerprint: fingerprintA,
        expectedTarget: { namespace: "workspace", reference: root },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        runId: "run_task6",
        attemptId: "att_task6-2",
        planRevisionId: "plan_task6",
        workspaceReference: root,
      }),
    );
    const prompt = "Change only result.txt to the exact accepted value.";
    const input = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-send",
      fingerprint: fingerprintB,
      expectedTarget: {
        namespace: "engine-handle",
        reference: start.handle.engineHandleId,
      },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: prompt,
    });
    const firstReceipt = await host.send(start.handle, input, {
      beforeExternalOperation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
    });
    const replayedReceipt = await host.send(start.handle, input, {
      beforeExternalOperation: () => {
        throw new Error("a replay must not re-authorize the external operation");
      },
    });
    expect(replayedReceipt).toEqual(firstReceipt);
    expect(processRuns).toBe(1);
    expect(authorizations).toBe(1);
    expect(await readFile(resultPath, "utf8")).toBe("READY\n");

    const observations = [];
    for await (const observation of host.observe(start.handle)) observations.push(observation);
    expect(observations.map((observation) => observation.kind)).toEqual([
      "OUTPUT_CAPTURED",
      "AGENT_RETURNED",
      "PROCESS_EXITED",
    ]);
    expect(observations[0]?.resourceUsage).toEqual({ outputBytes: 128 });
    expect(observations[1]?.resourceUsage).toEqual({
      externalOperations: 1,
      tokens: 165,
      costMinorUnits: 1,
    });
    expect(JSON.stringify({ firstReceipt, observations })).not.toContain(prompt);
  });

  it("does not treat test containment as qualified real-project process safety", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-qualified-gate-");
    cleanupRoots.push(root);
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: workspace,
          environment: {},
        }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          timedOut: false,
          framingValid: true,
          eventTypes: ["agent_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
          containment: "TEST_CONTAINED" as const,
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          leaseState: "RELEASED" as const,
        }),
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
      requireQualifiedProcess: true,
    });
    const start = await host.start(
      startAttemptRequestSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-qualified-start",
        fingerprint: fingerprintA,
        expectedTarget: { namespace: "workspace", reference: root },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        runId: "run_task6-qualified",
        attemptId: "att_task6-qualified",
        planRevisionId: "plan_task6-qualified",
        workspaceReference: root,
      }),
    );
    const receipt = await host.send(
      start.handle,
      engineInputSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-qualified-send",
        fingerprint: fingerprintB,
        expectedTarget: {
          namespace: "engine-handle",
          reference: start.handle.engineHandleId,
        },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        kind: "USER_INPUT",
        content: "qualified gate fixture",
      }),
    );
    expect(receipt).toMatchObject({ outcome: "UNKNOWN" });
  });

  it("reconciles only an exact qualified post-agent-end interruption as applied", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-recovery-");
    cleanupRoots.push(root);
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: [],
          cwd: workspace,
          environment: {},
        }),
      runProcess: (request) => {
        expect(request.forcedInterruption).toBe("AFTER_AGENT_END");
        return Promise.resolve({
          exitCode: 1,
          timedOut: false,
          framingValid: true,
          eventTypes: ["message_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
          interruption: "FORCED_PROCESS_KILL_AFTER_AGENT_END" as const,
          containment:
            process.platform === "win32"
              ? ("WINDOWS_JOB_OBJECT" as const)
              : ("LINUX_SUBREAPER_PROCESS_TREE" as const),
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          leaseState: "RELEASED" as const,
        });
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
      requireQualifiedProcess: true,
      forcedInterruption: "AFTER_AGENT_END",
    });
    const start = await host.start({
      schemaVersion: "1.0.0",
      operationId: "op_task6-recovery-start",
      fingerprint: fingerprintA,
      expectedTarget: { namespace: "workspace", reference: root },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      runId: "run_task6-recovery",
      attemptId: "att_task6-recovery",
      planRevisionId: "plan_task6-recovery",
      workspaceReference: root,
    });
    const send = await host.send(
      start.handle,
      engineInputSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-recovery-send",
        fingerprint: fingerprintB,
        expectedTarget: { namespace: "engine-handle", reference: start.handle.engineHandleId },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        kind: "USER_INPUT",
        content: "qualified recovery fixture",
      }),
    );
    expect(send).toMatchObject({ outcome: "UNKNOWN", observedEffects: [] });

    await expect(
      host.reconcile(
        reconcileOperationRequestSchema.parse({
          schemaVersion: "1.0.0",
          operationId: "op_task6-recovery-send",
          fingerprint: fingerprintB,
        }),
      ),
    ).resolves.toMatchObject({
      previousOutcome: "UNKNOWN",
      outcome: "APPLIED",
      observedEffects: ["qualified-agent-operation-returned-before-forced-process-finality"],
    });
  });

  it("does not consume a forced interruption when pre-send authorization rejects", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-auth-retry-");
    cleanupRoots.push(root);
    const forcedInterruptions: ProcessRequest["forcedInterruption"][] = [];
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: [],
          cwd: workspace,
          environment: {},
        }),
      runProcess: async (request, boundary) => {
        forcedInterruptions.push(request.forcedInterruption);
        await boundary?.beforeExternalOperation();
        return {
          exitCode: 1,
          timedOut: false,
          framingValid: true,
          eventTypes: ["message_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
          interruption: "FORCED_PROCESS_KILL_AFTER_AGENT_END" as const,
          containment:
            process.platform === "win32"
              ? ("WINDOWS_JOB_OBJECT" as const)
              : ("LINUX_SUBREAPER_PROCESS_TREE" as const),
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          leaseState: "RELEASED" as const,
        };
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
      requireQualifiedProcess: true,
      forcedInterruption: "AFTER_AGENT_END",
    });
    const start = await host.start({
      schemaVersion: "1.0.0",
      operationId: "op_task6-auth-retry-start",
      fingerprint: fingerprintA,
      expectedTarget: { namespace: "workspace", reference: root },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      runId: "run_task6-auth-retry",
      attemptId: "att_task6-auth-retry",
      planRevisionId: "plan_task6-auth-retry",
      workspaceReference: root,
    });
    const input = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-auth-retry-send",
      fingerprint: fingerprintB,
      expectedTarget: { namespace: "engine-handle", reference: start.handle.engineHandleId },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: "authorization retry fixture",
    });

    await expect(
      host.send(start.handle, input, {
        beforeExternalOperation: () => Promise.reject(new Error("authorization unavailable")),
      }),
    ).rejects.toThrow("authorization unavailable");
    await expect(
      host.send(start.handle, input, {
        beforeExternalOperation: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ outcome: "UNKNOWN" });
    expect(forcedInterruptions).toEqual(["AFTER_AGENT_END", "AFTER_AGENT_END"]);
  });

  it("stores an UNKNOWN tombstone when the process runner fails after authorization", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-post-boundary-");
    cleanupRoots.push(root);
    let processRuns = 0;
    let authorizations = 0;
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: [],
          cwd: workspace,
          environment: {},
        }),
      runProcess: async (_request, boundary) => {
        processRuns += 1;
        await boundary?.beforeExternalOperation();
        throw new Error("the process lost its final receipt after Provider authorization");
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
    });
    const start = await host.start({
      schemaVersion: "1.0.0",
      operationId: "op_task6-post-boundary-start",
      fingerprint: fingerprintA,
      expectedTarget: { namespace: "workspace", reference: root },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      runId: "run_task6-post-boundary",
      attemptId: "att_task6-post-boundary",
      planRevisionId: "plan_task6-post-boundary",
      workspaceReference: root,
    });
    const input = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-post-boundary-send",
      fingerprint: fingerprintB,
      expectedTarget: { namespace: "engine-handle", reference: start.handle.engineHandleId },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: "post-boundary failure fixture",
    });
    const boundary = {
      beforeExternalOperation: () => {
        authorizations += 1;
        return Promise.resolve();
      },
    };

    await expect(host.send(start.handle, input, boundary)).rejects.toThrow(
      "lost its final receipt",
    );
    await expect(host.send(start.handle, input, boundary)).resolves.toMatchObject({
      outcome: "UNKNOWN",
    });
    await expect(
      host.reconcile(
        reconcileOperationRequestSchema.parse({
          schemaVersion: "1.0.0",
          operationId: input.operationId,
          fingerprint: input.fingerprint,
        }),
      ),
    ).resolves.toMatchObject({ previousOutcome: "UNKNOWN", outcome: "UNKNOWN" });
    expect(processRuns).toBe(1);
    expect(authorizations).toBe(1);
  });

  it("coalesces an exact send that re-enters from the authorization callback", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-reentrant-send-");
    cleanupRoots.push(root);
    let processRuns = 0;
    let replayAuthorizations = 0;
    const forcedInterruptions: ProcessRequest["forcedInterruption"][] = [];
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: [],
          cwd: workspace,
          environment: {},
        }),
      runProcess: async (request, boundary) => {
        processRuns += 1;
        forcedInterruptions.push(request.forcedInterruption);
        await boundary?.beforeExternalOperation();
        return {
          exitCode: 1,
          timedOut: false,
          framingValid: true,
          eventTypes: ["message_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
          interruption: "FORCED_PROCESS_KILL_AFTER_AGENT_END" as const,
          containment:
            process.platform === "win32"
              ? ("WINDOWS_JOB_OBJECT" as const)
              : ("LINUX_SUBREAPER_PROCESS_TREE" as const),
          terminalFinality: "FINAL" as const,
          processTreeState: "EMPTY" as const,
          leaseState: "RELEASED" as const,
        };
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
      requireQualifiedProcess: true,
      forcedInterruption: "AFTER_AGENT_END",
    });
    const start = await host.start({
      schemaVersion: "1.0.0",
      operationId: "op_task6-reentrant-start",
      fingerprint: fingerprintA,
      expectedTarget: { namespace: "workspace", reference: root },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      runId: "run_task6-reentrant",
      attemptId: "att_task6-reentrant",
      planRevisionId: "plan_task6-reentrant",
      workspaceReference: root,
    });
    const input = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-reentrant-send",
      fingerprint: fingerprintB,
      expectedTarget: { namespace: "engine-handle", reference: start.handle.engineHandleId },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: "re-entrant authorization fixture",
    });
    let replay: Promise<unknown> | undefined;

    const first = host.send(start.handle, input, {
      beforeExternalOperation: () => {
        replay = host.send(start.handle, input, {
          beforeExternalOperation: () => {
            replayAuthorizations += 1;
            return Promise.resolve();
          },
        });
        return Promise.resolve();
      },
    });
    const firstReceipt = await first;
    if (replay === undefined) throw new Error("the authorization callback did not re-enter send");
    const replayReceipt = await replay;

    expect(replayReceipt).toEqual(firstReceipt);
    expect(processRuns).toBe(1);
    expect(replayAuthorizations).toBe(0);
    expect(forcedInterruptions).toEqual(["AFTER_AGENT_END"]);
  });

  it("rejects operation replay with a different payload even when the caller reuses the fingerprint", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-host-");
    cleanupRoots.push(root);
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: workspace,
          environment: {},
        }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          timedOut: false,
          framingValid: true,
          eventTypes: ["agent_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
        }),
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
    });
    const start = await host.start(
      startAttemptRequestSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-start",
        fingerprint: fingerprintA,
        expectedTarget: { namespace: "workspace", reference: root },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        runId: "run_task6",
        attemptId: "att_task6-2",
        planRevisionId: "plan_task6",
        workspaceReference: root,
      }),
    );
    const original = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-send",
      fingerprint: fingerprintB,
      expectedTarget: {
        namespace: "engine-handle",
        reference: start.handle.engineHandleId,
      },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: "first payload",
    });
    await host.send(start.handle, original);
    await expect(
      host.send(start.handle, { ...original, content: "different payload" }),
    ).rejects.toThrow(/replayed with a different fingerprint or payload/u);
  });

  it("coalesces an in-flight replay and rejects a conflicting payload before a second process starts", async () => {
    const Host = requireHostConstructor();
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-host-");
    cleanupRoots.push(root);
    let releaseProcess = (): void => {
      throw new Error("process gate was not initialized");
    };
    let reportProcessStarted = (): void => {
      throw new Error("process-start signal was not initialized");
    };
    const processGate = new Promise<void>((resolve) => {
      releaseProcess = resolve;
    });
    const processStarted = new Promise<void>((resolve) => {
      reportProcessStarted = resolve;
    });
    let processRuns = 0;
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: workspace,
          environment: {},
        }),
      runProcess: async () => {
        processRuns += 1;
        reportProcessStarted();
        await processGate;
        return {
          exitCode: 0,
          timedOut: false,
          framingValid: true,
          eventTypes: ["agent_end"],
          recordCount: 1,
          stdoutDigest: fingerprintA,
          stderrDigest: fingerprintB,
          capturedBytes: 16,
          outputTruncated: false,
          providerUsage: providerUsagePass,
        };
      },
      now: () => observedAt,
      processTimeoutMs: 30_000,
      maximumOutputBytes: 262_144,
    });
    const start = await host.start(
      startAttemptRequestSchema.parse({
        schemaVersion: "1.0.0",
        operationId: "op_task6-start",
        fingerprint: fingerprintA,
        expectedTarget: { namespace: "workspace", reference: root },
        deadline: "2026-08-04T00:01:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        runId: "run_task6",
        attemptId: "att_task6-2",
        planRevisionId: "plan_task6",
        workspaceReference: root,
      }),
    );
    const input = engineInputSchema.parse({
      schemaVersion: "1.0.0",
      operationId: "op_task6-send",
      fingerprint: fingerprintB,
      expectedTarget: {
        namespace: "engine-handle",
        reference: start.handle.engineHandleId,
      },
      deadline: "2026-08-04T00:01:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      kind: "USER_INPUT",
      content: "one bounded payload",
    });

    const first = host.send(start.handle, input);
    await processStarted;
    const replay = host.send(start.handle, input);
    const conflict = host.send(start.handle, { ...input, content: "conflicting payload" });
    await Promise.resolve();
    releaseProcess();
    const [firstResult, replayResult, conflictResult] = await Promise.allSettled([
      first,
      replay,
      conflict,
    ]);

    expect(processRuns).toBe(1);
    expect(firstResult.status).toBe("fulfilled");
    expect(replayResult).toEqual(firstResult);
    expect(conflictResult.status).toBe("rejected");
    if (conflictResult.status !== "rejected") {
      throw new Error("the conflicting replay unexpectedly fulfilled");
    }
    const conflictReason: unknown = conflictResult.reason;
    expect(conflictReason).toBeInstanceOf(Error);
    expect((conflictReason as Error).name).toBe("PiOperationReplayConflictError");
  });
});
