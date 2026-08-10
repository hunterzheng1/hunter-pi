import { describe, expect, it } from "vitest";

import {
  PilotPlanCompiler,
  createPilotRepositoryTargetReceipt,
  pilotExecutionPlanV3Schema,
  pilotExecutionPlanSchema,
  pilotFingerprint,
  pilotPlanInputSchema,
  pilotPlanInputV3Schema,
  pilotPreflightReceiptSchema,
  pilotRepositoryTargetReceiptSchema,
  type PilotPlanInput,
} from "@hunter-pi/pilot";

import { completePilotPlanInput, secondSourceFingerprint } from "./support/task12-plan-fixture.js";

describe("Task 12 pilot plan compiler", () => {
  it("creates a path-free target receipt from a clean explicit repository identity", () => {
    const receipt = createPilotRepositoryTargetReceipt({
      targetId: "repository-alpha",
      canonicalRepositoryIdentity: "C:\\private\\operator-repository",
      branch: "main",
      baseCommit: "a".repeat(40),
      baseTree: "b".repeat(40),
      dirty: false,
    });

    expect(receipt).toMatchObject({
      schemaVersion: "hpi-pilot-repository-target.v1",
      status: "READY",
      targetId: "repository-alpha",
      selectionMode: "EXPLICIT_OPERATOR_SELECTED",
      reasons: ["PILOT_TARGET_SCOPE_FROZEN"],
    });
    expect(receipt.repositoryFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.targetReferenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("C:\\private");
    expect(() => pilotRepositoryTargetReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("blocks a dirty target without emitting any repository identity", () => {
    const receipt = createPilotRepositoryTargetReceipt({
      targetId: "repository-alpha",
      canonicalRepositoryIdentity: "C:\\private\\operator-repository",
      branch: "main",
      baseCommit: "a".repeat(40),
      baseTree: "b".repeat(40),
      dirty: true,
    });

    expect(receipt).toMatchObject({
      status: "BLOCKED",
      reasons: ["PILOT_TARGET_DIRTY"],
      repositoryFingerprint: null,
      sourceFingerprint: null,
      targetReferenceFingerprint: null,
    });
    expect(JSON.stringify(receipt)).not.toContain("C:\\private");
  });

  it("rejects a target receipt that combines a frozen scope with another reason", () => {
    expect(() =>
      pilotRepositoryTargetReceiptSchema.parse({
        schemaVersion: "hpi-pilot-repository-target.v1",
        status: "READY",
        targetId: "repository-alpha",
        selectionMode: "EXPLICIT_OPERATOR_SELECTED",
        repositoryFingerprint: `sha256:${"a".repeat(64)}`,
        sourceFingerprint: `sha256:${"b".repeat(64)}`,
        targetReferenceFingerprint: `sha256:${"c".repeat(64)}`,
        reasons: ["PILOT_TARGET_SCOPE_FROZEN", "PILOT_TARGET_DIRTY"],
      }),
    ).toThrow(/one fixed reason|scope/u);
  });

  it("freezes explicit targets and tasks without carrying paths or credentials into the plan", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());

    expect(plan.schemaVersion).toBe("hpi-pilot-execution-plan.v4");
    expect(plan.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.repositoryTargets).toHaveLength(2);
    expect(plan.tasks).toHaveLength(10);
    expect(JSON.stringify(plan)).not.toContain("C:\\");
    expect(JSON.stringify(plan)).not.toMatch(/api[_-]?key\s*=|token\s*=|password\s*=/iu);
  });

  it("keeps Quick observations separate from Managed outcomes and freezes task definitions", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());
    const quickTasks = plan.tasks.filter((task) => task.mode === "QUICK");
    const managedTasks = plan.tasks.filter((task) => task.mode === "MANAGED");

    expect(quickTasks.length).toBeGreaterThan(0);
    expect(managedTasks.length).toBeGreaterThan(0);
    expect(
      plan.tasks.every((task) => /^sha256:[a-f0-9]{64}$/u.test(task.taskDefinitionFingerprint)),
    ).toBe(true);
    expect(quickTasks.every((task) => !("expectedOutcome" in task))).toBe(true);
    expect(managedTasks.every((task) => task.expectedOutcome === "READY")).toBe(true);
  });

  it("rejects a current plan task that cannot execute through the one-check runtime", () => {
    const input = completePilotPlanInput();
    const firstTask = input.tasks[0];
    const secondCheck = input.acceptanceChecks[1];
    if (firstTask === undefined || secondCheck === undefined) {
      throw new Error("pilot one-check fixture is incomplete");
    }

    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        tasks: [
          {
            ...firstTask,
            acceptanceCheckIds: [...firstTask.acceptanceCheckIds, secondCheck.checkId],
          },
          ...input.tasks.slice(1),
        ],
      }),
    ).toThrow(/exactly one|acceptance check/u);
  });

  it("preserves plural-check replay for historical v3 plans while current v4 rejects it", () => {
    const input = completePilotPlanInput();
    const firstTask = input.tasks[0];
    const secondCheck = input.acceptanceChecks[1];
    if (firstTask === undefined || secondCheck === undefined) {
      throw new Error("pilot historical-plan fixture is incomplete");
    }
    const { schemaVersion, deliberateFixbackTaskId, ...currentBody } = input;
    expect(schemaVersion).toBe("hpi-pilot-plan-input.v4");
    const historicalBody = {
      ...currentBody,
      tasks: [
        {
          ...firstTask,
          acceptanceCheckIds: [...firstTask.acceptanceCheckIds, secondCheck.checkId],
        },
        ...input.tasks.slice(1),
      ],
    };

    expect(() =>
      pilotPlanInputV3Schema.parse({
        schemaVersion: "hpi-pilot-plan-input.v3",
        ...historicalBody,
      }),
    ).not.toThrow();
    expect(() =>
      pilotExecutionPlanV3Schema.parse({
        schemaVersion: "hpi-pilot-execution-plan.v3",
        ...historicalBody,
        planFingerprint: pilotFingerprint(historicalBody),
      }),
    ).not.toThrow();
    expect(() =>
      pilotPlanInputSchema.parse({
        schemaVersion: "hpi-pilot-plan-input.v4",
        ...historicalBody,
        deliberateFixbackTaskId,
      }),
    ).toThrow(/exactly one|acceptance check/u);
  });

  it("freezes three distinct interruption scenarios onto Managed tasks only", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());
    const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));

    expect(plan.interruptionTasks).toHaveLength(3);
    expect(new Set(plan.interruptionTasks.map((item) => item.interruptionId)).size).toBe(3);
    expect(new Set(plan.interruptionTasks.map((item) => item.kind))).toEqual(
      new Set(["FORCED_PROCESS_KILL", "TERMINAL_CLOSE_SIMULATION", "POWER_LOSS_SIMULATION"]),
    );
    expect(
      plan.interruptionTasks.every((item) => taskById.get(item.taskId)?.mode === "MANAGED"),
    ).toBe(true);
  });

  it("freezes one paired Managed fixback task outside interruption recovery", () => {
    const input = completePilotPlanInput();
    const plan = new PilotPlanCompiler().compile(input);

    expect(plan.deliberateFixbackTaskId).toBe("pilot-task-04");
    expect(plan.pairedTaskIds).toContain(plan.deliberateFixbackTaskId);
    expect(plan.tasks.find((task) => task.taskId === plan.deliberateFixbackTaskId)?.mode).toBe(
      "MANAGED",
    );
    expect(plan.interruptionTasks.map((item) => item.taskId)).not.toContain(
      plan.deliberateFixbackTaskId,
    );

    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        deliberateFixbackTaskId: "pilot-task-01",
      }),
    ).toThrow(/fixback|Managed/u);
    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        deliberateFixbackTaskId: "pilot-task-02",
        pairedTaskIds: ["pilot-task-01", "pilot-task-02", "pilot-task-07"],
      }),
    ).toThrow(/fixback|interruption/u);
  });

  it("fails closed when repository selection is implicit", () => {
    const input = completePilotPlanInput();
    const implicitInput = {
      ...input,
      repositoryTargets: input.repositoryTargets.map((target, index) =>
        index === 0 ? { ...target, selectionMode: "IMPLICIT" as const } : target,
      ),
    } as unknown as PilotPlanInput;
    expect(() => new PilotPlanCompiler().compile(implicitInput)).toThrow(
      /EXPLICIT_OPERATOR_SELECTED|implicit/u,
    );
  });

  it("requires acknowledged Provider scope and binds every task to its selected target", () => {
    const input = completePilotPlanInput();
    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        operatorScope: { ...input.operatorScope, acknowledged: false },
      }),
    ).toThrow(/Provider|acknowledg/u);

    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        tasks: input.tasks.map((task, index) =>
          index === 0 ? { ...task, sourceFingerprint: secondSourceFingerprint } : task,
        ),
      }),
    ).toThrow(/target|source|bind/u);
  });

  it("requires exactly ten frozen tasks and three paired tasks", () => {
    const input = completePilotPlanInput();
    expect(() =>
      new PilotPlanCompiler().compile({ ...input, tasks: input.tasks.slice(0, 9) }),
    ).toThrow(/10|ten|length/u);
    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        pairedTaskIds: [...input.pairedTaskIds, "pilot-task-08"],
      }),
    ).toThrow(/3|three|length/u);
  });

  it("derives a stable plan fingerprint from the frozen plan body", () => {
    const compiler = new PilotPlanCompiler();
    const first = compiler.compile(completePilotPlanInput());
    const second = compiler.compile({
      ...completePilotPlanInput(),
      tasks: [...completePilotPlanInput().tasks].reverse().reverse(),
    });
    expect(second.planFingerprint).toBe(first.planFingerprint);
  });

  it("returns a safe blocked preflight without echoing invalid input", () => {
    const input = {
      ...completePilotPlanInput(),
      privatePath: "C:\\Users\\operator\\secret-repository",
      credential: "token=do-not-echo",
      operatorScope: { ...completePilotPlanInput().operatorScope, acknowledged: false },
    } as unknown;
    const receipt = new PilotPlanCompiler().preflight(input);

    expect(receipt.status).toBe("BLOCKED");
    expect(receipt.planFingerprint).toBeNull();
    expect(receipt.reasons.some((reason) => reason.startsWith("PILOT_PLAN_"))).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("C:\\Users");
    expect(JSON.stringify(receipt)).not.toContain("do-not-echo");
  });

  it("returns READY only with the exact frozen plan fingerprint", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());
    const receipt = new PilotPlanCompiler().preflight(completePilotPlanInput());

    expect(receipt.status).toBe("READY");
    expect(receipt.planFingerprint).toBe(plan.planFingerprint);
  });

  it("freezes the acceptance, comparator, plugin, update, and machine inputs", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());

    expect(plan.machineProfile.sourceFingerprint).toBe(plan.sourceFingerprint);
    expect(plan.acceptanceChecks).toHaveLength(10);
    expect(plan.comparatorConfigurationFingerprint).toMatch(/^sha256:/u);
    expect(plan.workflowFactChecklistFingerprint).toMatch(/^sha256:/u);
    expect(plan.pluginFixtures).toHaveLength(5);
    expect(plan.updateCandidates).toHaveLength(2);
  });

  it("requires two distinct repository identities rather than two aliases", () => {
    const input = completePilotPlanInput();
    expect(() =>
      new PilotPlanCompiler().compile({
        ...input,
        repositoryTargets: input.repositoryTargets.map((target) => ({
          ...target,
          repositoryFingerprint:
            input.repositoryTargets[0]?.repositoryFingerprint ?? target.repositoryFingerprint,
        })),
      }),
    ).toThrow(/distinct repository/u);
  });

  it("rejects contradictory preflight receipt states", () => {
    expect(() =>
      pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "READY",
        planFingerprint: null,
        reasons: ["PILOT_PLAN_SCOPE_FROZEN"],
      }),
    ).toThrow();
    expect(() =>
      pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: `sha256:${"a".repeat(64)}`,
        reasons: ["PILOT_PLAN_TARGETS_INVALID"],
      }),
    ).toThrow();
    expect(() =>
      pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["C:\\Users\\operator\\secret-plan.json"],
      }),
    ).toThrow();
  });

  it("rejects an execution plan whose fingerprint no longer matches its frozen body", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());
    expect(() =>
      pilotExecutionPlanSchema.parse({
        ...plan,
        operatorScope: { ...plan.operatorScope, workspacePolicy: "DISPOSABLE_PILOT_WORKTREES" },
        tasks: plan.tasks.map((task, index) =>
          index === 1 && task.mode === "MANAGED"
            ? { ...task, expectedOutcome: "BLOCKED" as const }
            : task,
        ),
      }),
    ).toThrow(/fingerprint/u);
  });
});
