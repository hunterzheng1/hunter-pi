import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  runIdSchema,
  type EvidenceEnvelope,
} from "@hunter-pi/domain";

import { writeImmutableAtomically, type AtomicWriteFaultInjector } from "./atomic-write.js";
import { DurableStoreError, isErrnoException, storeErrorFrom } from "./errors.js";
import {
  createPortableEvidenceEnvelope,
  type PortableEvidencePolicy,
  type PortableEvidenceRequest,
} from "./portable-evidence.js";
import { canonicalJson, sha256Fingerprint } from "./serialization.js";
import { LocalStorageController, runLogStopBytes } from "./storage-policy.js";

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function envelopeFilename(envelope: EvidenceEnvelope): string {
  return `${sha256Fingerprint(canonicalJson(envelope)).slice("sha256:".length)}.json`;
}

function evidenceIdentity(envelope: EvidenceEnvelope): string {
  return canonicalJson({
    schemaVersion: envelope.schemaVersion,
    evidenceId: envelope.evidenceId,
    kind: envelope.kind,
    scope: envelope.scope,
    createdAt: envelope.createdAt,
    sourceFingerprint: envelope.sourceFingerprint,
    contentClass: envelope.contentClass,
    contentHash: envelope.contentHash,
    summary: envelope.summary,
    redaction: envelope.redaction,
  });
}

const criticalEvidenceKinds = new Set([
  "verification",
  "review",
  "human_receipt",
  "operation",
  "checkpoint",
  "run_summary",
]);

function isCriticalEvidence(envelope: EvidenceEnvelope): boolean {
  return criticalEvidenceKinds.has(envelope.kind);
}

function serializeEnvelope(envelope: EvidenceEnvelope): string {
  return `${canonicalJson(envelope)}\n`;
}

function asDigestOnly(envelope: EvidenceEnvelope): EvidenceEnvelope {
  return evidenceEnvelopeSchema.parse({
    ...envelope,
    capture: {
      mediaType: "text/plain; charset=utf-8",
      retentionStatus: "DIGEST_ONLY",
      capturedBytes: 0,
      totalBytes: envelope.capture.totalBytes,
      truncated: false,
      cursor: { startByte: 0, endByte: 0 },
    },
  });
}

function assertRetainedContentHash(envelope: EvidenceEnvelope): void {
  if (
    envelope.capture.retentionStatus === "RETAINED" &&
    envelope.capture.capturedText !== undefined &&
    sha256Fingerprint(envelope.capture.capturedText) !== envelope.contentHash
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "Retained Evidence content does not match its declared content hash.",
    );
  }
}

export interface FileEvidenceStoreOptions {
  readonly stateRoot: string;
  readonly storage?: LocalStorageController;
  readonly faultInjector?: AtomicWriteFaultInjector;
  readonly runNoncriticalStopBytes?: number;
}

export class FileEvidenceStore {
  readonly #stateRoot: string;
  readonly #storage: LocalStorageController;
  readonly #faultInjector: AtomicWriteFaultInjector | undefined;
  readonly #runNoncriticalStopBytes: number;

  public constructor(options: FileEvidenceStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#storage = options.storage ?? new LocalStorageController({ stateRoot: this.#stateRoot });
    this.#faultInjector = options.faultInjector;
    this.#runNoncriticalStopBytes = options.runNoncriticalStopBytes ?? runLogStopBytes;
    if (
      !Number.isSafeInteger(this.#runNoncriticalStopBytes) ||
      this.#runNoncriticalStopBytes <= 0
    ) {
      throw new RangeError("runNoncriticalStopBytes must be a positive safe integer");
    }
  }

  public async capture(
    request: PortableEvidenceRequest,
    policy: PortableEvidencePolicy = {},
  ): Promise<EvidenceEnvelope> {
    return this.#persist(createPortableEvidenceEnvelope(request, policy));
  }

  async #persist(input: EvidenceEnvelope): Promise<EvidenceEnvelope> {
    const envelope = evidenceEnvelopeSchema.parse(input);
    assertRetainedContentHash(envelope);
    const existing = await this.#readOptional(envelope.evidenceId);
    if (existing !== undefined) {
      if (evidenceIdentity(existing) === evidenceIdentity(envelope)) {
        return existing;
      }
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The Evidence identity is already bound to different immutable content.",
      );
    }

    if (
      envelope.capture.retentionStatus === "DIGEST_ONLY" ||
      envelope.capture.retentionStatus === "PRUNED"
    ) {
      return isCriticalEvidence(envelope)
        ? this.#writeCritical(envelope)
        : this.#writeNonCritical(envelope);
    }

