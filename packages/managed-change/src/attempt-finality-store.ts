import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { fingerprintSchema, type Fingerprint } from "@hunter-pi/domain";
import {
  managedProcessFinalReceiptSchema,
  managedProcessSessionIdSchema,
  type ManagedProcessFinalReceipt,
  type ManagedProcessHost,
  type ManagedProcessSessionId,
} from "@hunter-pi/execution";
import {
  assertSafeDirectoryPath,
  canonicalJson,
  DurableStoreError,
  isErrnoException,
  sha256Fingerprint,
  writeImmutableAtomically,
} from "@hunter-pi/evidence";

import {
  attemptFinalityEvidenceRequestSchema,
  type AttemptFinalityEvidenceCapture,
  type AttemptFinalityEvidenceRequest,
  type ManagedProcessFinalReceiptReader,
} from "./attempt-finality-adapter.js";

const processFinalRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-process-final-record.v1"),
  receipt: managedProcessFinalReceiptSchema,
  fingerprint: fingerprintSchema,
});
type ProcessFinalRecord = z.infer<typeof processFinalRecordSchema>;

const attemptFinalityEvidenceRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-attempt-finality-evidence-record.v1"),
  request: attemptFinalityEvidenceRequestSchema,
  fingerprint: fingerprintSchema,
});
type AttemptFinalityEvidenceRecord = z.infer<typeof attemptFinalityEvidenceRecordSchema>;

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

function parseEvidenceRecord(
  text: string,
  evidenceId: AttemptFinalityEvidenceRequest["evidenceId"],
): AttemptFinalityEvidenceRecord {
  try {
    const record = attemptFinalityEvidenceRecordSchema.parse(JSON.parse(text) as unknown);
    if (
      record.request.evidenceId !== evidenceId ||
      record.fingerprint !== fingerprintOf(record.request)
    ) {
      throw new Error("Attempt-finality Evidence record binding changed");
    }
    return record;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "The immutable Attempt-finality Evidence record is invalid.",
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

export class FileAttemptFinalityEvidenceCapture implements AttemptFinalityEvidenceCapture {
  readonly #stateRoot: string;

  public constructor(options: FileAttemptFinalityStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public async capture(input: AttemptFinalityEvidenceRequest): Promise<{
    readonly evidenceId: AttemptFinalityEvidenceRequest["evidenceId"];
    readonly fingerprint: Fingerprint;
  }> {
    const request = attemptFinalityEvidenceRequestSchema.parse(input);
    const record = attemptFinalityEvidenceRecordSchema.parse({
      schemaVersion: "hpi-attempt-finality-evidence-record.v1",
      request,
      fingerprint: fingerprintOf(request),
    });
    await ensureStateRoot(this.#stateRoot);
    const filename = `${request.evidenceId}.json`;
    const path = join(this.#stateRoot, filename);
    const existingText = await readImmutableText(path);
    if (existingText !== undefined) {
      const existing = parseEvidenceRecord(existingText, request.evidenceId);
      if (canonicalJson(existing) === canonicalJson(record)) {
        return { evidenceId: existing.request.evidenceId, fingerprint: existing.fingerprint };
      }
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The Attempt-finality Evidence identity is already bound to different facts.",
      );
    }

    try {
      await writeImmutableAtomically({
        directory: this.#stateRoot,
        filename,
        content: serialize(record),
      });
      return { evidenceId: request.evidenceId, fingerprint: record.fingerprint };
    } catch (error) {
      if (!(error instanceof DurableStoreError) || error.code !== "IDENTITY_CONFLICT") throw error;
      const racedText = await readImmutableText(path);
      if (racedText === undefined) throw error;
      const raced = parseEvidenceRecord(racedText, request.evidenceId);
      if (canonicalJson(raced) === canonicalJson(record)) {
        return { evidenceId: raced.request.evidenceId, fingerprint: raced.fingerprint };
      }
      throw error;
    }
  }
}
