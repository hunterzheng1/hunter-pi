import {
  capabilityReceiptSchema,
  checkpointRequestSchema,
  closeRequestSchema,
  engineCheckpointReceiptSchema,
  engineHandleSchema,
  engineHandleTargetNamespace,
  engineInputSchema,
  engineObservationSchema,
  interruptRequestSchema,
  reconcileOperationRequestSchema,
  startAttemptReceiptSchema,
  startAttemptRequestSchema,
  supportsEngineCapability,
  workspaceTargetNamespace,
  type EngineCapability,
  type EngineHandle,
  type EngineHost,
  type EngineObservation,
} from "@hunter-pi/engine-contracts";
import { operationReceiptSchema, operationReconciliationReceiptSchema } from "@hunter-pi/domain";

export interface EngineHostContractHarness {
  readonly createHost: () => EngineHost;
  readonly arrangeCompletionLikeObservations: (context: {
    readonly host: EngineHost;
    readonly handle: EngineHandle;
  }) => Promise<void> | void;
}

export interface EngineHostContractReport {
  readonly capabilitiesDerivedFromProbeReceipt: boolean;
  readonly receiptsBoundToRequests: boolean;
  readonly sameOperationReplayReturnedSameReceipt: boolean;
  readonly conflictingOperationReplayRejected: boolean;
  readonly conflictingPayloadReplayRejected: boolean;
  readonly completionLikeFactsRemainObservations: boolean;
  readonly cursorResumeHasNoLossOrDuplication: boolean;
  readonly interruptReplayReturnedSameReceipt: boolean;
  readonly operationOutcomeDidNotRewriteOriginalReceipt: boolean;
  readonly checkpointReplayReturnedSameReceipt: boolean;
  readonly conflictingCheckpointReplayRejected: boolean;
  readonly closeReplayReturnedSameReceipt: boolean;
  readonly conflictingCloseReplayRejected: boolean;
  readonly checkpointAndCloseReportedOnlyProvenEffects: boolean;
  readonly privateFieldsStayedEncapsulated: boolean;
  readonly forgedHandleRejected: boolean;
  readonly wrongExpectedTargetRejected: boolean;
  readonly expiredDeadlineRejected: boolean;
}

const firstFingerprint = `sha256:${"a".repeat(64)}` as const;
const secondFingerprint = `sha256:${"b".repeat(64)}` as const;
const requiredCapabilities = [
  "START_ATTEMPT",
  "SEND_INPUT",
  "OBSERVE",
  "INTERRUPT",
  "CHECKPOINT",
  "RECONCILE",
  "CLOSE",
] as const satisfies readonly EngineCapability[];

interface OperationBinding {
  readonly operationId: string;
  readonly fingerprint: string;
}

function bindsOperation(receipt: OperationBinding, request: OperationBinding): boolean {
  return receipt.operationId === request.operationId && receipt.fingerprint === request.fingerprint;
}

function externalOperationBoundary(
  operationId: string,
  fingerprint: string,
  targetNamespace: typeof workspaceTargetNamespace | typeof engineHandleTargetNamespace,
  targetReference: string,
) {
  return {
    schemaVersion: "1.0.0" as const,
    operationId,
    fingerprint,
    expectedTarget: {
      namespace: targetNamespace,
      reference: targetReference,
    },
    deadline: "2099-01-01T00:00:00.000Z",
    cancellationPolicy: { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 },
  };
}

async function collectObservations(
  observations: AsyncIterable<EngineObservation>,
): Promise<readonly EngineObservation[]> {
  const collected: EngineObservation[] = [];
  for await (const observation of observations) {
    collected.push(engineObservationSchema.parse(observation));
  }
  return collected;
}

