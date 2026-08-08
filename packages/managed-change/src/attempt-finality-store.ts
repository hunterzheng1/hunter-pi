import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  fingerprintSchema,
  writerLeaseIdSchema,
  type Fingerprint,
  type WriterLeaseId,
} from "@hunter-pi/domain";
import {
  leaseMutationReceiptSchema,
  managedProcessFinalReceiptSchema,
  managedProcessSessionIdSchema,
  type LeaseManager,
  type LeaseMutationReceipt,
  type ManagedProcessFinalReceipt,
  type ManagedProcessHost,
  type ManagedProcessSessionId,
} from "@hunter-pi/execution";
import {
  assertSafeDirectoryPath,
  canonicalJson,
  DurableStoreError,
  FileEvidenceStore,
  isErrnoException,
  sha256Fingerprint,
  writeImmutableAtomically,
} from "@hunter-pi/evidence";

import {
  attemptFinalityEvidenceRequestSchema,
  type AttemptFinalityEvidenceCapture,
  type AttemptFinalityEvidenceRequest,
  type ManagedProcessFinalReceiptReader,
  type WriterLeaseReleaseReceiptReader,
} from "./attempt-finality-adapter.js";

const processFinalRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-final-record.v1"),
  receipt: managedProcessFinalReceiptSchema,
  fingerprint: fingerprintSchema,
});
type ProcessFinalRecord = z.infer<typeof processFinalRecordSchema>;

const writerLeaseReleaseRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-writer-lease-release-record.v1"),
  receipt: leaseMutationReceiptSchema,
  fingerprint: fingerprintSchema,
});
type WriterLeaseReleaseRecord = z.infer<typeof writerLeaseReleaseRecordSchema>;

function fingerprintOf(value: unknown): Fingerprint {
  return sha256Fingerprint(canonicalJson(value));
}

function serialize(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

async function ensureStateRoot(stateRoot: string): Promise<void> {
  await assertSafeDirectoryPath(stateRoot);
  await mkdir(stateRoot, { recursive: true });
  await assertSafeDirectoryPath(stateRoot);
}

async function readImmutableText(path: string): Promise<string | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "An Attempt-finality record is not a physical single-link file.",
      );
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseProcessRecord(text: string, sessionId: ManagedProcessSessionId): ProcessFinalRecord {
  try {
    const record = processFinalRecordSchema.parse(JSON.parse(text) as unknown);
    if (
      record.receipt.sessionId !== sessionId ||
      record.fingerprint !== fingerprintOf(record.receipt)
    ) {
      throw new Error("process final record binding changed");
    }
    return record;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "The immutable managed-process final Receipt is invalid.",
      error,
    );
  }
}

function parseWriterLeaseReleaseRecord(
  text: string,
  leaseId: WriterLeaseId,
): WriterLeaseReleaseRecord {
  try {
    const record = writerLeaseReleaseRecordSchema.parse(JSON.parse(text) as unknown);
    if (
      record.receipt.leaseId !== leaseId ||
      record.receipt.action !== "RELEASE" ||
      record.receipt.outcome !== "RELEASED" ||
      record.receipt.state !== "RELEASED" ||
      record.fingerprint !== fingerprintOf(record.receipt)
    ) {
      throw new Error("Writer Lease release record binding changed");
    }
    return record;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "The immutable Writer Lease release Receipt is invalid.",
      error,
    );
  }
}

export interface FileAttemptFinalityStoreOptions {
  readonly stateRoot: string;
}

export interface ManagedProcessFinalReceiptPublisher {
  publish(receipt: ManagedProcessFinalReceipt): Promise<ManagedProcessFinalReceipt>;
}

export interface WriterLeaseReleaseReceiptPublisher {
  publish(receipt: LeaseMutationReceipt): Promise<LeaseMutationReceipt>;
}

