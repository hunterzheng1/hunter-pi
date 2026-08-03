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
  type EngineCapability,
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
  operationReconciliationReceiptSchema,
  operationReceiptSchema,
  type ExternalOperation,
  type OperationId,
  type OperationReceipt,
  type OperationReconciliationReceipt,
} from "@hunter-pi/domain";

const defaultObservedAt = "2000-01-01T00:00:00.000Z";

export class OperationReplayConflictError extends Error {
  public constructor(operationId: string) {
    super(`operation ${operationId} was replayed with a different fingerprint or payload`);
    this.name = "OperationReplayConflictError";
  }
}

export interface FakeEngineHostOptions {
  readonly now?: () => string;
  readonly supportedCapabilities?: readonly EngineCapability[];
  readonly unknownThenReconcilesOperationIds?: readonly string[];
}

interface StoredOperation {
  readonly fingerprint: string;
  readonly payloadSignature: string;
  readonly receipt: OperationReceipt;
  readonly intendedEffect: string;
  reconciliationReceipt?: OperationReconciliationReceipt;
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

export class FakeEngineHost implements EngineHost {
  readonly #now: () => string;
  readonly #supportedCapabilities: ReadonlySet<EngineCapability>;
  readonly #operations = new Map<OperationId, StoredOperation>();
  readonly #observations = new Map<string, readonly EngineObservation[]>();
  readonly #handles = new Map<string, EngineHandle>();
  readonly #unknownThenReconcilesOperationIds: ReadonlySet<string>;