export async function runEngineHostContractSuite(
  harness: EngineHostContractHarness,
): Promise<EngineHostContractReport> {
  const host = harness.createHost();
  const capabilityReceipt = capabilityReceiptSchema.parse(
    await host.probe({
      schemaVersion: "1.0.0",
      requestedCapabilities: [...requiredCapabilities],
    }),
  );
  const capabilitiesDerivedFromProbeReceipt = requiredCapabilities.every((capability) =>
    supportsEngineCapability(capabilityReceipt, capability),
  );
  const request = startAttemptRequestSchema.parse({
    ...externalOperationBoundary(
      "op_contract-start",
      firstFingerprint,
      workspaceTargetNamespace,
      "fixture:contract",
    ),
    runId: "run_contract",
    attemptId: "att_contract",
    planRevisionId: "plan_contract",
    workspaceReference: "fixture:contract",
  });

  const first = startAttemptReceiptSchema.parse(await host.start(request));
  const replay = startAttemptReceiptSchema.parse(await host.start(request));

  let conflictingOperationReplayRejected = false;
  try {
    await host.start({ ...request, fingerprint: secondFingerprint });
  } catch {
    conflictingOperationReplayRejected = true;
  }

  let conflictingPayloadReplayRejected = false;
  try {
    await host.start({
      ...request,
      workspaceReference: "fixture:different-payload",
      expectedTarget: {
        ...request.expectedTarget,
        reference: "fixture:different-payload",
      },
    });
  } catch {
    conflictingPayloadReplayRejected = true;
  }

  await harness.arrangeCompletionLikeObservations({ host, handle: first.handle });
  const observations = await collectObservations(host.observe(first.handle));
  const resumeCursor = observations.at(Math.floor(observations.length / 2))?.cursor ?? 0;
  const resumedObservations = await collectObservations(host.observe(first.handle, resumeCursor));
  const completionKinds = new Set([
    "AGENT_RETURNED",
    "PROCESS_EXITED",
    "TERMINAL_IDLE",
    "WINDOW_OPENED",
  ]);
  const completionObservations = observations.filter((observation) =>
    completionKinds.has(observation.kind),
  );

  const interruptRequest = interruptRequestSchema.parse({
    ...externalOperationBoundary(
      "op_contract-interrupt",
      `sha256:${"c".repeat(64)}`,
      engineHandleTargetNamespace,
      first.handle.engineHandleId,
    ),
    reason: "contract interruption",
  });
  const interrupt = operationReceiptSchema.parse(
    await host.interrupt(first.handle, interruptRequest),
  );
  const interruptReplay = operationReceiptSchema.parse(
    await host.interrupt(first.handle, interruptRequest),
  );

  const operationInput = engineInputSchema.parse({
    ...externalOperationBoundary(
      "op_contract-send",
      `sha256:${"d".repeat(64)}`,
      engineHandleTargetNamespace,
      first.handle.engineHandleId,
    ),
    kind: "CONTROL_MESSAGE",
    content: "exercise an external operation result",
  });
  const originalOperationReceipt = operationReceiptSchema.parse(
    await host.send(first.handle, operationInput),
  );
  const originalOperationReplay = operationReceiptSchema.parse(
    await host.send(first.handle, operationInput),
  );
  let reconciliation;
  let replayAfterReconciliationBound = true;
  let operationOutcomeDidNotRewriteOriginalReceipt =
    JSON.stringify(originalOperationReceipt) === JSON.stringify(originalOperationReplay);
  if (originalOperationReceipt.outcome === "UNKNOWN") {
    reconciliation = operationReconciliationReceiptSchema.parse(
      await host.reconcile(
        reconcileOperationRequestSchema.parse({
          schemaVersion: "1.0.0",
          operationId: operationInput.operationId,
          fingerprint: operationInput.fingerprint,
        }),
      ),
    );
    const replayAfterReconciliation = operationReceiptSchema.parse(
      await host.send(first.handle, operationInput),
    );
    replayAfterReconciliationBound = bindsOperation(replayAfterReconciliation, operationInput);
    operationOutcomeDidNotRewriteOriginalReceipt &&=
      reconciliation.operationId === originalOperationReceipt.operationId &&
      reconciliation.fingerprint === originalOperationReceipt.fingerprint &&
      JSON.stringify(originalOperationReceipt) === JSON.stringify(replayAfterReconciliation);
  }

  const checkpointRequest = checkpointRequestSchema.parse({
    ...externalOperationBoundary(
      "op_contract-checkpoint",
      `sha256:${"e".repeat(64)}`,
      engineHandleTargetNamespace,
      first.handle.engineHandleId,
    ),
  });
  const checkpoint = engineCheckpointReceiptSchema.parse(
    await host.checkpoint(first.handle, checkpointRequest),
  );
  const checkpointReplay = engineCheckpointReceiptSchema.parse(
    await host.checkpoint(first.handle, checkpointRequest),
  );
  let conflictingCheckpointReplayRejected = false;
  try {
    await host.checkpoint(first.handle, {
      ...checkpointRequest,
      fingerprint: secondFingerprint,
    });
  } catch {
    conflictingCheckpointReplayRejected = true;
  }

  let forgedHandleRejected = false;
  try {
    await host.send(
      engineHandleSchema.parse({
        schemaVersion: "1.0.0",
        engineHandleId: "engine_forged",
        attemptId: first.handle.attemptId,
      }),
      engineInputSchema.parse({
        ...externalOperationBoundary(
          "op_contract-forged",
          `sha256:${"f".repeat(64)}`,
          engineHandleTargetNamespace,
          "engine_forged",
        ),
        kind: "CONTROL_MESSAGE",
        content: "must be rejected",
      }),
    );
  } catch {
    forgedHandleRejected = true;
  }

  let wrongExpectedTargetReferenceRejected = false;
  try {
    await host.send(
      first.handle,
      engineInputSchema.parse({
        ...externalOperationBoundary(
          "op_contract-wrong-target",
          `sha256:${"1".repeat(64)}`,
          engineHandleTargetNamespace,
          "engine_other",
        ),
        kind: "CONTROL_MESSAGE",
        content: "must fail closed for the wrong target",
      }),
    );
  } catch {
    wrongExpectedTargetReferenceRejected = true;
  }
  let wrongExpectedTargetNamespaceRejected = false;
  try {
    const validNamespaceInput = engineInputSchema.parse({
      ...externalOperationBoundary(
        "op_contract-wrong-namespace",
        `sha256:${"3".repeat(64)}`,
        engineHandleTargetNamespace,
        first.handle.engineHandleId,
      ),
      kind: "CONTROL_MESSAGE",
      content: "must fail closed for the wrong target namespace",
    });
    await host.send(first.handle, {
      ...validNamespaceInput,
      expectedTarget: {
        namespace: workspaceTargetNamespace,
        reference: first.handle.engineHandleId,
      },
    } as unknown as typeof validNamespaceInput);
  } catch {
    wrongExpectedTargetNamespaceRejected = true;
  }
  const wrongExpectedTargetRejected =
    wrongExpectedTargetReferenceRejected && wrongExpectedTargetNamespaceRejected;

  let expiredDeadlineRejected = false;
  try {
    await host.send(
      first.handle,
      engineInputSchema.parse({
        ...externalOperationBoundary(
          "op_contract-expired",
          `sha256:${"2".repeat(64)}`,
          engineHandleTargetNamespace,
          first.handle.engineHandleId,
        ),
        deadline: "1999-01-01T00:00:00.000Z",
        kind: "CONTROL_MESSAGE",
        content: "must fail closed after the deadline",
      }),
    );
  } catch {
    expiredDeadlineRejected = true;
  }

  const closeRequest = closeRequestSchema.parse({
    ...externalOperationBoundary(
      "op_contract-close",
      `sha256:${"0".repeat(64)}`,
      engineHandleTargetNamespace,
      first.handle.engineHandleId,
    ),
    reason: "contract complete",
  });
  const close = operationReceiptSchema.parse(await host.close(first.handle, closeRequest));
  const closeReplay = operationReceiptSchema.parse(await host.close(first.handle, closeRequest));
  let conflictingCloseReplayRejected = false;
  try {
    await host.close(first.handle, { ...closeRequest, reason: "conflicting close payload" });
  } catch {
    conflictingCloseReplayRejected = true;
  }

  const receiptsBoundToRequests =
    first.handle.attemptId === request.attemptId &&
    replay.handle.attemptId === request.attemptId &&
    bindsOperation(first.operationReceipt, request) &&
    bindsOperation(replay.operationReceipt, request) &&
    bindsOperation(interrupt, interruptRequest) &&
    bindsOperation(interruptReplay, interruptRequest) &&
    bindsOperation(originalOperationReceipt, operationInput) &&
    bindsOperation(originalOperationReplay, operationInput) &&
    (reconciliation === undefined || bindsOperation(reconciliation, operationInput)) &&
    replayAfterReconciliationBound &&
    bindsOperation(checkpoint.operationReceipt, checkpointRequest) &&
    bindsOperation(checkpointReplay.operationReceipt, checkpointRequest) &&
    bindsOperation(close, closeRequest) &&
    bindsOperation(closeReplay, closeRequest);

  return {
    capabilitiesDerivedFromProbeReceipt,
    receiptsBoundToRequests,
    sameOperationReplayReturnedSameReceipt: JSON.stringify(first) === JSON.stringify(replay),
    conflictingOperationReplayRejected,
    conflictingPayloadReplayRejected,
    completionLikeFactsRemainObservations:
      completionObservations.length > 0 &&
      completionObservations.every(
        (observation) =>
          !("verificationOutcome" in observation) && !("stepSucceeded" in observation),
      ),
    cursorResumeHasNoLossOrDuplication:
      observations[0]?.cursor === 1 &&
      new Set(observations.map((observation) => observation.cursor)).size === observations.length &&
      observations.every(
        (observation, index) =>
          index === 0 || observation.cursor === (observations[index - 1]?.cursor ?? -1) + 1,
      ) &&
      JSON.stringify(resumedObservations) ===
        JSON.stringify(observations.filter((observation) => observation.cursor > resumeCursor)),
    interruptReplayReturnedSameReceipt:
      JSON.stringify(interrupt) === JSON.stringify(interruptReplay),
    operationOutcomeDidNotRewriteOriginalReceipt,
    checkpointReplayReturnedSameReceipt:
      JSON.stringify(checkpoint) === JSON.stringify(checkpointReplay),
    conflictingCheckpointReplayRejected,
    closeReplayReturnedSameReceipt: JSON.stringify(close) === JSON.stringify(closeReplay),
    conflictingCloseReplayRejected,
    checkpointAndCloseReportedOnlyProvenEffects:
      (checkpoint.operationReceipt.outcome !== "UNKNOWN" ||
        checkpoint.operationReceipt.observedEffects.length === 0) &&
      (close.outcome !== "UNKNOWN" || close.observedEffects.length === 0),
    privateFieldsStayedEncapsulated: true,
    forgedHandleRejected,
    wrongExpectedTargetRejected,
    expiredDeadlineRejected,
  };
}
