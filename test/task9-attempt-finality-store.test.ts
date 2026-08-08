import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkpointSchema, fingerprintSchema, type Fingerprint } from "@hunter-pi/domain";
import {
  leaseMutationReceiptSchema,
  managedProcessFinalReceiptSchema,
  managedProcessSessionIdSchema,
  type ManagedProcessHost,
} from "@hunter-pi/execution";
import { FileEvidenceStore } from "@hunter-pi/evidence";
import {
  createFinalReceiptPersistingManagedProcessHost,
  ExecutionAttemptFinalityAdapter,
  FileAttemptFinalityEvidenceCapture,
  FileManagedProcessFinalReceiptStore,
  FileWriterLeaseReleaseReceiptStore,
  type AttemptFinalityEvidenceRequest,
} from "@hunter-pi/managed-change";

import { fixtureFingerprint } from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];
const checkpointTime = "2026-08-08T00:00:00.000Z";
const finalTime = "2026-08-08T00:00:01.000Z";

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): Fingerprint {
  return fingerprintSchema.parse(
    `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`,
  );
}

function processFinal(outputDigest: Fingerprint = fixtureFingerprint) {
  return managedProcessFinalReceiptSchema.parse({
    schemaVersion: "hpi-process-final-receipt.v1",
    sessionId: "process_finality-store",
    executionObservation: "EXITED",
    exitCode: 0,
    processTreeState: "EMPTY",
    outputState: "CLOSED",
    leaseState: "NOT_REQUIRED",
    observedBytes: 0,
    retainedBytes: 0,
    outputDigest,
    truncated: false,
    terminalFinality: "FINAL",
    reasonCodes: [],
    observedAt: finalTime,
  });
}

function releasedLease() {
  return leaseMutationReceiptSchema.parse({
    schemaVersion: "hpi-lease-mutation-receipt.v1",
    action: "RELEASE",
    outcome: "RELEASED",
    leaseId: "lease_finality-store",
    workspaceId: "workspace_finality-store",
    ownerFingerprint: fixtureFingerprint,
    generation: 2,
    resourceSetFingerprint: fixtureFingerprint,
    resourceCount: 1,
    state: "RELEASED",
    expiresAt: "2026-08-08T00:05:00.000Z",
    bindingFingerprint: null,
    reasonCodes: [],
    observedAt: finalTime,
  });
}

function checkpoint() {
  return checkpointSchema.parse({
    schemaVersion: "1.0.0",
    checkpointId: "checkpoint_finality-store",
    runId: "run_finality-store",
    attemptId: "att_finality-store",
    planRevisionId: "plan_finality-store",
    distributionReleaseId: "release_finality-store",
    workspaceId: "workspace_finality-store",
    repositoryFingerprint: fixtureFingerprint,
    workspaceFingerprint: fixtureFingerprint,
    sourceFingerprint: fixtureFingerprint,
    eventCursor: 3,
    createdAt: checkpointTime,
    engine: {
      engineReleaseId: "engine-release_finality-store",
      engineReleaseFingerprint: fixtureFingerprint,
      resumeCapability: "UNSUPPORTED",
    },
    activeOperationReceiptIds: [],
    unknownOperationIds: [],
    heldWriterLeaseIds: ["lease_finality-store"],
    processReferences: [
      {
        namespace: "hunter-pi.managed-process-session",
        reference: "process_finality-store",
      },
    ],
    remainingResourceBudgets: { maxCommands: 1 },
  });
}

async function captureRequest(): Promise<AttemptFinalityEvidenceRequest> {
  let captured: AttemptFinalityEvidenceRequest | undefined;
  const adapter = new ExecutionAttemptFinalityAdapter({
    processFinalReceipts: { read: () => Promise.resolve(processFinal()) },
    writerLeaseReleaseReceipts: { read: () => Promise.resolve(releasedLease()) },
    captureEvidence: {
      capture: (request) => {
        captured = request;
        return Promise.resolve({
          evidenceId: request.evidenceId,
          fingerprint: fingerprint(request),
        });
      },
    },
  });
  await adapter.reconcileAttemptFinality(checkpoint());
  if (captured === undefined) throw new Error("fixture did not capture finality Evidence");
  return captured;
}