export class FileManagedProcessFinalReceiptStore
  implements ManagedProcessFinalReceiptReader, ManagedProcessFinalReceiptPublisher
{
  readonly #stateRoot: string;

  public constructor(options: FileAttemptFinalityStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public async publish(input: ManagedProcessFinalReceipt): Promise<ManagedProcessFinalReceipt> {
    const receipt = managedProcessFinalReceiptSchema.parse(input);
    const record = processFinalRecordSchema.parse({
      schemaVersion: "hpi-process-final-record.v1",
      receipt,
      fingerprint: fingerprintOf(receipt),
    });
    await ensureStateRoot(this.#stateRoot);
    const filename = `${receipt.sessionId}.json`;
    const path = join(this.#stateRoot, filename);
    const existingText = await readImmutableText(path);
    if (existingText !== undefined) {
      const existing = parseProcessRecord(existingText, receipt.sessionId);
      if (canonicalJson(existing) === canonicalJson(record)) return existing.receipt;
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The managed-process session is already bound to another final Receipt.",
      );
    }

    try {
      await writeImmutableAtomically({
        directory: this.#stateRoot,
        filename,
        content: serialize(record),
      });
      return receipt;
    } catch (error) {
      if (!(error instanceof DurableStoreError) || error.code !== "IDENTITY_CONFLICT") throw error;
      const racedText = await readImmutableText(path);
      if (racedText === undefined) throw error;
      const raced = parseProcessRecord(racedText, receipt.sessionId);
      if (canonicalJson(raced) === canonicalJson(record)) return raced.receipt;
      throw error;
    }
  }

  public async read(sessionIdInput: ManagedProcessSessionId): Promise<ManagedProcessFinalReceipt> {
    const sessionId = managedProcessSessionIdSchema.parse(sessionIdInput);
    await ensureStateRoot(this.#stateRoot);
    const text = await readImmutableText(join(this.#stateRoot, `${sessionId}.json`));
    if (text === undefined) {
      throw new DurableStoreError(
        "NOT_FOUND",
        "No immutable final Receipt exists for the managed-process session.",
      );
    }
    return parseProcessRecord(text, sessionId).receipt;
  }
}

export function createFinalReceiptPersistingManagedProcessHost(options: {
  readonly host: ManagedProcessHost;
  readonly finalReceiptStore: ManagedProcessFinalReceiptPublisher;
}): ManagedProcessHost {
  const durableHost: ManagedProcessHost = {
    start: (request) => options.host.start(request),
    read: (request) => options.host.read(request),
    heartbeat: (sessionId) => options.host.heartbeat(sessionId),
    cancel: (request) => options.host.cancel(request),
    awaitFinal: async (sessionId) => {
      const result = await options.host.awaitFinal(sessionId);
      const receipt = await options.finalReceiptStore.publish(result.receipt);
      return { receipt };
    },
  };
  return durableHost;
}

export class FileWriterLeaseReleaseReceiptStore
  implements WriterLeaseReleaseReceiptReader, WriterLeaseReleaseReceiptPublisher
{
  readonly #stateRoot: string;

  public constructor(options: FileAttemptFinalityStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public async publish(input: LeaseMutationReceipt): Promise<LeaseMutationReceipt> {
    const receipt = leaseMutationReceiptSchema.parse(input);
    if (
      receipt.action !== "RELEASE" ||
      receipt.outcome !== "RELEASED" ||
      receipt.state !== "RELEASED"
    ) {
      throw new DurableStoreError(
        "INVALID_TARGET",
        "Only an exact released Writer Lease Receipt may enter the finality store.",
      );
    }
    const record = writerLeaseReleaseRecordSchema.parse({
      schemaVersion: "hpi-writer-lease-release-record.v1",
      receipt,
      fingerprint: fingerprintOf(receipt),
    });
    await ensureStateRoot(this.#stateRoot);
    const filename = `${receipt.leaseId}.json`;
    const path = join(this.#stateRoot, filename);
    const existingText = await readImmutableText(path);
    if (existingText !== undefined) {
      const existing = parseWriterLeaseReleaseRecord(existingText, receipt.leaseId);
      if (canonicalJson(existing) === canonicalJson(record)) return existing.receipt;
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The Writer Lease is already bound to another immutable release Receipt.",
      );
    }
    try {
      await writeImmutableAtomically({
        directory: this.#stateRoot,
        filename,
        content: serialize(record),
      });
      return receipt;
    } catch (error) {
      if (!(error instanceof DurableStoreError) || error.code !== "IDENTITY_CONFLICT") throw error;
      const racedText = await readImmutableText(path);
      if (racedText === undefined) throw error;
      const raced = parseWriterLeaseReleaseRecord(racedText, receipt.leaseId);
      if (canonicalJson(raced) === canonicalJson(record)) return raced.receipt;
      throw error;
    }
  }

  public async read(leaseIdInput: WriterLeaseId): Promise<LeaseMutationReceipt> {
    const leaseId = writerLeaseIdSchema.parse(leaseIdInput);
    await ensureStateRoot(this.#stateRoot);
    const text = await readImmutableText(join(this.#stateRoot, `${leaseId}.json`));
    if (text === undefined) {
      throw new DurableStoreError(
        "NOT_FOUND",
        "No immutable release Receipt exists for the Writer Lease.",
      );
    }
    return parseWriterLeaseReleaseRecord(text, leaseId).receipt;
  }
}

export function createReleaseReceiptPersistingLeaseManager(options: {
  readonly leaseManager: LeaseManager;
  readonly releaseReceiptStore: WriterLeaseReleaseReceiptPublisher;
}): LeaseManager {
  const durableManager: LeaseManager = {
    acquire: (request) => options.leaseManager.acquire(request),
    bind: (request) => options.leaseManager.bind(request),
    inspect: (leaseId) => options.leaseManager.inspect(leaseId),
    renew: (request) => options.leaseManager.renew(request),
    release: async (request) => {
      const result = await options.leaseManager.release(request);
      const receipt = await options.releaseReceiptStore.publish(result.receipt);
      return { receipt };
    },
  };
  return durableManager;
}

export class FileAttemptFinalityEvidenceCapture implements AttemptFinalityEvidenceCapture {
  readonly #evidenceStore: FileEvidenceStore;

  public constructor(options: FileAttemptFinalityStoreOptions) {
    this.#evidenceStore = new FileEvidenceStore({ stateRoot: resolve(options.stateRoot) });
  }

  public async capture(input: AttemptFinalityEvidenceRequest): Promise<{
    readonly evidenceId: AttemptFinalityEvidenceRequest["evidenceId"];
    readonly fingerprint: Fingerprint;
  }> {
    const request = attemptFinalityEvidenceRequestSchema.parse(input);
    const content = canonicalJson(request);
    const fingerprint = fingerprintOf(request);
    const summary = "Attempt finality reconciled from immutable process and Writer Lease receipts.";
    const envelope = await this.#evidenceStore.capture({
      schemaVersion: "1.0.0",
      evidenceId: request.evidenceId,
      kind: "checkpoint",
      scope: { runId: request.runId, attemptId: request.attemptId },
      createdAt: request.observedAt,
      sourceFingerprint: request.sourceFingerprint,
      summary,
      contentClass: "SUMMARY",
      content,
    });
    if (
      envelope.evidenceId !== request.evidenceId ||
      envelope.kind !== "checkpoint" ||
      envelope.scope.runId !== request.runId ||
      envelope.scope.attemptId !== request.attemptId ||
      envelope.createdAt !== request.observedAt ||
      envelope.sourceFingerprint !== request.sourceFingerprint ||
      envelope.contentClass !== "SUMMARY" ||
      envelope.contentHash !== fingerprint ||
      envelope.summary !== summary ||
      envelope.capture.retentionStatus !== "RETAINED" ||
      envelope.capture.capturedText !== content ||
      envelope.redaction.applied
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "Canonical Attempt-finality Evidence changed identity, content, or retention state.",
      );
    }
    return { evidenceId: envelope.evidenceId, fingerprint };
  }
}
