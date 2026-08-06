import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  attemptIdSchema,
  checkIdSchema,
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
  createPortableEvidenceEnvelope,
  createRunSummaryEvidence,
  redactPortableText,
} from "@hunter-pi/evidence";
import { runDeclaredCommandVerification } from "@hunter-pi/verification";
import {
  InMemoryWorkflowKernel,
  runProjectionSchema,
  type RunProjection,
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
    schemaVersion: z.literal("hpi-managed-change-request.v1"),
    title: terminalSafeTextSchema,
    goal: terminalSafeTextSchema,
    nonGoals: z.array(terminalSafeTextSchema).max(64),
    constraints: z.array(terminalSafeTextSchema).max(64),
    allowedPaths: z.array(projectPathSchema).min(1).max(256),
    check: projectCheckSchema,
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

const resourceAccountingSchema = z.strictObject({
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

export const realManagedChangeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("hpi-managed-change.v1"),
  observedAt: z.iso.datetime({ offset: true }),
  taskResult: z.enum(["GO", "REVISE", "STOP"]),
  productSource: productSourceSchema,
  engineRelease: z.strictObject({
    packageName: terminalSafeTextSchema.max(256),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  }),
  provider: z.strictObject({
    id: terminalSafeTextSchema.max(128),
    authStatus: z.enum(["DETECTED", "BLOCKED"]),
    requestStatus: z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]),
    promptFingerprint: fingerprintSchema,
  }),
  repository: z.strictObject({
    scope: z.literal("EXPLICIT_OPERATOR_SELECTED"),
    branch: terminalSafeTextSchema.max(512),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    workspaceFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
  }),
  plan: z.strictObject({
    planRevisionId: z.string().regex(/^plan_[A-Za-z0-9][A-Za-z0-9.-]*$/u),
    planFingerprint: fingerprintSchema,
    allowedPaths: z.array(projectPathSchema),
    checkId: z.string().regex(/^check_[A-Za-z0-9][A-Za-z0-9.-]*$/u),
    checkDefinitionFingerprint: fingerprintSchema,
  }),
  writerLease: z.strictObject({
    leaseId: writerLeaseIdSchema,
    workspaceId: workspaceIdSchema,
    resourceSetFingerprint: fingerprintSchema,
    acquireOutcome: z.literal("ACQUIRED"),
    releaseOutcome: z.literal("RELEASED"),
  }),
  projection: runProjectionSchema,
  evidence: z.array(evidenceEnvelopeSchema).min(1),
  review: z.strictObject({
    changedPaths: z.array(projectPathSchema),
    allowedPaths: z.array(projectPathSchema),
    baseCommitUnchanged: z.boolean(),
    agentReturned: z.boolean(),
    findings: z.array(reviewFindingSchema),
  }),
  resourceAccounting: resourceAccountingSchema,
  finalSummary: z.strictObject({
    attempts: z.array(z.string().min(1)),
    checks: z.array(z.string().min(1)),
    blockingFindings: z.array(z.string().min(1)),
    unresolvedRisks: z.array(z.string().min(1)),
  }),
  scorecard: z.strictObject({
    zeroFalseReady: z.boolean(),
    sourceLoss: z.boolean(),
    secretLeak: z.boolean(),
    failedAttemptPreserved: z.boolean(),
    fixbackPass: z.boolean(),
    changedPathsWithinScope: z.boolean(),
    agentReturnObserved: z.boolean(),
    summaryComplete: z.boolean(),
    resourceBudgetReconciled: z.boolean(),
    overheadMs: z.number().int().nonnegative(),
    overheadWithinLimit: z.boolean(),
  }),
  cleanup: z.strictObject({
    status: z.literal("NOT_APPLICABLE"),
    targetWorkingTree: z.enum(["PRESERVED_CHANGED", "PRESERVED_CLEAN"]),
  }),
  remoteCi: z.literal("PENDING"),
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
  | "WORKSPACE_BUSY";

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
});
const outputCaptureLimits = Object.freeze({ engine: 229_376, verification: 16_384 });
const runTimeoutMs = 300_000;

function sha256(value: string | Buffer): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function idSuffix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
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
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
}

