import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  checkpointSchema,
  evidenceIdSchema,
  fingerprintSchema,
  type Checkpoint,
} from "@hunter-pi/domain";
import {
  leaseStatusReceiptSchema,
  managedProcessFinalReceiptSchema,
  managedProcessSessionIdSchema,
  type LeaseManager,
  type ManagedProcessFinalReceipt,
  type ManagedProcessSessionId,
} from "@hunter-pi/execution";
import {
  ExecutionAttemptFinalityAdapter,
  type AttemptFinalityEvidenceRequest,
} from "@hunter-pi/managed-change";

import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";

const checkpointTime = "2026-08-08T00:00:00.000Z";
const finalTime = "2026-08-08T00:00:01.000Z";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return checkpointSchema.parse({
    schemaVersion: "1.0.0",
    checkpointId: "checkpoint_finality-adapter",
    runId: "run_finality-adapter",
    attemptId: "att_finality-adapter",
    planRevisionId: "plan_finality-adapter",
    distributionReleaseId: "release_finality-adapter",
    workspaceId: "workspace_finality-adapter",
    repositoryFingerprint: fixtureFingerprint,
    workspaceFingerprint: fixtureFingerprint,
    sourceFingerprint: fixtureFingerprint,
    eventCursor: 3,
    createdAt: checkpointTime,
    engine: {
      engineReleaseId: "engine-release_finality-adapter",
      engineReleaseFingerprint: fixtureFingerprint,
      resumeCapability: "UNSUPPORTED",
    },
    activeOperationReceiptIds: [],
    unknownOperationIds: [],
    heldWriterLeaseIds: ["lease_finality-adapter"],
    processReferences: [
      {
        namespace: "hunter-pi.managed-process-session",
        reference: "process_finality-adapter",
      },
    ],
    remainingResourceBudgets: { maxCommands: 1 },
    ...overrides,
  });
}

function processFinal(
  overrides: Partial<ManagedProcessFinalReceipt> = {},
): ManagedProcessFinalReceipt {
  return managedProcessFinalReceiptSchema.parse({
    schemaVersion: "hpi-process-final-receipt.v1",
    sessionId: "process_finality-adapter",
    executionObservation: "EXITED",
    exitCode: 0,
    processTreeState: "EMPTY",
    outputState: "CLOSED",
    leaseState: "NOT_REQUIRED",
    observedBytes: 0,
    retainedBytes: 0,
    outputDigest: fixtureFingerprint,
    truncated: false,
    terminalFinality: "FINAL",
    reasonCodes: [],
    observedAt: finalTime,
    ...overrides,
  });
}

function releasedLease(overrides: Record<string, unknown> = {}) {
  return leaseStatusReceiptSchema.parse({
    schemaVersion: "hpi-lease-status.v1",
    leaseId: "lease_finality-adapter",
    workspaceId: "workspace_finality-adapter",
    ownerFingerprint: fixtureFingerprint,
    generation: 2,
    resourceSetFingerprint: fixtureFingerprint,
    resourceCount: 1,
    state: "RELEASED",
    expiresAt: "2026-08-08T00:05:00.000Z",
    bindingFingerprint: null,
    observedAt: finalTime,
    ...overrides,
  });
}

function evidenceFingerprint(request: AttemptFinalityEvidenceRequest) {
  return fingerprintSchema.parse(sha256(canonicalJson(request)));
}

function createAdapter(options: {
  readonly readFinal?: (sessionId: ManagedProcessSessionId) => Promise<ManagedProcessFinalReceipt>;
  readonly inspectLease?: LeaseManager["inspect"];
}) {
  const capture = vi.fn((request: AttemptFinalityEvidenceRequest) =>
    Promise.resolve({
      evidenceId: request.evidenceId,
      fingerprint: evidenceFingerprint(request),
    }),
  );
  const adapter = new ExecutionAttemptFinalityAdapter({
    processFinalReceipts: {
      read: vi.fn(options.readFinal ?? (() => Promise.resolve(processFinal()))),
    },
    leaseManager: {
      inspect: vi.fn(options.inspectLease ?? (() => Promise.resolve({ receipt: releasedLease() }))),
    },
    captureEvidence: { capture },
  });
  return { adapter, capture };
}

