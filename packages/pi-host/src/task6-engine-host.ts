import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  checkpointRequestSchema,
  closeRequestSchema,
  engineCheckpointReceiptSchema,
  engineHandleSchema,
  engineHandleTargetNamespace,
  engineInputSchema,
  engineObservationSchema,
  interruptRequestSchema,
  probeRequestSchema,
  reconcileOperationRequestSchema,
  startAttemptReceiptSchema,
  startAttemptRequestSchema,
  workspaceTargetNamespace,
  type CapabilityReceipt,
  type CheckpointRequest,
  type CloseRequest,
  type EngineCheckpointReceipt,
  type EngineHandle,
  type EngineHost,
  type EngineInput,
  type EngineObservation,
  type EventCursor,
  type InterruptRequest,
  type ProbeRequest,
  type ReconcileOperationRequest,
  type StartAttemptReceipt,
  type StartAttemptRequest,
} from "@hunter-pi/engine-contracts";
import {
  fingerprintSchema,
  operationReceiptSchema,
  operationReconciliationReceiptSchema,
  type ExternalOperation,
  type OperationId,
  type OperationReceipt,
  type OperationReconciliationReceipt,
} from "@hunter-pi/domain";
import { LfOnlyNdjsonDecoder } from "./ndjson.js";
import type { PiLaunchPlan } from "./product-launcher.js";
import {
  accountPiProviderUsage,
  piProviderUsageSchema,
  unavailablePiProviderUsage,
} from "./provider-usage.js";

export const task6PiProcessResultSchema = z.strictObject({
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  framingValid: z.boolean(),
  eventTypes: z.array(z.string().trim().min(1).max(256)),
  recordCount: z.number().int().nonnegative(),
  stdoutDigest: fingerprintSchema,
  stderrDigest: fingerprintSchema,
  capturedBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
  providerUsage: piProviderUsageSchema,
  containment: z
    .enum(["WINDOWS_JOB_OBJECT", "LINUX_SUBREAPER_PROCESS_TREE", "TEST_CONTAINED"])
    .optional(),
  terminalFinality: z.enum(["FINAL", "NOT_PROVEN"]).optional(),
  processTreeState: z.enum(["EMPTY", "ACTIVE", "NOT_PROVEN"]).optional(),
  leaseState: z.enum(["RELEASED", "HELD", "NOT_REQUIRED", "NOT_PROVEN"]).optional(),
});
export type Task6PiProcessResult = z.infer<typeof task6PiProcessResultSchema>;

