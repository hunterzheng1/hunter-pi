import { describe, expect, it } from "vitest";

import { PilotPlanCompiler, pilotExecutionPlanSchema, type PilotPlanInput } from "@hunter-pi/pilot";

import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";

const firstRepositoryFingerprint = `sha256:${"a".repeat(64)}`;
const secondRepositoryFingerprint = `sha256:${"b".repeat(64)}`;
const firstSourceFingerprint = `sha256:${"c".repeat(64)}`;
const secondSourceFingerprint = `sha256:${"d".repeat(64)}`;
const artifactFingerprint = `sha256:${"e".repeat(64)}`;
const engineFingerprint = `sha256:${"f".repeat(64)}`;

function completePlanInput(): PilotPlanInput {
  const repositoryTargets = [
    {
      targetId: "repository-alpha",
      repositoryFingerprint: firstRepositoryFingerprint,
      sourceFingerprint: firstSourceFingerprint,
      targetReferenceFingerprint: `sha256:${"1".repeat(64)}`,
      selectionMode: "EXPLICIT_OPERATOR_SELECTED" as const,
    },
    {
      targetId: "repository-beta",
      repositoryFingerprint: secondRepositoryFingerprint,
      sourceFingerprint: secondSourceFingerprint,
      targetReferenceFingerprint: `sha256:${"2".repeat(64)}`,
      selectionMode: "EXPLICIT_OPERATOR_SELECTED" as const,
    },
  ];
  return {
    schemaVersion: "hpi-pilot-plan-input.v1",
    platform: "win32",
    architecture: "x64",
    sourceFingerprint: firstSourceFingerprint,
    artifactFingerprint,
    engineReleaseFingerprint: engineFingerprint,
    operatorScope: {
      repositorySelection: "EXPLICIT_OPERATOR_SELECTED",
      providerRequestPolicy: "EXPLICIT_OPERATOR_AUTHORIZED",
      providerEndpointFingerprint: fixtureFingerprint,
      credentialScopeFingerprint: `sha256:${"3".repeat(64)}`,
      acknowledged: true,
      workspacePolicy: "DISPOSABLE_PILOT_WORKTREES",
    },
    repositoryTargets,
    tasks: Array.from({ length: 10 }, (_, index) => {
      const target = repositoryTargets[index < 5 ? 0 : 1];
      if (target === undefined) throw new Error("fixture target missing");
      return {
        taskId: `pilot-task-${String(index + 1).padStart(2, "0")}`,
        targetId: target.targetId,
        sourceFingerprint: target.sourceFingerprint,
        mode: index % 2 === 0 ? ("QUICK" as const) : ("MANAGED" as const),
        expectedOutcome: "READY" as const,
        acceptanceCheckIds: [`check-${String(index + 1).padStart(2, "0")}`],
      };
    }),
    pairedTaskIds: ["pilot-task-01", "pilot-task-06", "pilot-task-07"],
  };
}

describe("Task 12 pilot plan compiler", () => {
  it("freezes explicit targets and tasks without carrying paths or credentials into the plan", () => {
    const plan = new PilotPlanCompiler().compile(completePlanInput());

    expect(plan.schemaVersion).toBe("hpi-pilot-execution-plan.v1");
    expect(plan.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.repositoryTargets).toHaveLength(2);
    expect(plan.tasks).toHaveLength(10);
    expect(JSON.stringify(plan)).not.toContain("C:\\");
    expect(JSON.stringify(plan)).not.toMatch(/api[_-]?key|token|password|secret/iu);
  });

  it("fails closed when repository selection is implicit", () => {
    const input = completePlanInput();
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
    const input = completePlanInput();
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
    const input = completePlanInput();
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
    const first = compiler.compile(completePlanInput());
    const second = compiler.compile({
      ...completePlanInput(),
      tasks: [...completePlanInput().tasks].reverse().reverse(),
    });
    expect(second.planFingerprint).toBe(first.planFingerprint);
  });

  it("returns a safe blocked preflight without echoing invalid input", () => {
    const input = {
      ...completePlanInput(),
      privatePath: "C:\\Users\\operator\\secret-repository",
      credential: "token=do-not-echo",
      operatorScope: { ...completePlanInput().operatorScope, acknowledged: false },
    } as unknown;
    const receipt = new PilotPlanCompiler().preflight(input);

    expect(receipt.status).toBe("BLOCKED");
    expect(receipt.planFingerprint).toBeNull();
    expect(receipt.reasons).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("C:\\Users");
    expect(JSON.stringify(receipt)).not.toContain("do-not-echo");
  });

  it("returns READY only with the exact frozen plan fingerprint", () => {
    const plan = new PilotPlanCompiler().compile(completePlanInput());
    const receipt = new PilotPlanCompiler().preflight(completePlanInput());

    expect(receipt.status).toBe("READY");
    expect(receipt.planFingerprint).toBe(plan.planFingerprint);
  });

  it("rejects an execution plan whose fingerprint no longer matches its frozen body", () => {
    const plan = new PilotPlanCompiler().compile(completePlanInput());
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
