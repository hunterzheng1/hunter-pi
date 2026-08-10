import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import {
  attemptFinalityReceiptSchema,
  attemptIdSchema,
  checkIdSchema,
  checkpointIdSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  fingerprintSchema,
  managedChangeSchema,
  observationIdSchema,
  operationIdSchema,
  planRevisionSchema,
  reviewFindingSchema,
  reviewReceiptSchema,
  runSchema,
  stepIdSchema,
  verificationReceiptIdSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type EvidenceEnvelope,
  type Fingerprint,
  type AttemptId,
  type PlanRevision,
  type ReviewFinding,
  type Run,
  type VerificationReceipt,
} from "@hunter-pi/domain";
import {
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  type LeaseManager,
  type LeaseMutationReceipt,
} from "@hunter-pi/execution";
import {
  capabilityReceiptSchema,
  engineInputSchema,
  startAttemptRequestSchema,
  supportsEngineCapability,
  type EngineHost,
  type EngineObservation,
} from "@hunter-pi/engine-contracts";
import {
  canonicalJson,
  createPortableEvidenceEnvelope,
  createRunSummaryEvidence,
  FileRunArchiveStore,
  FileWorkflowEventStore,
  redactPortableText,
  sha256Fingerprint,
} from "@hunter-pi/evidence";
import { runDeclaredCommandVerification } from "@hunter-pi/verification";
import {
  CheckpointCoordinator,
  DurableWorkflowKernel,
  InMemoryWorkflowKernel,
  RecoveryCoordinator,
  runProjectionSchema,
  type RunProjection,
  type WorkflowKernel,
} from "@hunter-pi/workflow-kernel";

const terminalSafeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }),
    "terminal control characters are forbidden",
  );

const processArgumentSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }),
    "terminal control characters are forbidden",
  );

const managedChangeTargetIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "target identities must be stable and path-free");

export const realManagedChangeTargetSchema = z.strictObject({
  targetId: managedChangeTargetIdSchema,
  selectionMode: z.literal("EXPLICIT_OPERATOR_SELECTED"),
  repositoryFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  targetReferenceFingerprint: fingerprintSchema,
});
export type RealManagedChangeTarget = z.infer<typeof realManagedChangeTargetSchema>;

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      "project paths must be non-empty, normalized, and relative to the repository root",
    );
  }
  return normalized;
}

const projectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    try {
      return normalizeRelativePath(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid project path",
      });
      return z.NEVER;
    }
  });

const projectCheckSchema = z.strictObject({
  label: terminalSafeTextSchema,
  executable: terminalSafeTextSchema.max(1_024),
  argv: z.array(processArgumentSchema).min(1).max(128),
});

export const realManagedChangeRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-managed-change-request.v2"),
    title: terminalSafeTextSchema,
    goal: terminalSafeTextSchema,
    nonGoals: z.array(terminalSafeTextSchema).max(64),
    constraints: z.array(terminalSafeTextSchema).max(64),
    allowedPaths: z.array(projectPathSchema).min(1).max(256),
    check: projectCheckSchema,
    target: realManagedChangeTargetSchema,
  })
  .superRefine((request, context) => {
    if (new Set(request.allowedPaths).size !== request.allowedPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedPaths"],
        message: "allowed project paths must be unique",
      });
    }
  });
export type RealManagedChangeRequest = z.infer<typeof realManagedChangeRequestSchema>;

const productSourceSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  state: z.literal("CLEAN"),
});

const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const resourceAccountingV2Schema = z.strictObject({
  status: z.enum(["PASS", "NOT_PROVEN", "EXCEEDED"]),
  budgets: z.strictObject({
    maxAgentTurns: z.number().int().positive(),
    maxExternalOperations: z.number().int().positive(),
    maxCommands: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
  }),
  captureLimits: z.strictObject({
    engine: z.number().int().positive(),
    verification: z.number().int().positive(),
  }),
  capturedOutputBytes: z.strictObject({
    engine: z.number().int().nonnegative().optional(),
    verification: z.number().int().nonnegative(),
  }),
  consumed: z.strictObject({
    agentTurns: z.number().int().nonnegative(),
    externalOperations: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative().optional(),
  }),
  unprovenReasons: z.array(z.string().min(1)),
});

const resourceAccountingSchema = z.strictObject({
  status: z.enum(["PASS", "NOT_PROVEN", "EXCEEDED"]),
  budgets: z.strictObject({
    maxAgentTurns: safePositiveIntegerSchema,
    maxExternalOperations: safePositiveIntegerSchema,
    maxCommands: safePositiveIntegerSchema,
    maxOutputBytes: safePositiveIntegerSchema,
    maxTokens: safePositiveIntegerSchema,
    maxCostMinorUnits: safePositiveIntegerSchema,
  }),
  captureLimits: z.strictObject({
    engine: safePositiveIntegerSchema,
    verification: safePositiveIntegerSchema,
  }),
  capturedOutputBytes: z.strictObject({
    engine: safeNonnegativeIntegerSchema.optional(),
    verification: safeNonnegativeIntegerSchema,
  }),
  consumed: z.strictObject({
    agentTurns: safeNonnegativeIntegerSchema,
    externalOperations: safeNonnegativeIntegerSchema,
    commands: safeNonnegativeIntegerSchema,
    outputBytes: safeNonnegativeIntegerSchema.optional(),
    tokens: safeNonnegativeIntegerSchema.optional(),
    costMinorUnits: safeNonnegativeIntegerSchema.optional(),
  }),
  unprovenReasons: z.array(z.string().min(1)),
});

const providerUsageEvidenceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("PASS"),
    requestCount: safeNonnegativeIntegerSchema,
    tokenCount: safeNonnegativeIntegerSchema,
    costMinorUnits: safeNonnegativeIntegerSchema,
    reasons: z.tuple([]),
  }),
  z.strictObject({
    status: z.literal("NOT_PROVEN"),
    requestCount: z.null(),
    tokenCount: z.null(),
    costMinorUnits: z.null(),
    reasons: z.tuple([z.literal("ENGINE_PROVIDER_USAGE_MISSING")]),
  }),
]);

const engineReleaseEvidenceSchema = z.strictObject({
  packageName: terminalSafeTextSchema.max(256),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
});
const providerEvidenceV2Schema = z.strictObject({
  id: terminalSafeTextSchema.max(128),
  authStatus: z.enum(["DETECTED", "BLOCKED"]),
  requestStatus: z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]),
  promptFingerprint: fingerprintSchema,
});
const providerEvidenceSchema = providerEvidenceV2Schema.extend({
  usage: providerUsageEvidenceSchema,
});

export const realManagedChangeTaskReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-real-managed-change-task-receipt.v1"),
  runId: runSchema.shape.runId,
  repositoryFingerprint: fingerprintSchema,
  targetReferenceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  mode: z.literal("MANAGED"),
  acceptanceCheckDefinitionFingerprints: z.array(fingerprintSchema).min(1),
  terminalOutcome: z.enum(["READY", "BLOCKED", "FAILED", "CANCELLED", "INCOMPLETE"]),
  taskResult: z.enum(["GO", "REVISE", "STOP"]),
  sourcePreserved: z.boolean(),
  rawSecretLeakage: z.boolean(),
  providerUsage: providerUsageEvidenceSchema,
  reviewP0P1Count: safeNonnegativeIntegerSchema,
  overheadMs: safeNonnegativeIntegerSchema,
});
export type RealManagedChangeTaskReceiptV1 = z.infer<typeof realManagedChangeTaskReceiptV1Schema>;

export const realManagedChangeTaskReceiptV2Schema = realManagedChangeTaskReceiptV1Schema
  .omit({ schemaVersion: true })
  .safeExtend({
    schemaVersion: z.literal("hpi-real-managed-change-task-receipt.v2"),
    taskDefinitionFingerprint: fingerprintSchema,
  });
export type RealManagedChangeTaskReceiptV2 = z.infer<typeof realManagedChangeTaskReceiptV2Schema>;

export const realManagedChangeInterruptionKindSchema = z.enum([
  "FORCED_PROCESS_KILL_AFTER_AGENT_END",
  "TERMINAL_CLOSE_SIMULATION_AFTER_AGENT_END",
  "POWER_LOSS_SIMULATION_AFTER_AGENT_END",
]);
export type RealManagedChangeInterruptionKind = z.infer<
  typeof realManagedChangeInterruptionKindSchema
>;

export const realManagedChangeTaskReceiptSchema = realManagedChangeTaskReceiptV2Schema
  .omit({ schemaVersion: true })
  .safeExtend({
    schemaVersion: z.literal("hpi-real-managed-change-task-receipt.v3"),
    interruptionKind: realManagedChangeInterruptionKindSchema.nullable(),
  });
export type RealManagedChangeTaskReceipt = z.infer<typeof realManagedChangeTaskReceiptSchema>;

const repositoryEvidenceSchema = z.strictObject({
  scope: z.literal("EXPLICIT_OPERATOR_SELECTED"),
  branch: terminalSafeTextSchema.max(512),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  target: realManagedChangeTargetSchema,
});
const planEvidenceSchema = z.strictObject({
  planRevisionId: z.string().regex(/^plan_[A-Za-z0-9][A-Za-z0-9.-]*$/u),
  planFingerprint: fingerprintSchema,
  allowedPaths: z.array(projectPathSchema),
  checkId: z.string().regex(/^check_[A-Za-z0-9][A-Za-z0-9.-]*$/u),
  checkDefinitionFingerprint: fingerprintSchema,
});
const writerLeaseEvidenceSchema = z.strictObject({
  leaseId: writerLeaseIdSchema,
  workspaceId: workspaceIdSchema,
  resourceSetFingerprint: fingerprintSchema,
  acquireOutcome: z.literal("ACQUIRED"),
  releaseOutcome: z.literal("RELEASED"),
});
const reviewEvidenceSchema = z.strictObject({
  changedPaths: z.array(projectPathSchema),
  allowedPaths: z.array(projectPathSchema),
  baseCommitUnchanged: z.boolean(),
  agentReturned: z.boolean(),
  findings: z.array(reviewFindingSchema),
});
const finalSummaryEvidenceSchema = z.strictObject({
  attempts: z.array(z.string().min(1)),
  checks: z.array(z.string().min(1)),
  blockingFindings: z.array(z.string().min(1)),
  unresolvedRisks: z.array(z.string().min(1)),
});
const scorecardEvidenceSharedShape = {
  zeroFalseReady: z.boolean(),
  sourceLoss: z.boolean(),
  secretLeak: z.boolean(),
  failedAttemptPreserved: z.boolean(),
  fixbackPass: z.boolean(),
  changedPathsWithinScope: z.boolean(),
  agentReturnObserved: z.boolean(),
  summaryComplete: z.boolean(),
  resourceBudgetReconciled: z.boolean(),
  overheadWithinLimit: z.boolean(),
} as const;
const scorecardEvidenceV2Schema = z.strictObject({
  ...scorecardEvidenceSharedShape,
  overheadMs: z.number().int().nonnegative(),
});
const scorecardEvidenceSchema = z.strictObject({
  ...scorecardEvidenceSharedShape,
  overheadMs: safeNonnegativeIntegerSchema,
});
const cleanupEvidenceSchema = z.strictObject({
  status: z.literal("NOT_APPLICABLE"),
  targetWorkingTree: z.enum(["PRESERVED_CHANGED", "PRESERVED_CLEAN"]),
});
const realManagedChangeEvidenceSharedShape = {
  observedAt: z.iso.datetime({ offset: true }),
  taskResult: z.enum(["GO", "REVISE", "STOP"]),
  productSource: productSourceSchema,
  engineRelease: engineReleaseEvidenceSchema,
  repository: repositoryEvidenceSchema,
  plan: planEvidenceSchema,
  writerLease: writerLeaseEvidenceSchema,
  projection: runProjectionSchema,
  evidence: z.array(evidenceEnvelopeSchema).min(1),
  review: reviewEvidenceSchema,
  finalSummary: finalSummaryEvidenceSchema,
  cleanup: cleanupEvidenceSchema,
  remoteCi: z.literal("PENDING"),
} as const;