function runGit(repository: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    env: minimalGitEnvironment(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
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
  readonly workspaceFingerprint: Fingerprint;
  readonly sourceFingerprint: Fingerprint;
}

async function inspectGitRepository(repositoryInput: string): Promise<GitRepositorySnapshot> {
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
  const workspaceStatus = runGit(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const sourceFingerprint = sha256(`hpi-real-source.v1\0${baseCommit}\0${baseTree}`);
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
    sourceFingerprint,
    workspaceFingerprint,
  };
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
  readonly kind: "observation" | "verification" | "review";
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
}

async function runAgent(options: {
  readonly engineHost: EngineHost;
  readonly kernel: InMemoryWorkflowKernel;
  readonly run: Run;
  readonly plan: PlanRevision;
  readonly attemptId: AttemptId;
  readonly attemptNumber: number;
  readonly repository: string;
  readonly prompt: string;
  readonly now: () => string;
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
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

export async function runRealManagedChange(
  options: RunRealManagedChangeOptions,
): Promise<RealManagedChangeEvidence> {
  const inputRequest = realManagedChangeRequestSchema.parse(options.request);
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
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
  const snapshot = await inspectGitRepository(options.repository);
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
  const checkDefinitionFingerprint = sha256(
    JSON.stringify({
      ...request.check,
      workingDirectoryReference: "workspace-root",
    }),
  );
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
  const writerLease = await acquireRealWriterLease({
    manager: options.writerLeaseManager,
    workspaceId: plan.workspaceId,
    ownerFingerprint: options.writerLeaseOwnerFingerprint,
    runSuffix: suffix,
  });
  let writerLeaseReleased = false;
  try {
    const lockedSnapshot = await inspectGitRepository(snapshot.repository);
    if (
      lockedSnapshot.status.length > 0 ||
      lockedSnapshot.baseCommit !== snapshot.baseCommit ||
      lockedSnapshot.sourceFingerprint !== snapshot.sourceFingerprint ||
      lockedSnapshot.workspaceFingerprint !== snapshot.workspaceFingerprint
    ) {
      throw new RealManagedChangeBlockedError(
        "WORKSPACE_DRIFT",
        "the selected repository changed between clean preflight and writer-lease acquisition",
      );
    }
    const kernel = new InMemoryWorkflowKernel();
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      change,
      planRevision: plan,
      run,
    });

    const allEvidence: EvidenceEnvelope[] = [];
    const allAgentRuns: AgentRunResult[] = [];
    const verificationReceipts: Awaited<
      ReturnType<typeof runDeclaredCommandVerification>
    >["receipt"][] = [];
    const verificationEvidence: EvidenceEnvelope[] = [];
    const attempt1Id = attemptIdSchema.parse("att_real-1");
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: run.runId,
      attemptId: attempt1Id,
      startedAt: now(),
    });
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
    });
    allAgentRuns.push(firstAgent);
    allEvidence.push(firstAgent.evidence);
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
    verificationReceipts.push(firstVerification.receipt);
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

    if (firstVerification.receipt.outcome === "FAIL") {
      const attempt2Id = attemptIdSchema.parse("att_real-2");
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
        },
        userInputRequired: false,
        workspaceDriftDetected: false,
        startedAt: now(),
      });
      const secondAgent = await runAgent({
        engineHost: options.engineHost,
        kernel,
        run,
        plan,
        attemptId: attempt2Id,
        attemptNumber: 2,
        repository: snapshot.repository,
        prompt: `${prompt}\nA previous bounded attempt did not pass the check. Inspect the current state and apply one more minimal fix within the same allowed paths.`,
        now,
      });
      allAgentRuns.push(secondAgent);
      allEvidence.push(secondAgent.evidence);
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
    const after = await inspectGitRepository(snapshot.repository);
    const parsedStatus = parseChangedPaths(after.status);
    const changedPathsWithinScope = parsedStatus.paths.every((path) =>
      request.allowedPaths.includes(path),
    );
    const baseCommitUnchanged = after.baseCommit === snapshot.baseCommit;
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
    const unprovenReasons = engineOutputMeasured ? [] : ["ENGINE_OUTPUT_BYTES_MISSING"];
    const budgetExceeded =
      (consumedOutputBytes !== undefined && consumedOutputBytes > resourceBudgets.maxOutputBytes) ||
      (engineOutputBytes !== undefined && engineOutputBytes > outputCaptureLimits.engine) ||
      verificationReceipts.some(
        (receipt) => receipt.output.capturedBytes > outputCaptureLimits.verification,
      );
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
      ...(parsedStatus.paths.length === 0
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
    const reviewEvidence = makeEvidence({
      evidenceId: reviewEvidenceId,
      kind: "review",
      runId: run.runId,
      attemptId: latestAttempt.attemptId,
      createdAt: now(),
      sourceFingerprint: plan.sourceFingerprint,
      summary: `Deterministic real-project review completed with ${String(findings.length)} blocking finding(s).`,
      content: JSON.stringify({
        changedPaths: parsedStatus.paths,
        allowedPaths: request.allowedPaths,
        baseCommitUnchanged,
        findings,
        resourceAccounting,
      }),
      repository: snapshot.repository,
      prompt,
    });
    allEvidence.push(reviewEvidence);
    const reviewStep = plan.steps.find((step) => step.stepId === "step_real-review");
    if (reviewStep?.kind !== "review") throw new Error("real-project review Step is missing");
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
            changedPaths: parsedStatus.paths,
            findings,
          }),
        ),
        outcome: latestVerification.outcome === "PASS" && findings.length === 0 ? "PASS" : "FAIL",
        observedAt: now(),
        findings,
        evidenceIds: [reviewEvidence.evidenceId],
      }),
    });
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
    const overheadMs = Math.max(0, Math.round(monotonicNow() - overheadStartedAt));
    const sourceLoss = !baseCommitUnchanged;
    const releasedWriterLease = await writerLease.release();
    writerLeaseReleased = true;
    const portableBeforeScore = {
      schemaVersion: "hpi-managed-change.v1" as const,
      observedAt: now(),
      taskResult: "STOP" as const,
      productSource: options.productSource,
      engineRelease: options.engineRelease,
      provider: {
        id: options.providerId,
        authStatus: "DETECTED" as const,
        requestStatus:
          latestAttempt.sendReceipt.outcome === "APPLIED"
            ? ("DETECTED" as const)
            : ("NOT_PROVEN" as const),
        promptFingerprint: sha256(prompt),
      },
      repository: {
        scope: "EXPLICIT_OPERATOR_SELECTED" as const,
        branch: snapshot.branch,
        baseCommit: snapshot.baseCommit,
        workspaceFingerprint: snapshot.workspaceFingerprint,
        sourceFingerprint: snapshot.sourceFingerprint,
      },
      plan: {
        planRevisionId: plan.planRevisionId,
        planFingerprint: sha256(JSON.stringify(plan)),
        allowedPaths: request.allowedPaths,
        checkId: "check_real-command",
        checkDefinitionFingerprint,
      },
      writerLease: {
        leaseId: writerLease.leaseId,
        workspaceId: writerLease.workspaceId,
        resourceSetFingerprint: writerLease.resourceSetFingerprint,
        acquireOutcome: "ACQUIRED" as const,
        releaseOutcome: releasedWriterLease.outcome,
      },
      projection,
      evidence: allEvidence,
      review: {
        changedPaths: parsedStatus.paths,
        allowedPaths: request.allowedPaths,
        baseCommitUnchanged,
        agentReturned,
        findings,
      },
      resourceAccounting,
      finalSummary: summary,
      scorecard: {
        zeroFalseReady:
          projection.change.lifecycle !== "READY" ||
          (latestVerification.outcome === "PASS" &&
            findings.length === 0 &&
            parsedStatus.paths.length > 0),
        sourceLoss,
        secretLeak: false,
        failedAttemptPreserved:
          projection.attempts.length < 2 ||
          (projection.attempts[0]?.verificationStatus === "FAILED" &&
            projection.verificationReceipts[0]?.outcome === "FAIL"),
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
          parsedStatus.paths.length > 0
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
      parsedStatus.paths.length > 0 &&
      changedPathsWithinScope &&
      baseCommitUnchanged &&
      agentReturned &&
      resourceAccounting.status === "PASS" &&
      !sourceLoss &&
      !secretLeak;
    const taskResult = correctnessPassed ? "GO" : "STOP";
    return realManagedChangeEvidenceSchema.parse({
      ...portableBeforeScore,
      taskResult,
      scorecard: { ...scorecard, zeroFalseReady: portableBeforeScore.scorecard.zeroFalseReady },
    });
  } finally {
    if (!writerLeaseReleased) {
      await writerLease.release().catch(() => undefined);
    }
  }
}
