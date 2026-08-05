import {
  pilotExecutionPlanSchema,
  pilotPreflightReceiptSchema,
  pilotPlanInputSchema,
  type PilotExecutionPlan,
  type PilotPreflightReceipt,
  type PilotPreflightReason,
  type PilotPlanInput,
} from "./contracts.js";
import { pilotFingerprint } from "./serialization.js";

export type PilotPreflightFailure = "FILE_UNREADABLE" | "INVALID_JSON";

const invalidPlanReasonByRoot: Readonly<Record<string, PilotPreflightReason>> = {
  schemaVersion: "PILOT_PLAN_VERSION_INVALID",
  machineProfile: "PILOT_PLAN_MACHINE_PROFILE_INVALID",
  comparatorConfigurationFingerprint: "PILOT_PLAN_COMPARATOR_CONFIG_INVALID",
  workflowFactChecklistFingerprint: "PILOT_PLAN_WORKFLOW_CHECKLIST_INVALID",
  acceptanceChecks: "PILOT_PLAN_ACCEPTANCE_CHECKS_INVALID",
  operatorScope: "PILOT_PLAN_PROVIDER_SCOPE_INVALID",
  repositoryTargets: "PILOT_PLAN_TARGETS_INVALID",
  tasks: "PILOT_PLAN_TASKS_INVALID",
  pluginFixtures: "PILOT_PLAN_PLUGIN_FIXTURES_INVALID",
  updateCandidates: "PILOT_PLAN_UPDATE_CANDIDATES_INVALID",
  pairedTaskIds: "PILOT_PLAN_PAIRED_TASKS_INVALID",
};

function invalidPlanReasons(
  issues: readonly { path: readonly PropertyKey[] }[],
): PilotPreflightReason[] {
  const reasons = new Set<PilotPreflightReason>();
  for (const issue of issues) {
    const root = issue.path[0];
    if (typeof root === "string") {
      reasons.add(invalidPlanReasonByRoot[root] ?? "PILOT_PLAN_FIELDS_INVALID");
    } else {
      reasons.add("PILOT_PLAN_SCHEMA_INVALID");
    }
  }
  return reasons.size > 0 ? [...reasons] : ["PILOT_PLAN_SCHEMA_INVALID"];
}

export class PilotPlanCompiler {
  public preflight(input: unknown, failure?: PilotPreflightFailure): PilotPreflightReceipt {
    if (failure === "FILE_UNREADABLE") {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["PILOT_PLAN_FILE_UNREADABLE"],
      });
    }
    if (failure === "INVALID_JSON") {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["PILOT_PLAN_JSON_INVALID"],
      });
    }
    let parsed;
    try {
      parsed = pilotPlanInputSchema.safeParse(input);
    } catch {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["PILOT_PLAN_SCHEMA_INVALID"],
      });
    }
    if (!parsed.success) {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: invalidPlanReasons(parsed.error.issues),
      });
    }
    try {
      const plan = this.compile(parsed.data);
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "READY",
        planFingerprint: plan.planFingerprint,
        reasons: ["PILOT_PLAN_SCOPE_FROZEN"],
      });
    } catch {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["PILOT_PLAN_COMPILATION_FAILED"],
      });
    }
  }

  public compile(input: PilotPlanInput): PilotExecutionPlan {
    const parsed = pilotPlanInputSchema.parse(input);
    const body = {
      platform: parsed.platform,
      architecture: parsed.architecture,
      sourceFingerprint: parsed.sourceFingerprint,
      artifactFingerprint: parsed.artifactFingerprint,
      engineReleaseFingerprint: parsed.engineReleaseFingerprint,
      machineProfile: parsed.machineProfile,
      comparatorConfigurationFingerprint: parsed.comparatorConfigurationFingerprint,
      workflowFactChecklistFingerprint: parsed.workflowFactChecklistFingerprint,
      acceptanceChecks: parsed.acceptanceChecks,
      operatorScope: parsed.operatorScope,
      repositoryTargets: parsed.repositoryTargets,
      tasks: parsed.tasks,
      pluginFixtures: parsed.pluginFixtures,
      updateCandidates: parsed.updateCandidates,
      pairedTaskIds: parsed.pairedTaskIds,
    };
    return pilotExecutionPlanSchema.parse({
      schemaVersion: "hpi-pilot-execution-plan.v1",
      ...body,
      planFingerprint: pilotFingerprint(body),
    });
  }
}
