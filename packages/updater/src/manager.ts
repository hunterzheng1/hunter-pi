import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

import type { z } from "zod";

import {
  fingerprintSchema,
  operationIdSchema,
  type DistributionReleaseId,
  type Fingerprint,
} from "@hunter-pi/domain";
import { redactPortableText, withDurableMutationLock } from "@hunter-pi/evidence";

import {
  releaseCandidateSchema,
  releaseCheckResultSchema,
  updateApplyRequestSchema,
  updateJournalEntrySchema,
  updateQualificationRequestSchema,
  updateReceiptSchema,
  updateRollbackRequestSchema,
  type ReleaseAdapter,
  type ReleaseArtifactSource,
  type ReleaseCandidate,
  type ReleaseCheckResult,
  type StagedRelease,
  type UpdateApplyRequest,
  type UpdateJournalEntry,
  type UpdateManager,
  type UpdateQualificationRequest,
  type UpdateReceipt,
  type UpdateRollbackRequest,
} from "./contracts.js";
import {
  windowsPortableQualificationRequestFingerprint,
  windowsPortableQualificationTargetReference,
  type WindowsPortableQualificationAuthority,
  type WindowsPortableQualificationResult,
} from "./github-actions-qualification.js";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key]))
        .join(",") +
      "}"
    );
  }
  return "null";
}

function digestOf(value: unknown): Fingerprint {
  return fingerprintSchema.parse(
    "sha256:" + createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"),
  );
}

function digestBytes(value: Uint8Array): Fingerprint {
  return fingerprintSchema.parse("sha256:" + createHash("sha256").update(value).digest("hex"));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertSafeDirectoryPath(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("update state directory contains a symbolic link or non-directory");
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

const updateJournalAppendLocks = new Map<string, Promise<void>>();
const updateManagerOperationLocks = new Map<string, Promise<void>>();

async function withUpdateJournalAppendLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = updateJournalAppendLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = predecessor.then(operation);
  void turn.then(
    () => {
      release();
    },
    () => {
      release();
    },
  );
  updateJournalAppendLocks.set(key, current);
  try {
    return await turn;
  } finally {
    if (updateJournalAppendLocks.get(key) === current) updateJournalAppendLocks.delete(key);
  }
}

async function withUpdateManagerOperationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = updateManagerOperationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = predecessor.then(operation);
  void turn.then(
    () => {
      release();
    },
    () => {
      release();
    },
  );
  updateManagerOperationLocks.set(key, current);
  try {
    return await turn;
  } finally {
    if (updateManagerOperationLocks.get(key) === current) updateManagerOperationLocks.delete(key);
  }
}

function redactFailureReason(raw: string, fallback: string): string {
  const redaction = redactPortableText(raw);
  const markers = redaction.categories.map((category) => `[REDACTED:${category}]`).join(" ");
  return `${fallback}${markers === "" ? "" : ` ${markers}`}`.slice(0, 4_096);
}

function rawFailureReason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function safeFailureReason(error: unknown, fallback: string): string {
  return redactFailureReason(rawFailureReason(error, fallback), fallback);
}

function combineFailureReasons(
  primary: string,
  cleanup: string | undefined,
  primaryFallback = "operation failed",
): string {
  const safePrimary = redactFailureReason(primary, primaryFallback);
  if (cleanup === undefined) return safePrimary;
  return `${safePrimary}; cleanup: ${redactFailureReason(cleanup, "cleanup failed")}`.slice(
    0,
    4_096,
  );
}

