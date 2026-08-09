import { readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineHost } from "@hunter-pi/engine-contracts";
import * as managedChangeModule from "@hunter-pi/managed-change";
import { Task6PiEngineHost } from "@hunter-pi/pi-host";
import { fixturePiProviderUsage } from "./support/pi-provider-usage-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;
const sourceCommit = "c".repeat(40);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

interface Task6Artifact {
  readonly schemaVersion: "hpi-task6-managed-change.v1";
  readonly taskResult: "GO" | "REVISE" | "STOP";
  readonly provider: {
    readonly id: string;
    readonly authStatus: "DETECTED";
    readonly requestStatus: "DETECTED" | "BLOCKED" | "NOT_PROVEN";
  };
  readonly fixture: {
    readonly fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY";
    readonly includePaths: readonly string[];
    readonly excludePaths: readonly string[];
  };
  readonly lifecycleAfterAgentReturn: string;
  readonly projection: {
    readonly change: { readonly lifecycle: string };
    readonly attempts: readonly {
      readonly attemptId: string;
      readonly sequence: number;
      readonly executionStatus: string;
      readonly verificationStatus: string;
    }[];
    readonly verificationReceipts: readonly {
      readonly attemptId: string;
      readonly outcome: string;
    }[];
    readonly reviewReceipts: readonly {
      readonly findings: readonly { readonly severity: string; readonly scope: string }[];
    }[];
    readonly checks: readonly { readonly checkId: string; readonly status: string }[];
  };
  readonly finalSummary: {
    readonly attempts: readonly string[];
    readonly checks: readonly string[];
    readonly blockingFindings: readonly string[];
    readonly unresolvedRisks: readonly string[];
  };
  readonly resourceAccounting: {
    readonly status: "PASS" | "NOT_PROVEN" | "EXCEEDED";
    readonly budgets: {
      readonly maxAgentTurns: number;
      readonly maxExternalOperations: number;
      readonly maxCommands: number;
      readonly maxOutputBytes: number;
    };
    readonly captureLimits: {
      readonly engine: number;
      readonly verificationAttempt1: number;
      readonly verificationAttempt2: number;
    };
    readonly capturedOutputBytes: {
      readonly engine?: number;
      readonly verificationAttempt1: number;
      readonly verificationAttempt2: number;
    };
    readonly consumed: {
      readonly agentTurns: number;
      readonly externalOperations: number;
      readonly commands: number;
      readonly outputBytes?: number;
    };
    readonly unprovenReasons: readonly string[];
  };
  readonly scorecard: {
    readonly zeroFalseReady: boolean;
    readonly sourceLoss: boolean;
    readonly secretLeak: boolean;
    readonly failedAttemptPreserved: boolean;
    readonly fixbackPass: boolean;
    readonly unplannedInterventions: number;
    readonly overheadWithinLimit: boolean;
    readonly summaryComplete: boolean;
    readonly resourceBudgetReconciled: boolean;
  };
  readonly cleanup: { readonly status: "PASS" | "BLOCKED" };
  readonly remoteCi: "PENDING";
}

type RunTask6 = (options: {
  readonly parentDirectory: string;
  readonly engineHost: EngineHost;
  readonly productSource: {
    readonly commit: string;
    readonly state: "CLEAN" | "DIRTY";
  };
  readonly engineRelease: {
    readonly packageName: string;
    readonly version: string;
  };
  readonly providerId: string;
  readonly environmentFingerprint: string;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}) => Promise<Task6Artifact>;

function requireRunner(): RunTask6 {
  const value: unknown = Reflect.get(managedChangeModule, "runTask6ManagedChange");
  expect(value, "runTask6ManagedChange must be exported").toBeTypeOf("function");
  return value as RunTask6;
}

function createHost(
  mutation: (workspace: string) => Promise<void>,
  capturedBytes = 128,
): Task6PiEngineHost {
  return new Task6PiEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve({
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: workspace,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      }),
    runProcess: async (request) => {
      await mutation(request.plan.cwd);
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: fingerprintA,
        stderrDigest: fingerprintB,
        capturedBytes,
        outputTruncated: false,
        providerUsage: fixturePiProviderUsage,
      };
    },
    now: () => "2026-08-04T00:00:10.000Z",
    processTimeoutMs: 30_000,
    maximumOutputBytes: 229_376,
  });
}

function withoutEngineOutputMeasurement(host: EngineHost): EngineHost {
  return {
    probe: (request) => host.probe(request),
    start: (request) => host.start(request),
    send: (handle, input) => host.send(handle, input),
    observe: async function* (handle, cursor) {
      for await (const observation of host.observe(handle, cursor)) {
        if (observation.kind !== "OUTPUT_CAPTURED") {
          yield observation;
          continue;
        }
        yield {
          schemaVersion: observation.schemaVersion,
          cursor: observation.cursor,
          attemptId: observation.attemptId,
          kind: observation.kind,
          observedAt: observation.observedAt,
          ...(observation.summary === undefined ? {} : { summary: observation.summary }),
        };
      }
    },
    interrupt: (handle, request) => host.interrupt(handle, request),
    checkpoint: (handle, request) => host.checkpoint(handle, request),
    reconcile: (request) => host.reconcile(request),
    close: (handle, request) => host.close(handle, request),
  };
}

