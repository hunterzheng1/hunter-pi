import { describe, expect, it } from "vitest";

import {
  PilotPlanCompiler,
  pilotExecutionPlanSchema,
  pilotPreflightReceiptSchema,
  type PilotPlanInput,
} from "@hunter-pi/pilot";

import { completePilotPlanInput, secondSourceFingerprint } from "./support/task12-plan-fixture.js";

describe("Task 12 pilot plan compiler", () => {
  it("freezes explicit targets and tasks without carrying paths or credentials into the plan", () => {
    const plan = new PilotPlanCompiler().compile(completePilotPlanInput());

    expect(plan.schemaVersion).toBe("hpi-pilot-execution-plan.v1");
    expect(plan.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.repositoryTargets).toHaveLength(2);
    expect(plan.tasks).toHaveLength(10);
    expect(JSON.stringify(plan)).not.toContain("C:\\");
    expect(JSON.stringify(plan)).not.toMatch(/api[_-]?key\s*=|token\s*=|password\s*=/iu);
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
          index === 0 ? { ...task, expectedOutcome: "BLOCKED" as const } : task,
        ),
      }),
    ).toThrow(/fingerprint/u);
  });
});
