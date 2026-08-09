import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planRevisionSchema, type PlanRevision } from "@hunter-pi/domain";
import {
  captureTask6QuickSessionPromotion,
  createTask6DisposableFixture,
  removeTask6DisposableFixture,
  type Task6DisposableFixture,
  type Task6QuickSessionPromotion,
} from "@hunter-pi/managed-change";
import * as verificationModule from "@hunter-pi/verification";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

interface VerificationResult {
  readonly receipt: {
    readonly verificationReceiptId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly checkId: string;
    readonly checkDefinitionFingerprint: string;
    readonly configFingerprint: string;
    readonly workspaceFingerprint: string;
    readonly sourceFingerprint: string;
    readonly inputFingerprint: string;
    readonly outcome: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN";
    readonly resultStatus: {
      readonly kind: "EXIT_CODE";
      readonly exitCode: number;
      readonly timedOut: boolean;
    };
    readonly output: {
      readonly stdoutDigest: string;
      readonly stderrDigest: string;
      readonly capturedBytes: number;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
    };
  };
}

type RunVerification = (request: {
  readonly planRevision: PlanRevision;
  readonly runId: string;
  readonly attemptId: string;
  readonly checkId: string;
  readonly verificationReceiptId: string;
  readonly evidenceId: string;
  readonly repository: string;
  readonly environmentFingerprint: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly now?: () => string;
}) => Promise<VerificationResult>;

const cleanupRoots: string[] = [];
const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function requireRunVerification(): RunVerification {
  const value: unknown = Reflect.get(verificationModule, "runDeclaredCommandVerification");
  expect(value, "runDeclaredCommandVerification must be exported").toBeTypeOf("function");
  return value as RunVerification;
}

function createPlan(
  promotion: Task6QuickSessionPromotion,
  definition?: {
    readonly executable: string;
    readonly argv: readonly string[];
  },
): PlanRevision {
  return planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: "plan_task6",
    changeId: "chg_task6",
    revision: 1,
    workspaceId: "workspace_task6",
    workspaceFingerprint: promotion.workspaceFingerprint,
    sourceFingerprint: promotion.sourceFingerprint,
    goal: "Make the disposable result pass its declared check",
    nonGoals: ["Mutate a real repository"],
    constraints: ["Only result.txt may change"],
    steps: [
      {
        stepId: "step_task6-agent",
        kind: "agent",
        title: "Fix the disposable result",
        dependsOn: [],
        required: true,
        inputContractFingerprint: fingerprintA,
        outputContractFingerprint: fingerprintB,
      },
    ],
    checks: [
      {
        checkId: "check_task6-result",
        version: 1,
        label: "Disposable result check",
        kind: "command",
        required: true,
        definition: {
          executable: definition?.executable ?? "node",
          argv: definition?.argv ?? ["verify.mjs"],
          workingDirectoryReference: "fixture-repository",
        },
        definitionFingerprint: fingerprintA,
        configurationFingerprint: fingerprintB,
      },
    ],
    loopPolicy: {
      maxIterations: 2,
      maxElapsedMs: 600_000,
      repeatedFailureLimit: 2,
      resourceBudgets: {
        maxAgentTurns: 1,
        maxExternalOperations: 4,
        maxCommands: 2,
        maxOutputBytes: 262_144,
      },
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt: "2026-08-04T00:00:00.000Z",
  });
}

async function createPromotedFixture(): Promise<{
  readonly fixture: Task6DisposableFixture;
  readonly promotion: Task6QuickSessionPromotion;
}> {
  const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-verifier-test-");
  cleanupRoots.push(parent);
  const fixture = await createTask6DisposableFixture(parent);
  const promotion = await captureTask6QuickSessionPromotion(fixture, {
    includePaths: ["result.txt"],
    excludePaths: ["scratch.txt"],
  });
  return { fixture, promotion };
}