describe("Task 9 execution Attempt-finality adapter", () => {
  it("binds exact Task 7 final receipts and released Writer Leases into one immutable receipt", async () => {
    const { adapter, capture } = createAdapter({});

    const first = await adapter.reconcileAttemptFinality(checkpoint());
    const replay = await adapter.reconcileAttemptFinality(checkpoint());

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      runId: "run_finality-adapter",
      attemptId: "att_finality-adapter",
      checkpointId: "checkpoint_finality-adapter",
      releasedWriterLeaseIds: ["lease_finality-adapter"],
      terminalFinality: "FINAL",
      observedAt: finalTime,
    });
    expect(first.processFinalities).toEqual([
      {
        processReference: {
          namespace: "hunter-pi.managed-process-session",
          reference: "process_finality-adapter",
        },
        finalReceiptFingerprint: fingerprintSchema.parse(sha256(canonicalJson(processFinal()))),
        processTreeState: "EMPTY",
        outputState: "CLOSED",
        leaseState: "NOT_REQUIRED",
        terminalFinality: "FINAL",
      },
    ]);
    expect(first.evidenceIds).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(2);
    const captured = capture.mock.calls[0]?.[0];
    expect(captured).toMatchObject({
      schemaVersion: "hpi-attempt-finality-evidence.v1",
      evidenceId: first.evidenceIds[0],
      runId: checkpoint().runId,
      checkpointId: checkpoint().checkpointId,
      attemptId: checkpoint().attemptId,
      processes: [
        {
          processReference: checkpoint().processReferences[0],
          receipt: processFinal(),
        },
      ],
      leases: [
        {
          leaseId: "lease_finality-adapter",
          receipt: releasedLease(),
        },
      ],
      observedAt: finalTime,
    });
  });

  it("fails closed for a process reference outside the exact managed-session namespace", async () => {
    const { adapter, capture } = createAdapter({});

    await expect(
      adapter.reconcileAttemptFinality(
        checkpoint({ processReferences: [{ namespace: "process", reference: "opaque" }] }),
      ),
    ).rejects.toThrow(/managed process session/u);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["session identity", { sessionId: managedProcessSessionIdSchema.parse("process_different") }],
    ["checkpoint freshness", { observedAt: "2026-08-07T23:59:59.000Z" }],
  ])("rejects a final receipt with stale %s", async (_label, overrides) => {
    const { adapter, capture } = createAdapter({
      readFinal: () => Promise.resolve(processFinal(overrides)),
    });

    await expect(adapter.reconcileAttemptFinality(checkpoint())).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["active", { state: "ACTIVE" }],
    ["wrong workspace", { workspaceId: "workspace_different" }],
    ["stale observation", { observedAt: "2026-08-07T23:59:59.000Z" }],
  ])("rejects a Writer Lease that is %s", async (_label, overrides) => {
    const { adapter, capture } = createAdapter({
      inspectLease: () => Promise.resolve({ receipt: releasedLease(overrides) }),
    });

    await expect(adapter.reconcileAttemptFinality(checkpoint())).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects Evidence capture that does not preserve the exact request identity", async () => {
    const adapter = new ExecutionAttemptFinalityAdapter({
      processFinalReceipts: { read: () => Promise.resolve(processFinal()) },
      leaseManager: { inspect: () => Promise.resolve({ receipt: releasedLease() }) },
      captureEvidence: {
        capture: () =>
          Promise.resolve({
            evidenceId: evidenceIdSchema.parse("evidence_changed"),
            fingerprint: fixtureFingerprint,
          }),
      },
    });

    await expect(adapter.reconcileAttemptFinality(checkpoint())).rejects.toThrow(
      /Evidence identity/u,
    );
  });
});