    try {
      return await this.#writeNonCritical(envelope);
    } catch (error) {
      const durableError = storeErrorFrom(error, "FAULT_INJECTED");
      if (durableError.code !== "RESERVE_REQUIRED" && durableError.code !== "STORAGE_EXHAUSTED") {
        throw durableError;
      }
      const committed = await this.#readOptional(envelope.evidenceId);
      if (committed !== undefined) {
        if (evidenceIdentity(committed) === evidenceIdentity(envelope)) {
          return committed;
        }
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "The Evidence identity was committed with different immutable content.",
        );
      }
      const digestOnly = asDigestOnly(envelope);
      return isCriticalEvidence(digestOnly)
        ? this.#writeCritical(digestOnly)
        : this.#writeNonCritical(digestOnly);
    }
  }

  public async read(evidenceId: string): Promise<EvidenceEnvelope> {
    const parsedEvidenceId = evidenceIdSchema.parse(evidenceId);
    const envelope = await this.#readOptional(parsedEvidenceId);
    if (envelope === undefined) {
      throw new DurableStoreError("NOT_FOUND", "The requested Evidence identity was not found.");
    }
    return envelope;
  }

  public async listEvidenceIds() {
    const evidenceRoot = join(this.#stateRoot, "evidence");
    try {
      const entries = await readdir(evidenceRoot, { withFileTypes: true });
      const parsed = entries.map((entry) => ({
        entry,
        evidenceId: evidenceIdSchema.safeParse(entry.name),
      }));
      if (parsed.some(({ entry, evidenceId }) => !entry.isDirectory() || !evidenceId.success)) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "The Evidence root contains an unrecognized committed entry.",
        );
      }
      return parsed
        .map(({ evidenceId }) => {
          if (!evidenceId.success) {
            throw new DurableStoreError("STORE_CORRUPT", "Invalid Evidence identity entry.");
          }
          return evidenceId.data;
        })
        .sort();
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  public async retainedBytesForRun(runId: string): Promise<number> {
    const parsedRunId = runIdSchema.parse(runId);
    let retainedBytes = 0;
    for (const evidenceId of await this.listEvidenceIds()) {
      const envelope = await this.read(evidenceId);
      if (envelope.scope.runId === parsedRunId) {
        retainedBytes += envelope.capture.capturedBytes;
      }
    }
    return retainedBytes;
  }

  async #writeCritical(envelope: EvidenceEnvelope): Promise<EvidenceEnvelope> {
    const serialized = serializeEnvelope(envelope);
    try {
      await this.#storage.writeCritical(() =>
        writeImmutableAtomically({
          directory: this.#evidenceDirectory(envelope.evidenceId),
          filename: envelopeFilename(envelope),
          content: serialized,
          ...(this.#faultInjector === undefined ? {} : { faultInjector: this.#faultInjector }),
        }),
      );
    } catch (error) {
      const durableError = storeErrorFrom(error, "FAULT_INJECTED");
      if (durableError.code === "RESERVE_REQUIRED") {
        throw durableError;
      }
      const committed = await this.#readOptional(envelope.evidenceId);
      if (committed !== undefined && evidenceIdentity(committed) === evidenceIdentity(envelope)) {
        return committed;
      }
      throw durableError;
    }
    return this.read(envelope.evidenceId);
  }

  async #writeNonCritical(envelope: EvidenceEnvelope): Promise<EvidenceEnvelope> {
    const serialized = serializeEnvelope(envelope);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    const usedBytes = await this.#noncriticalStoredBytesForRun(envelope.scope.runId);
    if (usedBytes + serializedBytes >= this.#runNoncriticalStopBytes) {
      throw new DurableStoreError(
        "RESERVE_REQUIRED",
        "Noncritical Run Evidence reached its storage stop without consuming the reserve.",
      );
    }
    await this.#storage.assertNonCriticalGrowth(serializedBytes);
    await writeImmutableAtomically({
      directory: this.#evidenceDirectory(envelope.evidenceId),
      filename: envelopeFilename(envelope),
      content: serialized,
      ...(this.#faultInjector === undefined ? {} : { faultInjector: this.#faultInjector }),
    });
    return this.read(envelope.evidenceId);
  }

  async #noncriticalStoredBytesForRun(runId: string): Promise<number> {
    const parsedRunId = runIdSchema.parse(runId);
    let storedBytes = 0;
    for (const evidenceId of await this.listEvidenceIds()) {
      const envelope = await this.read(evidenceId);
      if (envelope.scope.runId === parsedRunId && !isCriticalEvidence(envelope)) {
        storedBytes += Buffer.byteLength(serializeEnvelope(envelope), "utf8");
      }
    }
    return storedBytes;
  }

  async #readOptional(
    evidenceId: ReturnType<typeof evidenceIdSchema.parse>,
  ): Promise<EvidenceEnvelope | undefined> {
    const directory = this.#evidenceDirectory(evidenceId);
    let names: string[];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const unexpected = entries.filter(
        (entry) =>
          !entry.name.startsWith(".pending-") && (!entry.isFile() || !entry.name.endsWith(".json")),
      );
      if (unexpected.length > 0) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "The Evidence directory contains an unrecognized committed entry.",
        );
      }
      names = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
    if (names.length === 0) {
      return undefined;
    }
    if (names.length !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "The Evidence identity has multiple immutable records.",
      );
    }

    const name = names[0];
    if (name === undefined) {
      return undefined;
    }
    try {
      const envelope = evidenceEnvelopeSchema.parse(
        parseJson(await readFile(join(directory, name), "utf8")),
      );
      if (envelope.evidenceId !== evidenceId || name !== envelopeFilename(envelope)) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "An Evidence record failed identity or checksum validation.",
        );
      }
      assertRetainedContentHash(envelope);
      return envelope;
    } catch (error) {
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  #evidenceDirectory(evidenceId: string): string {
    return join(this.#stateRoot, "evidence", evidenceId);
  }
}