export interface Task6PiProcessRequest {
  readonly plan: PiLaunchPlan;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface Task6PiEngineHostOptions {
  readonly launchPlanForWorkspace: (workspace: string) => Promise<PiLaunchPlan>;
  readonly runProcess?: (request: Task6PiProcessRequest) => Promise<Task6PiProcessResult>;
  readonly now?: () => string;
  readonly processTimeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly requireQualifiedProcess?: boolean;
}

interface StoredOperation {
  readonly fingerprint: string;
  readonly payloadSignature: string;
  readonly receipt: OperationReceipt;
  reconciliation?: OperationReconciliationReceipt;
}

interface PendingOperation {
  readonly fingerprint: string;
  readonly payloadSignature: string;
  readonly receipt: Promise<OperationReceipt>;
}

interface HandleState {
  readonly handle: EngineHandle;
  readonly launchPlan: PiLaunchPlan;
  observations: readonly EngineObservation[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identityBody(identity: string): string {
  return identity.slice(identity.indexOf("_") + 1);
}

function operationBoundarySignature(operation: ExternalOperation): readonly unknown[] {
  return [
    operation.expectedTarget.namespace,
    operation.expectedTarget.reference,
    operation.deadline,
    operation.cancellationPolicy.mode,
    operation.cancellationPolicy.timeoutMs,
  ];
}

function hasQualifiedProcessContainment(result: Task6PiProcessResult): boolean {
  const expectedContainment =
    process.platform === "win32"
      ? "WINDOWS_JOB_OBJECT"
      : process.platform === "linux"
        ? "LINUX_SUBREAPER_PROCESS_TREE"
        : undefined;
  return (
    expectedContainment !== undefined &&
    result.containment === expectedContainment &&
    result.terminalFinality === "FINAL" &&
    result.processTreeState === "EMPTY" &&
    result.leaseState === "RELEASED"
  );
}

export class PiOperationReplayConflictError extends Error {
  public constructor(operationId: string) {
    super(`operation ${operationId} was replayed with a different fingerprint or payload`);
    this.name = "PiOperationReplayConflictError";
  }
}

export async function runTask6PiJsonProcess(
  request: Task6PiProcessRequest,
): Promise<Task6PiProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      request.plan.executable,
      [...request.plan.arguments, "--mode", "json", "--no-session", request.prompt],
      {
        cwd: request.plan.cwd,
        env: { ...process.env, ...request.plan.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let processError = false;
    let settled = false;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, request.maximumOutputBytes - capturedBytes);
      const retained = chunk.subarray(0, remaining);
      if (retained.length > 0) {
        target.push(retained);
        capturedBytes += retained.length;
      }
      if (retained.length < chunk.length) {
        outputTruncated = true;
        child.kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdoutChunks, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderrChunks, chunk);
    });
    child.once("error", () => {
      processError = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const eventTypes: string[] = [];
      let recordCount = 0;
      let providerUsage = unavailablePiProviderUsage();
      let framingValid = !outputTruncated && !processError;
      if (framingValid) {
        try {
          const decoder = new LfOnlyNdjsonDecoder(request.maximumOutputBytes);
          const records = [...decoder.push(stdout), ...decoder.finish()];
          recordCount = records.length;
          providerUsage = accountPiProviderUsage(records, "NOT_PROVEN");
          for (const record of records) {
            const type = Reflect.get(record, "type");
            if (typeof type === "string") eventTypes.push(type);
          }
        } catch {
          framingValid = false;
        }
      }
      resolvePromise(
        task6PiProcessResultSchema.parse({
          exitCode: timedOut ? 124 : processError ? 127 : signal === null ? (code ?? 1) : 1,
          timedOut,
          framingValid,
          eventTypes,
          recordCount,
          stdoutDigest: sha256(stdout),
          stderrDigest: sha256(stderr),
          capturedBytes,
          outputTruncated,
          providerUsage,
        }),
      );
    });
  });
}

export class Task6PiEngineHost implements EngineHost {
  readonly #launchPlanForWorkspace: Task6PiEngineHostOptions["launchPlanForWorkspace"];
  readonly #runProcess: NonNullable<Task6PiEngineHostOptions["runProcess"]>;
  readonly #now: () => string;
  readonly #processTimeoutMs: number;
  readonly #maximumOutputBytes: number;
  readonly #requireQualifiedProcess: boolean;
  readonly #operations = new Map<OperationId, StoredOperation>();
  readonly #pendingOperations = new Map<OperationId, PendingOperation>();
  readonly #handles = new Map<string, HandleState>();

