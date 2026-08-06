import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  engineInputSchema,
  probeRequestSchema,
  startAttemptRequestSchema,
} from "@hunter-pi/engine-contracts";
import * as piHostModule from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;
const observedAt = "2026-08-04T00:00:00.000Z";
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
  readonly containment?: "WINDOWS_JOB_OBJECT" | "LINUX_SUBREAPER_PROCESS_TREE" | "TEST_CONTAINED";
  readonly terminalFinality?: "FINAL" | "NOT_PROVEN";
  readonly processTreeState?: "EMPTY" | "ACTIVE" | "NOT_PROVEN";
  readonly leaseState?: "RELEASED" | "HELD" | "NOT_REQUIRED" | "NOT_PROVEN";
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
  send(handle: unknown, input: unknown): Promise<unknown>;
  observe(
    handle: unknown,
    cursor?: number,
  ): AsyncIterable<{
    readonly cursor: number;
    readonly kind: string;
    readonly summary?: string;
    readonly resourceUsage?: { readonly outputBytes?: number };
  }>;
}

type Task6HostConstructor = new (options: {
  readonly launchPlanForWorkspace: (workspace: string) => Promise<PiLaunchPlan>;
  readonly runProcess: (request: ProcessRequest) => Promise<ProcessResult>;
  readonly now: () => string;
  readonly processTimeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly requireQualifiedProcess?: boolean;
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
    const host = new Host({
      launchPlanForWorkspace: (workspace) =>
        Promise.resolve({
          executable: process.execPath,
          arguments: ["pi-cli.js"],
          cwd: workspace,
          environment: { HUNTER_PI_MODE: "MANAGED" },
        }),
      runProcess: async (request) => {
        processRuns += 1;
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
    const firstReceipt = await host.send(start.handle, input);
    const replayedReceipt = await host.send(start.handle, input);
    expect(replayedReceipt).toEqual(firstReceipt);
    expect(processRuns).toBe(1);
    expect(await readFile(resultPath, "utf8")).toBe("READY\n");

    const observations = [];
    for await (const observation of host.observe(start.handle)) observations.push(observation);
    expect(observations.map((observation) => observation.kind)).toEqual([
      "OUTPUT_CAPTURED",
      "AGENT_RETURNED",
      "PROCESS_EXITED",
    ]);
    expect(observations[0]?.resourceUsage).toEqual({ outputBytes: 128 });
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
