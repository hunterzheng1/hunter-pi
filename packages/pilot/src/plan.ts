import {
  pilotExecutionPlanSchema,
  pilotPreflightReceiptSchema,
  pilotPlanInputSchema,
  type PilotExecutionPlan,
  type PilotPreflightReceipt,
  type PilotPlanInput,
} from "./contracts.js";
import { pilotFingerprint } from "./serialization.js";

export class PilotPlanCompiler {
  public preflight(input: unknown): PilotPreflightReceipt {
    const parsed = pilotPlanInputSchema.safeParse(input);
    if (!parsed.success) {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["pilot plan failed strict safety preflight"],
      });
    }
    try {
      const plan = this.compile(parsed.data);
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "READY",
        planFingerprint: plan.planFingerprint,
        reasons: ["pilot plan scope is explicitly frozen and safe to start"],
      });
    } catch {
      return pilotPreflightReceiptSchema.parse({
        schemaVersion: "hpi-pilot-preflight.v1",
        status: "BLOCKED",
        planFingerprint: null,
        reasons: ["pilot plan failed strict safety preflight"],
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
      operatorScope: parsed.operatorScope,
      repositoryTargets: parsed.repositoryTargets,
      tasks: parsed.tasks,
      pairedTaskIds: parsed.pairedTaskIds,
    };
    return pilotExecutionPlanSchema.parse({
      schemaVersion: "hpi-pilot-execution-plan.v1",
      ...body,
      planFingerprint: pilotFingerprint(body),
    });
  }
}
