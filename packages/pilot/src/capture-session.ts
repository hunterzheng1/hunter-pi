import { createHmac, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import {
  archivePackageFingerprint,
  FileRunArchiveStore,
  FileWorkflowEventStore,
} from "@hunter-pi/evidence";
import {
  assertSafeDirectoryPath,
  withDurableMutationLock,
  writeImmutableAtomically,
} from "@hunter-pi/evidence/atomic-write";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  realManagedChangeRequestSchema,
  realManagedChangeTaskReceiptSchema,
  type RealManagedChangeRequest,
} from "@hunter-pi/managed-change";
import { DurableWorkflowKernel } from "@hunter-pi/workflow-kernel";

import { FilePilotArchiveStore, type TrustedPilotArchive } from "./archive.js";
import {
  PilotEvidenceCaptureError,
  PilotEvidenceCaptureFinalizer,
  createPilotEvidenceCaptureRuntime,
  finalizePilotEvidenceDraft,
  type PilotEvidenceDraft,
} from "./capture.js";
import {
  pilotCiReceiptSchema,
  pilotComparatorSchema,
  pilotExecutionPlanSchema,
  pilotInterruptionSchema,
  pilotOutcomeSchema,
  pilotPlanPluginFixtureIdSchema,
  pilotQuickTaskReceiptSchema,
  pilotRunRecoveryLinkSchema,
  pilotRunArchiveReceiptSchema,
  pilotTaskOracleSchema,
  pilotTaskResultSchema,
  pilotUpdateRollbackCycleSchema,
  type PilotComparator,
  type PilotExecutionPlan,
  type PilotInterruption,
  type PilotQuickTaskReceipt,
  type PilotRunArchiveReceipt,
  type PilotTaskOracle,
  type PilotTaskResult,
} from "./contracts.js";
import { canonicalJson, pilotFingerprint } from "./serialization.js";
import { pilotRuntimeBindingMatchesPlan, pilotRuntimeBindingSchema } from "./runtime-binding.js";
import { pilotQuickWorkflowFactChecklistFingerprint } from "./workflow-facts.js";

const stableCaptureIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "capture identities must be stable and path-free");
const safeNonnegativeIntegerSchema = z.number().int().nonnegative();
const safePositiveIntegerSchema = z.number().int().positive();
const nonnegativeNumberSchema = z.number().nonnegative();
const proofSchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u);
const eventFilenameSchema = z.string().regex(/^\d{6}-[A-Za-z][A-Za-z0-9._-]{0,127}\.json$/u);
const maximumCaptureFileBytes = 4 * 1024 * 1024;
const keyFilename = ".pilot-capture-key.json";
const sessionFilename = "session.json";
const eventsDirectoryName = "events";
const finalizationIntentFilename = "finalization-intent.json";
const finalizationCommitFilename = "finalization-commit.json";
const productObservationRuntimeKey = Symbol("pilot-product-observation-runtime-key");
const productObservationRuntimeCapability = Symbol("pilot-product-observation-runtime-capability");
const productQuickTaskExecutorKey = Symbol("pilot-product-quick-task-executor-key");
const productRawComparatorExecutorKey = Symbol("pilot-product-raw-comparator-executor-key");
const providerIntentFilenameSchema = z
  .string()
  .regex(/^provider-[A-Za-z][A-Za-z0-9._-]{0,127}\.intent\.json$/u);

const taskRunObservationSchema = z.strictObject({
  runId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  archiveFingerprint: fingerprintSchema,
  terminalOutcome: pilotOutcomeSchema,
  providerRequestCount: safeNonnegativeIntegerSchema,
  providerTokenCount: safeNonnegativeIntegerSchema,
  providerCostMinor: safeNonnegativeIntegerSchema,
  recoveryLinks: z.array(pilotRunRecoveryLinkSchema).max(3),
});

const installationObservationSchema = z.strictObject({
  kind: z.literal("INSTALLATION"),
  cleanProfileFingerprint: fingerprintSchema,
});

const managedTaskObservationSchema = z.strictObject({
  kind: z.literal("MANAGED_TASK"),
  taskId: stableCaptureIdSchema,
  terminalOutcome: pilotOutcomeSchema,
  sourcePreserved: z.boolean(),
  rawSecretLeakage: z.boolean(),
  applicableFactCount: safePositiveIntegerSchema,
  capturedFactCount: safeNonnegativeIntegerSchema,
  manualInterventions: safeNonnegativeIntegerSchema,
  hunterOverheadMinutes: nonnegativeNumberSchema,
  rawPiCapturedFactCount: safeNonnegativeIntegerSchema,
  rawPiManualInterventions: safeNonnegativeIntegerSchema,
  run: taskRunObservationSchema,
});

const quickTaskObservationSchema = z.strictObject({
  kind: z.literal("QUICK_TASK"),
  receipt: pilotQuickTaskReceiptSchema,
});

const warmStartObservationSchema = z.strictObject({
  kind: z.literal("WARM_START_SAMPLES"),
  discardedWarmups: z.literal(5),
  samplesMs: z.array(nonnegativeNumberSchema).min(20).max(1_000),
});

const acknowledgementObservationSchema = z.strictObject({
  kind: z.literal("ACKNOWLEDGEMENT_SAMPLES"),
  samplesMs: z.array(nonnegativeNumberSchema).min(30).max(1_000),
});

const memoryObservationSchema = z.strictObject({
  kind: z.literal("MEMORY_SAMPLES"),
  samplesMiB: z.array(nonnegativeNumberSchema).min(30).max(1_000),
});

const updateObservationSchema = z.strictObject({
  kind: z.literal("UPDATE_ROLLBACK"),
  cycleId: stableCaptureIdSchema,
  candidateId: stableCaptureIdSchema,
  applyOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  rollbackOutcome: z.enum(["APPLIED", "FAILED", "BLOCKED"]),
  statePreserved: z.boolean(),
  usableKnownGood: z.boolean(),
});

const pluginObservationSchema = z.strictObject({
  kind: z.literal("PLUGIN_FIXTURE"),
  fixtureId: pilotPlanPluginFixtureIdSchema,
  safeMode: z.boolean(),
  userCodeEvaluated: z.boolean(),
});

const gatesObservationSchema = z.strictObject({
  kind: z.literal("GATES"),
  storageGate: z.boolean(),
  manualStateEditingRequired: z.boolean(),
  privacyGate: z.boolean(),
  providerLatencySeparated: z.boolean(),
  reviewP0P1Count: safeNonnegativeIntegerSchema,
});

const ciObservationSchema = z.strictObject({
  kind: z.literal("CI"),
  platform: z.enum(["WINDOWS", "UBUNTU"]),
  status: z.enum(["PASS", "FAIL", "PENDING"]),
  runFingerprint: fingerprintSchema,
});

const comparatorObservationSchema = z.strictObject({
  kind: z.literal("RAW_PI_COMPARATOR"),
  comparator: pilotComparatorSchema,
});

export const pilotCaptureObservationSchema = z.discriminatedUnion("kind", [
  installationObservationSchema,
  managedTaskObservationSchema,
  quickTaskObservationSchema,
  warmStartObservationSchema,
  acknowledgementObservationSchema,
  updateObservationSchema,
  pluginObservationSchema,
  memoryObservationSchema,
  gatesObservationSchema,
  ciObservationSchema,
  comparatorObservationSchema,
]);
export type PilotCaptureObservation = z.infer<typeof pilotCaptureObservationSchema>;

const pilotCaptureOperatorObservationSchema = z.discriminatedUnion("kind", [
  installationObservationSchema,
  warmStartObservationSchema,
  acknowledgementObservationSchema,
  updateObservationSchema,
  pluginObservationSchema,
  memoryObservationSchema,
  gatesObservationSchema,
  ciObservationSchema,
]);
const pilotCaptureProductObservationSchema = z.discriminatedUnion("kind", [
  managedTaskObservationSchema,
  quickTaskObservationSchema,
  comparatorObservationSchema,
]);

export const pilotCaptureOpenInputSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-open.v1"),
  sessionId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  plan: pilotExecutionPlanSchema,
});
export type PilotCaptureOpenInput = z.infer<typeof pilotCaptureOpenInputSchema>;

export const pilotCaptureRecordInputSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-record.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  observation: pilotCaptureOperatorObservationSchema,
});
export type PilotCaptureRecordInput = z.infer<typeof pilotCaptureRecordInputSchema>;

const pilotCaptureProductRecordInputSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-record.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  observation: pilotCaptureProductObservationSchema,
});
type PilotCaptureProductRecordInput = z.infer<typeof pilotCaptureProductRecordInputSchema>;
type PilotCaptureAnyRecordInput = PilotCaptureRecordInput | PilotCaptureProductRecordInput;

export interface PilotCaptureProductObservationRuntime {
  readonly [productObservationRuntimeKey]: typeof productObservationRuntimeCapability;
  readonly [productQuickTaskExecutorKey]?: PilotCaptureQuickTaskExecutor;
  readonly [productRawComparatorExecutorKey]?: PilotCaptureRawComparatorExecutor;
}

/** @internal Product runtime and source-level test support; not re-exported from the package entry. */
export function createPilotCaptureProductObservationRuntime(): PilotCaptureProductObservationRuntime {
  return Object.freeze({
    [productObservationRuntimeKey]: productObservationRuntimeCapability,
  }) as PilotCaptureProductObservationRuntime;
}

/** @internal Bundled product execution seam; deliberately absent from the public package entry. */
export function createPilotCaptureProductExecutionRuntime(options: {
  readonly quickTask?: PilotCaptureQuickTaskExecutor;
  readonly rawComparator?: PilotCaptureRawComparatorExecutor;
}): PilotCaptureProductObservationRuntime {
  if (options.quickTask === undefined && options.rawComparator === undefined) {
    throw new Error("a product execution runtime requires one concrete executor");
  }
  return Object.freeze({
    [productObservationRuntimeKey]: productObservationRuntimeCapability,
    ...(options.quickTask === undefined
      ? {}
      : { [productQuickTaskExecutorKey]: options.quickTask }),
    ...(options.rawComparator === undefined
      ? {}
      : { [productRawComparatorExecutorKey]: options.rawComparator }),
  }) as PilotCaptureProductObservationRuntime;
}

function isPilotCaptureProductObservationRuntime(
  value: unknown,
): value is PilotCaptureProductObservationRuntime {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly [productObservationRuntimeKey]?: unknown })[
      productObservationRuntimeKey
    ] === productObservationRuntimeCapability
  );
}

function quickTaskExecutorFor(runtime: unknown): PilotCaptureQuickTaskExecutor | undefined {
  return isPilotCaptureProductObservationRuntime(runtime)
    ? runtime[productQuickTaskExecutorKey]
    : undefined;
}

function rawComparatorExecutorFor(runtime: unknown): PilotCaptureRawComparatorExecutor | undefined {
  return isPilotCaptureProductObservationRuntime(runtime)
    ? runtime[productRawComparatorExecutorKey]
    : undefined;
}

const pilotManagedTaskMetricsSchema = z.strictObject({
  applicableFactCount: safePositiveIntegerSchema,
  capturedFactCount: safeNonnegativeIntegerSchema,
  manualInterventions: safeNonnegativeIntegerSchema,
  rawPiCapturedFactCount: safeNonnegativeIntegerSchema,
  rawPiManualInterventions: safeNonnegativeIntegerSchema,
});

export const pilotCaptureManagedTaskInputV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-managed-task.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  taskId: stableCaptureIdSchema,
  archiveIds: z.array(stableCaptureIdSchema).length(1),
  metrics: pilotManagedTaskMetricsSchema,
});
export const pilotCaptureManagedTaskInputV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-managed-task.v2"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  taskId: stableCaptureIdSchema,
  archiveIds: z.array(stableCaptureIdSchema).length(1),
});
export const pilotCaptureManagedTaskInputSchema = z.discriminatedUnion("schemaVersion", [
  pilotCaptureManagedTaskInputV1Schema,
  pilotCaptureManagedTaskInputV2Schema,
]);
export type PilotCaptureManagedTaskInput = z.infer<typeof pilotCaptureManagedTaskInputV2Schema>;

export const pilotCaptureQuickTaskInputV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-quick-task.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  taskId: stableCaptureIdSchema,
  repository: z
    .string()
    .min(1)
    .max(32_768)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
        }),
      "repository path contains a control character",
    ),
  request: realManagedChangeRequestSchema,
});
export const pilotCaptureQuickTaskInputSchema = pilotCaptureQuickTaskInputV1Schema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal("hpi-pilot-capture-quick-task.v2"),
    runtimeBinding: pilotRuntimeBindingSchema,
  });
export type PilotCaptureQuickTaskInput = z.infer<typeof pilotCaptureQuickTaskInputSchema>;

export interface PilotCaptureQuickTaskExecutionContext {
  readonly plan: PilotExecutionPlan;
  readonly oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }>;
  readonly repository: string;
  readonly request: RealManagedChangeRequest;
}

export type PilotCaptureQuickTaskExecutor = (
  context: PilotCaptureQuickTaskExecutionContext,
) => Promise<PilotQuickTaskReceipt>;