/** Historical strict parser retained for replaying the immutable v2 contract. */
export const realManagedChangeEvidenceV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-managed-change.v2"),
  ...realManagedChangeEvidenceSharedShape,
  provider: providerEvidenceV2Schema,
  resourceAccounting: resourceAccountingV2Schema,
  scorecard: scorecardEvidenceV2Schema,
});
export type RealManagedChangeEvidenceV2 = z.infer<typeof realManagedChangeEvidenceV2Schema>;

/** Current evidence contract with exact Provider request, token, and cost accounting. */
export const realManagedChangeEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-managed-change.v3"),
    ...realManagedChangeEvidenceSharedShape,
    provider: providerEvidenceSchema,
    resourceAccounting: resourceAccountingSchema,
    scorecard: scorecardEvidenceSchema,
  })
  .superRefine((evidence, context) => {
    const usage = evidence.provider.usage;
    const accounting = evidence.resourceAccounting;
    if (usage.status === "PASS") {
      if (usage.requestCount === 0) {
        context.addIssue({
          code: "custom",
          path: ["provider", "usage", "requestCount"],
          message: "accounted Provider usage must include at least one request",
        });
      }
      if (evidence.provider.requestStatus !== "DETECTED") {
        context.addIssue({
          code: "custom",
          path: ["provider", "requestStatus"],
          message: "accounted Provider usage requires a detected request",
        });
      }
      if (accounting.consumed.tokens !== usage.tokenCount) {
        context.addIssue({
          code: "custom",
          path: ["resourceAccounting", "consumed", "tokens"],
          message: "consumed tokens must equal the accounted Provider total",
        });
      }
      if (accounting.consumed.costMinorUnits !== usage.costMinorUnits) {
        context.addIssue({
          code: "custom",
          path: ["resourceAccounting", "consumed", "costMinorUnits"],
          message: "consumed cost must equal the accounted Provider total",
        });
      }
      if (accounting.unprovenReasons.includes("ENGINE_PROVIDER_USAGE_MISSING")) {
        context.addIssue({
          code: "custom",
          path: ["resourceAccounting", "unprovenReasons"],
          message: "accounted Provider usage cannot also be marked missing",
        });
      }
      if (
        (usage.tokenCount > accounting.budgets.maxTokens ||
          usage.costMinorUnits > accounting.budgets.maxCostMinorUnits) &&
        accounting.status !== "EXCEEDED"
      ) {
        context.addIssue({
          code: "custom",
          path: ["resourceAccounting", "status"],
          message: "Provider usage above a declared budget must be marked EXCEEDED",
        });
      }
      return;
    }

    if (evidence.provider.requestStatus !== "NOT_PROVEN") {
      context.addIssue({
        code: "custom",
        path: ["provider", "requestStatus"],
        message: "unaccounted Provider usage requires a NOT_PROVEN request status",
      });
    }
    if (
      accounting.consumed.tokens !== undefined ||
      accounting.consumed.costMinorUnits !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["resourceAccounting", "consumed"],
        message: "unaccounted Provider usage cannot publish partial token or cost totals",
      });
    }
    if (!accounting.unprovenReasons.includes("ENGINE_PROVIDER_USAGE_MISSING")) {
      context.addIssue({
        code: "custom",
        path: ["resourceAccounting", "unprovenReasons"],
        message: "unaccounted Provider usage must remain explicit in resource accounting",
      });
    }
  });
export type RealManagedChangeEvidence = z.infer<typeof realManagedChangeEvidenceSchema>;

export type RealManagedChangeReasonCode =
  | "DIRTY_WORKTREE"
  | "NOT_GIT_ROOT"
  | "UNSTAMPED_OR_DIRTY_PRODUCT"
  | "PROVIDER_AUTH_REQUIRED"
  | "PLAN_CONTENT_NOT_PORTABLE"
  | "UNSUPPORTED_PROJECT_PATH"
  | "WORKSPACE_DRIFT"
  | "WORKSPACE_BUSY"
  | "WORKING_TREE_INSPECTION_BUDGET_EXCEEDED"
  | "TARGET_IDENTITY_MISMATCH"
  | "INTERRUPTION_NOT_PROVEN"
  | "EXTERNAL_FILTER_CONFIGURED";

export class RealManagedChangeBlockedError extends Error {
  public readonly reasonCode: RealManagedChangeReasonCode;

  public constructor(reasonCode: RealManagedChangeReasonCode, message: string) {
    super(`${reasonCode}: ${message}`);
    this.name = "RealManagedChangeBlockedError";
    this.reasonCode = reasonCode;
  }
}

const resourceBudgets = Object.freeze({
  maxAgentTurns: 2,
  maxExternalOperations: 6,
  maxCommands: 2,
  maxOutputBytes: 262_144,
  maxTokens: 200_000,
  maxCostMinorUnits: 1_000,
});
const fixbackProviderReserve = Object.freeze({ tokens: 100_000, costMinorUnits: 500 });
const outputCaptureLimits = Object.freeze({ engine: 229_376, verification: 16_384 });
const runTimeoutMs = 300_000;
const maximumWorkingTreeInspectionLimits = Object.freeze({
  maximumHashedBytes: 8 * 1_024 * 1_024 * 1_024,
  maximumElapsedMs: 120_000,
});
const workingTreeInspectionLimitsSchema = z.strictObject({
  maximumHashedBytes: safePositiveIntegerSchema.max(
    maximumWorkingTreeInspectionLimits.maximumHashedBytes,
  ),
  maximumElapsedMs: safePositiveIntegerSchema.max(
    maximumWorkingTreeInspectionLimits.maximumElapsedMs,
  ),
});
export type RealManagedChangeWorkingTreeInspectionLimits = z.infer<
  typeof workingTreeInspectionLimitsSchema
>;
type WorkingTreeInspectionLimits = RealManagedChangeWorkingTreeInspectionLimits;

function sha256(value: string | Buffer): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function idSuffix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function pilotTargetFingerprint(value: unknown): Fingerprint {
  return sha256Fingerprint(canonicalJson(value));
}

export function fingerprintRealManagedChangeTaskDefinition(
  input: RealManagedChangeRequest,
): Fingerprint {
  const request = realManagedChangeRequestSchema.parse(input);
  return sha256Fingerprint(
    canonicalJson({
      schemaVersion: "hpi-real-managed-change-task-definition.v1",
      title: request.title,
      goal: request.goal,
      nonGoals: request.nonGoals,
      constraints: request.constraints,
      allowedPaths: request.allowedPaths,
      check: request.check,
    }),
  );
}

export function fingerprintRealManagedChangeCheckDefinition(
  input: RealManagedChangeRequest,
): Fingerprint {
  const request = realManagedChangeRequestSchema.parse(input);
  return sha256(
    JSON.stringify({
      ...request.check,
      workingDirectoryReference: "workspace-root",
    }),
  );
}

function minimalGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOGLOBAL: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
}

interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error: Error | undefined;
}

function runGitCommand(repository: string, arguments_: readonly string[]): GitCommandResult {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      repository,
      ...arguments_,
    ],
    {
      env: minimalGitEnvironment(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    error: result.error,
  };
}

function runGit(repository: string, arguments_: readonly string[]): string {
  const result = runGitCommand(repository, arguments_);
  if (result.error !== undefined || result.status !== 0) {
    throw new RealManagedChangeBlockedError(
      "NOT_GIT_ROOT",
      "the explicitly selected directory is not a readable Git repository root",
    );
  }
  return result.stdout;
}

interface GitRepositorySnapshot {
  readonly repository: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly status: string;
  readonly workingTreeStateFingerprint: Fingerprint;
  readonly ignoredContent: IgnoredContentSnapshot;
  readonly digestCache: WorkingTreeDigestCache;
  readonly inspectionLimits: WorkingTreeInspectionLimits;
  readonly inspectionMonotonicNow: () => number;
  readonly workspaceFingerprint: Fingerprint;
  readonly sourceFingerprint: Fingerprint;
  readonly pilotRepositoryFingerprint: Fingerprint;
  readonly pilotSourceFingerprint: Fingerprint;
  readonly pilotTargetReferenceFingerprint: Fingerprint;
}

interface WorkingTreeContentEntry {
  readonly path: string;
  readonly kind: "REGULAR_FILE" | "SYMLINK" | "MISSING";
  readonly mode?: string;
  readonly digest?: Fingerprint;
}

interface IgnoredContentSnapshot {
  readonly fingerprint: Fingerprint;
  readonly entries: readonly WorkingTreeContentEntry[];
}

type WorkingTreeDigestCache = Map<
  string,
  { readonly statSignature: string; readonly digest: Fingerprint }
>;

interface WorkingTreeInspectionBudget {
  readonly maximumHashedBytes: bigint;
  readonly maximumElapsedMs: number;
  readonly startedAt: number;
  readonly monotonicNow: () => number;
  readonly abortController: AbortController;
  hashedBytes: bigint;
}

function workingTreeInspectionBudgetExceeded(message: string): RealManagedChangeBlockedError {
  return new RealManagedChangeBlockedError("WORKING_TREE_INSPECTION_BUDGET_EXCEEDED", message);
}

function remainingWorkingTreeInspectionMs(budget: WorkingTreeInspectionBudget): number {
  const elapsedMs = budget.monotonicNow() - budget.startedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > budget.maximumElapsedMs) {
    budget.abortController.abort();
    throw workingTreeInspectionBudgetExceeded(
      "the working-tree inspection exceeds the finite elapsed-time budget",
    );
  }
  return budget.maximumElapsedMs - elapsedMs;
}

async function withinWorkingTreeInspectionDeadline<T>(
  budget: WorkingTreeInspectionBudget,
  operation: () => Promise<T>,
): Promise<T> {
  const remainingMs = remainingWorkingTreeInspectionMs(budget);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => {
        budget.abortController.abort();
        reject(
          workingTreeInspectionBudgetExceeded(
            "the working-tree inspection exceeds the finite elapsed-time budget",
          ),
        );
      },
      Math.max(1, Math.ceil(remainingMs)),
    );
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function reserveWorkingTreeInspectionBytes(
  budget: WorkingTreeInspectionBudget,
  bytes: bigint,
): void {
  if (budget.hashedBytes + bytes > budget.maximumHashedBytes) {
    throw workingTreeInspectionBudgetExceeded(
      "the working-tree content exceeds the finite inspection byte budget",
    );
  }
  budget.hashedBytes += bytes;
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function snapshotWorkingTreePath(
  repository: string,
  path: string,
  digestCache: WorkingTreeDigestCache,
  inspectionBudget: WorkingTreeInspectionBudget,
): Promise<WorkingTreeContentEntry> {
  remainingWorkingTreeInspectionMs(inspectionBudget);
  const absolutePath = resolve(repository, path);
  if (!absolutePath.startsWith(`${repository}${sep}`)) {
    throw new RealManagedChangeBlockedError(
      "UNSUPPORTED_PROJECT_PATH",
      "a repository path escaped the selected physical Git root",
    );
  }
  const before = await lstat(absolutePath, { bigint: true }).catch((error: unknown) => {
    if (missingFile(error)) return undefined;
    throw error;
  });
  remainingWorkingTreeInspectionMs(inspectionBudget);
  if (before === undefined) {
    digestCache.delete(absolutePath);
    return { path, kind: "MISSING" };
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    remainingWorkingTreeInspectionMs(inspectionBudget);
    reserveWorkingTreeInspectionBytes(inspectionBudget, BigInt(Buffer.byteLength(target, "utf8")));
    const after = await lstat(absolutePath, { bigint: true });
    remainingWorkingTreeInspectionMs(inspectionBudget);
    if (
      !after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new RealManagedChangeBlockedError(
        "WORKSPACE_DRIFT",
        "a repository link changed while Hunter Pi inspected it",
      );
    }
    return {
      path,
      kind: "SYMLINK",
      mode: String(before.mode),
      digest: sha256(`hpi-working-tree-symlink.v1\0${target}`),
    };
  }
  if (!before.isFile()) {
    throw new RealManagedChangeBlockedError(
      "UNSUPPORTED_PROJECT_PATH",
      "a changed or ignored repository entry is not a regular file or symbolic link",
    );
  }
  const statSignature = [
    before.dev,
    before.ino,
    before.mode,
    before.size,
    before.mtimeNs,
    before.ctimeNs,
  ].join(":");
  const cached = digestCache.get(absolutePath);
  let digest = cached?.statSignature === statSignature ? cached.digest : undefined;
  if (digest === undefined) {
    reserveWorkingTreeInspectionBytes(inspectionBudget, before.size);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath, {
      signal: inspectionBudget.abortController.signal,
    })) {
      remainingWorkingTreeInspectionMs(inspectionBudget);
      hash.update(chunk as Buffer);
    }
    digest = fingerprintSchema.parse(`sha256:${hash.digest("hex")}`);
  }
  const after = await lstat(absolutePath, { bigint: true });
  remainingWorkingTreeInspectionMs(inspectionBudget);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new RealManagedChangeBlockedError(
      "WORKSPACE_DRIFT",
      "a repository file changed while Hunter Pi inspected it",
    );
  }
  digestCache.set(absolutePath, { statSignature, digest });
  return {
    path,
    kind: "REGULAR_FILE",
    mode: String(before.mode),
    digest,
  };
}

