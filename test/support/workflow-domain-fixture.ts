import { managedChangeSchema, planRevisionSchema, runSchema } from "@hunter-pi/domain";

export const fixtureTimestamp = "2026-08-03T00:00:00.000Z";
export const fixtureFingerprint = `sha256:${"a".repeat(64)}` as const;

export function createWorkflowDomainFixture(
  options: {
    readonly goal?: string;
    readonly suffix?: string;
    readonly includeRequiredGates?: boolean;
  } = {},
) {
  const suffix = options.suffix ?? "";
  const change = managedChangeSchema.parse({
    schemaVersion: "1.0.0",
    changeId: `chg_replay${suffix}`,
    title: "Exercise durable workflow replay",
    goal: options.goal ?? "Persist exact workflow facts",
    nonGoals: ["Run a real Agent"],
    constraints: ["Preserve prior facts"],
    lifecycle: "PLANNED",
    createdAt: fixtureTimestamp,
  });
  const planRevision = planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: `plan_replay${suffix}`,
    changeId: change.changeId,
    revision: 1,
    workspaceId: `workspace_replay${suffix}`,
    workspaceFingerprint: fixtureFingerprint,
    sourceFingerprint: fixtureFingerprint,
    goal: change.goal,
    nonGoals: change.nonGoals,
    constraints: change.constraints,
    steps: [
      {
        stepId: `step_replay${suffix}`,
        kind: "agent",
        title: "Return a durable fact",
        dependsOn: [],
        required: true,
        inputContractFingerprint: fixtureFingerprint,
        outputContractFingerprint: fixtureFingerprint,
      },
      ...(options.includeRequiredGates
        ? [
            {
              stepId: `step_human${suffix}`,
              kind: "human_gate" as const,
              title: "Confirm the exact result",
              dependsOn: [`step_replay${suffix}`],
              required: true,
              inputContractFingerprint: fixtureFingerprint,
              outputContractFingerprint: fixtureFingerprint,
              expectedContentHash: fixtureFingerprint,
              allowedDecisions: ["APPROVED", "REJECTED", "BLOCKED"] as const,
            },
            {
              stepId: `step_review${suffix}`,
              kind: "review" as const,
              title: "Review the exact result",
              dependsOn: [`step_replay${suffix}`],
              required: true,
              inputContractFingerprint: fixtureFingerprint,
              outputContractFingerprint: fixtureFingerprint,
              inputFingerprint: fixtureFingerprint,
              reviewDefinitionFingerprint: fixtureFingerprint,
              configurationFingerprint: fixtureFingerprint,
            },
          ]
        : []),
    ],
    checks: [
      {
        checkId: `check_replay${suffix}`,
        version: 1,
        label: "Durable fixture",
        kind: "command",
        required: true,
        definition: {
          executable: "npm",
          argv: ["test"],
          workingDirectoryReference: "workspace-root",
        },
        definitionFingerprint: fixtureFingerprint,
        configurationFingerprint: fixtureFingerprint,
      },
    ],
    loopPolicy: {
      maxIterations: 2,
      maxElapsedMs: 60_000,
      repeatedFailureLimit: 2,
      resourceBudgets: { maxExternalOperations: 4 },
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt: fixtureTimestamp,
  });
  const run = runSchema.parse({
    schemaVersion: "1.0.0",
    runId: `run_replay${suffix}`,
    changeId: change.changeId,
    planRevisionId: planRevision.planRevisionId,
    workspaceId: planRevision.workspaceId,
    workspaceFingerprint: planRevision.workspaceFingerprint,
    sourceFingerprint: planRevision.sourceFingerprint,
    lifecycle: "PLANNED",
    archiveStatus: "UNARCHIVED",
    startedAt: fixtureTimestamp,
  });
  return { change, planRevision, run };
}