export const pilotCaptureRawComparatorInputV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-raw-comparator.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  taskId: stableCaptureIdSchema,
  repository: pilotCaptureQuickTaskInputV1Schema.shape.repository,
  request: realManagedChangeRequestSchema,
});
export const pilotCaptureRawComparatorInputSchema = pilotCaptureRawComparatorInputV1Schema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal("hpi-pilot-capture-raw-comparator.v2"),
    runtimeBinding: pilotRuntimeBindingSchema,
    comparatorConfigurationFingerprint: fingerprintSchema,
  });
export type PilotCaptureRawComparatorInput = z.infer<typeof pilotCaptureRawComparatorInputSchema>;

export interface PilotCaptureRawComparatorExecutionContext {
  readonly plan: PilotExecutionPlan;
  readonly oracle: PilotTaskOracle;
  readonly hunterResult: PilotTaskResult;
  readonly repository: string;
  readonly request: RealManagedChangeRequest;
}

export type PilotCaptureRawComparatorExecutor = (
  context: PilotCaptureRawComparatorExecutionContext,
) => Promise<PilotComparator>;

export const pilotCaptureNextActionSchema = z.enum([
  "RECORD_INSTALLATION",
  "RECORD_TASK_CHAINS",
  "RECORD_INTERRUPTION_RECOVERY",
  "RECORD_WARM_START_SAMPLES",
  "RECORD_ACKNOWLEDGEMENT_SAMPLES",
  "RECORD_UPDATE_ROLLBACK",
  "RECORD_PLUGIN_FIXTURES",
  "RECORD_MEMORY_SAMPLES",
  "RECORD_GATES",
  "RECORD_WINDOWS_CI",
  "RECORD_UBUNTU_CI",
  "RECORD_RAW_PI_COMPARATORS",
  "FINALIZE_ARCHIVE",
  "RETRY_FINALIZE",
  "COMPLETE",
]);
export type PilotCaptureNextAction = z.infer<typeof pilotCaptureNextActionSchema>;

const providerUsageTotalSchema = z.strictObject({
  requests: safeNonnegativeIntegerSchema,
  tokens: safeNonnegativeIntegerSchema,
  costMinor: safeNonnegativeIntegerSchema,
});
type ProviderUsageTotal = z.infer<typeof providerUsageTotalSchema>;

const providerOperationIntentFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-provider-operation-intent.v1"),
  sessionId: stableCaptureIdSchema,
  planFingerprint: fingerprintSchema,
  operationId: stableCaptureIdSchema,
  taskId: stableCaptureIdSchema,
  kind: z.enum(["QUICK_TASK", "RAW_PI_COMPARATOR"]),
  factKey: stableCaptureIdSchema,
  inputFingerprint: fingerprintSchema,
  eventCountBefore: safeNonnegativeIntegerSchema,
  previousEventFingerprint: fingerprintSchema.nullable(),
  usageBefore: providerUsageTotalSchema,
  reservation: z.strictObject({
    requests: safePositiveIntegerSchema,
    tokens: safePositiveIntegerSchema,
    costMinor: safePositiveIntegerSchema,
  }),
  observedAt: timestampSchema,
});
const providerOperationIntentSchema = providerOperationIntentFactsSchema.extend({
  intentFingerprint: fingerprintSchema,
  proof: proofSchema,
});
type ProviderOperationIntent = z.infer<typeof providerOperationIntentSchema>;

const captureCountsSchema = z.strictObject({
  installation: z.number().int().min(0).max(1),
  taskChains: z.number().int().min(0).max(10),
  runArchives: z.number().int().min(0).max(100),
  interruptions: z.number().int().min(0).max(3),
  warmStartSamples: safeNonnegativeIntegerSchema,
  acknowledgementSamples: safeNonnegativeIntegerSchema,
  updateCycles: z.number().int().min(0).max(2),
  pluginFixtures: z.number().int().min(0).max(5),
  memorySamples: safeNonnegativeIntegerSchema,
  gates: z.number().int().min(0).max(1),
  ciReceipts: z.number().int().min(0).max(2),
  rawPiComparators: z.number().int().min(0).max(3),
});
type PilotCaptureCounts = z.infer<typeof captureCountsSchema>;

export const pilotCaptureStatusSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-status.v1"),
  sessionId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  planFingerprint: fingerprintSchema,
  state: z.enum(["COLLECTING", "READY_TO_FINALIZE", "FINALIZING", "ARCHIVED"]),
  counts: captureCountsSchema,
  providerUsage: providerUsageTotalSchema,
  nextActions: z.array(pilotCaptureNextActionSchema).min(1),
  archiveFingerprint: fingerprintSchema.nullable(),
});
export type PilotCaptureStatus = z.infer<typeof pilotCaptureStatusSchema>;

export const pilotCaptureRecordReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-record-receipt.v1"),
  sessionId: stableCaptureIdSchema,
  operationId: stableCaptureIdSchema,
  outcome: z.enum(["RECORDED", "REPLAYED"]),
  sequence: safePositiveIntegerSchema,
  eventFingerprint: fingerprintSchema,
  status: pilotCaptureStatusSchema,
});
export type PilotCaptureRecordReceipt = z.infer<typeof pilotCaptureRecordReceiptSchema>;

const captureKeySchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-key.v1"),
  keyBase64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
});

const sessionHeaderFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-session.v1"),
  sessionId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  plan: pilotExecutionPlanSchema,
  createdAt: timestampSchema,
});
const sessionHeaderSchema = sessionHeaderFactsSchema.extend({
  headerFingerprint: fingerprintSchema,
  proof: proofSchema,
});
type SessionHeader = z.infer<typeof sessionHeaderSchema>;

const captureEventFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-event.v1"),
  sessionId: stableCaptureIdSchema,
  sequence: safePositiveIntegerSchema,
  operationId: stableCaptureIdSchema,
  factKey: stableCaptureIdSchema,
  observation: pilotCaptureObservationSchema,
  previousEventFingerprint: fingerprintSchema.nullable(),
  observedAt: timestampSchema,
});
const captureEventSchema = captureEventFactsSchema.extend({
  eventFingerprint: fingerprintSchema,
  proof: proofSchema,
});
type CaptureEvent = z.infer<typeof captureEventSchema>;

const finalizationIntentFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-finalization-intent.v1"),
  sessionId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  planFingerprint: fingerprintSchema,
  evidenceFingerprint: fingerprintSchema,
  observedAt: timestampSchema,
});
const finalizationIntentSchema = finalizationIntentFactsSchema.extend({
  proof: proofSchema,
});
type FinalizationIntent = z.infer<typeof finalizationIntentSchema>;

const finalizationCommitFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-capture-finalization-commit.v1"),
  sessionId: stableCaptureIdSchema,
  archiveId: stableCaptureIdSchema,
  planFingerprint: fingerprintSchema,
  evidenceFingerprint: fingerprintSchema,
  archiveFingerprint: fingerprintSchema,
  observedAt: timestampSchema,
});
const finalizationCommitSchema = finalizationCommitFactsSchema.extend({
  proof: proofSchema,
});
type FinalizationCommit = z.infer<typeof finalizationCommitSchema>;

export type PilotCaptureCoordinatorErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_CONFLICT"
  | "SESSION_CORRUPT"
  | "OPERATION_CONFLICT"
  | "FACT_CONFLICT"
  | "SESSION_SEALED"
  | "OBSERVATION_INVALID"
  | "PROVIDER_BUDGET_EXCEEDED"
  | "PROVIDER_USAGE_RECONCILIATION_REQUIRED"
  | "RUNTIME_BINDING_MISMATCH"
  | "INCOMPLETE"
  | "WINDOWS_REQUIRED"
  | "ARCHIVE_MISMATCH"
  | "STORE_FAILURE";

export class PilotCaptureCoordinatorError extends Error {
  public readonly code: PilotCaptureCoordinatorErrorCode;

  public constructor(code: PilotCaptureCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "PilotCaptureCoordinatorError";
    this.code = code;
  }
}

function coordinatorError(
  code: PilotCaptureCoordinatorErrorCode,
  message: string,
): PilotCaptureCoordinatorError {
  return new PilotCaptureCoordinatorError(code, message);
}