async function snapshotPaths(
  repository: string,
  paths: readonly string[],
  digestCache: WorkingTreeDigestCache,
  inspectionBudget: WorkingTreeInspectionBudget,
): Promise<readonly WorkingTreeContentEntry[]> {
  return withinWorkingTreeInspectionDeadline(inspectionBudget, async () => {
    const entries: (WorkingTreeContentEntry | undefined)[] = Array.from({ length: paths.length });
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(16, paths.length) }, async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex;
        nextIndex += 1;
        const path = paths[index];
        if (path !== undefined) {
          entries[index] = await snapshotWorkingTreePath(
            repository,
            path,
            digestCache,
            inspectionBudget,
          );
        }
      }
    });
    await Promise.all(workers);
    remainingWorkingTreeInspectionMs(inspectionBudget);
    if (entries.some((entry) => entry === undefined)) {
      throw new Error("working-tree snapshot did not inspect every bounded path");
    }
    return entries.filter((entry): entry is WorkingTreeContentEntry => entry !== undefined);
  });
}

function exactGitPaths(raw: string): readonly string[] {
  const paths = raw
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => {
      const normalized = normalizeRelativePath(path);
      if (normalized !== path.replaceAll("\\", "/")) {
        throw new RealManagedChangeBlockedError(
          "UNSUPPORTED_PROJECT_PATH",
          "the repository contains a path that cannot be represented exactly",
        );
      }
      return normalized;
    });
  if (paths.length > 100_000 || new Set(paths).size !== paths.length) {
    throw new RealManagedChangeBlockedError(
      "UNSUPPORTED_PROJECT_PATH",
      "the ignored-content inventory exceeds the bounded inspection contract",
    );
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function inspectIgnoredContent(
  repository: string,
  digestCache: WorkingTreeDigestCache,
  inspectionBudget: WorkingTreeInspectionBudget,
): Promise<IgnoredContentSnapshot> {
  const paths = exactGitPaths(
    runGit(repository, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  );
  const entries = await snapshotPaths(repository, paths, digestCache, inspectionBudget);
  return {
    fingerprint: sha256(
      JSON.stringify({ schemaVersion: "hpi-ignored-content-snapshot.v1", entries }),
    ),
    entries,
  };
}

async function fingerprintWorkingTreeState(
  repository: string,
  status: string,
  ignoredContent: IgnoredContentSnapshot,
  digestCache: WorkingTreeDigestCache,
  inspectionBudget: WorkingTreeInspectionBudget,
): Promise<Fingerprint> {
  const entries = await snapshotPaths(
    repository,
    parseChangedPaths(status).paths,
    digestCache,
    inspectionBudget,
  );
  return sha256(
    JSON.stringify({
      schemaVersion: "hpi-real-working-tree-state.v1",
      status,
      entries,
      ignoredContentFingerprint: ignoredContent.fingerprint,
    }),
  );
}

function changedIgnoredPaths(
  before: IgnoredContentSnapshot,
  after: IgnoredContentSnapshot,
): readonly string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((path) => beforeByPath.get(path) !== afterByPath.get(path))
    .sort((left, right) => left.localeCompare(right));
}

async function inspectGitRepository(
  repositoryInput: string,
  existingDigestCache?: WorkingTreeDigestCache,
  inspectionLimits: WorkingTreeInspectionLimits = maximumWorkingTreeInspectionLimits,
  inspectionMonotonicNow: () => number = () => performance.now(),
): Promise<GitRepositorySnapshot> {
  const digestCache: WorkingTreeDigestCache =
    existingDigestCache ??
    new Map<string, { readonly statSignature: string; readonly digest: Fingerprint }>();
  const inspectionBudget: WorkingTreeInspectionBudget = {
    maximumHashedBytes: BigInt(inspectionLimits.maximumHashedBytes),
    maximumElapsedMs: inspectionLimits.maximumElapsedMs,
    startedAt: inspectionMonotonicNow(),
    monotonicNow: inspectionMonotonicNow,
    abortController: new AbortController(),
    hashedBytes: 0n,
  };
  const resolved = resolve(repositoryInput);
  const status = await lstat(resolved).catch(() => undefined);
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) {
    throw new RealManagedChangeBlockedError(
      "NOT_GIT_ROOT",
      "the explicitly selected repository must be one existing physical directory",
    );
  }
  const repository = await realpath(resolved);
  if (repository !== resolved) {
    throw new RealManagedChangeBlockedError(
      "NOT_GIT_ROOT",
      "the explicitly selected repository must use its canonical physical path",
    );
  }
  const topLevel = resolve(runGit(repository, ["rev-parse", "--show-toplevel"]).trim());
  if (topLevel !== repository) {
    throw new RealManagedChangeBlockedError(
      "NOT_GIT_ROOT",
      "the explicitly selected directory must be the exact Git repository root",
    );
  }
  const baseCommit = runGit(repository, ["rev-parse", "HEAD"]).trim();
  const baseTree = runGit(repository, ["rev-parse", "HEAD^{tree}"]).trim();
  const branch = runGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  const filterConfiguration = runGitCommand(repository, [
    "config",
    "--local",
    "--name-only",
    "--get-regexp",
    "^filter\\..*\\.(clean|process|smudge)$",
  ]);
  if (
    filterConfiguration.error !== undefined ||
    (filterConfiguration.status !== 0 && filterConfiguration.status !== 1)
  ) {
    throw new RealManagedChangeBlockedError(
      "NOT_GIT_ROOT",
      "the selected Git repository configuration could not be inspected safely",
    );
  }
  if (filterConfiguration.stdout.trim().length > 0) {
    throw new RealManagedChangeBlockedError(
      "EXTERNAL_FILTER_CONFIGURED",
      "the selected Git repository configures an external clean, process, or smudge filter",
    );
  }
  const workspaceStatus = runGit(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const ignoredContent = await inspectIgnoredContent(repository, digestCache, inspectionBudget);
  const workingTreeStateFingerprint = await fingerprintWorkingTreeState(
    repository,
    workspaceStatus,
    ignoredContent,
    digestCache,
    inspectionBudget,
  );
  const pilotRepositoryFingerprint = pilotTargetFingerprint({
    schemaVersion: "hpi-pilot-repository-identity.v1",
    canonicalRepositoryIdentity: repository,
  });
  const pilotSourceFingerprint = pilotTargetFingerprint({
    schemaVersion: "hpi-pilot-source.v1",
    baseCommit,
    baseTree,
  });
  const sourceFingerprint = pilotSourceFingerprint;
  const pilotTargetReferenceFingerprint = pilotTargetFingerprint({
    schemaVersion: "hpi-pilot-target-reference.v1",
    branch,
    baseCommit,
  });
  const workspaceFingerprint = sha256(
    JSON.stringify({
      schemaVersion: "hpi-real-workspace.v1",
      branch,
      baseCommit,
      sourceFingerprint,
    }),
  );
  return {
    repository,
    branch,
    baseCommit,
    baseTree,
    status: workspaceStatus,
    workingTreeStateFingerprint,
    ignoredContent,
    digestCache,
    inspectionLimits,
    inspectionMonotonicNow,
    sourceFingerprint,
    workspaceFingerprint,
    pilotRepositoryFingerprint,
    pilotSourceFingerprint,
    pilotTargetReferenceFingerprint,
  };
}

function assertTargetIdentity(
  target: RealManagedChangeTarget,
  snapshot: GitRepositorySnapshot,
): void {
  if (
    target.repositoryFingerprint !== snapshot.pilotRepositoryFingerprint ||
    target.sourceFingerprint !== snapshot.pilotSourceFingerprint ||
    target.targetReferenceFingerprint !== snapshot.pilotTargetReferenceFingerprint
  ) {
    throw new RealManagedChangeBlockedError(
      "TARGET_IDENTITY_MISMATCH",
      "the frozen target identity does not match the current canonical Git repository snapshot",
    );
  }
}

function assertWorkspaceBaseline(
  baseline: GitRepositorySnapshot,
  current: GitRepositorySnapshot,
  allowDirty: boolean,
): void {
  if (
    (!allowDirty &&
      (current.status.length > 0 ||
        current.workingTreeStateFingerprint !== baseline.workingTreeStateFingerprint)) ||
    current.baseCommit !== baseline.baseCommit ||
    current.sourceFingerprint !== baseline.sourceFingerprint ||
    current.workspaceFingerprint !== baseline.workspaceFingerprint
  ) {
    throw new RealManagedChangeBlockedError(
      "WORKSPACE_DRIFT",
      "the selected repository changed after preflight and before the next Agent started",
    );
  }
}

async function assertTargetReadyForAgent(
  baseline: GitRepositorySnapshot,
  target: RealManagedChangeTarget,
  allowDirty: boolean,
): Promise<void> {
  const current = await inspectGitRepository(
    baseline.repository,
    baseline.digestCache,
    baseline.inspectionLimits,
    baseline.inspectionMonotonicNow,
  );
  assertTargetIdentity(target, current);
  assertWorkspaceBaseline(baseline, current, allowDirty);
}

async function assertExactWorkspaceState(
  baseline: GitRepositorySnapshot,
  target: RealManagedChangeTarget,
  expectedWorkingTreeStateFingerprint: Fingerprint,
): Promise<void> {
  const current = await inspectGitRepository(
    baseline.repository,
    baseline.digestCache,
    baseline.inspectionLimits,
    baseline.inspectionMonotonicNow,
  );
  assertTargetIdentity(target, current);
  if (
    current.baseCommit !== baseline.baseCommit ||
    current.sourceFingerprint !== baseline.sourceFingerprint ||
    current.workspaceFingerprint !== baseline.workspaceFingerprint ||
    current.workingTreeStateFingerprint !== expectedWorkingTreeStateFingerprint
  ) {
    throw new RealManagedChangeBlockedError(
      "WORKSPACE_DRIFT",
      "the exact working-tree content changed outside the bounded operation",
    );
  }
}

function parseChangedPaths(status: string): {
  readonly paths: readonly string[];
  readonly renameOrCopyDetected: boolean;
} {
  const records = status.split("\0").filter((record) => record.length > 0);
  const paths: string[] = [];
  let renameOrCopyDetected = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new RealManagedChangeBlockedError(
        "WORKSPACE_DRIFT",
        "Git returned a working-tree status that Hunter Pi cannot classify safely",
      );
    }
    const code = record.slice(0, 2);
    try {
      paths.push(normalizeRelativePath(record.slice(3)));
    } catch {
      throw new RealManagedChangeBlockedError(
        "UNSUPPORTED_PROJECT_PATH",
        "the selected repository contains a changed path that cannot be represented safely",
      );
    }
    if (code.includes("R") || code.includes("C")) {
      renameOrCopyDetected = true;
      const destination = records[index + 1];
      if (destination === undefined) {
        throw new RealManagedChangeBlockedError(
          "WORKSPACE_DRIFT",
          "Git returned an incomplete rename or copy record",
        );
      }
      try {
        paths.push(normalizeRelativePath(destination));
      } catch {
        throw new RealManagedChangeBlockedError(
          "UNSUPPORTED_PROJECT_PATH",
          "the selected repository contains a renamed path that cannot be represented safely",
        );
      }
      index += 1;
    }
  }
  return {
    paths: [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
    renameOrCopyDetected,
  };
}