async function runWithHost(parentDirectory: string, host: EngineHost): Promise<Task6Artifact> {
  const runTask6 = requireRunner();
  let monotonic = 0;
  return runTask6({
    parentDirectory,
    engineHost: host,
    productSource: { commit: sourceCommit, state: "CLEAN" },
    engineRelease: {
      packageName: "@earendil-works/pi-coding-agent",
      version: "0.83.0",
    },
    providerId: "openai-codex",
    environmentFingerprint: fingerprintA,
    now: () => "2026-08-04T00:00:10.000Z",
    monotonicNow: () => {
      monotonic += 1;
      return monotonic;
    },
  });
}

describe("Task 6 Managed Change runner", () => {
  it("preserves the failed Attempt, treats Agent return as an Observation, then reaches READY only after verification and review", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-runner-");
    cleanupRoots.push(parent);
    const artifact = await runWithHost(
      parent,
      createHost((workspace) => writeFile(join(workspace, "result.txt"), "READY\n", "utf8")),
    );

    expect(artifact).toMatchObject({
      schemaVersion: "hpi-task6-managed-change.v1",
      taskResult: "GO",
      provider: {
        id: "openai-codex",
        authStatus: "DETECTED",
        requestStatus: "DETECTED",
      },
      fixture: {
        fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
        includePaths: ["result.txt"],
        excludePaths: ["scratch.txt"],
      },
      lifecycleAfterAgentReturn: "VERIFYING",
      cleanup: { status: "PASS" },
      remoteCi: "PENDING",
    });
    expect(artifact.projection.change.lifecycle).toBe("READY");
    expect(artifact.projection.attempts).toMatchObject([
      {
        attemptId: "att_task6-1",
        sequence: 1,
        executionStatus: "INCOMPLETE",
        verificationStatus: "FAILED",
      },
      {
        attemptId: "att_task6-2",
        sequence: 2,
        executionStatus: "RETURNED",
        verificationStatus: "PASSED",
      },
    ]);
    expect(artifact.projection.verificationReceipts.map((receipt) => receipt.outcome)).toEqual([
      "FAIL",
      "PASS",
    ]);
    expect(artifact.projection.checks).toEqual([
      { schemaVersion: "1.0.0", checkId: "check_task6-result", required: true, status: "PASS" },
    ]);
    expect(artifact.projection.reviewReceipts).toHaveLength(1);
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
      resourceBudgetReconciled: true,
    });
    expect(artifact.resourceAccounting).toEqual({
      status: "PASS",
      budgets: {
        maxAgentTurns: 1,
        maxExternalOperations: 4,
        maxCommands: 2,
        maxOutputBytes: 262_144,
      },
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
    });
    expect(artifact.finalSummary.attempts).toHaveLength(2);
    expect(artifact.finalSummary.checks).toEqual(["check_task6-result:PASS"]);
    expect(artifact.finalSummary.blockingFindings).toEqual([]);
    expect(JSON.stringify(artifact)).not.toContain(parent);
    expect(await readdir(parent)).toEqual([]);
  });

  it("keeps a passing command check out of READY when deterministic review finds an extra mutation", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-runner-");
    cleanupRoots.push(parent);
    const artifact = await runWithHost(
      parent,
      createHost(async (workspace) => {
        await Promise.all([
          writeFile(join(workspace, "result.txt"), "READY\n", "utf8"),
          writeFile(join(workspace, "unexpected.txt"), "unexpected\n", "utf8"),
        ]);
      }),
    );

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.projection.change.lifecycle).toBe("FAILED");
    expect(artifact.projection.verificationReceipts.at(-1)?.outcome).toBe("PASS");
    expect(artifact.projection.reviewReceipts[0]?.findings).toMatchObject([
      { severity: "P1", scope: "workspace-dirty-paths" },
    ]);
    expect(artifact.finalSummary.blockingFindings).toEqual(["P1:workspace-dirty-paths"]);
    expect(artifact.scorecard.zeroFalseReady).toBe(true);
    expect(artifact.scorecard.fixbackPass).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain(parent);
    expect(await readdir(parent)).toEqual([]);
  });

  it("stops instead of claiming READY when cumulative captured output exceeds the Run budget", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-runner-");
    cleanupRoots.push(parent);
    const artifact = await runWithHost(
      parent,
      createHost(
        (workspace) => writeFile(join(workspace, "result.txt"), "READY\n", "utf8"),
        262_130,
      ),
    );

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.resourceAccounting.status).toBe("EXCEEDED");
    expect(artifact.resourceAccounting.consumed.outputBytes).toBeGreaterThan(262_144);
    expect(artifact.scorecard.resourceBudgetReconciled).toBe(false);
    expect(artifact.projection.change.lifecycle).not.toBe("READY");
    expect(artifact.finalSummary.blockingFindings).toContain("P1:resource-budget");
    expect(await readdir(parent)).toEqual([]);
  });

  it("records NOT_PROVEN and stops when the Engine omits its output-byte measurement", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-runner-");
    cleanupRoots.push(parent);
    const artifact = await runWithHost(
      parent,
      withoutEngineOutputMeasurement(
        createHost((workspace) => writeFile(join(workspace, "result.txt"), "READY\n", "utf8")),
      ),
    );

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.resourceAccounting.status).toBe("NOT_PROVEN");
    expect(artifact.resourceAccounting.unprovenReasons).toEqual(["ENGINE_OUTPUT_BYTES_MISSING"]);
    expect(artifact.resourceAccounting.consumed.outputBytes).toBeUndefined();
    expect(artifact.projection.change.lifecycle).not.toBe("READY");
    expect(artifact.finalSummary.blockingFindings).toContain("P1:resource-budget");
    expect(await readdir(parent)).toEqual([]);
  });
});