  public constructor(options: Task6PiEngineHostOptions) {
    if (
      !Number.isSafeInteger(options.processTimeoutMs) ||
      options.processTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.maximumOutputBytes) ||
      options.maximumOutputBytes <= 0
    ) {
      throw new Error("Pi JSON process limits must be positive finite integers");
    }
    this.#launchPlanForWorkspace = options.launchPlanForWorkspace;
    this.#runProcess = options.runProcess ?? runTask6PiJsonProcess;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#processTimeoutMs = options.processTimeoutMs;
    this.#maximumOutputBytes = options.maximumOutputBytes;
    this.#requireQualifiedProcess = options.requireQualifiedProcess ?? false;
  }

  public probe(request: ProbeRequest): Promise<CapabilityReceipt> {
    const parsed = probeRequestSchema.parse(request);
    const supported = new Set(["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "CLOSE"]);
    return Promise.resolve({
      schemaVersion: "1.0.0",
      observedAt: this.#now(),
      results: parsed.requestedCapabilities.map((capability) => ({
        capability,
        status: supported.has(capability) ? "SUPPORTED" : "NOT_PROVEN",
      })),
    });
  }

  public async start(request: StartAttemptRequest): Promise<StartAttemptReceipt> {
    const parsed = startAttemptRequestSchema.parse(request);
    this.#validateOperationBoundary(parsed, workspaceTargetNamespace, parsed.workspaceReference);
    const payloadSignature = sha256(
      JSON.stringify([
        "START_ATTEMPT",
        parsed.runId,
        parsed.attemptId,
        parsed.planRevisionId,
        parsed.workspaceReference,
        operationBoundarySignature(parsed),
      ]),
    );
    const existing = this.#existingReceipt(
      parsed.operationId,
      parsed.fingerprint,
      payloadSignature,
    );
    const handle = engineHandleSchema.parse({
      schemaVersion: "1.0.0",
      engineHandleId: `engine_${identityBody(parsed.attemptId)}`,
      attemptId: parsed.attemptId,
    });
    if (existing !== undefined) {
      const issued = this.#handles.get(handle.engineHandleId);
      if (issued?.handle.attemptId !== handle.attemptId) {
        throw new Error("replayed start operation has no matching Engine Handle");
      }
      return startAttemptReceiptSchema.parse({
        schemaVersion: "1.0.0",
        handle,
        operationReceipt: existing,
      });
    }

    const workspaceStatus = await lstat(parsed.workspaceReference);
    const canonicalWorkspace = await realpath(resolve(parsed.workspaceReference));
    if (
      !workspaceStatus.isDirectory() ||
      workspaceStatus.isSymbolicLink() ||
      canonicalWorkspace !== resolve(parsed.workspaceReference)
    ) {
      throw new Error("Pi JSON workspace must be one exact physical directory");
    }
    const launchPlan = await this.#launchPlanForWorkspace(canonicalWorkspace);
    if (resolve(launchPlan.cwd) !== canonicalWorkspace) {
      throw new Error("Pi JSON launch plan does not bind the requested workspace");
    }
    const operationReceipt = this.#storeReceipt(
      parsed.operationId,
      parsed.fingerprint,
      payloadSignature,
      "APPLIED",
      ["engine-handle-created"],
    );
    this.#handles.set(handle.engineHandleId, { handle, launchPlan, observations: [] });
    return startAttemptReceiptSchema.parse({
      schemaVersion: "1.0.0",
      handle,
      operationReceipt,
    });
  }

  public async send(handle: EngineHandle, input: EngineInput): Promise<OperationReceipt> {
    const state = this.#requireHandle(handle);
    const parsed = engineInputSchema.parse(input);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      state.handle.engineHandleId,
    );
    const payloadSignature = sha256(
      JSON.stringify([
        "SEND_INPUT",
        state.handle.engineHandleId,
        parsed.kind,
        parsed.content,
        operationBoundarySignature(parsed),
      ]),
    );
    const existing = this.#existingReceipt(
      parsed.operationId,
      parsed.fingerprint,
      payloadSignature,
    );
    if (existing !== undefined) return existing;
    const pending = this.#existingPendingReceipt(
      parsed.operationId,
      parsed.fingerprint,
      payloadSignature,
    );
    if (pending !== undefined) return pending;

    const execution = (async (): Promise<OperationReceipt> => {
      const deadlineRemaining = Date.parse(parsed.deadline) - Date.parse(this.#now());
      const processResult = task6PiProcessResultSchema.parse(
        await this.#runProcess({
          plan: state.launchPlan,
          prompt: parsed.content,
          timeoutMs: Math.max(
            1,
            Math.min(
              this.#processTimeoutMs,
              parsed.cancellationPolicy.timeoutMs,
              deadlineRemaining,
            ),
          ),
          maximumOutputBytes: this.#maximumOutputBytes,
        }),
      );
      const observations: EngineObservation[] = [
        engineObservationSchema.parse({
          schemaVersion: "1.0.0",
          cursor: 1,
          attemptId: state.handle.attemptId,
          kind: "OUTPUT_CAPTURED",
          observedAt: this.#now(),
          summary: `Pi JSON emitted ${String(processResult.recordCount)} bounded records; containment=${processResult.containment ?? "NOT_PROVEN"} terminalFinality=${processResult.terminalFinality ?? "NOT_PROVEN"}; content retained by digest only.`,
          resourceUsage: { outputBytes: processResult.capturedBytes },
        }),
      ];
      if (processResult.framingValid && processResult.eventTypes.includes("agent_end")) {
        observations.push(
          engineObservationSchema.parse({
            schemaVersion: "1.0.0",
            cursor: observations.length + 1,
            attemptId: state.handle.attemptId,
            kind: "AGENT_RETURNED",
            observedAt: this.#now(),
            summary: "Pi emitted agent_end; independent Verification is still required.",
            ...(processResult.providerUsage.status === "PASS"
              ? {
                  resourceUsage: {
                    externalOperations: processResult.providerUsage.requestCount,
                    tokens: processResult.providerUsage.tokenCount,
                    costMinorUnits: processResult.providerUsage.costMinorUnits,
                  },
                }
              : {}),
          }),
        );
      }
      observations.push(
        engineObservationSchema.parse({
          schemaVersion: "1.0.0",
          cursor: observations.length + 1,
          attemptId: state.handle.attemptId,
          kind: "PROCESS_EXITED",
          observedAt: this.#now(),
          summary: `Pi process exit was observed with code ${String(processResult.exitCode)}; it is not a success result.`,
        }),
      );
      state.observations = observations;
      const applied =
        !processResult.timedOut &&
        !processResult.outputTruncated &&
        processResult.framingValid &&
        processResult.exitCode === 0 &&
        processResult.eventTypes.includes("agent_end") &&
        (!this.#requireQualifiedProcess || hasQualifiedProcessContainment(processResult));
      return this.#storeReceipt(
        parsed.operationId,
        parsed.fingerprint,
        payloadSignature,
        applied ? "APPLIED" : "UNKNOWN",
        applied ? ["agent-operation-returned"] : [],
      );
    })();
    this.#pendingOperations.set(parsed.operationId, {
      fingerprint: parsed.fingerprint,
      payloadSignature,
      receipt: execution,
    });
    try {
      return await execution;
    } finally {
      if (this.#pendingOperations.get(parsed.operationId)?.receipt === execution) {
        this.#pendingOperations.delete(parsed.operationId);
      }
    }
  }

  public async *observe(
    handle: EngineHandle,
    cursor: EventCursor = 0,
  ): AsyncIterable<EngineObservation> {
    const state = this.#requireHandle(handle);
    for (const observation of state.observations) {
      if (observation.cursor > cursor) {
        yield await Promise.resolve(engineObservationSchema.parse(observation));
      }
    }
  }

  public interrupt(handle: EngineHandle, request: InterruptRequest): Promise<OperationReceipt> {
    const state = this.#requireHandle(handle);
    const parsed = interruptRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      state.handle.engineHandleId,
    );
    return Promise.resolve(
      this.#recordNonAppliedOperation(
        parsed,
        sha256(JSON.stringify(["INTERRUPT", parsed.reason, operationBoundarySignature(parsed)])),
        "interrupt-not-proven",
      ),
    );
  }

  public checkpoint(
    handle: EngineHandle,
    request: CheckpointRequest,
  ): Promise<EngineCheckpointReceipt> {
    const state = this.#requireHandle(handle);
    const parsed = checkpointRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      state.handle.engineHandleId,
    );
    const receipt = this.#recordNonAppliedOperation(
      parsed,
      sha256(JSON.stringify(["CHECKPOINT", operationBoundarySignature(parsed)])),
      "checkpoint-not-proven",
    );
    return Promise.resolve(
      engineCheckpointReceiptSchema.parse({
        schemaVersion: "1.0.0",
        checkpointId: `checkpoint_${identityBody(parsed.operationId)}`,
        operationReceipt: receipt,
      }),
    );
  }

  public reconcile(request: ReconcileOperationRequest): Promise<OperationReconciliationReceipt> {
    const parsed = reconcileOperationRequestSchema.parse(request);
    const stored = this.#operations.get(parsed.operationId);
    if (stored === undefined) {
      return Promise.reject(new Error(`cannot reconcile unknown operation ${parsed.operationId}`));
    }
    if (stored.fingerprint !== parsed.fingerprint) {
      return Promise.reject(new PiOperationReplayConflictError(parsed.operationId));
    }
    if (stored.receipt.outcome !== "UNKNOWN") {
      return Promise.reject(new Error("only an UNKNOWN operation can be reconciled"));
    }
    stored.reconciliation ??= operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: `reconcile_${identityBody(parsed.operationId)}`,
      operationId: parsed.operationId,
      fingerprint: parsed.fingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "UNKNOWN",
      observedEffects: [],
      observedAt: this.#now(),
    });
    return Promise.resolve(operationReconciliationReceiptSchema.parse(stored.reconciliation));
  }

  public close(handle: EngineHandle, request: CloseRequest): Promise<OperationReceipt> {
    const state = this.#requireHandle(handle);
    const parsed = closeRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      state.handle.engineHandleId,
    );
    const payloadSignature = sha256(
      JSON.stringify(["CLOSE", parsed.reason, operationBoundarySignature(parsed)]),
    );
    const existing = this.#existingReceipt(
      parsed.operationId,
      parsed.fingerprint,
      payloadSignature,
    );
    return Promise.resolve(
      existing ??
        this.#storeReceipt(parsed.operationId, parsed.fingerprint, payloadSignature, "APPLIED", [
          "engine-handle-closed",
        ]),
    );
  }

  #requireHandle(handle: EngineHandle): HandleState {
    const parsed = engineHandleSchema.parse(handle);
    const state = this.#handles.get(parsed.engineHandleId);
    if (state?.handle.attemptId !== parsed.attemptId) {
      throw new Error(`engine handle ${parsed.engineHandleId} was not issued by this Host`);
    }
    return state;
  }

  #validateOperationBoundary(
    operation: ExternalOperation,
    expectedTargetNamespace: string,
    expectedTargetReference: string,
  ): void {
    if (
      operation.expectedTarget.namespace !== expectedTargetNamespace ||
      operation.expectedTarget.reference !== expectedTargetReference
    ) {
      throw new Error("operation expected target does not match the Pi JSON Host target");
    }
    if (Date.parse(operation.deadline) <= Date.parse(this.#now())) {
      throw new Error(`operation ${operation.operationId} deadline has expired`);
    }
  }

  #existingReceipt(
    operationId: OperationId,
    fingerprint: string,
    payloadSignature: string,
  ): OperationReceipt | undefined {
    const existing = this.#operations.get(operationId);
    if (existing === undefined) return undefined;
    if (existing.fingerprint !== fingerprint || existing.payloadSignature !== payloadSignature) {
      throw new PiOperationReplayConflictError(operationId);
    }
    return operationReceiptSchema.parse(existing.receipt);
  }

  #existingPendingReceipt(
    operationId: OperationId,
    fingerprint: string,
    payloadSignature: string,
  ): Promise<OperationReceipt> | undefined {
    const pending = this.#pendingOperations.get(operationId);
    if (pending === undefined) return undefined;
    if (pending.fingerprint !== fingerprint || pending.payloadSignature !== payloadSignature) {
      throw new PiOperationReplayConflictError(operationId);
    }
    return pending.receipt;
  }

  #storeReceipt(
    operationId: OperationId,
    fingerprint: string,
    payloadSignature: string,
    outcome: OperationReceipt["outcome"],
    observedEffects: readonly string[],
  ): OperationReceipt {
    const receipt = operationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      operationReceiptId: `opreceipt_${identityBody(operationId)}`,
      operationId,
      fingerprint,
      outcome,
      observedEffects,
      observedAt: this.#now(),
    });
    this.#operations.set(operationId, { fingerprint, payloadSignature, receipt });
    return receipt;
  }

  #recordNonAppliedOperation(
    operation: ExternalOperation,
    payloadSignature: string,
    observedEffect: string,
  ): OperationReceipt {
    const existing = this.#existingReceipt(
      operation.operationId,
      operation.fingerprint,
      payloadSignature,
    );
    return (
      existing ??
      this.#storeReceipt(
        operation.operationId,
        operation.fingerprint,
        payloadSignature,
        "REJECTED",
        [observedEffect],
      )
    );
  }
}

// Task 6 introduced this implementation. Keep the historical export for its immutable
// fixtures while exposing the provider-neutral name used by real-project Managed Change.
export { Task6PiEngineHost as PiJsonEngineHost };
export type PiJsonEngineHostOptions = Task6PiEngineHostOptions;
export type PiProcessRequest = Task6PiProcessRequest;
export type PiProcessResult = Task6PiProcessResult;
export const runPiJsonProcess = runTask6PiJsonProcess;