function deadlineFrom(now: string, timeoutMs: number): string {
  return new Date(Date.parse(now) + timeoutMs).toISOString();
}

interface RealWriterLease {
  readonly leaseId: z.infer<typeof writerLeaseIdSchema>;
  readonly workspaceId: z.infer<typeof workspaceIdSchema>;
  readonly resourceSetFingerprint: Fingerprint;
  readonly release: () => Promise<LeaseMutationReceipt>;
}

async function acquireRealWriterLease(options: {
  readonly manager: LeaseManager;
  readonly workspaceId: z.infer<typeof workspaceIdSchema>;
  readonly ownerFingerprint: Fingerprint;
  readonly runSuffix: string;
}): Promise<RealWriterLease> {
  const leaseSuffix = idSuffix(`${options.runSuffix}\0${randomUUID()}`);
  const leaseId = writerLeaseIdSchema.parse(`lease_real-${leaseSuffix}`);
  const acquireOperationId = operationIdSchema.parse(`op_real-lease-acquire-${leaseSuffix}`);
  const releaseOperationId = operationIdSchema.parse(`op_real-lease-release-${leaseSuffix}`);
  const operationFingerprint = sha256(
    JSON.stringify({
      schemaVersion: "hpi-real-writer-lease.v1",
      leaseId,
      workspaceId: options.workspaceId,
      ownerFingerprint: options.ownerFingerprint,
      resource: "repository-writer",
    }),
  );
  const acquire = await options.manager.acquire(
    leaseAcquireRequestSchema.parse({
      schemaVersion: "hpi-lease-acquire.v1",
      operationId: acquireOperationId,
      operationFingerprint,
      leaseId,
      workspaceId: options.workspaceId,
      ownerFingerprint: options.ownerFingerprint,
      resources: ["repository-writer"],
      ttlMs: 900_000,
    }),
  );
  if (acquire.receipt.outcome !== "ACQUIRED") {
    throw new RealManagedChangeBlockedError(
      "WORKSPACE_BUSY",
      "the selected repository is already held by another Hunter Pi Managed Change",
    );
  }
  let releaseReceipt: LeaseMutationReceipt | undefined;
  return {
    leaseId,
    workspaceId: options.workspaceId,
    resourceSetFingerprint: acquire.receipt.resourceSetFingerprint,
    release: async () => {
      releaseReceipt ??= (
        await options.manager.release(
          leaseReleaseRequestSchema.parse({
            schemaVersion: "hpi-lease-release.v1",
            operationId: releaseOperationId,
            operationFingerprint: sha256(`hpi-real-writer-release\0${leaseSuffix}`),
            leaseId,
            ownerFingerprint: options.ownerFingerprint,
            bindingFingerprint: null,
          }),
        )
      ).receipt;
      return releaseReceipt;
    },
  };
}

function portablePlanText(value: string, repository: string): string {
  const redaction = redactPortableText(value, { privatePathRoots: [repository] });
  if (
    redaction.categories.some((category) =>
      ["CREDENTIAL", "ENVIRONMENT_DUMP", "PRIVATE_PATH", "PRIVATE_PROMPT"].includes(category),
    )
  ) {
    throw new RealManagedChangeBlockedError(
      "PLAN_CONTENT_NOT_PORTABLE",
      "the Managed Change plan contains private path, credential, environment, or prompt material",
    );
  }
  return redaction.text;
}

function makeEvidence(options: {
  readonly evidenceId: string;
  readonly kind: "observation" | "verification" | "review" | "checkpoint";
  readonly runId: string;
  readonly attemptId: string;
  readonly verificationReceiptId?: string;
  readonly createdAt: string;
  readonly sourceFingerprint: Fingerprint;
  readonly summary: string;
  readonly content: string;
  readonly repository: string;
  readonly prompt: string;
}): EvidenceEnvelope {
  return evidenceEnvelopeSchema.parse(
    createPortableEvidenceEnvelope(
      {
        schemaVersion: "1.0.0",
        evidenceId: options.evidenceId,
        kind: options.kind,
        scope: {
          runId: options.runId,
          attemptId: options.attemptId,
          ...(options.verificationReceiptId === undefined
            ? {}
            : { verificationReceiptId: options.verificationReceiptId }),
        },
        createdAt: options.createdAt,
        sourceFingerprint: options.sourceFingerprint,
        contentClass: "SUMMARY",
        summary: options.summary,
        content: options.content,
      },
      {
        maxCaptureBytes: 16_384,
        privatePathRoots: [options.repository],
        privatePromptValues: [options.prompt],
      },
    ),
  );
}

interface AgentRunResult {
  readonly attemptId: AttemptId;
  readonly startReceipt: Awaited<ReturnType<EngineHost["start"]>>;
  readonly sendReceipt: Awaited<ReturnType<EngineHost["send"]>>;
  readonly closeReceipt: Awaited<ReturnType<EngineHost["close"]>>;
  readonly observations: readonly EngineObservation[];
  readonly evidence: EvidenceEnvelope;
  readonly runtimeMs: number;
}

interface ObservedProviderUsage {
  readonly requestCount: number;
  readonly tokenCount: number;
  readonly costMinorUnits: number;
}

