import { describe, expect, it } from "vitest";

import {
  capabilityReceiptSchema,
  engineHandleTargetNamespace,
  engineObservationSchema,
  engineInputSchema,
  startAttemptRequestSchema,
  supportsEngineCapability,
  workspaceTargetNamespace,
  type EngineHost,
} from "@hunter-pi/engine-contracts";
import { operationReceiptSchema, type OperationReceipt } from "@hunter-pi/domain";
import { FakeEngineHost, runEngineHostContractSuite } from "@hunter-pi/testkit";

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = (character: string) => `sha256:${character.repeat(64)}` as const;
const operationBoundary = (
  operationId: string,
  digest: string,
  targetNamespace: typeof workspaceTargetNamespace | typeof engineHandleTargetNamespace,
  targetReference: string,
) => ({
  schemaVersion: "1.0.0" as const,
  operationId,
  fingerprint: digest,
  expectedTarget: { namespace: targetNamespace, reference: targetReference },
  deadline: "2099-01-01T00:00:00.000Z",
  cancellationPolicy: { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 },
});

describe("provider-neutral Engine Host contract", () => {
  it("passes the shared deterministic contract suite", async () => {
    const report = await runEngineHostContractSuite({
      createHost: () =>
        new FakeEngineHost({
          now: () => timestamp,
          supportedCapabilities: [
            "START_ATTEMPT",
            "SEND_INPUT",
            "OBSERVE",
            "INTERRUPT",
            "CHECKPOINT",
            "RECONCILE",
            "CLOSE",
          ],
          unknownThenReconcilesOperationIds: ["op_contract-send"],
        }),
      arrangeCompletionLikeObservations: ({ host, handle }) => {
        if (!(host instanceof FakeEngineHost)) {
          throw new Error("the Fake contract harness received a different Host");
        }
        host.scriptObservations(
          handle,
          (["WINDOW_OPENED", "AGENT_RETURNED", "PROCESS_EXITED", "TERMINAL_IDLE"] as const).map(
            (kind, index) =>
              engineObservationSchema.parse({
                schemaVersion: "1.0.0",
                cursor: index + 1,
                attemptId: handle.attemptId,
                kind,
                observedAt: timestamp,
                summary: `${kind} is arranged by the harness as an Observation only.`,
              }),
          ),
        );
      },
    });

    expect(report).toEqual({
      capabilitiesDerivedFromProbeReceipt: true,
      receiptsBoundToRequests: true,
      sameOperationReplayReturnedSameReceipt: true,
      conflictingOperationReplayRejected: true,
      conflictingPayloadReplayRejected: true,
      completionLikeFactsRemainObservations: true,
      cursorResumeHasNoLossOrDuplication: true,
      interruptReplayReturnedSameReceipt: true,
      operationOutcomeDidNotRewriteOriginalReceipt: true,
      checkpointReplayReturnedSameReceipt: true,
      conflictingCheckpointReplayRejected: true,
      closeReplayReturnedSameReceipt: true,
      conflictingCloseReplayRejected: true,
      checkpointAndCloseReportedOnlyProvenEffects: true,
      privateFieldsStayedEncapsulated: true,
      forgedHandleRejected: true,
      wrongExpectedTargetRejected: true,
      expiredDeadlineRejected: true,
    });
  });

  it("detects schema-valid Receipts that are bound to a different operation", async () => {
    const base = new FakeEngineHost({ now: () => timestamp });
    const misbind = (receipt: OperationReceipt): OperationReceipt =>
      operationReceiptSchema.parse({
        ...receipt,
        operationId: "op_foreign",
        fingerprint: fingerprint("9"),
      });
    const misbindingHost: EngineHost = {
      probe: (request) => base.probe(request),
      start: async (request) => {
        const receipt = await base.start(request);
        return { ...receipt, operationReceipt: misbind(receipt.operationReceipt) };
      },
      send: async (handle, input) => misbind(await base.send(handle, input)),
      observe: (handle, cursor) => base.observe(handle, cursor),
      interrupt: async (handle, request) => misbind(await base.interrupt(handle, request)),
      checkpoint: async (handle, request) => {
        const receipt = await base.checkpoint(handle, request);
        return { ...receipt, operationReceipt: misbind(receipt.operationReceipt) };
      },
      reconcile: (request) => base.reconcile(request),
      close: async (handle, request) => misbind(await base.close(handle, request)),
    };

    const report = await runEngineHostContractSuite({
      createHost: () => misbindingHost,
      arrangeCompletionLikeObservations: ({ handle }) => {
        base.scriptObservations(
          handle,
          (["AGENT_RETURNED", "PROCESS_EXITED", "TERMINAL_IDLE", "WINDOW_OPENED"] as const).map(
            (kind, index) =>
              engineObservationSchema.parse({
                schemaVersion: "1.0.0",
                cursor: index + 1,
                attemptId: handle.attemptId,
                kind,
                observedAt: timestamp,
              }),
          ),
        );
      },
    });

    expect(report.receiptsBoundToRequests).toBe(false);
  });

  it("computes support from an actual capability receipt", async () => {
    const host = new FakeEngineHost({
      now: () => timestamp,
      supportedCapabilities: ["START_ATTEMPT", "OBSERVE"],
    });

    const receipt = await host.probe({
      schemaVersion: "1.0.0",
      requestedCapabilities: ["START_ATTEMPT", "SEND_INPUT", "OBSERVE"],
    });

    expect(supportsEngineCapability(receipt, "START_ATTEMPT")).toBe(true);
    expect(supportsEngineCapability(receipt, "OBSERVE")).toBe(true);
    expect(supportsEngineCapability(receipt, "SEND_INPUT")).toBe(false);
    expect(
      capabilityReceiptSchema.safeParse({
        schemaVersion: "1.0.0",
        observedAt: timestamp,
        results: [
          { capability: "OBSERVE", status: "SUPPORTED" },
          { capability: "OBSERVE", status: "UNSUPPORTED" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects Host responses with fields outside the strict public schemas", async () => {
    const base = new FakeEngineHost({ now: () => timestamp });
    const leakingHost: EngineHost = {
      probe: (request) => base.probe(request),
      start: async (request) =>
        ({
          ...(await base.start(request)),
          sessionId: "private-session",
        }) as unknown as Awaited<ReturnType<EngineHost["start"]>>,
      send: (handle, input) => base.send(handle, input),
      observe: (handle, cursor) => base.observe(handle, cursor),
      interrupt: (handle, request) => base.interrupt(handle, request),
      checkpoint: (handle, request) => base.checkpoint(handle, request),
      reconcile: (request) => base.reconcile(request),
      close: (handle, request) => base.close(handle, request),
    };

    await expect(
      runEngineHostContractSuite({
        createHost: () => leakingHost,
        arrangeCompletionLikeObservations: () => undefined,
      }),
    ).rejects.toThrow();
  });

  it("rejects private provider and UI fields from public schemas", () => {
    const request = {
      ...operationBoundary(
        "op_start",
        fingerprint("a"),
        workspaceTargetNamespace,
        "fixture:contract",
      ),
      runId: "run_contract",
      attemptId: "att_contract",
      planRevisionId: "plan_contract",
      workspaceReference: "fixture:contract",
    };

    expect(startAttemptRequestSchema.safeParse(request).success).toBe(true);
    expect(
      startAttemptRequestSchema.safeParse({ ...request, piSessionId: "private" }).success,
    ).toBe(false);
    expect(startAttemptRequestSchema.safeParse({ ...request, terminalHandle: 42 }).success).toBe(
      false,
    );

    const observation = {
      schemaVersion: "1.0.0",
      cursor: 1,
      attemptId: "att_contract",
      kind: "AGENT_RETURNED",
      observedAt: timestamp,
      summary: "The engine returned control.",
    };
    expect(engineObservationSchema.safeParse(observation).success).toBe(true);
    expect(
      engineObservationSchema.safeParse({
        ...observation,
        kind: "OUTPUT_CAPTURED",
        resourceUsage: { outputBytes: 128 },
      }).success,
    ).toBe(true);
    expect(
      engineObservationSchema.safeParse({
        ...observation,
        stepSucceeded: true,
      }).success,
    ).toBe(false);
    expect(
      engineObservationSchema.safeParse({
        ...observation,
        modelName: "private",
      }).success,
    ).toBe(false);
  });

  it("does not expose the Fake operation ledger through returned Receipts", async () => {
    const host = new FakeEngineHost({ now: () => timestamp });
    const started = await host.start(
      startAttemptRequestSchema.parse({
        ...operationBoundary(
          "op_start-isolation",
          fingerprint("a"),
          workspaceTargetNamespace,
          "fixture:contract",
        ),
        runId: "run_contract",
        attemptId: "att_contract",
        planRevisionId: "plan_contract",
        workspaceReference: "fixture:contract",
      }),
    );
    const input = engineInputSchema.parse({
      ...operationBoundary(
        "op_send-isolation",
        fingerprint("b"),
        engineHandleTargetNamespace,
        started.handle.engineHandleId,
      ),
      kind: "CONTROL_MESSAGE",
      content: "continue",
    });
    const first = await host.send(started.handle, input);
    first.observedEffects[0] = "corrupted by a caller";

    expect((await host.send(started.handle, input)).observedEffects).toEqual(["input-recorded"]);
  });
});