describe("Task 9 durable Attempt-finality stores", () => {
  it("publishes every Task 7 awaitFinal Receipt before returning it to the caller", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hpi-t9-final-host-");
    cleanupRoots.push(root);
    const store = new FileManagedProcessFinalReceiptStore({ stateRoot: root });
    const awaitFinal = vi.fn(() => Promise.resolve({ receipt: processFinal() }));
    const host = { awaitFinal } as unknown as ManagedProcessHost;
    const durableHost = createFinalReceiptPersistingManagedProcessHost({
      host,
      finalReceiptStore: store,
    });

    const result = await durableHost.awaitFinal(
      managedProcessSessionIdSchema.parse("process_finality-store"),
    );

    expect(result.receipt).toEqual(processFinal());
    await expect(
      new FileManagedProcessFinalReceiptStore({ stateRoot: root }).read(
        managedProcessSessionIdSchema.parse("process_finality-store"),
      ),
    ).resolves.toEqual(processFinal());
  });

  it("reopens immutable process and Evidence receipts without changing the finality aggregate", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hpi-t9-finality-store-");
    cleanupRoots.push(root);
    const processRoot = join(root, "process-final");
    const leaseRoot = join(root, "lease-release");
    const evidenceRoot = join(root, "finality-evidence");
    await Promise.all([mkdir(processRoot), mkdir(leaseRoot), mkdir(evidenceRoot)]);
    const processStore = new FileManagedProcessFinalReceiptStore({ stateRoot: processRoot });
    const leaseStore = new FileWriterLeaseReleaseReceiptStore({ stateRoot: leaseRoot });
    const evidenceStore = new FileAttemptFinalityEvidenceCapture({ stateRoot: evidenceRoot });

    await expect(processStore.publish(processFinal())).resolves.toEqual(processFinal());
    await expect(processStore.publish(processFinal())).resolves.toEqual(processFinal());
    await expect(leaseStore.publish(releasedLease())).resolves.toEqual(releasedLease());
    await expect(leaseStore.publish(releasedLease())).resolves.toEqual(releasedLease());

    const first = await new ExecutionAttemptFinalityAdapter({
      processFinalReceipts: processStore,
      writerLeaseReleaseReceipts: leaseStore,
      captureEvidence: evidenceStore,
    }).reconcileAttemptFinality(checkpoint());
    const reopened = await new ExecutionAttemptFinalityAdapter({
      processFinalReceipts: new FileManagedProcessFinalReceiptStore({ stateRoot: processRoot }),
      writerLeaseReleaseReceipts: new FileWriterLeaseReleaseReceiptStore({
        stateRoot: leaseRoot,
      }),
      captureEvidence: new FileAttemptFinalityEvidenceCapture({ stateRoot: evidenceRoot }),
    }).reconcileAttemptFinality(checkpoint());

    expect(reopened).toEqual(first);
  });

  it("rejects a changed final Receipt under the same process session identity", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hpi-t9-process-conflict-");
    cleanupRoots.push(root);
    const store = new FileManagedProcessFinalReceiptStore({ stateRoot: root });
    await store.publish(processFinal());

    await expect(store.publish(processFinal(fingerprint("changed output")))).rejects.toMatchObject({
      code: "IDENTITY_CONFLICT",
    });
  });

  it("fails closed when a committed process Receipt is corrupted on disk", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hpi-t9-process-corrupt-");
    cleanupRoots.push(root);
    const store = new FileManagedProcessFinalReceiptStore({ stateRoot: root });
    await store.publish(processFinal());
    await writeFile(join(root, "process_finality-store.json"), "{}\n", "utf8");

    await expect(
      store.read(managedProcessSessionIdSchema.parse("process_finality-store")),
    ).rejects.toMatchObject({
      code: "STORE_CORRUPT",
    });
  });

  it("replays exact Evidence and rejects a changed immutable Evidence identity", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hpi-t9-evidence-store-");
    cleanupRoots.push(root);
    const store = new FileAttemptFinalityEvidenceCapture({ stateRoot: root });
    const request = await captureRequest();

    const first = await store.capture(request);
    await expect(store.capture(request)).resolves.toEqual(first);
    const envelope = await new FileEvidenceStore({ stateRoot: root }).read(request.evidenceId);
    expect(envelope).toMatchObject({
      evidenceId: request.evidenceId,
      kind: "checkpoint",
      scope: { runId: request.runId, attemptId: request.attemptId },
      contentHash: first.fingerprint,
      capture: { capturedText: canonicalJson(request) },
      redaction: { applied: false },
    });
    const evidenceDirectory = join(root, "evidence", request.evidenceId);
    const records = await readdir(evidenceDirectory);
    const record = records.find((name) => name.endsWith(".json"));
    if (record === undefined) throw new Error("fixture Evidence record is missing");
    await writeFile(join(evidenceDirectory, record), "{}\n", "utf8");
    await expect(store.capture(request)).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });
});