function sumSafeNonnegativeIntegers(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function observedProviderUsage(
  observations: readonly EngineObservation[],
): ObservedProviderUsage | undefined {
  const interruptedUsageObservations = observations.filter(
    (candidate) =>
      candidate.kind === "OPERATION_OBSERVED" &&
      candidate.summary?.startsWith("QualifiedInterruption=") === true,
  );
  const usageObservations =
    interruptedUsageObservations.length > 0
      ? interruptedUsageObservations
      : observations.filter((candidate) => candidate.kind === "AGENT_RETURNED");
  if (usageObservations.length !== 1) return undefined;
  const observation = usageObservations[0];
  const usage = observation?.resourceUsage;
  if (
    usage?.externalOperations === undefined ||
    usage.tokens === undefined ||
    usage.costMinorUnits === undefined ||
    !Number.isSafeInteger(usage.externalOperations) ||
    usage.externalOperations <= 0 ||
    !Number.isSafeInteger(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isSafeInteger(usage.costMinorUnits) ||
    usage.costMinorUnits < 0
  ) {
    return undefined;
  }
  return {
    requestCount: usage.externalOperations,
    tokenCount: usage.tokens,
    costMinorUnits: usage.costMinorUnits,
  };
}

function qualifiedInterruptionObserved(
  observations: readonly EngineObservation[],
): RealManagedChangeInterruptionKind | undefined {
  const matches = observations.flatMap((observation) => {
    if (observation.kind !== "OPERATION_OBSERVED" || observation.summary === undefined) return [];
    const match = /^QualifiedInterruption=([^;]+);/u.exec(observation.summary);
    if (match?.[1] === undefined) return [];
    const parsed = realManagedChangeInterruptionKindSchema.safeParse(match[1]);
    return parsed.success ? [parsed.data] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function runAgent(options: {
  readonly engineHost: EngineHost;
  readonly kernel: WorkflowKernel;
  readonly run: Run;
  readonly plan: PlanRevision;
  readonly attemptId: AttemptId;
  readonly attemptNumber: number;
  readonly repository: string;
  readonly prompt: string;
  readonly now: () => string;
  readonly beforeStart: () => Promise<void>;
  readonly monotonicNow: () => number;
}): Promise<AgentRunResult> {
  const capabilityReceipt = capabilityReceiptSchema.parse(
    await options.engineHost.probe({
      schemaVersion: "1.0.0",
      requestedCapabilities: ["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "CLOSE"],
    }),
  );
  for (const capability of ["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "CLOSE"] as const) {
    if (!supportsEngineCapability(capabilityReceipt, capability)) {
      throw new RealManagedChangeBlockedError(
        "WORKSPACE_DRIFT",
        `the Engine Host does not support required capability ${capability}`,
      );
    }
  }
  const operationSuffix = `a${String(options.attemptNumber)}`;
  const operationDeadline = deadlineFrom(options.now(), runTimeoutMs);
  const startPayload = {
    runId: options.run.runId,
    attemptId: options.attemptId,
    planRevisionId: options.plan.planRevisionId,
    workspaceReference: options.repository,
  };
  await options.beforeStart();
  const startReceipt = await options.engineHost.start(
    startAttemptRequestSchema.parse({
      schemaVersion: "1.0.0",
      operationId: operationIdSchema.parse(`op_real-${operationSuffix}-start`),
      fingerprint: sha256(JSON.stringify(startPayload)),
      expectedTarget: { namespace: "workspace", reference: options.repository },
      deadline: operationDeadline,
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: runTimeoutMs },
      ...startPayload,
    }),
  );
  const engineInput = engineInputSchema.parse({
    schemaVersion: "1.0.0",
    operationId: operationIdSchema.parse(`op_real-${operationSuffix}-send`),
    fingerprint: sha256(options.prompt),
    expectedTarget: {
      namespace: "engine-handle",
      reference: startReceipt.handle.engineHandleId,
    },
    deadline: operationDeadline,
    cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: runTimeoutMs },
    kind: "USER_INPUT",
    content: options.prompt,
  });
  const closeRequest = {
    schemaVersion: "1.0.0" as const,
    operationId: operationIdSchema.parse(`op_real-${operationSuffix}-close`),
    fingerprint: sha256(`real-close-${operationSuffix}`),
    expectedTarget: {
      namespace: "engine-handle" as const,
      reference: startReceipt.handle.engineHandleId,
    },
    deadline: operationDeadline,
    cancellationPolicy: { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 },
    reason: "Bounded Managed Change Agent operation returned.",
  };
  let sendReceipt: Awaited<ReturnType<EngineHost["send"]>>;
  const runtimeStartedAt = options.monotonicNow();
  try {
    sendReceipt = await options.engineHost.send(startReceipt.handle, engineInput);
  } catch (error: unknown) {
    try {
      await options.engineHost.close(startReceipt.handle, closeRequest);
    } catch {
      // Preserve the original SEND failure; the Engine Host owns its own fail-closed cleanup.
    }
    throw error;
  }
  const observations: EngineObservation[] = [];
  for await (const observation of options.engineHost.observe(startReceipt.handle)) {
    observations.push(observation);
  }
  const closeReceipt = await options.engineHost.close(startReceipt.handle, closeRequest);
  const evidence = makeEvidence({
    evidenceId: evidenceIdSchema.parse(`evidence_real-agent-${String(options.attemptNumber)}`),
    kind: "observation",
    runId: options.run.runId,
    attemptId: options.attemptId,
    createdAt: options.now(),
    sourceFingerprint: options.plan.sourceFingerprint,
    summary: "The bounded Pi Agent operation returned provider-neutral observations.",
    content: JSON.stringify({
      startOperation: startReceipt.operationReceipt,
      sendOperation: sendReceipt,
      closeOperation: closeReceipt,
      observationKinds: observations.map((observation) => observation.kind),
    }),
    repository: options.repository,
    prompt: options.prompt,
  });
  for (const observation of observations) {
    await options.kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse(
          `obs_real-${String(options.attemptNumber)}-${String(observation.cursor)}`,
        ),
        runId: options.run.runId,
        attemptId: options.attemptId,
        stepId: stepIdSchema.parse("step_real-agent"),
        kind: observation.kind,
        observedAt: observation.observedAt,
        ...(observation.summary === undefined ? {} : { summary: observation.summary }),
        evidenceIds: [evidence.evidenceId],
      },
    });
  }
  return {
    attemptId: options.attemptId,
    startReceipt,
    sendReceipt,
    closeReceipt,
    observations,
    evidence,
    runtimeMs: Math.max(0, options.monotonicNow() - runtimeStartedAt),
  };
}

async function recoverInterruptedManagedAttempt(options: {
  readonly kernel: WorkflowKernel;
  readonly run: Run;
  readonly plan: PlanRevision;
  readonly firstAgent: AgentRunResult;
  readonly writerLease: RealWriterLease;
  readonly engineHost: EngineHost;
  readonly repository: GitRepositorySnapshot;
  readonly target: RealManagedChangeTarget;
  readonly distributionReleaseId: string;
  readonly engineRelease: RunRealManagedChangeOptions["engineRelease"];
  readonly prompt: string;
  readonly now: () => string;
  readonly elapsedMs: number;
}): Promise<{
  readonly recoveryAttemptId: AttemptId;
  readonly evidence: readonly EvidenceEnvelope[];
  readonly interruptedWorkingTreeStateFingerprint: Fingerprint;
}> {
  if (options.firstAgent.sendReceipt.outcome !== "UNKNOWN") {
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      "the interrupted Agent operation did not preserve an UNKNOWN operation Receipt",
    );
  }
  const interruptedWorkspace = await inspectGitRepository(
    options.repository.repository,
    options.repository.digestCache,
    options.repository.inspectionLimits,
    options.repository.inspectionMonotonicNow,
  );
  assertTargetIdentity(options.target, interruptedWorkspace);
  if (
    interruptedWorkspace.baseCommit !== options.repository.baseCommit ||
    interruptedWorkspace.sourceFingerprint !== options.repository.sourceFingerprint ||
    interruptedWorkspace.workspaceFingerprint !== options.repository.workspaceFingerprint
  ) {
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      "the interrupted Agent changed the frozen repository identity",
    );
  }
  const checkpointId = checkpointIdSchema.parse(
    `checkpoint_real-${idSuffix(`${options.run.runId}\0${options.firstAgent.attemptId}`)}`,
  );
  const engineReleaseId = engineReleaseIdSchema.parse(
    `engine-release_real-${idSuffix(
      `${options.engineRelease.packageName}\0${options.engineRelease.version}`,
    )}`,
  );
  const engineReleaseFingerprint = sha256Fingerprint(
    canonicalJson({
      schemaVersion: "hpi-real-engine-release.v1",
      packageName: options.engineRelease.packageName,
      version: options.engineRelease.version,
    }),
  );
  const checkpoint = await new CheckpointCoordinator({
    kernel: options.kernel,
    policy: { everyEvents: 1, everyElapsedMs: 1 },
    capture: {
      capture: ({ projection, now }) => {
        const attempt = projection.attempts.at(-1);
        if (attempt?.attemptId !== options.firstAgent.attemptId) {
          throw new Error("interrupted Checkpoint does not bind the active Attempt");
        }
        return Promise.resolve({
          checkpointId,
          distributionReleaseId: distributionReleaseIdSchema.parse(options.distributionReleaseId),
          repositoryFingerprint: options.target.repositoryFingerprint,
          engine: {
            engineReleaseId,
            engineReleaseFingerprint,
            resumeCapability: "UNSUPPORTED" as const,
          },
          activeOperationReceiptIds: [options.firstAgent.sendReceipt.operationReceiptId],
          unknownOperationIds: [options.firstAgent.sendReceipt.operationId],
          heldWriterLeaseIds: [options.writerLease.leaseId],
          processReferences: [],
          remainingResourceBudgets: attempt.remainingResourceBudgets,
          createdAt: now,
        });
      },
    },
    now: options.now,
  }).maybeRecord(options.run.runId, { force: true });
  if (checkpoint.outcome !== "RECORDED" || checkpoint.checkpointId !== checkpointId) {
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      "the interrupted Managed Attempt did not produce one exact Checkpoint",
    );
  }

  const releasedLease = await options.writerLease.release();
  if (
    releasedLease.outcome !== "RELEASED" ||
    releasedLease.state !== "RELEASED" ||
    releasedLease.leaseId !== options.writerLease.leaseId
  ) {
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      "the interrupted Managed Attempt did not release its exact Writer Lease",
    );
  }
  const evidence: EvidenceEnvelope[] = [];
  const finalityEvidence = makeEvidence({
    evidenceId: "evidence_real-finality-1",
    kind: "checkpoint",
    runId: options.run.runId,
    attemptId: options.firstAgent.attemptId,
    createdAt: releasedLease.observedAt,
    sourceFingerprint: options.plan.sourceFingerprint,
    summary: "The interrupted Attempt reached final process and Writer Lease state.",
    content: canonicalJson({
      schemaVersion: "hpi-real-interrupted-finality.v1",
      checkpointId,
      operationReceiptId: options.firstAgent.sendReceipt.operationReceiptId,
      closeReceipt: options.firstAgent.closeReceipt,
      releasedLease,
    }),
    repository: options.repository.repository,
    prompt: options.prompt,
  });
  evidence.push(finalityEvidence);
  const finalityReceipt = attemptFinalityReceiptSchema.parse({
    schemaVersion: "1.0.0",
    attemptFinalityReceiptId: `finality_real-${idSuffix(checkpointId)}`,
    runId: options.run.runId,
    attemptId: options.firstAgent.attemptId,
    checkpointId,
    workspaceId: options.plan.workspaceId,
    workspaceFingerprint: options.plan.workspaceFingerprint,
    sourceFingerprint: options.plan.sourceFingerprint,
    processFinalities: [],
    releasedWriterLeaseIds: [options.writerLease.leaseId],
    terminalFinality: "FINAL",
    evidenceIds: [finalityEvidence.evidenceId],
    observedAt: releasedLease.observedAt,
  });
  const recoveryAttemptId = attemptIdSchema.parse("att_real-2");
  const recoveryOperationId = operationIdSchema.parse("op_real-recovery-1");
  const recoveryOperationFingerprint = sha256Fingerprint(
    canonicalJson({
      schemaVersion: "hpi-real-recovery-operation.v1",
      runId: options.run.runId,
      checkpointId,
      recoveryAttemptId,
    }),
  );
  const firstUsage = observedProviderUsage(options.firstAgent.observations);
  if (firstUsage === undefined) {
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      "the interrupted Managed Attempt has no exact Provider usage for recovery",
    );
  }
  const recovery = await new RecoveryCoordinator({
    kernel: options.kernel,
    reconciler: {
      revalidateDistributionRelease: (candidate) =>
        Promise.resolve({
          status: "PASS" as const,
          identity: {
            kind: "DISTRIBUTION_RELEASE" as const,
            distributionReleaseId: candidate.distributionReleaseId,
          },
        }),
      revalidateWorkspace: async (candidate) => {
        await assertExactWorkspaceState(
          options.repository,
          options.target,
          interruptedWorkspace.workingTreeStateFingerprint,
        );
        return {
          status: "PASS" as const,
          identity: {
            kind: "WORKSPACE" as const,
            workspaceId: candidate.workspaceId,
            repositoryFingerprint: candidate.repositoryFingerprint,
            workspaceFingerprint: candidate.workspaceFingerprint,
            sourceFingerprint: candidate.sourceFingerprint,
          },
        };
      },
      reconcileOperations: async (candidate) => {
        const receipt = await options.engineHost.reconcile({
          schemaVersion: "1.0.0",
          operationId: options.firstAgent.sendReceipt.operationId,
          fingerprint: options.firstAgent.sendReceipt.fingerprint,
        });
        return {
          activeOperationReceiptIds: candidate.activeOperationReceiptIds,
          unknownOperationIds: candidate.unknownOperationIds,
          receipts: [receipt],
        };
      },
      reconcileAttemptFinality: () => Promise.resolve(finalityReceipt),
      reconcileEngine: (candidate) =>
        Promise.resolve({
          status: "PASS" as const,
          identity: {
            kind: "ENGINE" as const,
            engineReleaseId: candidate.engine.engineReleaseId,
            engineReleaseFingerprint: candidate.engine.engineReleaseFingerprint,
          },
        }),
    },
    captureEvidence: {
      capture: (request) => {
        const fingerprint = sha256Fingerprint(canonicalJson(request));
        const recoveryEvidence = makeEvidence({
          evidenceId: "evidence_real-recovery-1",
          kind: "observation",
          runId: options.run.runId,
          attemptId: options.firstAgent.attemptId,
          createdAt: request.createdAt,
          sourceFingerprint: options.plan.sourceFingerprint,
          summary: "The interrupted Attempt was reconciled before same-Run recovery.",
          content: canonicalJson(request),
          repository: options.repository.repository,
          prompt: options.prompt,
        });
        evidence.push(recoveryEvidence);
        return Promise.resolve({ evidenceId: recoveryEvidence.evidenceId, fingerprint });
      },
    },
    now: options.now,
  }).recover(checkpointId, {
    attemptId: recoveryAttemptId,
    operationId: recoveryOperationId,
    operationFingerprint: recoveryOperationFingerprint,
    elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
    consumedResources: {
      agentTurns: 1,
      externalOperations: 3,
      commands: 0,
      outputBytes: options.firstAgent.observations.reduce(
        (total, observation) => total + (observation.resourceUsage?.outputBytes ?? 0),
        0,
      ),
      tokens: firstUsage.tokenCount,
      costMinorUnits: firstUsage.costMinorUnits,
    },
    startedAt: options.now(),
  });
  if (recovery.status !== "RECOVERED" || recovery.recoveryAttemptId !== recoveryAttemptId) {
    const detail = recovery.status === "NOT_PROVEN" ? recovery.reasons.join(",") : recovery.status;
    throw new RealManagedChangeBlockedError(
      "INTERRUPTION_NOT_PROVEN",
      `the interrupted Managed Attempt did not pass exact same-Run reconciliation (${detail})`,
    );
  }
  return {
    recoveryAttemptId,
    evidence,
    interruptedWorkingTreeStateFingerprint: interruptedWorkspace.workingTreeStateFingerprint,
  };
}

function finalSummary(projection: RunProjection): RealManagedChangeEvidence["finalSummary"] {
  const blockingFindings = projection.reviewReceipts.flatMap((receipt) =>
    receipt.findings
      .filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map((finding) => `${finding.severity}:${finding.scope}`),
  );
  return {
    attempts: projection.attempts.map(
      (attempt) =>
        `${attempt.attemptId}:execution=${attempt.executionStatus},verification=${attempt.verificationStatus}`,
    ),
    checks: projection.checks.map((check) => `${check.checkId}:${check.status}`),
    blockingFindings,
    unresolvedRisks: [
      "Remote Windows and Ubuntu CI remain PENDING for this local Managed Change run.",
      "Hunter Pi does not commit, push, publish, or deploy the operator's repository automatically.",
      "The source working tree is preserved for explicit operator review after this command.",
    ],
  };
}

const realPilotInterruptionSchema = z.strictObject({
  runIdentity: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  forcedInterruption: realManagedChangeInterruptionKindSchema.optional(),
});

export interface RunRealManagedChangeOptions {
  readonly repository: string;
  readonly request: RealManagedChangeRequest;
  readonly engineHost: EngineHost;
  readonly providerAuthConfigured: boolean;
  readonly productSource: { readonly commit: string; readonly state: "CLEAN" | "DIRTY" };
  readonly engineRelease: { readonly packageName: string; readonly version: string };
  readonly providerId: string;
  readonly environmentFingerprint: Fingerprint;
  readonly writerLeaseManager: LeaseManager;
  readonly writerLeaseOwnerFingerprint: Fingerprint;
  readonly durableArchive?: {
    readonly stateRoot: string;
    readonly archiveId: string;
    readonly distributionReleaseId: string;
    readonly operationId: string;
  };
  readonly pilotInterruption?: {
    readonly runIdentity: string;
    readonly forcedInterruption?: RealManagedChangeInterruptionKind;
  };
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly workingTreeInspectionLimits?: RealManagedChangeWorkingTreeInspectionLimits;
}