async function writeImmutableAtomically(options: {
  readonly directory: string;
  readonly filename: string;
  readonly content: string;
}): Promise<void> {
  if (
    options.filename.length === 0 ||
    options.filename.includes("/") ||
    options.filename.includes("\\") ||
    options.filename.includes("\0")
  ) {
    throw new Error("update journal filename must be one contained path segment");
  }
  await assertSafeDirectoryPath(options.directory);
  await mkdir(options.directory, { recursive: true });
  const temporaryPath = join(options.directory, ".pending-" + randomUUID());
  const finalPath = join(options.directory, options.filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(options.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, finalPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function entryPayload(entry: UpdateJournalEntry): Omit<UpdateJournalEntry, "entryFingerprint"> {
  return {
    schemaVersion: entry.schemaVersion,
    sequence: entry.sequence,
    operationId: entry.operationId,
    operationFingerprint: entry.operationFingerprint,
    requestFingerprint: entry.requestFingerprint,
    action: entry.action,
    ...(entry.candidate === undefined ? {} : { candidate: entry.candidate }),
    ...(entry.targetReleaseId === undefined ? {} : { targetReleaseId: entry.targetReleaseId }),
    receipt: entry.receipt,
    createdAt: entry.createdAt,
    previousEntryFingerprint: entry.previousEntryFingerprint,
  };
}

function entryFilename(entry: UpdateJournalEntry): string {
  return (
    entry.sequence.toString().padStart(12, "0") +
    "-" +
    entry.entryFingerprint.slice("sha256:".length) +
    ".json"
  );
}

class FileUpdateJournal {
  readonly #stateRoot: string;

  public constructor(stateRoot: string) {
    this.#stateRoot = resolve(stateRoot);
  }

  public async read(): Promise<readonly UpdateJournalEntry[]> {
    await assertSafeDirectoryPath(this.#stateRoot);
    let filenames: string[];
    try {
      const entries = await readdir(this.#stateRoot, { withFileTypes: true });
      if (
        entries.some(
          (entry) =>
            !entry.name.startsWith(".pending-") &&
            entry.name !== ".journal-mutation-lock" &&
            (!entry.isFile() || !entry.name.endsWith(".json")),
        )
      ) {
        throw new Error("update journal contains an unexpected committed entry");
      }
      filenames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const parsed = await Promise.all(
      filenames.map(async (filename) => ({
        filename,
        entry: updateJournalEntrySchema.parse(
          JSON.parse(await readFile(join(this.#stateRoot, filename), "utf8")) as unknown,
        ),
      })),
    );
    parsed.sort((left, right) => left.entry.sequence - right.entry.sequence);
    let previous: Fingerprint | null = null;
    for (const [index, item] of parsed.entries()) {
      if (
        item.entry.sequence !== index + 1 ||
        item.entry.previousEntryFingerprint !== previous ||
        item.entry.entryFingerprint !== digestOf(entryPayload(item.entry)) ||
        entryFilename(item.entry) !== item.filename
      ) {
        throw new Error("update journal failed sequence, hash, or filename validation");
      }
      previous = item.entry.entryFingerprint;
    }
    return parsed.map((item) => item.entry);
  }

  public async append(entry: UpdateJournalEntry): Promise<void> {
    const parsed = updateJournalEntrySchema.parse(entry);
    return withUpdateJournalAppendLock(this.#stateRoot, () =>
      withDurableMutationLock(join(this.#stateRoot, ".journal-mutation-lock"), () =>
        this.#appendValidated(parsed),
      ),
    );
  }

  async #appendValidated(entry: UpdateJournalEntry): Promise<void> {
    const entries = await this.read();
    if (
      entry.sequence !== entries.length + 1 ||
      entry.previousEntryFingerprint !== (entries.at(-1)?.entryFingerprint ?? null) ||
      entry.entryFingerprint !== digestOf(entryPayload(entry))
    ) {
      throw new Error("update journal append does not continue its immutable chain");
    }
    await writeImmutableAtomically({
      directory: this.#stateRoot,
      filename: entryFilename(entry),
      content: canonicalJson(entry) + "\n",
    });
  }
}

export interface FileUpdateManagerOptions {
  readonly stateRoot: string;
  readonly channel: "STABLE" | "PREVIEW";
  readonly adapter: ReleaseAdapter;
  readonly artifacts: ReleaseArtifactSource;
  readonly qualificationVerifierFingerprint: Fingerprint;
  readonly qualificationAuthority?: WindowsPortableQualificationAuthority;
  readonly now?: () => string;
}

export class FileUpdateManager implements UpdateManager {
  readonly #journal: FileUpdateJournal;
  readonly #channel: "STABLE" | "PREVIEW";
  readonly #adapter: ReleaseAdapter;
  readonly #artifacts: ReleaseArtifactSource;
  readonly #qualificationVerifierFingerprint: Fingerprint;
  readonly #qualificationAuthority: WindowsPortableQualificationAuthority | undefined;
  readonly #operationKey: string;
  readonly #now: () => string;

  public constructor(options: FileUpdateManagerOptions) {
    this.#journal = new FileUpdateJournal(join(resolve(options.stateRoot), "journal"));
    this.#channel = options.channel;
    this.#adapter = options.adapter;
    this.#artifacts = options.artifacts;
    this.#operationKey = resolve(options.stateRoot);
    this.#qualificationVerifierFingerprint = fingerprintSchema.parse(
      options.qualificationVerifierFingerprint,
    );
    this.#qualificationAuthority = options.qualificationAuthority;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async check(candidateInput: ReleaseCandidate): Promise<ReleaseCheckResult> {
    const candidate = releaseCandidateSchema.parse(candidateInput);
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), async () => {
        const gateReason = this.#gateReason(candidate);
        if (gateReason !== undefined) {
          return releaseCheckResultSchema.parse({
            status: "BLOCKED",
            reason: gateReason,
          });
        }
        let artifact: Uint8Array;
        try {
          artifact = await this.#artifacts.read(candidate);
        } catch (error) {
          return releaseCheckResultSchema.parse({
            status: "BLOCKED",
            reason: safeFailureReason(error, "release artifact could not be read"),
          });
        }
        if (
          artifact.byteLength !== candidate.artifact.byteLength ||
          digestBytes(artifact) !== candidate.artifact.fingerprint
        ) {
          return releaseCheckResultSchema.parse({
            status: "BLOCKED",
            reason: "release artifact bytes do not match the declared candidate digest",
          });
        }
        return releaseCheckResultSchema.parse({ status: "AVAILABLE", candidate });
      }),
    );
  }

  public async apply(request: UpdateApplyRequest): Promise<UpdateReceipt> {
    const parsed = updateApplyRequestSchema.parse(request);
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#reconcile().then(() => this.#applyParsed(parsed)),
      ),
    );
  }

  public async qualify(request: UpdateQualificationRequest): Promise<UpdateReceipt> {
    const parsed = updateQualificationRequestSchema.parse(request);
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#reconcile().then(() => this.#qualifyParsed(parsed)),
      ),
    );
  }

  async #qualifyParsed(
    parsed: ReturnType<typeof updateQualificationRequestSchema.parse>,
  ): Promise<UpdateReceipt> {
    const requestFingerprint = windowsPortableQualificationRequestFingerprint(parsed);
    if (parsed.operationFingerprint !== requestFingerprint) {
      throw new Error("qualification operation fingerprint does not bind its canonical request");
    }
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      parsed.operationId,
      parsed.operationFingerprint,
      requestFingerprint,
    );
    if (replay !== undefined) return replay;
    if (Date.parse(this.#now()) > Date.parse(parsed.deadline)) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        targetReleaseId: undefined,
        outcome: "BLOCKED",
        reason: "qualification operation deadline elapsed before mutation",
        observedAt: parsed.observedAt,
      });
    }
    let activeReleaseId: DistributionReleaseId | undefined;
    try {
      activeReleaseId = await this.#adapter.current();
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        outcome: "FAILED",
        reason: safeFailureReason(error, "qualification target state could not be read"),
        observedAt: parsed.observedAt,
      });
    }
    if (activeReleaseId === undefined || this.#adapter.installedCandidate === undefined) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        outcome: "BLOCKED",
        reason: "qualification requires one verifiable active portable release",
        observedAt: parsed.observedAt,
      });
    }
    let baseCandidate: ReleaseCandidate;
    try {
      const installed = await this.#adapter.installedCandidate({ releaseId: activeReleaseId });
      if (installed === undefined) throw new Error("active candidate metadata is missing");
      baseCandidate = releaseCandidateSchema.parse(installed);
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        targetReleaseId: activeReleaseId,
        outcome: "FAILED",
        activeReleaseId,
        reason: safeFailureReason(error, "active qualification candidate could not be verified"),
        observedAt: parsed.observedAt,
      });
    }
    if (
      parsed.expectedTarget.namespace !== "hunter-pi.windows-portable-release" ||
      parsed.expectedTarget.reference !==
        windowsPortableQualificationTargetReference(baseCandidate).reference
    ) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        targetReleaseId: activeReleaseId,
        outcome: "BLOCKED",
        activeReleaseId,
        reason: "qualification expected target does not match the active release identity",
        observedAt: parsed.observedAt,
      });
    }
    const existingQualification = entries.find(
      (entry) =>
        entry.action === "QUALIFY" &&
        entry.receipt.outcome === "APPLIED" &&
        entry.candidate?.releaseId === baseCandidate.releaseId &&
        canonicalJson(entry.candidate) === canonicalJson(baseCandidate) &&
        entry.candidate.qualification.checks.some((check) =>
          check.evidenceIds.some(
            (evidenceId) =>
              evidenceId === `evidence_main-ci-${String(parsed.source.runId)}-portable`,
          ),
        ),
    );
    if (existingQualification !== undefined) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        candidate: existingQualification.candidate,
        targetReleaseId: activeReleaseId,
        outcome: "NOOP",
        activeReleaseId,
        observedAt: parsed.observedAt,
      });
    }
    if (
      this.#qualificationAuthority === undefined ||
      this.#adapter.promoteQualification === undefined ||
      this.#adapter.finalizeQualification === undefined
    ) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        targetReleaseId: activeReleaseId,
        outcome: "BLOCKED",
        activeReleaseId,
        reason: "trusted portable qualification authority is not configured",
        observedAt: parsed.observedAt,
      });
    }
    let artifact: Uint8Array;
    let result: WindowsPortableQualificationResult | undefined;
    let promotionAttempted = false;
    try {
      artifact = await this.#artifacts.read(baseCandidate);
      if (
        artifact.byteLength !== baseCandidate.artifact.byteLength ||
        digestBytes(artifact) !== baseCandidate.artifact.fingerprint
      ) {
        throw new Error("qualification artifact bytes do not match the active candidate");
      }
      result = await this.#qualificationAuthority.qualify({
        candidate: baseCandidate,
        artifact,
        source: parsed.source,
        deadline: parsed.deadline,
        cancellationPolicy: parsed.cancellationPolicy,
      });
      if (
        windowsPortableQualificationTargetReference(result.candidate).reference !==
          parsed.expectedTarget.reference ||
        result.candidate.releaseId !== activeReleaseId
      ) {
        throw new Error("qualification authority changed immutable release identity");
      }
      const blockedReason = this.#gateReason(result.candidate);
      if (blockedReason !== undefined) throw new Error(blockedReason);
      promotionAttempted = true;
      const outcome = await this.#adapter.promoteQualification({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        baseCandidate,
        candidate: result.candidate,
        evidence: result.evidence,
        artifact,
        observedAt: parsed.observedAt,
      });
      const receipt = await this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        candidate: result.candidate,
        targetReleaseId: activeReleaseId,
        outcome: outcome === "PROMOTED" ? "APPLIED" : "NOOP",
        activeReleaseId,
        observedAt: parsed.observedAt,
      });
      await this.#finalizeQualification(
        parsed.operationId,
        parsed.operationFingerprint,
        requestFingerprint,
        result.candidate,
      );
      return receipt;
    } catch (error) {
      if (promotionAttempted && result !== undefined && this.#adapter.reconcile !== undefined) {
        let reconciliation;
        try {
          reconciliation = await this.#adapter.reconcile();
        } catch (reconciliationError) {
          throw new AggregateError(
            [error, reconciliationError],
            "qualification mutation finality could not be reconciled",
            { cause: reconciliationError },
          );
        }
        if (
          reconciliation.status === "RECOVERED" &&
          reconciliation.operation?.operationId === parsed.operationId &&
          reconciliation.operation.operationFingerprint === parsed.operationFingerprint &&
          reconciliation.operation.requestFingerprint === requestFingerprint &&
          reconciliation.candidate !== undefined &&
          canonicalJson(reconciliation.candidate) === canonicalJson(result.candidate)
        ) {
          const reconciledEntries = await this.#journal.read();
          const existingReceipt = this.#replayedOperation(
            reconciledEntries,
            parsed.operationId,
            parsed.operationFingerprint,
            requestFingerprint,
          );
          const receipt =
            existingReceipt ??
            (await this.#append({
              operationId: parsed.operationId,
              operationFingerprint: parsed.operationFingerprint,
              requestFingerprint,
              action: "QUALIFY",
              candidate: result.candidate,
              targetReleaseId: activeReleaseId,
              outcome: "APPLIED",
              activeReleaseId,
              observedAt: parsed.observedAt,
            }));
          if (receipt.action !== "QUALIFY" || receipt.outcome !== "APPLIED") {
            throw new Error("reconciled qualification conflicts with its terminal Receipt", {
              cause: error,
            });
          }
          await this.#finalizeQualification(
            parsed.operationId,
            parsed.operationFingerprint,
            requestFingerprint,
            result.candidate,
          );
          return receipt;
        }
        if (reconciliation.status !== "NONE") {
          throw new Error("qualification mutation reconciled to an unexpected operation", {
            cause: error,
          });
        }
      }
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        action: "QUALIFY",
        targetReleaseId: activeReleaseId,
        outcome: "FAILED",
        activeReleaseId,
        reason: safeFailureReason(error, "portable qualification failed closed"),
        observedAt: parsed.observedAt,
      });
    }
  }

  async #applyParsed(parsed: z.infer<typeof updateApplyRequestSchema>): Promise<UpdateReceipt> {
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      parsed.operationId,
      parsed.operationFingerprint,
      digestOf({ action: "APPLY", candidate: parsed.candidate }),
    );
    if (replay !== undefined) return replay;
    const candidate = releaseCandidateSchema.parse(parsed.candidate);
    const blockedReason = this.#gateReason(candidate);
    if (blockedReason !== undefined) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "BLOCKED",
        reason: blockedReason,
        observedAt: parsed.observedAt,
      });
    }
    let artifact: Uint8Array;
    try {
      artifact = await this.#artifacts.read(candidate);
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        reason: safeFailureReason(error, "qualified artifact source failed"),
        observedAt: parsed.observedAt,
      });
    }
    if (
      artifact.byteLength !== candidate.artifact.byteLength ||
      digestBytes(artifact) !== candidate.artifact.fingerprint
    ) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "BLOCKED",
        reason: "qualified artifact digest or byte length does not match",
        observedAt: parsed.observedAt,
      });
    }
    let previousReleaseId: DistributionReleaseId | undefined;
    try {
      previousReleaseId = await this.#adapter.current();
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        reason: safeFailureReason(error, "current release state could not be read"),
        observedAt: parsed.observedAt,
      });
    }
    if (previousReleaseId === candidate.releaseId) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "NOOP",
        activeReleaseId: previousReleaseId,
        observedAt: parsed.observedAt,
      });
    }
    let staged: StagedRelease;
    try {
      staged = await this.#adapter.stage(candidate, artifact);
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        previousReleaseId,
        activeReleaseId: previousReleaseId,
        reason: safeFailureReason(error, "release staging failed"),
        observedAt: parsed.observedAt,
      });
    }
    let health: Awaited<ReturnType<ReleaseAdapter["healthCheck"]>>;
    try {
      health = await this.#adapter.healthCheck(staged);
    } catch (error) {
      const cleanupReason = await this.#discard(staged);
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        previousReleaseId,
        activeReleaseId: previousReleaseId,
        reason: combineFailureReasons(
          rawFailureReason(error, "release health check failed"),
          cleanupReason,
          "release health check failed",
        ),
        observedAt: parsed.observedAt,
      });
    }
    if (health.status !== "PASS") {
      const cleanupReason = await this.#discard(staged);
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        previousReleaseId,
        activeReleaseId: previousReleaseId,
        reason: combineFailureReasons(health.reason, cleanupReason),
        observedAt: parsed.observedAt,
      });
    }
    let migrationRollback: (() => Promise<void>) | undefined;
    let migrationCommit: (() => Promise<void>) | undefined;
    try {
      const migration = await this.#adapter.migrate?.(staged, previousReleaseId);
      migrationRollback = migration === undefined ? undefined : () => migration.rollback();
      migrationCommit =
        migration?.commit === undefined
          ? undefined
          : () => migration.commit?.() ?? Promise.resolve();
    } catch (error) {
      const cleanupReason = await this.#discard(staged);
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        previousReleaseId,
        activeReleaseId: previousReleaseId,
        reason: combineFailureReasons(
          rawFailureReason(error, "release state migration failed"),
          cleanupReason,
          "release state migration failed",
        ),
        observedAt: parsed.observedAt,
      });
    }
    let activationFailure: string | undefined;
    try {
      await this.#adapter.activate(staged);
      const activeReleaseId = await this.#adapter.current();
      if (activeReleaseId !== candidate.releaseId) {
        activationFailure = "release activation did not publish the candidate identity";
      } else if (migrationCommit !== undefined) {
        await migrationCommit();
      }
    } catch (error) {
      activationFailure = safeFailureReason(error, "release activation failed");
    }
    if (activationFailure !== undefined) {
      let restoreReason: string | undefined;
      let restored = previousReleaseId === undefined;
      if (previousReleaseId !== undefined) {
        try {
          await this.#adapter.restore({ releaseId: previousReleaseId });
          restored = true;
        } catch (restoreError) {
          restoreReason = safeFailureReason(restoreError, "previous release restoration failed");
        }
      }
      const migrationRollbackReason = await this.#rollbackMigration(migrationRollback);
      const discardReason = await this.#discard(staged);
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "APPLY",
        candidate,
        outcome: "FAILED",
        previousReleaseId,
        ...(restored && previousReleaseId === undefined
          ? {}
          : restored
            ? { activeReleaseId: previousReleaseId }
            : {}),
        reason: combineFailureReasons(
          activationFailure,
          [restoreReason, migrationRollbackReason, discardReason]
            .filter((reason): reason is string => reason !== undefined)
            .join("; cleanup: "),
          "release activation failed",
        ).replace(/; cleanup: $/u, ""),
        observedAt: parsed.observedAt,
      });
    }
    return this.#append({
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      action: "APPLY",
      candidate,
      outcome: "APPLIED",
      previousReleaseId,
      activeReleaseId: candidate.releaseId,
      observedAt: parsed.observedAt,
    });
  }

  public async rollback(request: UpdateRollbackRequest): Promise<UpdateReceipt> {
    const parsed = updateRollbackRequestSchema.parse(request);
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#reconcile().then(() => this.#rollbackParsed(parsed)),
      ),
    );
  }

  async #rollbackParsed(
    parsed: z.infer<typeof updateRollbackRequestSchema>,
  ): Promise<UpdateReceipt> {
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      parsed.operationId,
      parsed.operationFingerprint,
      digestOf({ action: "ROLLBACK", targetReleaseId: parsed.targetReleaseId }),
    );
    if (replay !== undefined) return replay;
    let currentReleaseId: DistributionReleaseId | undefined;
    try {
      currentReleaseId = await this.#adapter.current();
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "FAILED",
        reason: safeFailureReason(error, "current release state could not be read"),
        observedAt: parsed.observedAt,
      });
    }
    if (currentReleaseId === parsed.targetReleaseId) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "NOOP",
        activeReleaseId: currentReleaseId,
        observedAt: parsed.observedAt,
      });
    }
    const historyCandidate = (await this.#history()).find(
      (entry) => entry.releaseId === parsed.targetReleaseId,
    );
    let candidate = historyCandidate;
    const installedCandidateWasPreviouslyActive = entries.some(
      (entry) =>
        entry.receipt.action === "APPLY" &&
        entry.receipt.outcome === "APPLIED" &&
        entry.receipt.previousReleaseId === parsed.targetReleaseId,
    );
    if (
      (historyCandidate !== undefined || installedCandidateWasPreviouslyActive) &&
      this.#adapter.installedCandidate !== undefined
    ) {
      try {
        const installed = await this.#adapter.installedCandidate({
          releaseId: parsed.targetReleaseId,
        });
        if (installed !== undefined) {
          const verifiedCandidate = releaseCandidateSchema.parse(installed);
          if (verifiedCandidate.releaseId !== parsed.targetReleaseId) {
            throw new Error("installed rollback candidate identity does not match the target");
          }
          if (
            historyCandidate !== undefined &&
            canonicalJson(verifiedCandidate) !== canonicalJson(historyCandidate)
          ) {
            throw new Error("installed rollback candidate no longer matches its journal identity");
          }
          candidate = verifiedCandidate;
        } else if (historyCandidate !== undefined) {
          throw new Error("journaled rollback candidate is no longer installed");
        }
      } catch (error) {
        return this.#append({
          operationId: parsed.operationId,
          operationFingerprint: parsed.operationFingerprint,
          action: "ROLLBACK",
          targetReleaseId: parsed.targetReleaseId,
          outcome: "FAILED",
          previousReleaseId: currentReleaseId,
          activeReleaseId: currentReleaseId,
          reason: safeFailureReason(error, "installed rollback candidate could not be verified"),
          observedAt: parsed.observedAt,
        });
      }
    }
    const qualificationReason = candidate === undefined ? undefined : this.#gateReason(candidate);
    if (candidate === undefined || qualificationReason !== undefined) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "BLOCKED",
        activeReleaseId: currentReleaseId,
        reason:
          candidate === undefined
            ? "rollback target is not a known applied qualified candidate"
            : `rollback target no longer meets the qualification gate: ${qualificationReason ?? "unknown qualification failure"}`,
        observedAt: parsed.observedAt,
      });
    }
    const target = { releaseId: parsed.targetReleaseId };
    try {
      await this.#adapter.restore(target);
    } catch (error) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "FAILED",
        previousReleaseId: currentReleaseId,
        reason: safeFailureReason(error, "rollback target restoration failed"),
        observedAt: parsed.observedAt,
      });
    }
    let health: Awaited<ReturnType<ReleaseAdapter["healthCheck"]>>;
    try {
      health = await this.#adapter.healthCheck(target);
    } catch (error) {
      let restoreReason: string | undefined;
      if (currentReleaseId !== undefined) {
        try {
          await this.#adapter.restore({ releaseId: currentReleaseId });
        } catch (restoreError) {
          restoreReason = safeFailureReason(
            restoreError,
            "previous release restoration failed after rollback probe",
          );
        }
      }
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "FAILED",
        previousReleaseId: currentReleaseId,
        ...(restoreReason === undefined && currentReleaseId !== undefined
          ? { activeReleaseId: currentReleaseId }
          : {}),
        reason: combineFailureReasons(
          rawFailureReason(error, "rollback health check failed"),
          restoreReason,
          "rollback health check failed",
        ),
        observedAt: parsed.observedAt,
      });
    }
    if (health.status !== "PASS") {
      let restoreReason: string | undefined;
      if (currentReleaseId !== undefined) {
        try {
          await this.#adapter.restore({ releaseId: currentReleaseId });
        } catch (restoreError) {
          restoreReason = safeFailureReason(
            restoreError,
            "previous release restoration failed after rollback health failure",
          );
        }
      }
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "FAILED",
        previousReleaseId: currentReleaseId,
        ...(restoreReason === undefined && currentReleaseId !== undefined
          ? { activeReleaseId: currentReleaseId }
          : {}),
        reason: combineFailureReasons(health.reason, restoreReason),
        observedAt: parsed.observedAt,
      });
    }
    try {
      await this.#adapter.activate(target);
      const activeReleaseId = await this.#adapter.current();
      if (activeReleaseId !== parsed.targetReleaseId) {
        throw new Error("rollback activation did not publish the target identity");
      }
    } catch (error) {
      let restoreReason: string | undefined;
      if (currentReleaseId !== undefined) {
        try {
          await this.#adapter.restore({ releaseId: currentReleaseId });
        } catch (restoreError) {
          restoreReason = safeFailureReason(
            restoreError,
            "previous release restoration failed after rollback activation failure",
          );
        }
      }
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        action: "ROLLBACK",
        targetReleaseId: parsed.targetReleaseId,
        outcome: "FAILED",
        previousReleaseId: currentReleaseId,
        ...(restoreReason === undefined && currentReleaseId !== undefined
          ? { activeReleaseId: currentReleaseId }
          : {}),
        reason: combineFailureReasons(
          rawFailureReason(error, "rollback activation failed"),
          restoreReason,
          "rollback activation failed",
        ),
        observedAt: parsed.observedAt,
      });
    }
    return this.#append({
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      action: "ROLLBACK",
      targetReleaseId: parsed.targetReleaseId,
      outcome: "APPLIED",
      previousReleaseId: currentReleaseId,
      activeReleaseId: parsed.targetReleaseId,
      observedAt: parsed.observedAt,
    });
  }

  public async reconcile(): Promise<readonly UpdateReceipt[]> {
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#reconcile(),
      ),
    );
  }

  public async current(): Promise<{ readonly releaseId: DistributionReleaseId | undefined }> {
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), async () => {
        await this.#reconcile();
        return { releaseId: await this.#adapter.current() };
      }),
    );
  }

  public async history(): Promise<readonly ReleaseCandidate[]> {
    return withUpdateManagerOperationLock(this.#operationKey, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), async () => {
        await this.#reconcile();
        return this.#history();
      }),
    );
  }

  async #history(): Promise<readonly ReleaseCandidate[]> {
    const candidates = new Map<string, ReleaseCandidate>();
    for (const entry of await this.#journal.read()) {
      if (
        entry.receipt.action === "APPLY" &&
        entry.receipt.outcome === "APPLIED" &&
        entry.candidate !== undefined
      ) {
        candidates.set(entry.candidate.releaseId, entry.candidate);
      }
    }
    return [...candidates.values()];
  }

  async #finalizeQualification(
    operationId: UpdateQualificationRequest["operationId"],
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
    candidate: ReleaseCandidate,
  ): Promise<void> {
    if (this.#adapter.finalizeQualification === undefined) {
      throw new Error("qualification adapter cannot finalize its durable intent");
    }
    await this.#adapter.finalizeQualification({
      operationId,
      operationFingerprint,
      requestFingerprint,
      candidate,
    });
  }

  async #reconcile(): Promise<readonly UpdateReceipt[]> {
    const reconciliation = await this.#adapter.reconcile?.();
    if (reconciliation === undefined || reconciliation.status === "NONE") return [];
    const entries = await this.#journal.read();
    if (reconciliation.operation !== undefined) {
      const existing = entries.find(
        (entry) => entry.operationId === reconciliation.operation?.operationId,
      );
      if (existing !== undefined) {
        if (
          existing.operationFingerprint !== reconciliation.operation.operationFingerprint ||
          existing.requestFingerprint !== reconciliation.operation.requestFingerprint
        ) {
          throw new Error("reconciled qualification operation conflicts with update journal");
        }
        if (
          existing.receipt.action !== "QUALIFY" ||
          existing.receipt.outcome !== "APPLIED" ||
          existing.candidate === undefined ||
          reconciliation.candidate === undefined ||
          canonicalJson(existing.candidate) !== canonicalJson(reconciliation.candidate)
        ) {
          throw new Error("reconciled qualification conflicts with its terminal Receipt");
        }
        await this.#finalizeQualification(
          reconciliation.operation.operationId,
          reconciliation.operation.operationFingerprint,
          reconciliation.operation.requestFingerprint,
          reconciliation.candidate,
        );
        return [];
      }
      const receipt = await this.#append({
        operationId: reconciliation.operation.operationId,
        operationFingerprint: reconciliation.operation.operationFingerprint,
        requestFingerprint: reconciliation.operation.requestFingerprint,
        action: reconciliation.operation.action,
        candidate: reconciliation.candidate,
        targetReleaseId: reconciliation.candidate?.releaseId,
        outcome: "APPLIED",
        activeReleaseId: reconciliation.activeReleaseId,
        observedAt: this.#now(),
      });
      if (reconciliation.candidate === undefined) {
        throw new Error("reconciled qualification did not return its candidate");
      }
      await this.#finalizeQualification(
        reconciliation.operation.operationId,
        reconciliation.operation.operationFingerprint,
        reconciliation.operation.requestFingerprint,
        reconciliation.candidate,
      );
      return [receipt];
    }
    if (
      reconciliation.status === "RECOVERED" &&
      reconciliation.candidate !== undefined &&
      entries.some(
        (entry) =>
          entry.receipt.action === "APPLY" &&
          entry.receipt.outcome === "APPLIED" &&
          entry.candidate?.releaseId === reconciliation.candidate?.releaseId,
      )
    ) {
      return [];
    }
    const operationId = operationIdSchema.parse(`op_update-reconcile-${randomUUID()}`);
    const receipt = await this.#append({
      operationId,
      operationFingerprint: digestOf({
        action: "RECONCILE",
        reconciliation,
      }),
      action: "APPLY",
      ...(reconciliation.candidate === undefined ? {} : { candidate: reconciliation.candidate }),
      outcome: reconciliation.status === "RECOVERED" ? "APPLIED" : "FAILED",
      ...(reconciliation.previousReleaseId === undefined
        ? {}
        : { previousReleaseId: reconciliation.previousReleaseId }),
      ...(reconciliation.activeReleaseId === undefined
        ? {}
        : { activeReleaseId: reconciliation.activeReleaseId }),
      ...(reconciliation.reason === undefined ? {} : { reason: reconciliation.reason }),
      observedAt: this.#now(),
    });
    return [receipt];
  }

  #gateReason(candidate: ReleaseCandidate): string | undefined {
    if (this.#channel === "STABLE" && candidate.channel !== "STABLE") {
      return "preview candidates are not allowed on the stable channel";
    }
    if (this.#channel === "STABLE" && candidate.updatePolicy.unsigned) {
      return "unsigned candidates are not allowed on the stable channel";
    }
    if (candidate.qualification.status !== "PASS") {
      return "release candidate qualification is not PASS";
    }
    if (candidate.qualification.verifierFingerprint !== this.#qualificationVerifierFingerprint) {
      return "release candidate qualification was produced by an unknown verifier";
    }
    if (candidate.updatePolicy.piSelfUpdate !== "DISABLED") {
      return "Pi self-update is disabled; only Hunter-qualified Engine updates are allowed";
    }
    return undefined;
  }

  #replayedOperation(
    entries: readonly UpdateJournalEntry[],
    operationId: string,
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
  ): UpdateReceipt | undefined {
    const entry = entries.find((candidate) => candidate.operationId === operationId);
    if (entry === undefined) return undefined;
    if (
      entry.operationFingerprint !== operationFingerprint ||
      entry.requestFingerprint !== requestFingerprint
    ) {
      throw new Error("update operation identity, request, or fingerprint changed during replay");
    }
    return entry.receipt;
  }

  async #discard(staged: StagedRelease): Promise<string | undefined> {
    try {
      await this.#adapter.discard(staged);
      return undefined;
    } catch (error) {
      return safeFailureReason(error, "staged release cleanup failed");
    }
  }

  async #rollbackMigration(
    rollback: (() => Promise<void>) | undefined,
  ): Promise<string | undefined> {
    if (rollback === undefined) return undefined;
    try {
      await rollback();
      return undefined;
    } catch (error) {
      return safeFailureReason(error, "release state migration rollback failed");
    }
  }

  async #append(input: {
    readonly operationId: UpdateReceipt["operationId"];
    readonly operationFingerprint: Fingerprint;
    readonly requestFingerprint?: Fingerprint | undefined;
    readonly action: UpdateReceipt["action"];
    readonly candidate?: ReleaseCandidate | undefined;
    readonly targetReleaseId?: DistributionReleaseId | undefined;
    readonly outcome: UpdateReceipt["outcome"];
    readonly previousReleaseId?: DistributionReleaseId | undefined;
    readonly activeReleaseId?: DistributionReleaseId | undefined;
    readonly reason?: string | undefined;
    readonly observedAt: string;
  }): Promise<UpdateReceipt> {
    const receipt = updateReceiptSchema.parse({
      schemaVersion: "hpi-update-receipt.v1",
      operationId: input.operationId,
      operationFingerprint: input.operationFingerprint,
      action: input.action,
      outcome: input.outcome,
      ...(input.candidate === undefined ? {} : { candidateReleaseId: input.candidate.releaseId }),
      ...(input.targetReleaseId === undefined ? {} : { targetReleaseId: input.targetReleaseId }),
      ...(input.previousReleaseId === undefined
        ? {}
        : { previousReleaseId: input.previousReleaseId }),
      ...(input.activeReleaseId === undefined ? {} : { activeReleaseId: input.activeReleaseId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      observedAt: input.observedAt,
    });
    const entries = await this.#journal.read();
    const payload = {
      schemaVersion: "hpi-update-journal.v1" as const,
      sequence: entries.length + 1,
      operationId: input.operationId,
      operationFingerprint: input.operationFingerprint,
      requestFingerprint:
        input.requestFingerprint ??
        digestOf({
          action: input.action,
          ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
          ...(input.targetReleaseId === undefined
            ? {}
            : { targetReleaseId: input.targetReleaseId }),
        }),
      action: input.action,
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
      ...(input.targetReleaseId === undefined ? {} : { targetReleaseId: input.targetReleaseId }),
      receipt,
      createdAt: input.observedAt,
      previousEntryFingerprint: entries.at(-1)?.entryFingerprint ?? null,
    };
    const entry = updateJournalEntrySchema.parse({
      ...payload,
      entryFingerprint: digestOf(payload),
    });
    await this.#journal.append(entry);
    return receipt;
  }
}