  public constructor(options: FakeEngineHostOptions = {}) {
    this.#now = options.now ?? (() => defaultObservedAt);
    this.#unknownThenReconcilesOperationIds = new Set(
      options.unknownThenReconcilesOperationIds ?? [],
    );
    this.#supportedCapabilities = new Set(
      options.supportedCapabilities ?? [
        "START_ATTEMPT",
        "SEND_INPUT",
        "OBSERVE",
        "INTERRUPT",
        "CHECKPOINT",
        "RECONCILE",
        "CLOSE",
      ],
    );
  }

  public probe(request: ProbeRequest): Promise<CapabilityReceipt> {
    const parsed = probeRequestSchema.parse(request);
    return Promise.resolve({
      schemaVersion: "1.0.0",
      observedAt: this.#now(),
      results: parsed.requestedCapabilities.map((capability) => ({
        capability,
        status: this.#supportedCapabilities.has(capability) ? "SUPPORTED" : "UNSUPPORTED",
      })),
    });
  }

  public start(request: StartAttemptRequest): Promise<StartAttemptReceipt> {
    const parsed = startAttemptRequestSchema.parse(request);
    this.#validateOperationBoundary(parsed, workspaceTargetNamespace, parsed.workspaceReference);
    const operationReceipt = this.#recordOperation(
      parsed.operationId,
      parsed.fingerprint,
      JSON.stringify([
        "START_ATTEMPT",
        parsed.runId,
        parsed.attemptId,
        parsed.planRevisionId,
        parsed.workspaceReference,
        operationBoundarySignature(parsed),
      ]),
      "attempt-started",
    );
    const handle = engineHandleSchema.parse({
      schemaVersion: "1.0.0",
      engineHandleId: `engine_${identityBody(parsed.attemptId)}`,
      attemptId: parsed.attemptId,
    });
    this.#handles.set(handle.engineHandleId, handle);
    this.#ensureDefaultObservations(handle);
    return Promise.resolve(
      startAttemptReceiptSchema.parse({
        schemaVersion: "1.0.0",
        handle,
        operationReceipt,
      }),
    );
  }

  public send(handle: EngineHandle, input: EngineInput): Promise<OperationReceipt> {
    const parsedHandle = this.#requireIssuedHandle(handle);
    const parsed = engineInputSchema.parse(input);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      parsedHandle.engineHandleId,
    );
    return Promise.resolve(
      this.#recordOperation(
        parsed.operationId,
        parsed.fingerprint,
        JSON.stringify([
          "SEND_INPUT",
          parsedHandle.engineHandleId,
          parsed.kind,
          parsed.content,
          operationBoundarySignature(parsed),
        ]),
        "input-recorded",
      ),
    );
  }

  public async *observe(
    handle: EngineHandle,
    cursor: EventCursor = 0,
  ): AsyncIterable<EngineObservation> {
    const parsedHandle = this.#requireIssuedHandle(handle);
    for (const observation of this.#observations.get(parsedHandle.engineHandleId) ?? []) {
      if (observation.cursor > cursor) {
        yield await Promise.resolve(engineObservationSchema.parse(observation));
      }
    }
  }

  public interrupt(handle: EngineHandle, request: InterruptRequest): Promise<OperationReceipt> {
    const parsedHandle = this.#requireIssuedHandle(handle);
    const parsed = interruptRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      parsedHandle.engineHandleId,
    );
    return Promise.resolve(
      this.#recordOperation(
        parsed.operationId,
        parsed.fingerprint,
        JSON.stringify([
          "INTERRUPT",
          parsedHandle.engineHandleId,
          parsed.reason,
          operationBoundarySignature(parsed),
        ]),
        "interrupt-requested",
      ),
    );
  }

  public checkpoint(
    handle: EngineHandle,
    request: CheckpointRequest,
  ): Promise<EngineCheckpointReceipt> {
    const parsedHandle = this.#requireIssuedHandle(handle);
    const parsed = checkpointRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      parsedHandle.engineHandleId,
    );
    const operationReceipt = this.#recordOperation(
      parsed.operationId,
      parsed.fingerprint,
      JSON.stringify([
        "CHECKPOINT",
        parsedHandle.engineHandleId,
        operationBoundarySignature(parsed),
      ]),
      "checkpoint-captured",
    );
    return Promise.resolve(
      engineCheckpointReceiptSchema.parse({
        schemaVersion: "1.0.0",
        checkpointId: `checkpoint_${identityBody(parsed.operationId)}`,
        operationReceipt,
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
      return Promise.reject(new OperationReplayConflictError(parsed.operationId));
    }
    if (stored.receipt.outcome !== "UNKNOWN") {
      return Promise.reject(
        new Error(`operation ${parsed.operationId} does not have an UNKNOWN outcome`),
      );
    }
    stored.reconciliationReceipt ??= operationReconciliationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      reconciliationReceiptId: `reconcile_${identityBody(parsed.operationId)}`,
      operationId: parsed.operationId,
      fingerprint: parsed.fingerprint,
      previousOutcome: "UNKNOWN",
      outcome: "APPLIED",
      observedEffects: [`reconciled-${stored.intendedEffect}`],
      observedAt: this.#now(),
    });
    return Promise.resolve(
      operationReconciliationReceiptSchema.parse(stored.reconciliationReceipt),
    );
  }

  public close(handle: EngineHandle, request: CloseRequest): Promise<OperationReceipt> {
    const parsedHandle = this.#requireIssuedHandle(handle);
    const parsed = closeRequestSchema.parse(request);
    this.#validateOperationBoundary(
      parsed,
      engineHandleTargetNamespace,
      parsedHandle.engineHandleId,
    );
    return Promise.resolve(
      this.#recordOperation(
        parsed.operationId,
        parsed.fingerprint,
        JSON.stringify([
          "CLOSE",
          parsedHandle.engineHandleId,
          parsed.reason,
          operationBoundarySignature(parsed),
        ]),
        "handle-closed",
      ),
    );
  }

  public scriptObservations(
    handle: EngineHandle,
    observations: readonly EngineObservation[],
  ): void {
    const parsedHandle = this.#requireIssuedHandle(handle);
    this.#observations.set(
      parsedHandle.engineHandleId,
      observations.map((observation) => engineObservationSchema.parse(observation)),
    );
  }

  #ensureDefaultObservations(handle: EngineHandle): void {
    if (this.#observations.has(handle.engineHandleId)) {
      return;
    }
    const kinds = ["WINDOW_OPENED", "AGENT_RETURNED", "PROCESS_EXITED", "TERMINAL_IDLE"] as const;
    this.#observations.set(
      handle.engineHandleId,
      kinds.map((kind, index) =>
        engineObservationSchema.parse({
          schemaVersion: "1.0.0",
          cursor: index + 1,
          attemptId: handle.attemptId,
          kind,
          observedAt: this.#now(),
          summary: `${kind} is an observation, not a success result.`,
        }),
      ),
    );
  }

  #requireIssuedHandle(handle: EngineHandle): EngineHandle {
    const parsed = engineHandleSchema.parse(handle);
    const issued = this.#handles.get(parsed.engineHandleId);
    if (issued?.attemptId !== parsed.attemptId) {
      throw new Error(`engine handle ${parsed.engineHandleId} was not issued by this Host`);
    }
    return issued;
  }

  #validateOperationBoundary(
    operation: ExternalOperation,
    expectedTargetNamespace: string,
    expectedTargetReference: string,
  ): void {
    if (this.#operations.has(operation.operationId)) {
      return;
    }
    if (
      operation.expectedTarget.namespace !== expectedTargetNamespace ||
      operation.expectedTarget.reference !== expectedTargetReference
    ) {
      throw new Error(
        `operation ${operation.operationId} expected target ${operation.expectedTarget.namespace}:${operation.expectedTarget.reference}, not ${expectedTargetNamespace}:${expectedTargetReference}`,
      );
    }
    if (Date.parse(operation.deadline) <= Date.parse(this.#now())) {
      throw new Error(`operation ${operation.operationId} deadline has expired`);
    }
  }

  #recordOperation(
    operationId: OperationId,
    fingerprint: string,
    payloadSignature: string,
    observedEffect: string,
  ): OperationReceipt {
    const stored = this.#operations.get(operationId);
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint || stored.payloadSignature !== payloadSignature) {
        throw new OperationReplayConflictError(operationId);
      }
      return operationReceiptSchema.parse(stored.receipt);
    }

    const isUnknown = this.#unknownThenReconcilesOperationIds.has(operationId);
    const receipt = operationReceiptSchema.parse({
      schemaVersion: "1.0.0",
      operationReceiptId: `opreceipt_${identityBody(operationId)}`,
      operationId,
      fingerprint,
      outcome: isUnknown ? "UNKNOWN" : "APPLIED",
      observedEffects: isUnknown ? [] : [observedEffect],
      observedAt: this.#now(),
    });
    this.#operations.set(operationId, {
      fingerprint,
      payloadSignature,
      receipt,
      intendedEffect: observedEffect,
    });
    return operationReceiptSchema.parse(receipt);
  }
}