export async function runRealManagedChange(
  options: RunRealManagedChangeOptions,
): Promise<RealManagedChangeEvidence> {
  const inputRequest = realManagedChangeRequestSchema.parse(options.request);
  const pilotInterruption =
    options.pilotInterruption === undefined
      ? undefined
      : realPilotInterruptionSchema.parse(options.pilotInterruption);
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const workingTreeInspectionLimits = workingTreeInspectionLimitsSchema.parse(
    options.workingTreeInspectionLimits ?? maximumWorkingTreeInspectionLimits,
  );
  const overheadStartedAt = monotonicNow();
  if (!options.providerAuthConfigured) {
    throw new RealManagedChangeBlockedError(
      "PROVIDER_AUTH_REQUIRED",
      "Provider authentication metadata is not configured",
    );
  }
  if (
    !/^[a-f0-9]{40}$/u.test(options.productSource.commit) ||
    options.productSource.state !== "CLEAN"
  ) {
    throw new RealManagedChangeBlockedError(
      "UNSTAMPED_OR_DIRTY_PRODUCT",
      "the Managed Change requires an exact clean stamped Hunter Pi product",
    );
  }
  const snapshot = await inspectGitRepository(
    options.repository,
    undefined,
    workingTreeInspectionLimits,
    monotonicNow,
  );
  assertTargetIdentity(inputRequest.target, snapshot);
  if (snapshot.status.length > 0) {
    throw new RealManagedChangeBlockedError(
      "DIRTY_WORKTREE",
      "the explicitly selected repository has existing staged, unstaged, or untracked work",
    );
  }

  const request: RealManagedChangeRequest = {
    ...inputRequest,
    title: portablePlanText(inputRequest.title, snapshot.repository),
    goal: portablePlanText(inputRequest.goal, snapshot.repository),
    nonGoals: inputRequest.nonGoals.map((value) => portablePlanText(value, snapshot.repository)),
    constraints: inputRequest.constraints.map((value) =>
      portablePlanText(value, snapshot.repository),
    ),
    check: {
      label: portablePlanText(inputRequest.check.label, snapshot.repository),
      executable: portablePlanText(inputRequest.check.executable, snapshot.repository),
      argv: inputRequest.check.argv.map((value) => portablePlanText(value, snapshot.repository)),
    },
  };

  const prompt = [
    `Goal: ${request.goal}`,
    "Operate only in the explicitly selected repository workspace.",
    `Allowed paths: ${request.allowedPaths.join(", ")}`,
    ...request.constraints.map((constraint) => `Constraint: ${constraint}`),
    "Do not commit, push, publish, deploy, edit credentials, or modify paths outside the declared allowed paths.",
    "After making the smallest useful change, stop and return control; Hunter Pi will run the independent declared check.",
  ].join("\n");
  const suffix = idSuffix(
    JSON.stringify({
      request,
      baseCommit: snapshot.baseCommit,
      sourceFingerprint: snapshot.sourceFingerprint,
      ...(pilotInterruption === undefined
        ? {}
        : {
            pilotRunIdentity: pilotInterruption.runIdentity,
          }),
    }),
  );
  const createdAt = now();
  const change = managedChangeSchema.parse({
    schemaVersion: "1.0.0",
    changeId: `chg_real-${suffix}`,
    title: request.title,
    goal: request.goal,
    nonGoals: request.nonGoals,
    constraints: request.constraints,
    lifecycle: "PLANNED",
    createdAt,
  });
  const reviewInputFingerprint = sha256(
    JSON.stringify({
      sourceFingerprint: snapshot.sourceFingerprint,
      allowedPaths: request.allowedPaths,
    }),
  );
  const checkDefinitionFingerprint = fingerprintRealManagedChangeCheckDefinition(request);
  const checkConfigurationFingerprint = sha256(
    JSON.stringify({
      allowedPaths: request.allowedPaths,
      timeoutMs: 30_000,
      maximumOutputBytes: outputCaptureLimits.verification,
    }),
  );
  const plan = planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: `plan_real-${suffix}`,
    changeId: change.changeId,
    revision: 1,
    workspaceId: `workspace_real-${idSuffix(snapshot.repository)}`,
    workspaceFingerprint: snapshot.workspaceFingerprint,
    sourceFingerprint: snapshot.sourceFingerprint,
    goal: request.goal,
    nonGoals: request.nonGoals,
    constraints: request.constraints,
    steps: [
      {
        stepId: "step_real-agent",
        kind: "agent",
        title: "Apply one bounded fix through the Pi Engine",
        dependsOn: [],
        required: true,
        inputContractFingerprint: sha256("hpi-real-agent-input.v1"),
        outputContractFingerprint: sha256("hpi-real-agent-output.v1"),
      },
      {
        stepId: "step_real-review",
        kind: "review",
        title: "Review exact project working-tree mutations",
        dependsOn: ["step_real-agent"],
        required: true,
        inputContractFingerprint: sha256("hpi-real-review-input.v1"),
        outputContractFingerprint: sha256("hpi-real-review-output.v1"),
        inputFingerprint: reviewInputFingerprint,
        reviewDefinitionFingerprint: sha256("hpi-real-deterministic-review.v1"),
        configurationFingerprint: checkConfigurationFingerprint,
      },
    ],
    checks: [
      {
        checkId: "check_real-command",
        version: 1,
        label: request.check.label,
        kind: "command",
        required: true,
        definition: {
          executable: request.check.executable,
          argv: request.check.argv,
          workingDirectoryReference: "workspace-root",
        },
        definitionFingerprint: checkDefinitionFingerprint,
        configurationFingerprint: checkConfigurationFingerprint,
      },
    ],
    loopPolicy: {
      maxIterations: 2,
      maxElapsedMs: runTimeoutMs * 2,
      repeatedFailureLimit: 2,
      resourceBudgets,
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt,
  });
  const run = runSchema.parse({
    schemaVersion: "1.0.0",
    runId: `run_real-${suffix}`,
    changeId: change.changeId,
    planRevisionId: plan.planRevisionId,
    workspaceId: plan.workspaceId,
    workspaceFingerprint: plan.workspaceFingerprint,
    sourceFingerprint: plan.sourceFingerprint,
    lifecycle: "PLANNED",
    archiveStatus: "UNARCHIVED",
    startedAt: createdAt,
  });
  let activeWriterLease = await acquireRealWriterLease({
    manager: options.writerLeaseManager,
    workspaceId: plan.workspaceId,
    ownerFingerprint: options.writerLeaseOwnerFingerprint,
    runSuffix: suffix,
  });
  let activeWriterLeaseReleased = false;
  try {
    const lockedSnapshot = await inspectGitRepository(
      snapshot.repository,
      snapshot.digestCache,
      snapshot.inspectionLimits,
      snapshot.inspectionMonotonicNow,
    );
    assertTargetIdentity(inputRequest.target, lockedSnapshot);
    if (
      lockedSnapshot.status.length > 0 ||
      lockedSnapshot.workingTreeStateFingerprint !== snapshot.workingTreeStateFingerprint ||
      lockedSnapshot.baseCommit !== snapshot.baseCommit ||
      lockedSnapshot.sourceFingerprint !== snapshot.sourceFingerprint ||
      lockedSnapshot.workspaceFingerprint !== snapshot.workspaceFingerprint
    ) {
      throw new RealManagedChangeBlockedError(
        "WORKSPACE_DRIFT",
        "the selected repository changed between clean preflight and writer-lease acquisition",
      );
    }
    const eventStore =
      options.durableArchive === undefined
        ? undefined
        : new FileWorkflowEventStore({
            stateRoot: join(options.durableArchive.stateRoot, "workflow"),
            now,
          });
    const kernel =
      eventStore === undefined
        ? new InMemoryWorkflowKernel()
        : new DurableWorkflowKernel(eventStore);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change,
      planRevision: plan,
      run,
    });

    const allEvidence: EvidenceEnvelope[] = [];
    const allAgentRuns: AgentRunResult[] = [];
    const verificationReceipts: VerificationReceipt[] = [];
    const verificationWorkspacePreservation: boolean[] = [];
    const verificationEvidence: EvidenceEnvelope[] = [];
    const attempt1Id = attemptIdSchema.parse("att_real-1");
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: attempt1Id,
      startedAt: now(),
    });
    await assertTargetReadyForAgent(snapshot, inputRequest.target, false);
    const firstAgent = await runAgent({
      engineHost: options.engineHost,
      kernel,
      run,
      plan,
      attemptId: attempt1Id,
      attemptNumber: 1,
      repository: snapshot.repository,
      prompt,
      now,
      beforeStart: () => assertTargetReadyForAgent(snapshot, inputRequest.target, false),
      monotonicNow,
    });
    allAgentRuns.push(firstAgent);
    allEvidence.push(firstAgent.evidence);
    const interruptionObserved = qualifiedInterruptionObserved(firstAgent.observations);
    if (pilotInterruption?.forcedInterruption !== interruptionObserved) {
      throw new RealManagedChangeBlockedError(
        "INTERRUPTION_NOT_PROVEN",
        "the observed Pi process boundary does not match the frozen pilot interruption",
      );
    }
    const firstProviderUsage = observedProviderUsage(firstAgent.observations);
    let attempt2Id: AttemptId | undefined;
    let attempt2Prompt: string | undefined;
    let attempt2WorkingTreeStateFingerprint: Fingerprint | undefined;
    if (interruptionObserved) {
      if (options.durableArchive === undefined) {
        throw new RealManagedChangeBlockedError(
          "INTERRUPTION_NOT_PROVEN",
          "same-Run interruption recovery requires the durable Managed Run store",
        );
      }
      const recovery = await recoverInterruptedManagedAttempt({
        kernel,
        run,
        plan,
        firstAgent,
        writerLease: activeWriterLease,
        engineHost: options.engineHost,
        repository: snapshot,
        target: inputRequest.target,
        distributionReleaseId: options.durableArchive.distributionReleaseId,
        engineRelease: options.engineRelease,
        prompt,
        now,
        elapsedMs: monotonicNow() - overheadStartedAt,
      });
      allEvidence.push(...recovery.evidence);
      activeWriterLeaseReleased = true;
      activeWriterLease = await acquireRealWriterLease({
        manager: options.writerLeaseManager,
        workspaceId: plan.workspaceId,
        ownerFingerprint: options.writerLeaseOwnerFingerprint,
        runSuffix: `${suffix}-recovery`,
      });
      activeWriterLeaseReleased = false;
      attempt2Id = recovery.recoveryAttemptId;
      attempt2WorkingTreeStateFingerprint = recovery.interruptedWorkingTreeStateFingerprint;
      attempt2Prompt = `${prompt}\nThe preceding Agent process was deliberately interrupted after its exact agent_end marker. Its operation, process finality, and Writer Lease were reconciled. Inspect the preserved working tree and finish the same Run without repeating unrelated work.`;
    } else {
      const beforeFirstVerification = await inspectGitRepository(
        snapshot.repository,
        snapshot.digestCache,
        snapshot.inspectionLimits,
        snapshot.inspectionMonotonicNow,
      );
      const firstVerification = await runDeclaredCommandVerification({
        planRevision: plan,
        runId: run.runId,
        attemptId: attempt1Id,
        checkId: checkIdSchema.parse("check_real-command"),
        verificationReceiptId: verificationReceiptIdSchema.parse("verify_real-1"),
        evidenceId: evidenceIdSchema.parse("evidence_real-verify-1"),
        repository: snapshot.repository,
        environmentFingerprint: options.environmentFingerprint,
        timeoutMs: 30_000,
        maximumOutputBytes: outputCaptureLimits.verification,
        now,
      });
      const afterFirstVerification = await inspectGitRepository(
        snapshot.repository,
        snapshot.digestCache,
        snapshot.inspectionLimits,
        snapshot.inspectionMonotonicNow,
      );
      const firstVerificationPreservedWorkspace =
        afterFirstVerification.workingTreeStateFingerprint ===
        beforeFirstVerification.workingTreeStateFingerprint;
      verificationReceipts.push(firstVerification.receipt);
      verificationWorkspacePreservation.push(firstVerificationPreservedWorkspace);
      const firstVerificationEvidence = makeEvidence({
        evidenceId: "evidence_real-verify-1",
        kind: "verification",
        runId: run.runId,
        attemptId: attempt1Id,
        verificationReceiptId: firstVerification.receipt.verificationReceiptId,
        createdAt: now(),
        sourceFingerprint: plan.sourceFingerprint,
        summary: `Independent project check returned ${firstVerification.receipt.outcome}.`,
        content: JSON.stringify(firstVerification.receipt),
        repository: snapshot.repository,
        prompt,
      });
      verificationEvidence.push(firstVerificationEvidence);
      allEvidence.push(firstVerificationEvidence);
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_VERIFICATION",
        receipt: firstVerification.receipt,
      });
      const fixbackProviderReserveAvailable =
        firstProviderUsage !== undefined &&
        firstProviderUsage.tokenCount <=
          resourceBudgets.maxTokens - fixbackProviderReserve.tokens &&
        firstProviderUsage.costMinorUnits <=
          resourceBudgets.maxCostMinorUnits - fixbackProviderReserve.costMinorUnits;
      if (
        firstVerification.receipt.outcome === "FAIL" &&
        firstVerificationPreservedWorkspace &&
        fixbackProviderReserveAvailable
      ) {
        attempt2Id = attemptIdSchema.parse("att_real-2");
        attempt2WorkingTreeStateFingerprint = afterFirstVerification.workingTreeStateFingerprint;
        attempt2Prompt = `${prompt}\nA previous bounded attempt did not pass the check. Inspect the current state and apply one more minimal fix within the same allowed paths.`;
        await kernel.dispatch({
          schemaVersion: "1.0.0",
          type: "RETRY_ATTEMPT",
          runId: run.runId,
          previousAttemptId: attempt1Id,
          attemptId: attempt2Id,
          failureEvidenceIds: [firstVerificationEvidence.evidenceId],
          failureFingerprint: firstVerification.receipt.resultFingerprint,
          reason: "The first bounded Agent attempt did not pass the declared project check.",
          elapsedMs: 1,
          consumedResources: {
            agentTurns: 1,
            externalOperations: 3,
            commands: 1,
            outputBytes: firstAgent.observations.reduce(
              (total, observation) => total + (observation.resourceUsage?.outputBytes ?? 0),
              firstVerification.receipt.output.capturedBytes,
            ),
            tokens: firstProviderUsage.tokenCount,
            costMinorUnits: firstProviderUsage.costMinorUnits,
          },
          userInputRequired: false,
          workspaceDriftDetected: false,
          startedAt: now(),
        });
      }
    }

    if (attempt2Id !== undefined && attempt2Prompt !== undefined) {
      if (attempt2WorkingTreeStateFingerprint === undefined) {
        throw new Error("a second Managed Attempt has no exact working-tree binding");
      }
      await assertExactWorkspaceState(
        snapshot,
        inputRequest.target,
        attempt2WorkingTreeStateFingerprint,
      );
      const secondAgent = await runAgent({
        engineHost: options.engineHost,
        kernel,
        run,
        plan,
        attemptId: attempt2Id,
        attemptNumber: 2,
        repository: snapshot.repository,
        prompt: attempt2Prompt,
        now,
        beforeStart: () =>
          assertExactWorkspaceState(
            snapshot,
            inputRequest.target,
            attempt2WorkingTreeStateFingerprint,
          ),
        monotonicNow,
      });
      allAgentRuns.push(secondAgent);
      allEvidence.push(secondAgent.evidence);
      if (qualifiedInterruptionObserved(secondAgent.observations) !== undefined) {
        throw new RealManagedChangeBlockedError(
          "INTERRUPTION_NOT_PROVEN",
          "the bounded recovery Attempt was interrupted again",
        );
      }
      const beforeSecondVerification = await inspectGitRepository(
        snapshot.repository,
        snapshot.digestCache,
        snapshot.inspectionLimits,
        snapshot.inspectionMonotonicNow,
      );
      const secondVerification = await runDeclaredCommandVerification({
        planRevision: plan,
        runId: run.runId,
        attemptId: attempt2Id,
        checkId: checkIdSchema.parse("check_real-command"),
        verificationReceiptId: verificationReceiptIdSchema.parse("verify_real-2"),
        evidenceId: evidenceIdSchema.parse("evidence_real-verify-2"),
        repository: snapshot.repository,
        environmentFingerprint: options.environmentFingerprint,
        timeoutMs: 30_000,
        maximumOutputBytes: outputCaptureLimits.verification,
        now,
      });
      const afterSecondVerification = await inspectGitRepository(
        snapshot.repository,
        snapshot.digestCache,
        snapshot.inspectionLimits,
        snapshot.inspectionMonotonicNow,
      );
      verificationWorkspacePreservation.push(
        afterSecondVerification.workingTreeStateFingerprint ===
          beforeSecondVerification.workingTreeStateFingerprint,
      );
      verificationReceipts.push(secondVerification.receipt);
      const secondVerificationEvidence = makeEvidence({
        evidenceId: "evidence_real-verify-2",
        kind: "verification",
        runId: run.runId,
        attemptId: attempt2Id,
        verificationReceiptId: secondVerification.receipt.verificationReceiptId,
        createdAt: now(),
        sourceFingerprint: plan.sourceFingerprint,
        summary: `Independent project check returned ${secondVerification.receipt.outcome}.`,
        content: JSON.stringify(secondVerification.receipt),
        repository: snapshot.repository,
        prompt,
      });
      verificationEvidence.push(secondVerificationEvidence);
      allEvidence.push(secondVerificationEvidence);
      await kernel.dispatch({
        schemaVersion: "1.0.0",
        type: "RECORD_VERIFICATION",
        receipt: secondVerification.receipt,
      });
    }

    const latestAttempt = allAgentRuns.at(-1);
    const latestVerification = verificationReceipts.at(-1);
    if (latestAttempt === undefined || latestVerification === undefined) {
      throw new Error("Managed Change did not produce a final Agent and Verification pair");
    }
    const after = await inspectGitRepository(
      snapshot.repository,
      snapshot.digestCache,
      snapshot.inspectionLimits,
      snapshot.inspectionMonotonicNow,
    );
    const parsedStatus = parseChangedPaths(after.status);
    const verificationPreservedWorkspace =
      verificationWorkspacePreservation.length === verificationReceipts.length &&
      verificationWorkspacePreservation.every(Boolean);
    const reviewedChangedPaths = [
      ...new Set([
        ...parsedStatus.paths,
        ...changedIgnoredPaths(snapshot.ignoredContent, after.ignoredContent),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    const changedPathsWithinScope = reviewedChangedPaths.every((path) =>
      request.allowedPaths.includes(path),
    );
    const baseCommitUnchanged = after.baseCommit === snapshot.baseCommit;
    const targetReferenceUnchanged =
      after.branch === snapshot.branch &&
      after.pilotTargetReferenceFingerprint === snapshot.pilotTargetReferenceFingerprint &&
      after.pilotTargetReferenceFingerprint === inputRequest.target.targetReferenceFingerprint;
    const agentReturned =
      latestAttempt.sendReceipt.outcome === "APPLIED" &&
      latestAttempt.observations.some((observation) => observation.kind === "AGENT_RETURNED");
    const engineOutputObservations = allAgentRuns.flatMap((agent) =>
      agent.observations.filter((observation) => observation.kind === "OUTPUT_CAPTURED"),
    );
    const engineOutputMeasured = engineOutputObservations.every(
      (observation) => observation.resourceUsage?.outputBytes !== undefined,
    );
    const engineOutputBytes = engineOutputMeasured
      ? engineOutputObservations.reduce(
          (total, observation) => total + (observation.resourceUsage?.outputBytes ?? 0),
          0,
        )
      : undefined;
    const verificationOutputBytes = verificationReceipts.reduce(
      (total, receipt) => total + receipt.output.capturedBytes,
      0,
    );
    const consumedOutputBytes =
      engineOutputBytes === undefined ? undefined : engineOutputBytes + verificationOutputBytes;
    const agentProviderUsages = allAgentRuns.map((agent) =>
      observedProviderUsage(agent.observations),
    );
    const completeProviderUsages = agentProviderUsages.filter(
      (usage): usage is ObservedProviderUsage => usage !== undefined,
    );
    const providerUsageObservationsMeasured =
      completeProviderUsages.length === agentProviderUsages.length;
    const providerRequestCount = providerUsageObservationsMeasured
      ? sumSafeNonnegativeIntegers(completeProviderUsages.map((usage) => usage.requestCount))
      : undefined;
    const providerTokenCount = providerUsageObservationsMeasured
      ? sumSafeNonnegativeIntegers(completeProviderUsages.map((usage) => usage.tokenCount))
      : undefined;
    const providerCostMinorUnits = providerUsageObservationsMeasured
      ? sumSafeNonnegativeIntegers(completeProviderUsages.map((usage) => usage.costMinorUnits))
      : undefined;
    const providerUsageMeasured =
      providerUsageObservationsMeasured &&
      providerRequestCount !== undefined &&
      providerTokenCount !== undefined &&
      providerCostMinorUnits !== undefined;
    const unprovenReasons = [
      ...(engineOutputMeasured ? [] : ["ENGINE_OUTPUT_BYTES_MISSING"]),
      ...(providerUsageMeasured ? [] : ["ENGINE_PROVIDER_USAGE_MISSING"]),
    ];
    const budgetExceeded =
      (consumedOutputBytes !== undefined && consumedOutputBytes > resourceBudgets.maxOutputBytes) ||
      (engineOutputBytes !== undefined && engineOutputBytes > outputCaptureLimits.engine) ||
      (providerTokenCount !== undefined && providerTokenCount > resourceBudgets.maxTokens) ||
      (providerCostMinorUnits !== undefined &&
        providerCostMinorUnits > resourceBudgets.maxCostMinorUnits) ||
      verificationReceipts.some(
        (receipt) => receipt.output.capturedBytes > outputCaptureLimits.verification,
      );
    const providerUsage = providerUsageMeasured
      ? ({
          status: "PASS" as const,
          requestCount: providerRequestCount,
          tokenCount: providerTokenCount,
          costMinorUnits: providerCostMinorUnits,
          reasons: [] as const,
        } as const)
      : ({
          status: "NOT_PROVEN" as const,
          requestCount: null,
          tokenCount: null,
          costMinorUnits: null,
          reasons: ["ENGINE_PROVIDER_USAGE_MISSING"] as const,
        } as const);
    const resourceAccounting = {
      status: budgetExceeded
        ? ("EXCEEDED" as const)
        : unprovenReasons.length > 0
          ? ("NOT_PROVEN" as const)
          : ("PASS" as const),
      budgets: resourceBudgets,
      captureLimits: outputCaptureLimits,
      capturedOutputBytes: {
        ...(engineOutputBytes === undefined ? {} : { engine: engineOutputBytes }),
        verification: verificationOutputBytes,
      },
      consumed: {
        agentTurns: allAgentRuns.length,
        externalOperations: allAgentRuns.length * 3,
        commands: verificationReceipts.length,
        ...(consumedOutputBytes === undefined ? {} : { outputBytes: consumedOutputBytes }),
        ...(providerTokenCount === undefined ? {} : { tokens: providerTokenCount }),
        ...(providerCostMinorUnits === undefined ? {} : { costMinorUnits: providerCostMinorUnits }),
      },
      unprovenReasons,
    };
    const reviewEvidenceId = evidenceIdSchema.parse("evidence_real-review");
    const findings: ReviewFinding[] = [
      ...(parsedStatus.renameOrCopyDetected
        ? [
            {
              severity: "P1" as const,
              scope: "workspace-rename-or-copy",
              rationale:
                "Renames and copies are outside this first real-project promotion boundary.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(!changedPathsWithinScope
        ? [
            {
              severity: "P1" as const,
              scope: "workspace-out-of-scope-paths",
              rationale: "The Agent changed a path outside the explicit allowedPaths declaration.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(!verificationPreservedWorkspace
        ? [
            {
              severity: "P1" as const,
              scope: "verification-workspace-mutation",
              rationale:
                "An independent Verification command changed repository content instead of observing it.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(!baseCommitUnchanged
        ? [
            {
              severity: "P0" as const,
              scope: "workspace-head-drift",
              rationale:
                "The Agent changed the repository HEAD instead of leaving commit history untouched.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(!targetReferenceUnchanged
        ? [
            {
              severity: "P0" as const,
              scope: "workspace-target-reference-drift",
              rationale:
                "The final repository branch no longer matches the frozen target-reference identity.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(reviewedChangedPaths.length === 0
        ? [
            {
              severity: "P1" as const,
              scope: "workspace-no-change",
              rationale:
                "The requested Managed Change produced no reviewable working-tree mutation.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(!agentReturned
        ? [
            {
              severity: "P1" as const,
              scope: "agent-operation-outcome",
              rationale:
                "The final Agent operation did not produce both an APPLIED Receipt and AGENT_RETURNED Observation.",
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]
        : []),
      ...(resourceAccounting.status === "PASS"
        ? []
        : [
            {
              severity: "P1" as const,
              scope: "resource-budget",
              rationale: `Real-project cumulative resource accounting is ${resourceAccounting.status}.`,
              evidenceIds: [reviewEvidenceId],
              confidence: 1,
            },
          ]),
    ];
    let recordedReviewFindings: readonly ReviewFinding[] = [];
    if (latestVerification.outcome === "PASS") {
      const reviewEvidence = makeEvidence({
        evidenceId: reviewEvidenceId,
        kind: "review",
        runId: run.runId,
        attemptId: latestAttempt.attemptId,
        createdAt: now(),
        sourceFingerprint: plan.sourceFingerprint,
        summary: `Deterministic real-project review completed with ${String(findings.length)} blocking finding(s).`,
        content: JSON.stringify({
          changedPaths: reviewedChangedPaths,
          allowedPaths: request.allowedPaths,
          baseCommitUnchanged,
          targetReferenceUnchanged,
          verificationPreservedWorkspace,
          findings,
          resourceAccounting,
        }),
        repository: snapshot.repository,
        prompt,
      });
      allEvidence.push(reviewEvidence);
      const reviewProjection = await kernel.project(run.runId);
      if (reviewProjection.run.lifecycle === "REVIEWING") {
        const reviewStep = plan.steps.find((step) => step.stepId === "step_real-review");
        if (reviewStep?.kind !== "review") throw new Error("real-project review Step is missing");
        recordedReviewFindings = findings;
        await kernel.dispatch({
          schemaVersion: "1.0.0",
          type: "RECORD_REVIEW_RECEIPT",
          receipt: reviewReceiptSchema.parse({
            schemaVersion: "1.0.0",
            reviewReceiptId: "review_real",
            runId: run.runId,
            attemptId: latestAttempt.attemptId,
            stepId: reviewStep.stepId,
            inputFingerprint: reviewStep.inputFingerprint,
            reviewDefinitionFingerprint: reviewStep.reviewDefinitionFingerprint,
            configurationFingerprint: reviewStep.configurationFingerprint,
            workspaceFingerprint: plan.workspaceFingerprint,
            sourceFingerprint: plan.sourceFingerprint,
            resultFingerprint: sha256(
              JSON.stringify({
                verificationInputFingerprint: latestVerification.inputFingerprint,
                changedPaths: reviewedChangedPaths,
                findings,
              }),
            ),
            outcome: findings.length === 0 ? "PASS" : "FAIL",
            observedAt: now(),
            findings,
            evidenceIds: [reviewEvidence.evidenceId],
          }),
        });
      }
    }
    const projection = await kernel.project(run.runId);
    const summary = finalSummary(projection);
    const summaryEvidence = createRunSummaryEvidence(
      {
        schemaVersion: "1.0.0",
        evidenceId: "evidence_real-summary",
        projection,
        evidence: allEvidence,
        createdAt: now(),
      },
      { privatePathRoots: [snapshot.repository], privatePromptValues: [prompt] },
    );
    allEvidence.push(summaryEvidence);
    const excludedEngineRuntimeMs = allAgentRuns.reduce(
      (total, agentRun) => total + agentRun.runtimeMs,
      0,
    );
    const overheadMs = Math.max(
      0,
      Math.round(monotonicNow() - overheadStartedAt - excludedEngineRuntimeMs),
    );
    const sourceLoss = !baseCommitUnchanged;
    const releasedWriterLease = await activeWriterLease.release();
    activeWriterLeaseReleased = true;
    const interruptedAttemptHistoryPreserved = projection.checkpoints.some(
      (checkpoint) =>
        checkpoint.attemptId === projection.attempts[0]?.attemptId &&
        projection.attemptFinalityReceipts.some(
          (receipt) =>
            receipt.attemptId === checkpoint.attemptId &&
            receipt.checkpointId === checkpoint.checkpointId,
        ) &&
        projection.attempts[1]?.previousAttemptId === checkpoint.attemptId &&
        projection.attempts[1]?.recoveryCheckpointId === checkpoint.checkpointId,
    );
    const portableBeforeScore = {
      schemaVersion: "hpi-managed-change.v3" as const,
      observedAt: now(),
      taskResult: "STOP" as const,
      productSource: options.productSource,
      engineRelease: options.engineRelease,
      provider: {
        id: options.providerId,
        authStatus: "DETECTED" as const,
        requestStatus:
          (latestAttempt.sendReceipt.outcome === "APPLIED" ||
            qualifiedInterruptionObserved(latestAttempt.observations) !== undefined) &&
          providerUsage.status === "PASS" &&
          providerUsage.requestCount > 0
            ? ("DETECTED" as const)
            : ("NOT_PROVEN" as const),
        promptFingerprint: sha256(prompt),
        usage: providerUsage,
      },
      repository: {
        scope: "EXPLICIT_OPERATOR_SELECTED" as const,
        branch: snapshot.branch,
        baseCommit: snapshot.baseCommit,
        workspaceFingerprint: snapshot.workspaceFingerprint,
        sourceFingerprint: snapshot.sourceFingerprint,
        target: inputRequest.target,
      },
      plan: {
        planRevisionId: plan.planRevisionId,
        planFingerprint: sha256(JSON.stringify(plan)),
        allowedPaths: request.allowedPaths,
        checkId: "check_real-command",
        checkDefinitionFingerprint,
      },
      writerLease: {
        leaseId: activeWriterLease.leaseId,
        workspaceId: activeWriterLease.workspaceId,
        resourceSetFingerprint: activeWriterLease.resourceSetFingerprint,
        acquireOutcome: "ACQUIRED" as const,
        releaseOutcome: releasedWriterLease.outcome,
      },
      projection,
      evidence: allEvidence,
      review: {
        changedPaths: reviewedChangedPaths,
        allowedPaths: request.allowedPaths,
        baseCommitUnchanged,
        agentReturned,
        findings: recordedReviewFindings,
      },
      resourceAccounting,
      finalSummary: summary,
      scorecard: {
        zeroFalseReady:
          projection.change.lifecycle !== "READY" ||
          (latestVerification.outcome === "PASS" &&
            findings.length === 0 &&
            reviewedChangedPaths.length > 0),
        sourceLoss,
        secretLeak: false,
        failedAttemptPreserved:
          projection.attempts.length < 2 ||
          (projection.attempts[0]?.verificationStatus === "FAILED" &&
            projection.verificationReceipts[0]?.outcome === "FAIL") ||
          interruptedAttemptHistoryPreserved,
        fixbackPass:
          latestVerification.outcome === "PASS" &&
          (projection.attempts.length === 1 ||
            projection.attempts[1]?.verificationStatus === "PASSED"),
        changedPathsWithinScope,
        agentReturnObserved: agentReturned,
        summaryComplete:
          summary.attempts.length === projection.attempts.length &&
          summary.checks.length === projection.checks.length,
        resourceBudgetReconciled: resourceAccounting.status === "PASS",
        overheadMs,
        overheadWithinLimit: overheadMs <= 600_000,
      },
      cleanup: {
        status: "NOT_APPLICABLE" as const,
        targetWorkingTree:
          reviewedChangedPaths.length > 0
            ? ("PRESERVED_CHANGED" as const)
            : ("PRESERVED_CLEAN" as const),
      },
      remoteCi: "PENDING" as const,
    };
    const portableText = JSON.stringify(portableBeforeScore);
    const secretLeak =
      portableText.includes(snapshot.repository) ||
      /\b(?:authorization|cookie|api[_-]?key|access[_-]?token)\s*[:=]/iu.test(portableText);
    const scorecard = { ...portableBeforeScore.scorecard, secretLeak };
    const correctnessPassed =
      projection.change.lifecycle === "READY" &&
      latestVerification.outcome === "PASS" &&
      findings.length === 0 &&
      reviewedChangedPaths.length > 0 &&
      changedPathsWithinScope &&
      baseCommitUnchanged &&
      targetReferenceUnchanged &&
      agentReturned &&
      resourceAccounting.status === "PASS" &&
      !sourceLoss &&
      !secretLeak;
    const taskResult = correctnessPassed ? "GO" : "STOP";
    if (options.durableArchive !== undefined) {
      const taskReceipt = realManagedChangeTaskReceiptSchema.parse({
        schemaVersion: "hpi-real-managed-change-task-receipt.v3",
        runId: run.runId,
        repositoryFingerprint: inputRequest.target.repositoryFingerprint,
        targetReferenceFingerprint: inputRequest.target.targetReferenceFingerprint,
        sourceFingerprint: plan.sourceFingerprint,
        taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(inputRequest),
        interruptionKind: interruptionObserved ?? null,
        mode: "MANAGED",
        acceptanceCheckDefinitionFingerprints: [checkDefinitionFingerprint],
        terminalOutcome: projection.change.lifecycle,
        taskResult,
        sourcePreserved: !sourceLoss,
        rawSecretLeakage: secretLeak,
        providerUsage,
        reviewP0P1Count: recordedReviewFindings.filter(
          (finding) => finding.severity === "P0" || finding.severity === "P1",
        ).length,
        overheadMs,
      });
      allEvidence.push(
        makeEvidence({
          evidenceId: "evidence_real-task-receipt",
          kind: "review",
          runId: run.runId,
          attemptId: latestAttempt.attemptId,
          createdAt: now(),
          sourceFingerprint: plan.sourceFingerprint,
          summary: "The durable Managed Change task receipt binds outcome and Provider usage.",
          content: JSON.stringify(taskReceipt),
          repository: snapshot.repository,
          prompt,
        }),
      );
    }
    const artifact = realManagedChangeEvidenceSchema.parse({
      ...portableBeforeScore,
      taskResult,
      scorecard: { ...scorecard, zeroFalseReady: portableBeforeScore.scorecard.zeroFalseReady },
    });
    if (options.durableArchive !== undefined && eventStore !== undefined) {
      const events = await eventStore.read(run.runId);
      const operationFingerprint = sha256Fingerprint(
        canonicalJson({
          schemaVersion: "hpi-real-managed-change-archive-operation.v1",
          operationId: options.durableArchive.operationId,
          archiveId: options.durableArchive.archiveId,
          distributionReleaseId: options.durableArchive.distributionReleaseId,
          runId: run.runId,
          sourceFingerprint: plan.sourceFingerprint,
          projectionFingerprint: sha256Fingerprint(canonicalJson(projection)),
          eventFingerprint: sha256Fingerprint(canonicalJson(events)),
          evidenceFingerprint: sha256Fingerprint(canonicalJson(artifact.evidence)),
        }),
      );
      await new FileRunArchiveStore({
        stateRoot: join(options.durableArchive.stateRoot, "archive"),
        kernel,
      }).finalize({
        schemaVersion: "hpi-archive-finalize.v1",
        operationId: options.durableArchive.operationId,
        operationFingerprint,
        archiveId: options.durableArchive.archiveId,
        distributionReleaseId: options.durableArchive.distributionReleaseId,
        projection,
        events: [...events],
        evidence: [...artifact.evidence],
        recoveryLimits: { maxAttempts: 2, maxElapsedMs: 60_000 },
        archivedAt: artifact.observedAt,
      });
    }
    return artifact;
  } finally {
    if (!activeWriterLeaseReleased) {
      await activeWriterLease.release().catch(() => undefined);
    }
  }
}