function captureProof(key: Uint8Array, domain: string, facts: unknown): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update(`hunter-pi-pilot-capture\0${domain}\0${canonicalJson(facts)}`, "utf8")
    .digest("hex")}`;
}

function factsWithoutProof(value: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [key, fact] of Object.entries(value)) {
    if (key !== "proof") facts[key] = fact;
  }
  return facts;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readExactJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    !Number.isSafeInteger(stats.size) ||
    stats.size > maximumCaptureFileBytes
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture state is not an exact bounded file");
  }
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof PilotCaptureCoordinatorError) throw error;
    throw coordinatorError("SESSION_CORRUPT", "pilot capture state is invalid or corrupt");
  }
}

function eventFacts(event: CaptureEvent): z.infer<typeof captureEventFactsSchema> {
  return {
    schemaVersion: event.schemaVersion,
    sessionId: event.sessionId,
    sequence: event.sequence,
    operationId: event.operationId,
    factKey: event.factKey,
    observation: event.observation,
    previousEventFingerprint: event.previousEventFingerprint,
    observedAt: event.observedAt,
  };
}

function providerIntentFacts(
  intent: ProviderOperationIntent,
): z.infer<typeof providerOperationIntentFactsSchema> {
  return {
    schemaVersion: intent.schemaVersion,
    sessionId: intent.sessionId,
    planFingerprint: intent.planFingerprint,
    operationId: intent.operationId,
    taskId: intent.taskId,
    kind: intent.kind,
    factKey: intent.factKey,
    inputFingerprint: intent.inputFingerprint,
    eventCountBefore: intent.eventCountBefore,
    previousEventFingerprint: intent.previousEventFingerprint,
    usageBefore: intent.usageBefore,
    reservation: intent.reservation,
    observedAt: intent.observedAt,
  };
}

function safeUsageSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function factKeyFor(observation: PilotCaptureObservation): string {
  switch (observation.kind) {
    case "INSTALLATION":
      return "installation";
    case "MANAGED_TASK":
      return `task.${observation.taskId}`;
    case "QUICK_TASK":
      return `task.${observation.receipt.taskId}`;
    case "WARM_START_SAMPLES":
      return "samples.warm-start";
    case "ACKNOWLEDGEMENT_SAMPLES":
      return "samples.acknowledgement";
    case "UPDATE_ROLLBACK":
      return `update.${observation.candidateId}`;
    case "PLUGIN_FIXTURE":
      return `plugin.${observation.fixtureId}`;
    case "MEMORY_SAMPLES":
      return "samples.memory";
    case "GATES":
      return "gates";
    case "CI":
      return `ci.${observation.platform.toLowerCase()}`;
    case "RAW_PI_COMPARATOR":
      return `comparator.${observation.comparator.taskId}`;
  }
}

type ManagedTaskObservation = Extract<PilotCaptureObservation, { readonly kind: "MANAGED_TASK" }>;
type QuickTaskObservation = Extract<PilotCaptureObservation, { readonly kind: "QUICK_TASK" }>;
type ComparatorObservation = Extract<
  PilotCaptureObservation,
  { readonly kind: "RAW_PI_COMPARATOR" }
>;
type UpdateObservation = Extract<PilotCaptureObservation, { readonly kind: "UPDATE_ROLLBACK" }>;
type PluginObservation = Extract<PilotCaptureObservation, { readonly kind: "PLUGIN_FIXTURE" }>;
type CiObservation = Extract<PilotCaptureObservation, { readonly kind: "CI" }>;

function taskOraclesFor(plan: PilotExecutionPlan): PilotTaskOracle[] {
  const targetById = new Map(plan.repositoryTargets.map((target) => [target.targetId, target]));
  const checkById = new Map(
    plan.acceptanceChecks.map((check) => [check.checkId, check.definitionFingerprint]),
  );
  return plan.tasks.map((task) => {
    const target = targetById.get(task.targetId);
    if (target === undefined) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture plan target binding is invalid");
    }
    const definitions = task.acceptanceCheckIds.map((checkId) => checkById.get(checkId));
    if (definitions.some((fingerprint) => fingerprint === undefined)) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture plan check binding is invalid");
    }
    const binding = {
      taskId: task.taskId,
      repositoryFingerprint: target.repositoryFingerprint,
      targetReferenceFingerprint: target.targetReferenceFingerprint,
      sourceFingerprint: task.sourceFingerprint,
      taskDefinitionFingerprint: task.taskDefinitionFingerprint,
      acceptanceCheckIds: task.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: definitions,
    };
    return pilotTaskOracleSchema.parse(
      task.mode === "QUICK"
        ? {
            ...binding,
            mode: "QUICK",
            expectedExecutionObservation: task.expectedExecutionObservation,
            expectedAcceptanceObservation: task.expectedAcceptanceObservation,
          }
        : { ...binding, mode: "MANAGED", expectedOutcome: task.expectedOutcome },
    );
  });
}

function oracleFor(plan: PilotExecutionPlan, taskId: string): PilotTaskOracle {
  const oracle = taskOraclesFor(plan).find((candidate) => candidate.taskId === taskId);
  if (oracle === undefined) {
    throw coordinatorError("OBSERVATION_INVALID", "pilot capture observation is outside the plan");
  }
  return oracle;
}

function resolvedBinding(oracle: PilotTaskOracle) {
  return {
    taskId: oracle.taskId,
    repositoryFingerprint: oracle.repositoryFingerprint,
    targetReferenceFingerprint: oracle.targetReferenceFingerprint,
    sourceFingerprint: oracle.sourceFingerprint,
    taskDefinitionFingerprint: oracle.taskDefinitionFingerprint,
    acceptanceCheckIds: oracle.acceptanceCheckIds,
    acceptanceCheckDefinitionFingerprints: oracle.acceptanceCheckDefinitionFingerprints,
  };
}

function processInterruptionForPlanKind(
  kind: PilotExecutionPlan["interruptionTasks"][number]["kind"],
) {
  switch (kind) {
    case "FORCED_PROCESS_KILL":
      return "FORCED_PROCESS_KILL_AFTER_AGENT_END" as const;
    case "TERMINAL_CLOSE_SIMULATION":
      return "TERMINAL_CLOSE_SIMULATION_AFTER_AGENT_END" as const;
    case "POWER_LOSS_SIMULATION":
      return "POWER_LOSS_SIMULATION_AFTER_AGENT_END" as const;
  }
}

function runReceiptFor(
  plan: PilotExecutionPlan,
  observation: ManagedTaskObservation,
): PilotRunArchiveReceipt {
  const oracle = oracleFor(plan, observation.taskId);
  if (oracle.mode !== "MANAGED") {
    throw coordinatorError("OBSERVATION_INVALID", "Managed Archive does not bind a Managed task");
  }
  try {
    return pilotRunArchiveReceiptSchema.parse({
      ...observation.run,
      taskId: observation.taskId,
      sourceFingerprint: oracle.sourceFingerprint,
    });
  } catch {
    throw coordinatorError("OBSERVATION_INVALID", "pilot capture Run receipt is invalid");
  }
}

function taskResultForManaged(
  plan: PilotExecutionPlan,
  observation: ManagedTaskObservation,
): PilotTaskResult {
  const oracle = oracleFor(plan, observation.taskId);
  if (oracle.mode !== "MANAGED") {
    throw coordinatorError(
      "OBSERVATION_INVALID",
      "Managed observation does not bind a Managed task",
    );
  }
  const run = runReceiptFor(plan, observation);
  try {
    return pilotTaskResultSchema.parse({
      ...resolvedBinding(oracle),
      mode: "MANAGED",
      terminalOutcome: observation.terminalOutcome,
      oracleOutcome: oracle.expectedOutcome,
      correct: observation.terminalOutcome === oracle.expectedOutcome,
      sourcePreserved: observation.sourcePreserved,
      rawSecretLeakage: observation.rawSecretLeakage,
      providerSendAcknowledged: run.providerRequestCount > 0,
      providerRequestCount: run.providerRequestCount,
      providerTokenCount: run.providerTokenCount,
      providerCostMinor: run.providerCostMinor,
      applicableFactCount: observation.applicableFactCount,
      capturedFactCount: observation.capturedFactCount,
      manualInterventions: observation.manualInterventions,
      hunterOverheadMinutes: observation.hunterOverheadMinutes,
      rawPiCapturedFactCount: observation.rawPiCapturedFactCount,
      rawPiManualInterventions: observation.rawPiManualInterventions,
    });
  } catch {
    throw coordinatorError("OBSERVATION_INVALID", "pilot Managed task observation is invalid");
  }
}

function quickReceiptFor(plan: PilotExecutionPlan, observation: QuickTaskObservation) {
  const oracle = oracleFor(plan, observation.receipt.taskId);
  if (
    oracle.mode !== "QUICK" ||
    canonicalJson(resolvedBinding(oracle)) !==
      canonicalJson({
        taskId: observation.receipt.taskId,
        repositoryFingerprint: observation.receipt.repositoryFingerprint,
        targetReferenceFingerprint: observation.receipt.targetReferenceFingerprint,
        sourceFingerprint: observation.receipt.sourceFingerprint,
        taskDefinitionFingerprint: observation.receipt.taskDefinitionFingerprint,
        acceptanceCheckIds: observation.receipt.acceptanceCheckIds,
        acceptanceCheckDefinitionFingerprints:
          observation.receipt.acceptanceCheckDefinitionFingerprints,
      })
  ) {
    throw coordinatorError("OBSERVATION_INVALID", "Quick receipt does not bind its frozen task");
  }
  return pilotQuickTaskReceiptSchema.parse(observation.receipt);
}

function taskResultForQuick(
  plan: PilotExecutionPlan,
  observation: QuickTaskObservation,
  rawMeasurements?: {
    readonly capturedFactCount: number;
    readonly manualInterventions: number;
  },
): PilotTaskResult {
  const oracle = oracleFor(plan, observation.receipt.taskId);
  if (oracle.mode !== "QUICK") {
    throw coordinatorError("OBSERVATION_INVALID", "Quick receipt does not bind a Quick task");
  }
  const receipt = quickReceiptFor(plan, observation);
  return pilotTaskResultSchema.parse({
    ...resolvedBinding(oracle),
    mode: "QUICK",
    quickReceiptId: receipt.receiptId,
    executionObservation: receipt.executionObservation,
    oracleExecutionObservation: oracle.expectedExecutionObservation,
    acceptanceObservation: receipt.acceptanceObservation,
    oracleAcceptanceObservation: oracle.expectedAcceptanceObservation,
    verifiedChangeClaimed: false,
    correct:
      receipt.executionObservation === oracle.expectedExecutionObservation &&
      receipt.acceptanceObservation === oracle.expectedAcceptanceObservation,
    sourcePreserved: receipt.sourcePreserved,
    rawSecretLeakage: receipt.rawSecretLeakage,
    providerSendAcknowledged: receipt.providerSendAcknowledged,
    providerRequestCount: receipt.providerRequestCount,
    providerTokenCount: receipt.providerTokenCount,
    providerCostMinor: receipt.providerCostMinor,
    applicableFactCount: receipt.applicableFactCount,
    capturedFactCount: receipt.capturedFactCount,
    manualInterventions: receipt.manualInterventions,
    hunterOverheadMinutes: receipt.hunterOverheadMinutes,
    rawPiCapturedFactCount: rawMeasurements?.capturedFactCount ?? 0,
    rawPiManualInterventions: rawMeasurements?.manualInterventions ?? 0,
  });
}

function taskResultFor(
  plan: PilotExecutionPlan,
  observation: ManagedTaskObservation | QuickTaskObservation,
  rawMeasurements?: {
    readonly capturedFactCount: number;
    readonly manualInterventions: number;
  },
): PilotTaskResult {
  return observation.kind === "MANAGED_TASK"
    ? taskResultForManaged(plan, {
        ...observation,
        ...(rawMeasurements === undefined
          ? {}
          : {
              rawPiCapturedFactCount: rawMeasurements.capturedFactCount,
              rawPiManualInterventions: rawMeasurements.manualInterventions,
            }),
      })
    : taskResultForQuick(plan, observation, rawMeasurements);
}

function comparatorFor(
  plan: PilotExecutionPlan,
  observation: ComparatorObservation,
  taskObservation: ManagedTaskObservation | QuickTaskObservation,
): PilotComparator {
  const comparator = pilotComparatorSchema.parse(observation.comparator);
  if (
    !plan.pairedTaskIds.includes(comparator.taskId) ||
    comparator.comparatorConfigurationFingerprint !== plan.comparatorConfigurationFingerprint ||
    comparator.workflowFactChecklistFingerprint !== plan.workflowFactChecklistFingerprint
  ) {
    throw coordinatorError(
      "OBSERVATION_INVALID",
      "pilot comparator is outside the frozen paired task or configuration",
    );
  }
  const oracle = oracleFor(plan, comparator.taskId);
  const taskResult = taskResultFor(plan, taskObservation);
  if (
    canonicalJson(resolvedBinding(oracle)) !==
      canonicalJson({
        taskId: comparator.taskId,
        repositoryFingerprint: comparator.repositoryFingerprint,
        targetReferenceFingerprint: comparator.targetReferenceFingerprint,
        sourceFingerprint: comparator.sourceFingerprint,
        taskDefinitionFingerprint: comparator.taskDefinitionFingerprint,
        acceptanceCheckIds: comparator.acceptanceCheckIds,
        acceptanceCheckDefinitionFingerprints: comparator.acceptanceCheckDefinitionFingerprints,
      }) ||
    comparator.mode !== oracle.mode ||
    comparator.applicableFactCount !== taskResult.applicableFactCount ||
    comparator.hunterCapturedFactCount !== taskResult.capturedFactCount ||
    comparator.hunterManualInterventions !== taskResult.manualInterventions ||
    comparator.hunterAdditionalOverheadMinutes !== taskResult.hunterOverheadMinutes ||
    comparator.rawPiCapturedFactCount > comparator.applicableFactCount
  ) {
    throw coordinatorError("OBSERVATION_INVALID", "pilot comparator observation is invalid");
  }
  return comparator;
}

function updateCycleFor(
  plan: PilotExecutionPlan,
  observation: UpdateObservation,
): z.infer<typeof pilotUpdateRollbackCycleSchema> {
  const candidate = plan.updateCandidates.find(
    (entry) => entry.candidateId === observation.candidateId,
  );
  if (candidate === undefined) {
    throw coordinatorError("OBSERVATION_INVALID", "pilot update observation is outside the plan");
  }
  try {
    return pilotUpdateRollbackCycleSchema.parse({
      cycleId: observation.cycleId,
      candidateId: candidate.candidateId,
      artifactFingerprint: candidate.artifactFingerprint,
      qualificationFingerprint: candidate.qualificationFingerprint,
      applyOutcome: observation.applyOutcome,
      rollbackOutcome: observation.rollbackOutcome,
      statePreserved: observation.statePreserved,
      usableKnownGood: observation.usableKnownGood,
    });
  } catch {
    throw coordinatorError("OBSERVATION_INVALID", "pilot update observation is invalid");
  }
}

function pluginFixtureFor(
  plan: PilotExecutionPlan,
  observation: PluginObservation,
): {
  readonly fixtureId: PluginObservation["fixtureId"];
  readonly definitionFingerprint: Fingerprint;
  readonly safeMode: boolean;
  readonly userCodeEvaluated: boolean;
} {
  const planned = plan.pluginFixtures.find((entry) => entry.fixtureId === observation.fixtureId);
  if (planned === undefined) {
    throw coordinatorError("OBSERVATION_INVALID", "pilot Plugin observation is outside the plan");
  }
  return {
    fixtureId: observation.fixtureId,
    definitionFingerprint: planned.definitionFingerprint,
    safeMode: observation.safeMode,
    userCodeEvaluated: observation.userCodeEvaluated,
  };
}

function ciReceiptFor(plan: PilotExecutionPlan, observation: CiObservation) {
  return pilotCiReceiptSchema.parse({
    platform: observation.platform,
    status: observation.status,
    sourceFingerprint: plan.sourceFingerprint,
    runFingerprint: observation.runFingerprint,
    artifactFingerprint: plan.artifactFingerprint,
    engineReleaseFingerprint: plan.engineReleaseFingerprint,
  });
}

function observationsOfKind<K extends PilotCaptureObservation["kind"]>(
  observations: readonly PilotCaptureObservation[],
  kind: K,
): Extract<PilotCaptureObservation, { readonly kind: K }>[] {
  return observations.filter(
    (observation): observation is Extract<PilotCaptureObservation, { readonly kind: K }> =>
      observation.kind === kind,
  );
}

function usageForObservations(
  observations: readonly PilotCaptureObservation[],
): ProviderUsageTotal {
  const managedTasks = observationsOfKind(observations, "MANAGED_TASK");
  const quickTasks = observationsOfKind(observations, "QUICK_TASK");
  const comparators = observationsOfKind(observations, "RAW_PI_COMPARATOR");
  const requests = safeUsageSum([
    ...managedTasks.map((task) => task.run.providerRequestCount),
    ...quickTasks.map((task) => task.receipt.providerRequestCount),
    ...comparators.map((item) => item.comparator.rawPiProviderRequestCount),
  ]);
  const tokens = safeUsageSum([
    ...managedTasks.map((task) => task.run.providerTokenCount),
    ...quickTasks.map((task) => task.receipt.providerTokenCount),
    ...comparators.map((item) => item.comparator.rawPiProviderTokenCount),
  ]);
  const costMinor = safeUsageSum([
    ...managedTasks.map((task) => task.run.providerCostMinor),
    ...quickTasks.map((task) => task.receipt.providerCostMinor),
    ...comparators.map((item) => item.comparator.rawPiProviderCostMinor),
  ]);
  if (requests === undefined || tokens === undefined || costMinor === undefined) {
    throw coordinatorError("PROVIDER_BUDGET_EXCEEDED", "pilot Provider usage cannot be bounded");
  }
  return providerUsageTotalSchema.parse({ requests, tokens, costMinor });
}

function assertProviderBudget(
  plan: PilotExecutionPlan,
  observations: readonly PilotCaptureObservation[],
): void {
  const usage = usageForObservations(observations);
  const scope = plan.operatorScope;
  const exceeds =
    scope.providerRequestPolicy === "NO_PROVIDER_REQUESTS"
      ? usage.requests > 0 || usage.tokens > 0 || usage.costMinor > 0
      : scope.maxProviderRequests === null ||
        scope.maxProviderTokens === null ||
        scope.maxProviderCostMinor === null ||
        usage.requests > scope.maxProviderRequests ||
        usage.tokens > scope.maxProviderTokens ||
        usage.costMinor > scope.maxProviderCostMinor;
  if (exceeds) {
    throw coordinatorError(
      "PROVIDER_BUDGET_EXCEEDED",
      "pilot Provider usage exceeds the frozen authorization budget",
    );
  }
}

function remainingProviderBudget(
  plan: PilotExecutionPlan,
  usage: ProviderUsageTotal,
): ProviderOperationIntent["reservation"] {
  const scope = plan.operatorScope;
  if (
    scope.providerRequestPolicy !== "EXPLICIT_OPERATOR_AUTHORIZED" ||
    scope.maxProviderRequests === null ||
    scope.maxProviderTokens === null ||
    scope.maxProviderCostMinor === null
  ) {
    throw coordinatorError(
      "PROVIDER_BUDGET_EXCEEDED",
      "the frozen pilot scope does not authorize a bounded Provider operation",
    );
  }
  const reservation = {
    requests: scope.maxProviderRequests - usage.requests,
    tokens: scope.maxProviderTokens - usage.tokens,
    costMinor: scope.maxProviderCostMinor - usage.costMinor,
  };
  try {
    return providerOperationIntentFactsSchema.shape.reservation.parse(reservation);
  } catch {
    throw coordinatorError(
      "PROVIDER_BUDGET_EXCEEDED",
      "the frozen pilot scope has no complete remaining Provider budget",
    );
  }
}

function countsFor(observations: readonly PilotCaptureObservation[]): PilotCaptureCounts {
  const managedTasks = observationsOfKind(observations, "MANAGED_TASK");
  const quickTasks = observationsOfKind(observations, "QUICK_TASK");
  return captureCountsSchema.parse({
    installation: observationsOfKind(observations, "INSTALLATION").length,
    taskChains: managedTasks.length + quickTasks.length,
    runArchives: managedTasks.length,
    interruptions: managedTasks.reduce((total, task) => total + task.run.recoveryLinks.length, 0),
    warmStartSamples:
      observationsOfKind(observations, "WARM_START_SAMPLES")[0]?.samplesMs.length ?? 0,
    acknowledgementSamples:
      observationsOfKind(observations, "ACKNOWLEDGEMENT_SAMPLES")[0]?.samplesMs.length ?? 0,
    updateCycles: observationsOfKind(observations, "UPDATE_ROLLBACK").length,
    pluginFixtures: observationsOfKind(observations, "PLUGIN_FIXTURE").length,
    memorySamples: observationsOfKind(observations, "MEMORY_SAMPLES")[0]?.samplesMiB.length ?? 0,
    gates: observationsOfKind(observations, "GATES").length,
    ciReceipts: observationsOfKind(observations, "CI").length,
    rawPiComparators: observationsOfKind(observations, "RAW_PI_COMPARATOR").length,
  });
}

function countsAreComplete(plan: PilotExecutionPlan, counts: PilotCaptureCounts): boolean {
  return (
    counts.installation === 1 &&
    counts.taskChains === 10 &&
    counts.runArchives === plan.tasks.filter((task) => task.mode === "MANAGED").length &&
    counts.interruptions === 3 &&
    counts.warmStartSamples >= 20 &&
    counts.acknowledgementSamples >= 30 &&
    counts.updateCycles === 2 &&
    counts.pluginFixtures === 5 &&
    counts.memorySamples >= 30 &&
    counts.gates === 1 &&
    counts.ciReceipts === 2 &&
    counts.rawPiComparators === 3
  );
}

function nextActionsFor(
  counts: PilotCaptureCounts,
  observations: readonly PilotCaptureObservation[],
): PilotCaptureNextAction[] {
  const actions: PilotCaptureNextAction[] = [];
  if (counts.installation < 1) actions.push("RECORD_INSTALLATION");
  if (counts.taskChains < 10) actions.push("RECORD_TASK_CHAINS");
  if (counts.interruptions < 3) actions.push("RECORD_INTERRUPTION_RECOVERY");
  if (counts.warmStartSamples < 20) actions.push("RECORD_WARM_START_SAMPLES");
  if (counts.acknowledgementSamples < 30) actions.push("RECORD_ACKNOWLEDGEMENT_SAMPLES");
  if (counts.updateCycles < 2) actions.push("RECORD_UPDATE_ROLLBACK");
  if (counts.pluginFixtures < 5) actions.push("RECORD_PLUGIN_FIXTURES");
  if (counts.memorySamples < 30) actions.push("RECORD_MEMORY_SAMPLES");
  if (counts.gates < 1) actions.push("RECORD_GATES");
  const ciPlatforms = new Set(observationsOfKind(observations, "CI").map((item) => item.platform));
  if (!ciPlatforms.has("WINDOWS")) actions.push("RECORD_WINDOWS_CI");
  if (!ciPlatforms.has("UBUNTU")) actions.push("RECORD_UBUNTU_CI");
  if (counts.rawPiComparators < 3) actions.push("RECORD_RAW_PI_COMPARATORS");
  return actions;
}

function assertObservationValid(
  plan: PilotExecutionPlan,
  existing: readonly PilotCaptureObservation[],
  candidate: PilotCaptureObservation,
): void {
  const observations = [...existing, candidate];
  let counts: PilotCaptureCounts;
  try {
    counts = countsFor(observations);
  } catch {
    throw coordinatorError("OBSERVATION_INVALID", "pilot capture observation count is invalid");
  }

  switch (candidate.kind) {
    case "INSTALLATION":
    case "WARM_START_SAMPLES":
    case "ACKNOWLEDGEMENT_SAMPLES":
    case "MEMORY_SAMPLES":
    case "GATES":
      break;
    case "MANAGED_TASK": {
      taskResultForManaged(plan, candidate);
      const plannedInterruptionIds = plan.interruptionTasks
        .filter((item) => item.taskId === candidate.taskId)
        .map((item) => item.interruptionId)
        .toSorted();
      const actualInterruptionIds = candidate.run.recoveryLinks
        .map((item) => item.interruptionId)
        .toSorted();
      if (canonicalJson(plannedInterruptionIds) !== canonicalJson(actualInterruptionIds)) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "Managed recovery links do not match the frozen interruption task",
        );
      }
      const tasks = observationsOfKind(observations, "MANAGED_TASK");
      const runIds = tasks.map((task) => task.run.runId);
      const archiveIds = tasks.map((task) => task.run.archiveId);
      if (
        new Set(runIds).size !== runIds.length ||
        new Set(archiveIds).size !== archiveIds.length
      ) {
        throw coordinatorError("OBSERVATION_INVALID", "pilot Run identities must be unique");
      }
      break;
    }
    case "QUICK_TASK": {
      taskResultForQuick(plan, candidate);
      break;
    }
    case "UPDATE_ROLLBACK": {
      updateCycleFor(plan, candidate);
      const cycles = observationsOfKind(observations, "UPDATE_ROLLBACK");
      if (new Set(cycles.map((cycle) => cycle.cycleId)).size !== cycles.length) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot update cycle identities must be unique",
        );
      }
      break;
    }
    case "PLUGIN_FIXTURE":
      pluginFixtureFor(plan, candidate);
      break;
    case "CI": {
      try {
        ciReceiptFor(plan, candidate);
      } catch {
        throw coordinatorError("OBSERVATION_INVALID", "pilot CI observation is invalid");
      }
      const ci = observationsOfKind(observations, "CI");
      if (new Set(ci.map((item) => item.runFingerprint)).size !== ci.length) {
        throw coordinatorError("OBSERVATION_INVALID", "pilot CI Run identities must be distinct");
      }
      break;
    }
    case "RAW_PI_COMPARATOR": {
      const task = [
        ...observationsOfKind(observations, "MANAGED_TASK"),
        ...observationsOfKind(observations, "QUICK_TASK"),
      ].find((entry) =>
        entry.kind === "MANAGED_TASK"
          ? entry.taskId === candidate.comparator.taskId
          : entry.receipt.taskId === candidate.comparator.taskId,
      );
      if (task === undefined) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "raw Pi comparison requires the paired Hunter task result",
        );
      }
      comparatorFor(plan, candidate, task);
      break;
    }
  }

  assertProviderBudget(plan, observations);
  if (countsAreComplete(plan, counts)) {
    buildEvidenceDraft(plan, observations, "2000-01-01T00:00:00.000Z");
  }
}

function requiredSingle<K extends PilotCaptureObservation["kind"]>(
  observations: readonly PilotCaptureObservation[],
  kind: K,
): Extract<PilotCaptureObservation, { readonly kind: K }> {
  const matches = observationsOfKind(observations, kind);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw coordinatorError("INCOMPLETE", "pilot capture observations are incomplete");
  }
  return matches[0];
}

function buildEvidenceDraft(
  plan: PilotExecutionPlan,
  observations: readonly PilotCaptureObservation[],
  observedAt: string,
): PilotEvidenceDraft {
  const counts = countsFor(observations);
  if (!countsAreComplete(plan, counts)) {
    throw coordinatorError("INCOMPLETE", "pilot capture observations are incomplete");
  }
  const taskOracles = taskOraclesFor(plan);
  const managedTaskObservations = observationsOfKind(observations, "MANAGED_TASK");
  const quickTaskObservations = observationsOfKind(observations, "QUICK_TASK");
  const taskById = new Map<string, ManagedTaskObservation | QuickTaskObservation>([
    ...managedTaskObservations.map((task) => [task.taskId, task] as const),
    ...quickTaskObservations.map((task) => [task.receipt.taskId, task] as const),
  ]);
  const comparatorObservationByTaskId = new Map(
    observationsOfKind(observations, "RAW_PI_COMPARATOR").map((item) => [
      item.comparator.taskId,
      item.comparator,
    ]),
  );
  const taskResults = taskOracles.map((oracle) => {
    const task = taskById.get(oracle.taskId);
    if (task === undefined) {
      throw coordinatorError("INCOMPLETE", "pilot task observations are incomplete");
    }
    const comparator = comparatorObservationByTaskId.get(oracle.taskId);
    return taskResultFor(
      plan,
      task,
      comparator === undefined
        ? undefined
        : {
            capturedFactCount: comparator.rawPiCapturedFactCount,
            manualInterventions: comparator.rawPiManualInterventions,
          },
    );
  });
  const runArchives = managedTaskObservations.map((task) => runReceiptFor(plan, task));
  const quickTaskReceipts = quickTaskObservations.map((task) => quickReceiptFor(plan, task));
  const managedTaskById = new Map(managedTaskObservations.map((task) => [task.taskId, task]));
  const interruptions = plan.interruptionTasks.map((planned): PilotInterruption => {
    const task = managedTaskById.get(planned.taskId);
    const link = task?.run.recoveryLinks.find(
      (candidate) => candidate.interruptionId === planned.interruptionId,
    );
    if (task === undefined || link === undefined) {
      throw coordinatorError("INCOMPLETE", "pilot interruption observations are incomplete");
    }
    return pilotInterruptionSchema.parse({
      interruptionId: planned.interruptionId,
      taskId: planned.taskId,
      kind: planned.kind,
      runId: task.run.runId,
      archiveFingerprint: task.run.archiveFingerprint,
      checkpointId: link.checkpointId,
      interruptedAttemptId: link.interruptedAttemptId,
      recoveryAttemptId: link.recoveryAttemptId,
      historyPreserved: true,
      sourcePreserved: task.sourcePreserved,
      resumeOutcome: task.run.terminalOutcome,
      actionableWithinFiveMinutes: link.actionableWithinFiveMinutes,
    });
  });
  const warmStart = requiredSingle(observations, "WARM_START_SAMPLES");
  const acknowledgement = requiredSingle(observations, "ACKNOWLEDGEMENT_SAMPLES");
  const memory = requiredSingle(observations, "MEMORY_SAMPLES");
  const gates = requiredSingle(observations, "GATES");
  const updateByCandidate = new Map(
    observationsOfKind(observations, "UPDATE_ROLLBACK").map((item) => [item.candidateId, item]),
  );
  const updateRollbackCycles = plan.updateCandidates.map((candidate) => {
    const observation = updateByCandidate.get(candidate.candidateId);
    if (observation === undefined) {
      throw coordinatorError("INCOMPLETE", "pilot update observations are incomplete");
    }
    return updateCycleFor(plan, observation);
  });
  const pluginById = new Map(
    observationsOfKind(observations, "PLUGIN_FIXTURE").map((item) => [item.fixtureId, item]),
  );
  const pluginFixtures = plan.pluginFixtures.map((fixture) => {
    const observation = pluginById.get(fixture.fixtureId);
    if (observation === undefined) {
      throw coordinatorError("INCOMPLETE", "pilot Plugin observations are incomplete");
    }
    return pluginFixtureFor(plan, observation);
  });
  const ciByPlatform = new Map(
    observationsOfKind(observations, "CI").map((item) => [item.platform, item]),
  );
  const windowsCi = ciByPlatform.get("WINDOWS");
  const ubuntuCi = ciByPlatform.get("UBUNTU");
  if (windowsCi === undefined || ubuntuCi === undefined) {
    throw coordinatorError("INCOMPLETE", "pilot CI observations are incomplete");
  }
  const comparatorByTaskId = new Map(
    observationsOfKind(observations, "RAW_PI_COMPARATOR").map((item) => [
      item.comparator.taskId,
      item,
    ]),
  );
  const pairedComparators = plan.pairedTaskIds.map((taskId) => {
    const comparator = comparatorByTaskId.get(taskId);
    const task = taskById.get(taskId);
    if (comparator === undefined || task === undefined) {
      throw coordinatorError("INCOMPLETE", "pilot comparator observations are incomplete");
    }
    return comparatorFor(plan, comparator, task);
  });
  const installation = requiredSingle(observations, "INSTALLATION");
  const draft: PilotEvidenceDraft = {
    schemaVersion: "hpi-pilot-evidence.v7",
    planFingerprint: plan.planFingerprint,
    operatorScope: plan.operatorScope,
    machine: plan.machineProfile,
    installation: {
      status: "PASS",
      sourceFingerprint: plan.sourceFingerprint,
      artifactFingerprint: plan.artifactFingerprint,
      cleanProfileFingerprint: installation.cleanProfileFingerprint,
    },
    taskOracles,
    taskResults,
    quickTaskReceipts,
    runArchives,
    interruptions,
    discardedWarmups: warmStart.discardedWarmups,
    warmStartSamplesMs: warmStart.samplesMs,
    acknowledgementSamplesMs: acknowledgement.samplesMs,
    updateRollbackCycles,
    pluginFixtures,
    memorySamplesMiB: memory.samplesMiB,
    storageGate: gates.storageGate,
    manualStateEditingRequired: gates.manualStateEditingRequired,
    privacyGate: gates.privacyGate,
    providerLatencySeparated: gates.providerLatencySeparated,
    reviewP0P1Count: gates.reviewP0P1Count,
    ci: {
      sourceFingerprint: plan.sourceFingerprint,
      windows: ciReceiptFor(plan, windowsCi),
      ubuntu: ciReceiptFor(plan, ubuntuCi),
    },
    pairedComparators,
    observedAt,
  };
  try {
    finalizePilotEvidenceDraft(plan, draft);
    return draft;
  } catch (error) {
    if (error instanceof PilotCaptureCoordinatorError) throw error;
    throw coordinatorError("OBSERVATION_INVALID", "pilot capture projection is invalid");
  }
}

function statusFor(
  header: SessionHeader,
  events: readonly CaptureEvent[],
  intent: FinalizationIntent | undefined,
  commit: FinalizationCommit | undefined,
): PilotCaptureStatus {
  const observations = events.map((event) => event.observation);
  const counts = countsFor(observations);
  const providerUsage = usageForObservations(observations);
  let state: PilotCaptureStatus["state"];
  let nextActions: PilotCaptureNextAction[];
  let archiveFingerprint: Fingerprint | null = null;
  if (commit !== undefined) {
    state = "ARCHIVED";
    nextActions = ["COMPLETE"];
    archiveFingerprint = commit.archiveFingerprint;
  } else if (intent !== undefined) {
    state = "FINALIZING";
    nextActions = ["RETRY_FINALIZE"];
  } else if (countsAreComplete(header.plan, counts)) {
    buildEvidenceDraft(header.plan, observations, "2000-01-01T00:00:00.000Z");
    state = "READY_TO_FINALIZE";
    nextActions = ["FINALIZE_ARCHIVE"];
  } else {
    state = "COLLECTING";
    nextActions = nextActionsFor(counts, observations);
  }
  return pilotCaptureStatusSchema.parse({
    schemaVersion: "hpi-pilot-capture-status.v1",
    sessionId: header.sessionId,
    archiveId: header.archiveId,
    planFingerprint: header.plan.planFingerprint,
    state,
    counts,
    providerUsage,
    nextActions,
    archiveFingerprint,
  });
}

interface LoadedCaptureSession {
  readonly key: Uint8Array;
  readonly header: SessionHeader;
  readonly events: readonly CaptureEvent[];
  readonly providerIntents: readonly ProviderOperationIntent[];
  readonly intent: FinalizationIntent | undefined;
  readonly commit: FinalizationCommit | undefined;
  readonly directory: string;
  readonly eventsDirectory: string;
}

export interface FilePilotCaptureCoordinatorOptions {
  readonly stateRoot: string;
  readonly archiveStateRoot: string;
  readonly managedRunStateRoot?: string;
  readonly now?: () => string;
}

function sessionDirectoryFor(stateRoot: string, sessionId: string): string {
  return join(stateRoot, "sessions", sessionId);
}

function timestampFrom(now: () => string): string {
  try {
    return timestampSchema.parse(now());
  } catch {
    throw coordinatorError(
      "STORE_FAILURE",
      "pilot capture clock did not provide a valid timestamp",
    );
  }
}

async function ensureCaptureDirectory(directory: string): Promise<void> {
  try {
    await assertSafeDirectoryPath(directory);
    await mkdir(directory, { recursive: true });
    await assertSafeDirectoryPath(directory);
  } catch (error) {
    if (error instanceof PilotCaptureCoordinatorError) throw error;
    throw coordinatorError("STORE_FAILURE", "pilot capture directory could not be prepared safely");
  }
}

async function assertExistingCaptureDirectory(directory: string): Promise<void> {
  try {
    if (!(await pathExists(directory))) {
      throw coordinatorError("SESSION_NOT_FOUND", "pilot capture session was not found");
    }
    await assertSafeDirectoryPath(directory);
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture session directory is invalid");
    }
  } catch (error) {
    if (error instanceof PilotCaptureCoordinatorError) throw error;
    throw coordinatorError("SESSION_CORRUPT", "pilot capture session directory is invalid");
  }
}

async function writeCaptureFile(
  directory: string,
  filename: string,
  value: unknown,
): Promise<void> {
  try {
    await writeImmutableAtomically({
      directory,
      filename,
      content: `${canonicalJson(value)}\n`,
    });
  } catch {
    throw coordinatorError("STORE_FAILURE", "pilot capture state could not be written durably");
  }
}

async function readCaptureKey(stateRoot: string): Promise<Uint8Array> {
  const path = join(stateRoot, keyFilename);
  if (!(await pathExists(path))) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture integrity key is missing");
  }
  const record = await readExactJsonFile(path, captureKeySchema);
  const key = Buffer.from(record.keyBase64, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== record.keyBase64) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture integrity key is invalid");
  }
  return key;
}

async function loadOrCreateCaptureKey(stateRoot: string): Promise<Uint8Array> {
  await ensureCaptureDirectory(stateRoot);
  const path = join(stateRoot, keyFilename);
  if (!(await pathExists(path))) {
    const sessionsDirectory = join(stateRoot, "sessions");
    if (await pathExists(sessionsDirectory)) {
      await assertExistingCaptureDirectory(sessionsDirectory);
      const entries = await readdir(sessionsDirectory, { withFileTypes: true });
      if (entries.some((entry) => !entry.name.startsWith(".pending-"))) {
        throw coordinatorError(
          "SESSION_CORRUPT",
          "pilot capture integrity key is missing for existing sessions",
        );
      }
    }
    await writeCaptureFile(stateRoot, keyFilename, {
      schemaVersion: "hpi-pilot-capture-key.v1",
      keyBase64: randomBytes(32).toString("base64"),
    });
  }
  return readCaptureKey(stateRoot);
}

function headerFacts(header: SessionHeader): z.infer<typeof sessionHeaderFactsSchema> {
  return {
    schemaVersion: header.schemaVersion,
    sessionId: header.sessionId,
    archiveId: header.archiveId,
    plan: header.plan,
    createdAt: header.createdAt,
  };
}

function verifySessionHeader(header: SessionHeader, key: Uint8Array): void {
  const facts = headerFacts(header);
  if (
    header.headerFingerprint !== pilotFingerprint(facts) ||
    header.proof !== captureProof(key, "SESSION", factsWithoutProof(header))
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture session header proof is invalid");
  }
}

function verifyCaptureEvent(
  event: CaptureEvent,
  key: Uint8Array,
  header: SessionHeader,
  expectedSequence: number,
  previousEventFingerprint: Fingerprint | null,
  expectedFilename: string,
): void {
  const facts = eventFacts(event);
  if (
    event.sessionId !== header.sessionId ||
    event.sequence !== expectedSequence ||
    expectedFilename !== `${String(event.sequence).padStart(6, "0")}-${event.operationId}.json` ||
    event.factKey !== factKeyFor(event.observation) ||
    event.previousEventFingerprint !== previousEventFingerprint ||
    event.eventFingerprint !== pilotFingerprint(facts) ||
    event.proof !== captureProof(key, "EVENT", factsWithoutProof(event)) ||
    Date.parse(event.observedAt) < Date.parse(header.createdAt)
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture event chain is invalid");
  }
}

async function readCaptureEvents(
  directory: string,
  key: Uint8Array,
  header: SessionHeader,
): Promise<CaptureEvent[]> {
  if (!(await pathExists(directory))) return [];
  await assertExistingCaptureDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture events could not be enumerated");
  });
  const filenames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".pending-")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture event directory is invalid");
    }
    try {
      filenames.push(eventFilenameSchema.parse(entry.name));
    } catch {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture event filename is invalid");
    }
  }
  filenames.sort((left, right) => left.localeCompare(right));

  const events: CaptureEvent[] = [];
  const operationIds = new Set<string>();
  const factKeys = new Set<string>();
  let previousFingerprint: Fingerprint | null = null;
  let previousObservedAt = header.createdAt;
  for (const [index, filename] of filenames.entries()) {
    const event = await readExactJsonFile(join(directory, filename), captureEventSchema);
    verifyCaptureEvent(event, key, header, index + 1, previousFingerprint, filename);
    if (
      operationIds.has(event.operationId) ||
      factKeys.has(event.factKey) ||
      Date.parse(event.observedAt) < Date.parse(previousObservedAt)
    ) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture event history is inconsistent");
    }
    try {
      assertObservationValid(
        header.plan,
        events.map((candidate) => candidate.observation),
        event.observation,
      );
    } catch {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture event facts are invalid");
    }
    events.push(event);
    operationIds.add(event.operationId);
    factKeys.add(event.factKey);
    previousFingerprint = event.eventFingerprint;
    previousObservedAt = event.observedAt;
  }
  return events;
}

function providerIntentFilename(operationId: string): string {
  return providerIntentFilenameSchema.parse(`provider-${operationId}.intent.json`);
}

function providerObservationTaskId(observation: PilotCaptureObservation): string | undefined {
  return observation.kind === "QUICK_TASK"
    ? observation.receipt.taskId
    : observation.kind === "RAW_PI_COMPARATOR"
      ? observation.comparator.taskId
      : undefined;
}

function verifyProviderIntent(
  intent: ProviderOperationIntent,
  filename: string,
  key: Uint8Array,
  header: SessionHeader,
  events: readonly CaptureEvent[],
): void {
  const facts = providerIntentFacts(intent);
  const priorEvents = events.slice(0, intent.eventCountBefore);
  const priorUsage = usageForObservations(priorEvents.map((event) => event.observation));
  let expectedReservation: ProviderOperationIntent["reservation"];
  try {
    expectedReservation = remainingProviderBudget(header.plan, priorUsage);
  } catch {
    throw coordinatorError("SESSION_CORRUPT", "pilot Provider intent budget is invalid");
  }
  const precedingEvent = priorEvents.at(-1);
  const completionEvent = events[intent.eventCountBefore];
  const completionUsage =
    completionEvent === undefined ? undefined : usageForObservations([completionEvent.observation]);
  if (
    filename !== providerIntentFilename(intent.operationId) ||
    intent.sessionId !== header.sessionId ||
    intent.planFingerprint !== header.plan.planFingerprint ||
    intent.eventCountBefore > events.length ||
    intent.previousEventFingerprint !== (precedingEvent?.eventFingerprint ?? null) ||
    canonicalJson(intent.usageBefore) !== canonicalJson(priorUsage) ||
    canonicalJson(intent.reservation) !== canonicalJson(expectedReservation) ||
    intent.intentFingerprint !== pilotFingerprint(facts) ||
    intent.proof !==
      captureProof(key, "PROVIDER_OPERATION_INTENT", {
        ...facts,
        intentFingerprint: intent.intentFingerprint,
      }) ||
    Date.parse(intent.observedAt) < Date.parse(precedingEvent?.observedAt ?? header.createdAt) ||
    (completionEvent !== undefined &&
      (completionEvent.operationId !== intent.operationId ||
        completionEvent.factKey !== intent.factKey ||
        completionEvent.observation.kind !== intent.kind ||
        providerObservationTaskId(completionEvent.observation) !== intent.taskId ||
        Date.parse(completionEvent.observedAt) < Date.parse(intent.observedAt) ||
        completionUsage === undefined ||
        completionUsage.requests > intent.reservation.requests ||
        completionUsage.tokens > intent.reservation.tokens ||
        completionUsage.costMinor > intent.reservation.costMinor))
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot Provider operation intent is invalid");
  }
}

async function readProviderIntents(
  directory: string,
  key: Uint8Array,
  header: SessionHeader,
  events: readonly CaptureEvent[],
): Promise<ProviderOperationIntent[]> {
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && providerIntentFilenameSchema.safeParse(entry.name).success)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const intents: ProviderOperationIntent[] = [];
  const operationIds = new Set<string>();
  for (const filename of filenames) {
    const intent = await readExactJsonFile(
      join(directory, filename),
      providerOperationIntentSchema,
    );
    if (operationIds.has(intent.operationId)) {
      throw coordinatorError("SESSION_CORRUPT", "pilot Provider intent identity is duplicated");
    }
    verifyProviderIntent(intent, filename, key, header, events);
    intents.push(intent);
    operationIds.add(intent.operationId);
  }
  return intents;
}

function unresolvedProviderIntent(
  loaded: Pick<LoadedCaptureSession, "events" | "providerIntents">,
): ProviderOperationIntent | undefined {
  return loaded.providerIntents.find(
    (intent) => loaded.events[intent.eventCountBefore]?.operationId !== intent.operationId,
  );
}

function assertNoUnresolvedProviderIntent(
  loaded: Pick<LoadedCaptureSession, "events" | "providerIntents">,
  completingOperationId?: string,
): void {
  const unresolved = unresolvedProviderIntent(loaded);
  if (unresolved !== undefined && unresolved.operationId !== completingOperationId) {
    throw coordinatorError(
      "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
      "a started pilot Provider operation has no exact durable usage receipt and will not be retried",
    );
  }
}

function verifyIntent(
  intent: FinalizationIntent,
  key: Uint8Array,
  header: SessionHeader,
  events: readonly CaptureEvent[],
): void {
  if (
    intent.sessionId !== header.sessionId ||
    intent.archiveId !== header.archiveId ||
    intent.planFingerprint !== header.plan.planFingerprint ||
    intent.proof !== captureProof(key, "FINALIZATION_INTENT", factsWithoutProof(intent)) ||
    Date.parse(intent.observedAt) < Date.parse(events.at(-1)?.observedAt ?? header.createdAt)
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture finalization intent is invalid");
  }
  try {
    const evidence = finalizePilotEvidenceDraft(
      header.plan,
      buildEvidenceDraft(
        header.plan,
        events.map((event) => event.observation),
        intent.observedAt,
      ),
    );
    if (pilotFingerprint(evidence) !== intent.evidenceFingerprint) {
      throw new Error("fingerprint mismatch");
    }
  } catch {
    throw coordinatorError(
      "SESSION_CORRUPT",
      "pilot capture finalization intent does not bind the observed facts",
    );
  }
}

function verifyCommit(
  commit: FinalizationCommit,
  key: Uint8Array,
  header: SessionHeader,
  intent: FinalizationIntent | undefined,
): void {
  if (
    intent === undefined ||
    commit.sessionId !== header.sessionId ||
    commit.archiveId !== header.archiveId ||
    commit.planFingerprint !== header.plan.planFingerprint ||
    commit.evidenceFingerprint !== intent.evidenceFingerprint ||
    commit.observedAt !== intent.observedAt ||
    commit.proof !== captureProof(key, "FINALIZATION_COMMIT", factsWithoutProof(commit))
  ) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture finalization commit is invalid");
  }
}

async function validateSessionDirectoryEntries(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Set([sessionFilename, finalizationIntentFilename, finalizationCommitFilename]);
  for (const entry of entries) {
    if (entry.name.startsWith(".pending-")) continue;
    if (entry.name === eventsDirectoryName) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw coordinatorError("SESSION_CORRUPT", "pilot capture events directory is invalid");
      }
      continue;
    }
    if (providerIntentFilenameSchema.safeParse(entry.name).success) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw coordinatorError("SESSION_CORRUPT", "pilot Provider intent path is invalid");
      }
      continue;
    }
    if (!files.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture session contains unknown state");
    }
  }
}

async function loadCaptureSession(
  stateRoot: string,
  sessionId: string,
): Promise<LoadedCaptureSession> {
  const directory = sessionDirectoryFor(stateRoot, sessionId);
  await assertExistingCaptureDirectory(directory);
  await validateSessionDirectoryEntries(directory);
  const headerPath = join(directory, sessionFilename);
  if (!(await pathExists(headerPath))) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture session header is missing");
  }
  const key = await readCaptureKey(stateRoot);
  const header = await readExactJsonFile(headerPath, sessionHeaderSchema);
  verifySessionHeader(header, key);
  if (header.sessionId !== sessionId) {
    throw coordinatorError("SESSION_CORRUPT", "pilot capture session identity is invalid");
  }
  const eventsDirectory = join(directory, eventsDirectoryName);
  const events = await readCaptureEvents(eventsDirectory, key, header);
  const providerIntents = await readProviderIntents(directory, key, header, events);
  const intentPath = join(directory, finalizationIntentFilename);
  const commitPath = join(directory, finalizationCommitFilename);
  const intent = (await pathExists(intentPath))
    ? await readExactJsonFile(intentPath, finalizationIntentSchema)
    : undefined;
  if (intent !== undefined) verifyIntent(intent, key, header, events);
  const commit = (await pathExists(commitPath))
    ? await readExactJsonFile(commitPath, finalizationCommitSchema)
    : undefined;
  if (commit !== undefined) verifyCommit(commit, key, header, intent);
  return { key, header, events, providerIntents, intent, commit, directory, eventsDirectory };
}

function assertArchiveMatches(
  trusted: TrustedPilotArchive,
  header: SessionHeader,
  intent: FinalizationIntent,
  commit?: FinalizationCommit,
): void {
  const archive = trusted.archive;
  if (
    archive.archiveId !== header.archiveId ||
    archive.planFingerprint !== header.plan.planFingerprint ||
    archive.evidenceFingerprint !== intent.evidenceFingerprint ||
    archive.evidence.observedAt !== intent.observedAt ||
    archive.observedAt !== intent.observedAt ||
    (commit !== undefined && archive.archiveFingerprint !== commit.archiveFingerprint)
  ) {
    throw coordinatorError("ARCHIVE_MISMATCH", "pilot Archive does not match the capture session");
  }
}

async function publishProviderOperationIntent(options: {
  readonly loaded: LoadedCaptureSession;
  readonly operationId: string;
  readonly taskId: string;
  readonly kind: "QUICK_TASK" | "RAW_PI_COMPARATOR";
  readonly factKey: string;
  readonly inputFingerprint: Fingerprint;
  readonly now: () => string;
}): Promise<void> {
  assertNoUnresolvedProviderIntent(options.loaded);
  if (options.loaded.providerIntents.some((intent) => intent.operationId === options.operationId)) {
    throw coordinatorError(
      "OPERATION_CONFLICT",
      "pilot Provider operation identity already has an immutable intent",
    );
  }
  const usageBefore = usageForObservations(options.loaded.events.map((event) => event.observation));
  const observedAt = timestampFrom(options.now);
  if (
    Date.parse(observedAt) <
    Date.parse(options.loaded.events.at(-1)?.observedAt ?? options.loaded.header.createdAt)
  ) {
    throw coordinatorError("STORE_FAILURE", "pilot capture clock moved before durable history");
  }
  const facts = providerOperationIntentFactsSchema.parse({
    schemaVersion: "hpi-pilot-provider-operation-intent.v1",
    sessionId: options.loaded.header.sessionId,
    planFingerprint: options.loaded.header.plan.planFingerprint,
    operationId: options.operationId,
    taskId: options.taskId,
    kind: options.kind,
    factKey: options.factKey,
    inputFingerprint: options.inputFingerprint,
    eventCountBefore: options.loaded.events.length,
    previousEventFingerprint: options.loaded.events.at(-1)?.eventFingerprint ?? null,
    usageBefore,
    reservation: remainingProviderBudget(options.loaded.header.plan, usageBefore),
    observedAt,
  });
  const intentFingerprint = pilotFingerprint(facts);
  const intent = providerOperationIntentSchema.parse({
    ...facts,
    intentFingerprint,
    proof: captureProof(options.loaded.key, "PROVIDER_OPERATION_INTENT", {
      ...facts,
      intentFingerprint,
    }),
  });
  await writeCaptureFile(
    options.loaded.directory,
    providerIntentFilename(options.operationId),
    intent,
  );
}

export class FilePilotCaptureCoordinator {
  readonly #stateRoot: string;
  readonly #archiveStore: FilePilotArchiveStore;
  readonly #managedRunStateRoot: string | undefined;
  readonly #now: () => string;
  readonly #mutationLockPath: string;
  readonly #providerOperationLockPath: string;

  public constructor(options: FilePilotCaptureCoordinatorOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#archiveStore = new FilePilotArchiveStore({
      stateRoot: resolve(options.archiveStateRoot),
    });
    this.#managedRunStateRoot =
      options.managedRunStateRoot === undefined ? undefined : resolve(options.managedRunStateRoot);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#mutationLockPath = join(this.#stateRoot, ".pilot-capture-mutation.lock");
    this.#providerOperationLockPath = join(this.#stateRoot, ".pilot-provider-operation.lock");
  }

  async #withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withDurableMutationLock(this.#mutationLockPath, operation);
    } catch (error) {
      if (error instanceof PilotCaptureCoordinatorError) throw error;
      throw coordinatorError("STORE_FAILURE", "pilot capture store operation failed");
    }
  }

  async #withProviderOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withDurableMutationLock(this.#providerOperationLockPath, operation);
    } catch (error) {
      if (error instanceof PilotCaptureCoordinatorError) throw error;
      throw coordinatorError("STORE_FAILURE", "pilot Provider operation lock failed");
    }
  }

  #readCommittedArchive(loaded: LoadedCaptureSession): TrustedPilotArchive {
    if (loaded.intent === undefined || loaded.commit === undefined) {
      throw coordinatorError("SESSION_CORRUPT", "pilot capture commit binding is missing");
    }
    try {
      const trusted = this.#archiveStore.read(loaded.header.archiveId);
      assertArchiveMatches(trusted, loaded.header, loaded.intent, loaded.commit);
      return trusted;
    } catch (error) {
      if (error instanceof PilotCaptureCoordinatorError) throw error;
      throw coordinatorError(
        "ARCHIVE_MISMATCH",
        "pilot committed Archive is unavailable or invalid",
      );
    }
  }

  #statusFromLoaded(loaded: LoadedCaptureSession): PilotCaptureStatus {
    assertNoUnresolvedProviderIntent(loaded);
    if (loaded.commit !== undefined) this.#readCommittedArchive(loaded);
    return statusFor(loaded.header, loaded.events, loaded.intent, loaded.commit);
  }

  public async open(input: unknown): Promise<PilotCaptureStatus> {
    let parsed: PilotCaptureOpenInput;
    try {
      parsed = pilotCaptureOpenInputSchema.parse(input);
    } catch {
      throw coordinatorError("SESSION_CONFLICT", "pilot capture open request is invalid");
    }
    return this.#withMutationLock(async () => {
      const key = await loadOrCreateCaptureKey(this.#stateRoot);
      const directory = sessionDirectoryFor(this.#stateRoot, parsed.sessionId);
      const headerPath = join(directory, sessionFilename);
      if (!(await pathExists(directory))) await ensureCaptureDirectory(directory);
      else await assertExistingCaptureDirectory(directory);
      await validateSessionDirectoryEntries(directory);
      if (!(await pathExists(headerPath))) {
        const existing = await readdir(directory);
        if (existing.some((name) => !name.startsWith(".pending-"))) {
          throw coordinatorError(
            "SESSION_CORRUPT",
            "pilot capture session is missing its immutable header",
          );
        }
        const facts = sessionHeaderFactsSchema.parse({
          schemaVersion: "hpi-pilot-capture-session.v1",
          sessionId: parsed.sessionId,
          archiveId: parsed.archiveId,
          plan: parsed.plan,
          createdAt: timestampFrom(this.#now),
        });
        const headerFingerprint = pilotFingerprint(facts);
        const header = sessionHeaderSchema.parse({
          ...facts,
          headerFingerprint,
          proof: captureProof(key, "SESSION", { ...facts, headerFingerprint }),
        });
        await writeCaptureFile(directory, sessionFilename, header);
      }
      const loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
      if (
        loaded.header.archiveId !== parsed.archiveId ||
        loaded.header.plan.planFingerprint !== parsed.plan.planFingerprint ||
        canonicalJson(loaded.header.plan) !== canonicalJson(parsed.plan)
      ) {
        throw coordinatorError(
          "SESSION_CONFLICT",
          "pilot capture session is already bound to another immutable plan",
        );
      }
      return this.#statusFromLoaded(loaded);
    });
  }

  public async status(sessionId: string): Promise<PilotCaptureStatus> {
    let parsedSessionId: string;
    try {
      parsedSessionId = stableCaptureIdSchema.parse(sessionId);
    } catch {
      throw coordinatorError("SESSION_NOT_FOUND", "pilot capture session was not found");
    }
    return this.#withMutationLock(async () => {
      const loaded = await loadCaptureSession(this.#stateRoot, parsedSessionId);
      return this.#statusFromLoaded(loaded);
    });
  }

  public async recordManagedTask(input: unknown): Promise<PilotCaptureRecordReceipt> {
    let parsed: PilotCaptureManagedTaskInput;
    try {
      parsed = pilotCaptureManagedTaskInputV2Schema.parse(input);
      if (new Set(parsed.archiveIds).size !== parsed.archiveIds.length) {
        throw new Error("duplicate Archive identity");
      }
    } catch {
      throw coordinatorError("OBSERVATION_INVALID", "pilot managed-task request is invalid");
    }
    const managedRunStateRoot = this.#managedRunStateRoot;
    if (managedRunStateRoot === undefined) {
      throw coordinatorError("STORE_FAILURE", "pilot managed Run store is not configured");
    }
    const observation = await this.#withMutationLock(async (): Promise<ManagedTaskObservation> => {
      const loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
      if (loaded.intent !== undefined || loaded.commit !== undefined) {
        throw coordinatorError("SESSION_SEALED", "pilot capture session is sealed");
      }
      const oracle = oracleFor(loaded.header.plan, parsed.taskId);
      if (oracle.mode !== "MANAGED") {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot managed Run Archive does not match the frozen task mode",
        );
      }
      const eventStore = new FileWorkflowEventStore({
        stateRoot: join(managedRunStateRoot, "workflow"),
      });
      const kernel = new DurableWorkflowKernel(eventStore);
      const archiveStore = new FileRunArchiveStore({
        stateRoot: join(managedRunStateRoot, "archive"),
        kernel,
      });
      const archiveId = parsed.archiveIds[0];
      if (archiveId === undefined) {
        throw coordinatorError("OBSERVATION_INVALID", "pilot managed-task Archive is missing");
      }
      let package_;
      try {
        package_ = await archiveStore.readCanonicalPackage(archiveId);
      } catch {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot managed Run Archive is unavailable or invalid",
        );
      }
      const receiptEvidence = package_.evidence.filter(
        (evidence) => evidence.evidenceId === "evidence_real-task-receipt",
      );
      const capturedText = receiptEvidence[0]?.capture.capturedText;
      let receipt: z.infer<typeof realManagedChangeTaskReceiptSchema>;
      try {
        if (receiptEvidence.length !== 1 || capturedText === undefined) {
          throw new Error("task receipt missing");
        }
        receipt = realManagedChangeTaskReceiptSchema.parse(JSON.parse(capturedText) as unknown);
      } catch {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot managed Run Archive has no exact product task receipt",
        );
      }
      if (receipt.providerUsage.status !== "PASS" || receipt.providerUsage.requestCount <= 0) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot managed Run Archive has no exact Provider usage",
        );
      }
      const actualCheckFingerprints = package_.projection.planRevision.checks.map(
        (check) => check.definitionFingerprint,
      );
      const bindingFailure = [
        package_.manifest.archiveId !== archiveId,
        package_.manifest.runId !== receipt.runId,
        package_.manifest.sourceFingerprint !== oracle.sourceFingerprint,
        package_.manifest.sourceFingerprint !== receipt.sourceFingerprint,
        package_.manifest.outcome !== receipt.terminalOutcome,
        package_.projection.change.lifecycle !== package_.manifest.outcome,
        package_.projection.run.predecessorRunId !== undefined,
        receipt.repositoryFingerprint !== oracle.repositoryFingerprint,
        receipt.targetReferenceFingerprint !== oracle.targetReferenceFingerprint,
        receipt.taskDefinitionFingerprint !== oracle.taskDefinitionFingerprint,
        canonicalJson(receipt.acceptanceCheckDefinitionFingerprints) !==
          canonicalJson(actualCheckFingerprints),
        canonicalJson(receipt.acceptanceCheckDefinitionFingerprints) !==
          canonicalJson(oracle.acceptanceCheckDefinitionFingerprints),
        receipt.reviewP0P1Count > 0,
        (receipt.taskResult === "GO") !== (receipt.terminalOutcome === "READY"),
      ].some(Boolean);
      if (bindingFailure) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot managed Run Archive does not bind the frozen task facts",
        );
      }
      const plannedInterruptions = loaded.header.plan.interruptionTasks.filter(
        (item) => item.taskId === parsed.taskId,
      );
      const recoveryAttempts = package_.projection.attempts.filter(
        (attempt) => attempt.recoveryCheckpointId !== undefined,
      );
      const expectedProcessInterruption = plannedInterruptions[0];
      if (
        plannedInterruptions.length !== recoveryAttempts.length ||
        (expectedProcessInterruption === undefined
          ? receipt.interruptionKind !== null
          : receipt.interruptionKind !==
            processInterruptionForPlanKind(expectedProcessInterruption.kind))
      ) {
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "pilot Managed Archive recovery history does not match the frozen task",
        );
      }
      const recoveryLinks = recoveryAttempts.map((attempt, index) => {
        const planned = plannedInterruptions[index];
        const checkpoint = package_.projection.checkpoints.find(
          (candidate) => candidate.checkpointId === attempt.recoveryCheckpointId,
        );
        if (
          planned === undefined ||
          checkpoint === undefined ||
          attempt.previousAttemptId === undefined ||
          checkpoint.attemptId !== attempt.previousAttemptId
        ) {
          throw coordinatorError(
            "OBSERVATION_INVALID",
            "pilot Managed Archive has an invalid Checkpoint recovery link",
          );
        }
        const recoveryDelayMs = Date.parse(attempt.startedAt) - Date.parse(checkpoint.createdAt);
        return pilotRunRecoveryLinkSchema.parse({
          interruptionId: planned.interruptionId,
          kind: planned.kind,
          checkpointId: checkpoint.checkpointId,
          interruptedAttemptId: attempt.previousAttemptId,
          recoveryAttemptId: attempt.attemptId,
          actionableWithinFiveMinutes: recoveryDelayMs >= 0 && recoveryDelayMs <= 300_000,
        });
      });
      const providerUsage = receipt.providerUsage;
      const metrics = {
        applicableFactCount: 20,
        capturedFactCount: 20,
        manualInterventions: 0,
        rawPiCapturedFactCount: 0,
        rawPiManualInterventions: 0,
      };
      return managedTaskObservationSchema.parse({
        kind: "MANAGED_TASK",
        taskId: parsed.taskId,
        terminalOutcome: package_.manifest.outcome,
        sourcePreserved: receipt.sourcePreserved,
        rawSecretLeakage: receipt.rawSecretLeakage,
        applicableFactCount: metrics.applicableFactCount,
        capturedFactCount: metrics.capturedFactCount,
        manualInterventions: metrics.manualInterventions,
        hunterOverheadMinutes: receipt.overheadMs / 60_000,
        rawPiCapturedFactCount: metrics.rawPiCapturedFactCount,
        rawPiManualInterventions: metrics.rawPiManualInterventions,
        run: {
          runId: package_.manifest.runId,
          archiveId: package_.manifest.archiveId,
          archiveFingerprint: fingerprintSchema.parse(archivePackageFingerprint(package_)),
          terminalOutcome: package_.manifest.outcome,
          providerRequestCount: providerUsage.requestCount,
          providerTokenCount: providerUsage.tokenCount,
          providerCostMinor: providerUsage.costMinorUnits,
          recoveryLinks,
        },
      });
    });
    return this.#recordParsed(
      pilotCaptureProductRecordInputSchema.parse({
        schemaVersion: "hpi-pilot-capture-record.v1",
        sessionId: parsed.sessionId,
        operationId: parsed.operationId,
        observation,
      }),
    );
  }

  public async recordQuickTask(
    runtime: unknown,
    input: unknown,
  ): Promise<PilotCaptureRecordReceipt> {
    const execute = quickTaskExecutorFor(runtime);
    if (execute === undefined) {
      throw coordinatorError(
        "OBSERVATION_INVALID",
        "pilot Quick-task execution requires the bundled product runtime",
      );
    }
    let parsed: PilotCaptureQuickTaskInput;
    try {
      parsed = pilotCaptureQuickTaskInputSchema.parse(input);
    } catch {
      throw coordinatorError("OBSERVATION_INVALID", "pilot Quick-task request is invalid");
    }
    return this.#withProviderOperationLock(async () => {
      const prepared = await this.#withMutationLock(async () => {
        const loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
        if (loaded.intent !== undefined || loaded.commit !== undefined) {
          throw coordinatorError("SESSION_SEALED", "pilot capture session is sealed");
        }
        const existingOperation = loaded.events.find(
          (event) => event.operationId === parsed.operationId,
        );
        if (existingOperation !== undefined) {
          if (
            existingOperation.observation.kind !== "QUICK_TASK" ||
            existingOperation.observation.receipt.taskId !== parsed.taskId ||
            loaded.providerIntents.find((intent) => intent.operationId === parsed.operationId)
              ?.inputFingerprint !== pilotFingerprint(parsed)
          ) {
            throw coordinatorError(
              "OPERATION_CONFLICT",
              "pilot capture operation identity is already bound to other facts",
            );
          }
          return {
            replay: pilotCaptureRecordReceiptSchema.parse({
              schemaVersion: "hpi-pilot-capture-record-receipt.v1",
              sessionId: parsed.sessionId,
              operationId: parsed.operationId,
              outcome: "REPLAYED",
              sequence: existingOperation.sequence,
              eventFingerprint: existingOperation.eventFingerprint,
              status: this.#statusFromLoaded(loaded),
            }),
          } as const;
        }
        if (loaded.events.some((event) => event.factKey === `task.${parsed.taskId}`)) {
          throw coordinatorError(
            "FACT_CONFLICT",
            "pilot task identity is already bound to another operation",
          );
        }
        const oracle = oracleFor(loaded.header.plan, parsed.taskId);
        if (
          oracle.mode !== "QUICK" ||
          !pilotRuntimeBindingMatchesPlan(loaded.header.plan, parsed.runtimeBinding) ||
          loaded.header.plan.workflowFactChecklistFingerprint !==
            pilotQuickWorkflowFactChecklistFingerprint ||
          parsed.request.target.repositoryFingerprint !== oracle.repositoryFingerprint ||
          parsed.request.target.sourceFingerprint !== oracle.sourceFingerprint ||
          parsed.request.target.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
          fingerprintRealManagedChangeTaskDefinition(parsed.request) !==
            oracle.taskDefinitionFingerprint ||
          oracle.acceptanceCheckDefinitionFingerprints.length !== 1 ||
          fingerprintRealManagedChangeCheckDefinition(parsed.request) !==
            oracle.acceptanceCheckDefinitionFingerprints[0]
        ) {
          throw coordinatorError(
            "OBSERVATION_INVALID",
            "pilot Quick-task input does not bind the frozen plan",
          );
        }
        remainingProviderBudget(
          loaded.header.plan,
          usageForObservations(loaded.events.map((event) => event.observation)),
        );
        await publishProviderOperationIntent({
          loaded,
          operationId: parsed.operationId,
          taskId: parsed.taskId,
          kind: "QUICK_TASK",
          factKey: `task.${parsed.taskId}`,
          inputFingerprint: pilotFingerprint(parsed),
          now: this.#now,
        });
        return { plan: loaded.header.plan, oracle } as const;
      });
      if ("replay" in prepared) return prepared.replay;
      let receipt: PilotQuickTaskReceipt;
      try {
        receipt = await execute({
          plan: prepared.plan,
          oracle: prepared.oracle,
          repository: parsed.repository,
          request: parsed.request,
        });
        quickReceiptFor(prepared.plan, { kind: "QUICK_TASK", receipt });
      } catch (error) {
        if (error instanceof PilotCaptureCoordinatorError) throw error;
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "the product could not derive one valid Quick-task receipt",
        );
      }
      return this.#recordParsed(
        pilotCaptureProductRecordInputSchema.parse({
          schemaVersion: "hpi-pilot-capture-record.v1",
          sessionId: parsed.sessionId,
          operationId: parsed.operationId,
          observation: { kind: "QUICK_TASK", receipt },
        }),
        parsed.operationId,
      );
    });
  }

  public async recordRawComparator(
    runtime: unknown,
    input: unknown,
  ): Promise<PilotCaptureRecordReceipt> {
    const execute = rawComparatorExecutorFor(runtime);
    if (execute === undefined) {
      throw coordinatorError(
        "OBSERVATION_INVALID",
        "pilot raw-comparator execution requires the bundled product runtime",
      );
    }
    let parsed: PilotCaptureRawComparatorInput;
    try {
      parsed = pilotCaptureRawComparatorInputSchema.parse(input);
    } catch {
      throw coordinatorError("OBSERVATION_INVALID", "pilot raw-comparator request is invalid");
    }
    return this.#withProviderOperationLock(async () => {
      const prepared = await this.#withMutationLock(async () => {
        const loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
        if (loaded.intent !== undefined || loaded.commit !== undefined) {
          throw coordinatorError("SESSION_SEALED", "pilot capture session is sealed");
        }
        const existingOperation = loaded.events.find(
          (event) => event.operationId === parsed.operationId,
        );
        if (existingOperation !== undefined) {
          if (
            existingOperation.observation.kind !== "RAW_PI_COMPARATOR" ||
            existingOperation.observation.comparator.taskId !== parsed.taskId ||
            loaded.providerIntents.find((intent) => intent.operationId === parsed.operationId)
              ?.inputFingerprint !== pilotFingerprint(parsed)
          ) {
            throw coordinatorError(
              "OPERATION_CONFLICT",
              "pilot capture operation identity is already bound to other facts",
            );
          }
          return {
            replay: pilotCaptureRecordReceiptSchema.parse({
              schemaVersion: "hpi-pilot-capture-record-receipt.v1",
              sessionId: parsed.sessionId,
              operationId: parsed.operationId,
              outcome: "REPLAYED",
              sequence: existingOperation.sequence,
              eventFingerprint: existingOperation.eventFingerprint,
              status: this.#statusFromLoaded(loaded),
            }),
          } as const;
        }
        if (loaded.events.some((event) => event.factKey === `comparator.${parsed.taskId}`)) {
          throw coordinatorError(
            "FACT_CONFLICT",
            "pilot comparator identity is already bound to another operation",
          );
        }
        if (!loaded.header.plan.pairedTaskIds.includes(parsed.taskId)) {
          throw coordinatorError(
            "OBSERVATION_INVALID",
            "the raw comparator task is outside the frozen paired set",
          );
        }
        const oracle = oracleFor(loaded.header.plan, parsed.taskId);
        const taskObservation = [
          ...observationsOfKind(
            loaded.events.map((event) => event.observation),
            "MANAGED_TASK",
          ),
          ...observationsOfKind(
            loaded.events.map((event) => event.observation),
            "QUICK_TASK",
          ),
        ].find((entry) =>
          entry.kind === "MANAGED_TASK"
            ? entry.taskId === parsed.taskId
            : entry.receipt.taskId === parsed.taskId,
        );
        if (taskObservation === undefined) {
          throw coordinatorError(
            "OBSERVATION_INVALID",
            "the product-derived Hunter task must be recorded before its raw comparator",
          );
        }
        if (
          !pilotRuntimeBindingMatchesPlan(loaded.header.plan, parsed.runtimeBinding) ||
          loaded.header.plan.workflowFactChecklistFingerprint !==
            pilotQuickWorkflowFactChecklistFingerprint ||
          loaded.header.plan.comparatorConfigurationFingerprint !==
            parsed.comparatorConfigurationFingerprint ||
          parsed.request.target.repositoryFingerprint !== oracle.repositoryFingerprint ||
          parsed.request.target.sourceFingerprint !== oracle.sourceFingerprint ||
          parsed.request.target.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
          fingerprintRealManagedChangeTaskDefinition(parsed.request) !==
            oracle.taskDefinitionFingerprint ||
          oracle.acceptanceCheckDefinitionFingerprints.length !== 1 ||
          fingerprintRealManagedChangeCheckDefinition(parsed.request) !==
            oracle.acceptanceCheckDefinitionFingerprints[0]
        ) {
          throw coordinatorError(
            "OBSERVATION_INVALID",
            "pilot raw-comparator input does not bind the frozen plan",
          );
        }
        remainingProviderBudget(
          loaded.header.plan,
          usageForObservations(loaded.events.map((event) => event.observation)),
        );
        await publishProviderOperationIntent({
          loaded,
          operationId: parsed.operationId,
          taskId: parsed.taskId,
          kind: "RAW_PI_COMPARATOR",
          factKey: `comparator.${parsed.taskId}`,
          inputFingerprint: pilotFingerprint(parsed),
          now: this.#now,
        });
        return {
          plan: loaded.header.plan,
          oracle,
          taskObservation,
          hunterResult: taskResultFor(loaded.header.plan, taskObservation),
        } as const;
      });
      if ("replay" in prepared) return prepared.replay;
      let comparator: PilotComparator;
      try {
        comparator = await execute({
          plan: prepared.plan,
          oracle: prepared.oracle,
          hunterResult: prepared.hunterResult,
          repository: parsed.repository,
          request: parsed.request,
        });
        comparatorFor(
          prepared.plan,
          { kind: "RAW_PI_COMPARATOR", comparator },
          prepared.taskObservation,
        );
      } catch (error) {
        if (error instanceof PilotCaptureCoordinatorError) throw error;
        throw coordinatorError(
          "OBSERVATION_INVALID",
          "the product could not derive one valid raw Pi comparator receipt",
        );
      }
      return this.#recordParsed(
        pilotCaptureProductRecordInputSchema.parse({
          schemaVersion: "hpi-pilot-capture-record.v1",
          sessionId: parsed.sessionId,
          operationId: parsed.operationId,
          observation: { kind: "RAW_PI_COMPARATOR", comparator },
        }),
        parsed.operationId,
      );
    });
  }

  public async record(input: unknown): Promise<PilotCaptureRecordReceipt> {
    let parsed: PilotCaptureRecordInput;
    try {
      parsed = pilotCaptureRecordInputSchema.parse(input);
    } catch {
      throw coordinatorError("OBSERVATION_INVALID", "pilot capture observation is invalid");
    }
    return this.#recordParsed(parsed);
  }

  /** @internal Product-derived capture path; requires a module-private runtime capability. */
  public async recordProductObservation(
    runtime: unknown,
    input: unknown,
  ): Promise<PilotCaptureRecordReceipt> {
    if (!isPilotCaptureProductObservationRuntime(runtime)) {
      throw coordinatorError("OBSERVATION_INVALID", "pilot product observation runtime is invalid");
    }
    let parsed: PilotCaptureProductRecordInput;
    try {
      parsed = pilotCaptureProductRecordInputSchema.parse(input);
    } catch {
      throw coordinatorError("OBSERVATION_INVALID", "pilot product observation is invalid");
    }
    return this.#recordParsed(parsed);
  }

  async #recordParsed(
    parsed: PilotCaptureAnyRecordInput,
    completingProviderOperationId?: string,
  ): Promise<PilotCaptureRecordReceipt> {
    return this.#withMutationLock(async () => {
      let loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
      assertNoUnresolvedProviderIntent(loaded, completingProviderOperationId);
      const pendingProviderIntent = unresolvedProviderIntent(loaded);
      if (
        completingProviderOperationId !== undefined &&
        (pendingProviderIntent?.operationId !== completingProviderOperationId ||
          parsed.operationId !== completingProviderOperationId ||
          pendingProviderIntent.factKey !== factKeyFor(parsed.observation) ||
          pendingProviderIntent.kind !== parsed.observation.kind ||
          pendingProviderIntent.taskId !== providerObservationTaskId(parsed.observation))
      ) {
        throw coordinatorError(
          "PROVIDER_USAGE_RECONCILIATION_REQUIRED",
          "the completed pilot Provider operation does not match its durable intent",
        );
      }
      if (loaded.intent !== undefined || loaded.commit !== undefined) {
        throw coordinatorError("SESSION_SEALED", "pilot capture session is sealed");
      }
      const existingOperation = loaded.events.find(
        (event) => event.operationId === parsed.operationId,
      );
      if (existingOperation !== undefined) {
        if (canonicalJson(existingOperation.observation) !== canonicalJson(parsed.observation)) {
          throw coordinatorError(
            "OPERATION_CONFLICT",
            "pilot capture operation identity is already bound to other facts",
          );
        }
        return pilotCaptureRecordReceiptSchema.parse({
          schemaVersion: "hpi-pilot-capture-record-receipt.v1",
          sessionId: parsed.sessionId,
          operationId: parsed.operationId,
          outcome: "REPLAYED",
          sequence: existingOperation.sequence,
          eventFingerprint: existingOperation.eventFingerprint,
          status: this.#statusFromLoaded(loaded),
        });
      }
      const factKey = factKeyFor(parsed.observation);
      if (loaded.events.some((event) => event.factKey === factKey)) {
        throw coordinatorError(
          "FACT_CONFLICT",
          "pilot capture fact identity is already bound to another operation",
        );
      }
      assertObservationValid(
        loaded.header.plan,
        loaded.events.map((event) => event.observation),
        parsed.observation,
      );
      const observedAt = timestampFrom(this.#now);
      const previous = loaded.events.at(-1);
      if (Date.parse(observedAt) < Date.parse(previous?.observedAt ?? loaded.header.createdAt)) {
        throw coordinatorError("STORE_FAILURE", "pilot capture clock moved before durable history");
      }
      const facts = captureEventFactsSchema.parse({
        schemaVersion: "hpi-pilot-capture-event.v1",
        sessionId: parsed.sessionId,
        sequence: loaded.events.length + 1,
        operationId: parsed.operationId,
        factKey,
        observation: parsed.observation,
        previousEventFingerprint: previous?.eventFingerprint ?? null,
        observedAt,
      });
      const eventFingerprint = pilotFingerprint(facts);
      const event = captureEventSchema.parse({
        ...facts,
        eventFingerprint,
        proof: captureProof(loaded.key, "EVENT", { ...facts, eventFingerprint }),
      });
      const filename = `${String(event.sequence).padStart(6, "0")}-${event.operationId}.json`;
      await writeCaptureFile(loaded.eventsDirectory, filename, event);
      loaded = await loadCaptureSession(this.#stateRoot, parsed.sessionId);
      const stored = loaded.events.at(-1);
      if (stored?.eventFingerprint !== event.eventFingerprint) {
        throw coordinatorError("SESSION_CORRUPT", "pilot capture event was not published exactly");
      }
      return pilotCaptureRecordReceiptSchema.parse({
        schemaVersion: "hpi-pilot-capture-record-receipt.v1",
        sessionId: parsed.sessionId,
        operationId: parsed.operationId,
        outcome: "RECORDED",
        sequence: event.sequence,
        eventFingerprint: event.eventFingerprint,
        status: this.#statusFromLoaded(loaded),
      });
    });
  }

  public async finalize(sessionId: string): Promise<TrustedPilotArchive> {
    let parsedSessionId: string;
    try {
      parsedSessionId = stableCaptureIdSchema.parse(sessionId);
    } catch {
      throw coordinatorError("SESSION_NOT_FOUND", "pilot capture session was not found");
    }
    return this.#withMutationLock(async () => {
      let loaded = await loadCaptureSession(this.#stateRoot, parsedSessionId);
      assertNoUnresolvedProviderIntent(loaded);
      if (loaded.commit !== undefined) return this.#readCommittedArchive(loaded);
      const observations = loaded.events.map((event) => event.observation);
      let intent = loaded.intent;
      if (intent === undefined) {
        const observedAt = timestampFrom(this.#now);
        if (
          Date.parse(observedAt) <
          Date.parse(loaded.events.at(-1)?.observedAt ?? loaded.header.createdAt)
        ) {
          throw coordinatorError(
            "STORE_FAILURE",
            "pilot capture clock moved before durable history",
          );
        }
        const draft = buildEvidenceDraft(loaded.header.plan, observations, observedAt);
        const evidence = finalizePilotEvidenceDraft(loaded.header.plan, draft);
        const facts = finalizationIntentFactsSchema.parse({
          schemaVersion: "hpi-pilot-capture-finalization-intent.v1",
          sessionId: loaded.header.sessionId,
          archiveId: loaded.header.archiveId,
          planFingerprint: loaded.header.plan.planFingerprint,
          evidenceFingerprint: pilotFingerprint(evidence),
          observedAt,
        });
        intent = finalizationIntentSchema.parse({
          ...facts,
          proof: captureProof(loaded.key, "FINALIZATION_INTENT", facts),
        });
        await writeCaptureFile(loaded.directory, finalizationIntentFilename, intent);
        loaded = await loadCaptureSession(this.#stateRoot, parsedSessionId);
        intent = loaded.intent;
      }
      if (intent === undefined) {
        throw coordinatorError("SESSION_CORRUPT", "pilot capture finalization intent is missing");
      }
      const draft = buildEvidenceDraft(loaded.header.plan, observations, intent.observedAt);
      const projected = finalizePilotEvidenceDraft(loaded.header.plan, draft);
      if (pilotFingerprint(projected) !== intent.evidenceFingerprint) {
        throw coordinatorError(
          "SESSION_CORRUPT",
          "pilot capture finalization intent does not match its observations",
        );
      }
      const runtime = createPilotEvidenceCaptureRuntime(() => draft);
      let capture;
      try {
        capture = await new PilotEvidenceCaptureFinalizer({
          plan: loaded.header.plan,
          runtime,
        }).finalize();
      } catch (error) {
        if (error instanceof PilotEvidenceCaptureError && error.code === "WINDOWS_REQUIRED") {
          throw coordinatorError("WINDOWS_REQUIRED", "live pilot finalization requires Windows");
        }
        throw coordinatorError("STORE_FAILURE", "pilot live capture finalization failed");
      }
      let trusted: TrustedPilotArchive;
      try {
        trusted = this.#archiveStore.write({
          archiveId: loaded.header.archiveId,
          planFingerprint: loaded.header.plan.planFingerprint,
          capture,
          observedAt: intent.observedAt,
        });
      } catch {
        throw coordinatorError("STORE_FAILURE", "pilot Archive could not be published");
      }
      assertArchiveMatches(trusted, loaded.header, intent);
      const commitFacts = finalizationCommitFactsSchema.parse({
        schemaVersion: "hpi-pilot-capture-finalization-commit.v1",
        sessionId: loaded.header.sessionId,
        archiveId: loaded.header.archiveId,
        planFingerprint: loaded.header.plan.planFingerprint,
        evidenceFingerprint: intent.evidenceFingerprint,
        archiveFingerprint: trusted.archive.archiveFingerprint,
        observedAt: intent.observedAt,
      });
      const commit = finalizationCommitSchema.parse({
        ...commitFacts,
        proof: captureProof(loaded.key, "FINALIZATION_COMMIT", commitFacts),
      });
      await writeCaptureFile(loaded.directory, finalizationCommitFilename, commit);
      loaded = await loadCaptureSession(this.#stateRoot, parsedSessionId);
      return this.#readCommittedArchive(loaded);
    });
  }
}
