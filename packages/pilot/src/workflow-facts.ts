import type { z } from "zod";

import { realManagedChangeWorkflowFactIdSchema } from "@hunter-pi/managed-change";

import { pilotFingerprint } from "./serialization.js";

export const pilotWorkflowFactIdSchema = realManagedChangeWorkflowFactIdSchema;
export type PilotWorkflowFactId = z.infer<typeof pilotWorkflowFactIdSchema>;

export const pilotWorkflowFactDefinitions = Object.freeze(
  pilotWorkflowFactIdSchema.options.map((factId) => ({
    factId,
    applicability: "QUICK_MANAGED_RAW_PI" as const,
    scoring: "CAPTURED_ONLY_WHEN_PRODUCT_DERIVES_SUPPORTING_RECEIPT" as const,
  })),
);

const quickCapturedFactIds = Object.freeze(
  pilotWorkflowFactIdSchema.options.filter((factId) => factId !== "ATTEMPT_HISTORY"),
);
const rawPiCapturedFactIds = Object.freeze([
  "TASK_IDENTITY",
  "REPOSITORY_IDENTITY",
  "TARGET_REFERENCE_IDENTITY",
  "SOURCE_IDENTITY",
  "TASK_DEFINITION",
  "ACCEPTANCE_DEFINITION",
  "EXECUTION_OBSERVATION",
  "PROCESS_FINALITY",
  "PROCESS_TREE_FINALITY",
  "OUTPUT_FINALITY",
  "WRITER_LEASE_FINALITY",
  "PROVIDER_REQUEST_USAGE",
  "PROVIDER_TOKEN_USAGE",
  "PROVIDER_COST_USAGE",
  "INDEPENDENT_ACCEPTANCE",
] satisfies readonly PilotWorkflowFactId[]);

export const pilotQuickWorkflowFactChecklist = Object.freeze({
  schemaVersion: "hpi-pilot-workflow-fact-checklist.v2",
  facts: pilotWorkflowFactDefinitions,
  profiles: {
    managedRequiredFactIds: pilotWorkflowFactIdSchema.options,
    quickCapturedFactIds,
    rawPiCapturedFactIds,
  },
});

export const pilotQuickWorkflowFactChecklistFingerprint = pilotFingerprint(
  pilotQuickWorkflowFactChecklist,
);

export const pilotApplicableWorkflowFactCount = pilotWorkflowFactDefinitions.length;

export function capturedPilotWorkflowFactIds(
  signals: Readonly<Partial<Record<PilotWorkflowFactId, boolean>>>,
): readonly PilotWorkflowFactId[] {
  return pilotWorkflowFactIdSchema.options.filter((factId) => signals[factId] === true);
}

export function quickPilotWorkflowFactSignals(input: {
  readonly taskIdentityObserved: boolean;
  readonly repositoryIdentityObserved: boolean;
  readonly targetReferenceObserved: boolean;
  readonly sourceIdentityObserved: boolean;
  readonly taskDefinitionObserved: boolean;
  readonly acceptanceDefinitionObserved: boolean;
  readonly executionObserved: boolean;
  readonly processFinal: boolean;
  readonly processTreeFinal: boolean;
  readonly outputFinal: boolean;
  readonly writerLeaseFinal: boolean;
  readonly providerRequestUsageObserved: boolean;
  readonly providerTokenUsageObserved: boolean;
  readonly providerCostUsageObserved: boolean;
  readonly sourcePreservationObserved: boolean;
  readonly changedPathScopeObserved: boolean;
  readonly independentAcceptanceObserved: boolean;
  readonly acceptanceWorkspacePreservationObserved: boolean;
  readonly secretLeakageObserved: boolean;
}): Readonly<Record<PilotWorkflowFactId, boolean>> {
  return {
    TASK_IDENTITY: input.taskIdentityObserved,
    REPOSITORY_IDENTITY: input.repositoryIdentityObserved,
    TARGET_REFERENCE_IDENTITY: input.targetReferenceObserved,
    SOURCE_IDENTITY: input.sourceIdentityObserved,
    TASK_DEFINITION: input.taskDefinitionObserved,
    ACCEPTANCE_DEFINITION: input.acceptanceDefinitionObserved,
    EXECUTION_OBSERVATION: input.executionObserved,
    PROCESS_FINALITY: input.processFinal,
    PROCESS_TREE_FINALITY: input.processTreeFinal,
    OUTPUT_FINALITY: input.outputFinal,
    WRITER_LEASE_FINALITY: input.writerLeaseFinal,
    PROVIDER_REQUEST_USAGE: input.providerRequestUsageObserved,
    PROVIDER_TOKEN_USAGE: input.providerTokenUsageObserved,
    PROVIDER_COST_USAGE: input.providerCostUsageObserved,
    SOURCE_PRESERVATION: input.sourcePreservationObserved,
    CHANGED_PATH_SCOPE: input.changedPathScopeObserved,
    INDEPENDENT_ACCEPTANCE: input.independentAcceptanceObserved,
    ACCEPTANCE_WORKSPACE_PRESERVATION: input.acceptanceWorkspacePreservationObserved,
    SECRET_LEAKAGE_OBSERVATION: input.secretLeakageObserved,
    ATTEMPT_HISTORY: false,
  };
}

export function rawPiCapturedWorkflowFactCount(): number {
  return rawPiCapturedFactIds.length;
}