describe("independent command verifier", () => {
  it("binds the deliberate failure and later pass to exact check, source, and input identities", async () => {
    const runVerification = requireRunVerification();
    const { fixture, promotion } = await createPromotedFixture();
    const planRevision = createPlan(promotion);
    const times = [
      "2026-08-04T00:00:01.000Z",
      "2026-08-04T00:00:02.000Z",
      "2026-08-04T00:00:03.000Z",
      "2026-08-04T00:00:04.000Z",
    ];
    const now = (): string => times.shift() ?? "2026-08-04T00:00:05.000Z";

    const failed = await runVerification({
      planRevision,
      runId: "run_task6",
      attemptId: "att_task6-1",
      checkId: "check_task6-result",
      verificationReceiptId: "verify_task6-1",
      evidenceId: "evidence_task6-1",
      repository: fixture.repository,
      environmentFingerprint: fingerprintA,
      timeoutMs: 5_000,
      maximumOutputBytes: 4_096,
      now,
    });
    expect(failed.receipt).toMatchObject({
      outcome: "FAIL",
      resultStatus: { kind: "EXIT_CODE", exitCode: 1, timedOut: false },
      checkDefinitionFingerprint: fingerprintA,
      configFingerprint: fingerprintB,
      workspaceFingerprint: promotion.workspaceFingerprint,
      sourceFingerprint: promotion.sourceFingerprint,
    });
    expect(JSON.stringify(failed)).not.toContain("RESULT_NOT_READY");

    await writeFile(join(fixture.repository, "result.txt"), "READY\n", "utf8");
    const passed = await runVerification({
      planRevision,
      runId: "run_task6",
      attemptId: "att_task6-2",
      checkId: "check_task6-result",
      verificationReceiptId: "verify_task6-2",
      evidenceId: "evidence_task6-2",
      repository: fixture.repository,
      environmentFingerprint: fingerprintA,
      timeoutMs: 5_000,
      maximumOutputBytes: 4_096,
      now,
    });
    expect(passed.receipt).toMatchObject({
      outcome: "PASS",
      resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
    });
    expect(passed.receipt.inputFingerprint).not.toBe(failed.receipt.inputFingerprint);
    expect(passed.receipt.output.stdoutDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(passed.receipt.output.stderrDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    await removeTask6DisposableFixture(fixture);
  });

  it("fails closed for an undeclared check and bounds captured output", async () => {
    const runVerification = requireRunVerification();
    const { fixture, promotion } = await createPromotedFixture();
    const planRevision = createPlan(promotion, {
      executable: "node",
      argv: ["-e", "process.stdout.write('x'.repeat(1024))"],
    });

    await expect(
      runVerification({
        planRevision,
        runId: "run_task6",
        attemptId: "att_task6-1",
        checkId: "check_unknown",
        verificationReceiptId: "verify_task6-1",
        evidenceId: "evidence_task6-1",
        repository: fixture.repository,
        environmentFingerprint: fingerprintA,
        timeoutMs: 5_000,
        maximumOutputBytes: 32,
      }),
    ).rejects.toThrow(/not declared/u);

    const bounded = await runVerification({
      planRevision,
      runId: "run_task6",
      attemptId: "att_task6-1",
      checkId: "check_task6-result",
      verificationReceiptId: "verify_task6-1",
      evidenceId: "evidence_task6-1",
      repository: fixture.repository,
      environmentFingerprint: fingerprintA,
      timeoutMs: 5_000,
      maximumOutputBytes: 32,
    });
    expect(bounded.receipt.outcome).toBe("PASS");
    expect(bounded.receipt.output).toMatchObject({
      capturedBytes: 32,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
  });

  it("accepts the provider-neutral workspace-root working-directory reference for a real project", async () => {
    const runVerification = requireRunVerification();
    const { fixture, promotion } = await createPromotedFixture();
    const planRevision = planRevisionSchema.parse({
      ...createPlan(promotion),
      checks: [
        {
          ...createPlan(promotion).checks[0],
          definition: {
            ...createPlan(promotion).checks[0]?.definition,
            workingDirectoryReference: "workspace-root",
          },
        },
      ],
    });

    const result = await runVerification({
      planRevision,
      runId: "run_task6",
      attemptId: "att_task6-1",
      checkId: "check_task6-result",
      verificationReceiptId: "verify_task6-workspace-root",
      evidenceId: "evidence_task6-workspace-root",
      repository: fixture.repository,
      environmentFingerprint: fingerprintA,
      timeoutMs: 5_000,
      maximumOutputBytes: 4_096,
    });

    expect(result.receipt.outcome).toBe("FAIL");
    expect(result.receipt.workspaceFingerprint).toBe(promotion.workspaceFingerprint);
  });

  it("launches the npm command shim through Node on Windows", async () => {
    const runVerification = requireRunVerification();
    const { fixture, promotion } = await createPromotedFixture();
    const planRevision = createPlan(promotion, {
      executable: "npm",
      argv: ["--version"],
    });

    const result = await runVerification({
      planRevision,
      runId: "run_task6",
      attemptId: "att_task6-1",
      checkId: "check_task6-result",
      verificationReceiptId: "verify_task6-npm",
      evidenceId: "evidence_task6-npm",
      repository: fixture.repository,
      environmentFingerprint: fingerprintA,
      timeoutMs: 5_000,
      maximumOutputBytes: 4_096,
    });

    expect(result.receipt.outcome).toBe("PASS");
  });
});
