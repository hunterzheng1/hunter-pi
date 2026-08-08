import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  archiveIdSchema,
  attemptIdSchema,
  changeIdSchema,
  checkpointIdSchema,
  distributionReleaseIdSchema,
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  externalReferenceSchema,
  fingerprintSchema,
  operationIdSchema,
  operationReceiptIdSchema,
  planRevisionIdSchema,
  runIdSchema,
  timestampSchema,
  writerLeaseIdSchema,
  type EvidenceEnvelope,
} from "@hunter-pi/domain";
import {
  assertRunProjectionIntegrity,
  replayWorkflowEvents,
  runProjectionSchema,
  workflowEventSchema,
  type RunProjection,
  type WorkflowEvent,
  type WorkflowKernel,
} from "@hunter-pi/workflow-kernel";

import {
  assertSafeDirectoryPath,
  withDurableMutationLock,
  writeImmutableAtomically,
} from "./atomic-write.js";
import { DurableStoreError, isErrnoException, storeErrorFrom } from "./errors.js";
import { redactPortableText } from "./portable-evidence.js";
import { canonicalJson, sha256Fingerprint } from "./serialization.js";
import { LocalStorageController } from "./storage-policy.js";

const terminalOutcomes = new Set(["READY", "BLOCKED", "FAILED", "CANCELLED", "INCOMPLETE"]);
const positiveIntegerSchema = z.number().int().positive();
const targetReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u, "archive target must be one safe path segment");

const archiveEvidenceReferenceSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  digest: fingerprintSchema,
});

const archiveRecoveryLimitsSchema = z.strictObject({
  maxAttempts: positiveIntegerSchema,
  maxElapsedMs: positiveIntegerSchema,
});
export type ArchiveRecoveryLimits = z.infer<typeof archiveRecoveryLimitsSchema>;

export const archiveManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-archive.v1"),
    archiveId: archiveIdSchema,
    runId: runIdSchema,
    changeId: changeIdSchema,
    planRevisionId: planRevisionIdSchema,
    distributionReleaseId: distributionReleaseIdSchema,
    outcome: z.enum(["READY", "BLOCKED", "FAILED", "CANCELLED", "INCOMPLETE"]),
    archiveStatus: z.literal("ARCHIVED"),
    archivedAt: timestampSchema,
    sourceFingerprint: fingerprintSchema,
    workspaceFingerprint: fingerprintSchema,
    eventCursor: positiveIntegerSchema,
    eventDigest: fingerprintSchema,
    projectionDigest: fingerprintSchema,
    evidenceDigest: fingerprintSchema,
    attemptIds: z.array(attemptIdSchema).min(1),
    checkpointIds: z.array(checkpointIdSchema),
    evidence: z.array(archiveEvidenceReferenceSchema),
    recoveryLimits: archiveRecoveryLimitsSchema,
    finalizationOperationId: operationIdSchema,
    finalizationOperationFingerprint: fingerprintSchema,
  })
  .superRefine((manifest, context) => {
    if (new Set(manifest.attemptIds).size !== manifest.attemptIds.length) {
      context.addIssue({
        code: "custom",
        path: ["attemptIds"],
        message: "Attempt identities must be unique",
      });
    }
    if (new Set(manifest.checkpointIds).size !== manifest.checkpointIds.length) {
      context.addIssue({
        code: "custom",
        path: ["checkpointIds"],
        message: "Checkpoint identities must be unique",
      });
    }
    if (
      new Set(manifest.evidence.map((reference) => reference.evidenceId)).size !==
      manifest.evidence.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Evidence identities must be unique",
      });
    }
  });
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

export const archivePortabilitySchema = z
  .strictObject({
    activeAttemptIds: z.array(attemptIdSchema),
    activeOperationReceiptIds: z.array(operationReceiptIdSchema),
    unknownOperationIds: z.array(operationIdSchema),
    heldWriterLeaseIds: z.array(writerLeaseIdSchema),
    processReferences: z.array(externalReferenceSchema),
    deviceLocalPaths: z.array(z.string().trim().min(1).max(4_096)),
    credentialMaterial: z.boolean(),
  })
  .superRefine((portability, context) => {
    for (const key of [
      "activeAttemptIds",
      "activeOperationReceiptIds",
      "unknownOperationIds",
      "heldWriterLeaseIds",
      "processReferences",
      "deviceLocalPaths",
    ] as const) {
      const values = portability[key].map((value) => JSON.stringify(value));
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} identities must be unique`,
        });
      }
    }
  });

export const archivePackageSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-package.v1"),
  manifest: archiveManifestSchema,
  projection: runProjectionSchema,
  events: z.array(workflowEventSchema).min(1),
  evidence: z.array(evidenceEnvelopeSchema),
  portability: archivePortabilitySchema,
});
export type ArchivePackage = z.infer<typeof archivePackageSchema>;

export const archiveFinalizeRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-finalize.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  distributionReleaseId: distributionReleaseIdSchema,
  projection: runProjectionSchema,
  events: z.array(workflowEventSchema).min(1),
  evidence: z.array(evidenceEnvelopeSchema),
  recoveryLimits: archiveRecoveryLimitsSchema,
  archivedAt: timestampSchema,
});
export type ArchiveFinalizeRequest = z.input<typeof archiveFinalizeRequestSchema>;

export const archiveExportRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-export.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  targetReference: targetReferenceSchema,
});
export type ArchiveExportRequest = z.input<typeof archiveExportRequestSchema>;

export const archiveExportReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-export-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  targetReference: targetReferenceSchema,
  artifactFingerprint: fingerprintSchema,
  outcome: z.enum(["APPLIED", "NOOP"]),
  observedAt: timestampSchema,
});
export type ArchiveExportReceipt = z.infer<typeof archiveExportReceiptSchema>;

export const archiveImportRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-import.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archive: archivePackageSchema,
});
export type ArchiveImportRequest = z.input<typeof archiveImportRequestSchema>;

export const archiveImportReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-import-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  artifactFingerprint: fingerprintSchema,
  outcome: z.enum(["APPLIED", "NOOP"]),
  observedAt: timestampSchema,
});
export type ArchiveImportReceipt = z.infer<typeof archiveImportReceiptSchema>;

export const archiveDeleteExportRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-delete-export.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  targetReference: targetReferenceSchema,
});
export type ArchiveDeleteExportRequest = z.input<typeof archiveDeleteExportRequestSchema>;

export const archiveDeleteExportReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-delete-export-receipt.v2"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  targetReference: targetReferenceSchema,
  archiveId: archiveIdSchema.nullable(),
  artifactFingerprint: fingerprintSchema.nullable(),
  outcome: z.enum(["APPLIED", "NOOP", "BLOCKED"]),
  observedAt: timestampSchema,
});
export type ArchiveDeleteExportReceipt = z.infer<typeof archiveDeleteExportReceiptSchema>;

interface ArchiveExportArtifact {
  readonly schemaVersion: "hpi-archive-export-artifact.v1";
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly archive: ArchivePackage;
}

const archiveExportArtifactSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-export-artifact.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  archive: archivePackageSchema,
});

const archiveDeletePendingSchema = z.strictObject({
  schemaVersion: z.literal("hpi-archive-delete-pending.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  targetReference: targetReferenceSchema,
  archiveId: archiveIdSchema,
  artifactFingerprint: fingerprintSchema,
});

export interface RunArchiveStore {
  finalize(request: ArchiveFinalizeRequest): Promise<ArchiveManifest>;
  read(archiveId: string): Promise<ArchiveManifest>;
  export(request: ArchiveExportRequest): Promise<ArchiveExportReceipt>;
  import(request: ArchiveImportRequest): Promise<ArchiveImportReceipt>;
  deleteExport(request: ArchiveDeleteExportRequest): Promise<ArchiveDeleteExportReceipt>;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function archiveDirectory(stateRoot: string, archiveId: string): string {
  return join(stateRoot, "archives", archiveId);
}

function archivePackageFilename(): string {
  return "package.json";
}

function archivePackageFingerprint(archive: ArchivePackage): string {
  return sha256Fingerprint(canonicalJson(archive));
}

function operationReceiptPath(stateRoot: string, kind: "imports" | "deletes", key: string): string {
  return join(stateRoot, ".operation-receipts", kind, `${key}.json`);
}

function operationPendingPath(stateRoot: string, key: string): string {
  return join(stateRoot, ".operation-receipts", "deletes", `${key}.pending.json`);
}

async function readImmutableJsonOptional<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    await assertSafeDirectoryPath(dirname(path));
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "An immutable operation receipt must be an exact regular file.",
      );
    }
    return schema.parse(parseJson(await readFile(path, "utf8")));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw storeErrorFrom(error, "STORE_CORRUPT");
  }
}

function assertOperationIdentity(
  existing: { readonly operationId: string; readonly operationFingerprint: string },
  requested: { readonly operationId: string; readonly operationFingerprint: string },
): void {
  if (
    existing.operationId !== requested.operationId ||
    existing.operationFingerprint !== requested.operationFingerprint
  ) {
    throw new DurableStoreError(
      "IDENTITY_CONFLICT",
      "The exact operation identity is already bound to another Archive fact.",
    );
  }
}

const archiveOperationLocks = new Map<string, Promise<void>>();

async function withArchiveOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = archiveOperationLocks.get(key) ?? Promise.resolve();
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
  archiveOperationLocks.set(key, current);
  try {
    return await turn;
  } finally {
    if (archiveOperationLocks.get(key) === current) archiveOperationLocks.delete(key);
  }
}

export function assertPortableArchive(archive: ArchivePackage): void {
  if (
    archive.portability.activeAttemptIds.length > 0 ||
    archive.portability.activeOperationReceiptIds.length > 0 ||
    archive.portability.unknownOperationIds.length > 0 ||
    archive.portability.heldWriterLeaseIds.length > 0 ||
    archive.portability.processReferences.length > 0 ||
    archive.portability.deviceLocalPaths.length > 0 ||
    archive.portability.credentialMaterial
  ) {
    throw new DurableStoreError(
      "INVALID_TARGET",
      "A portable Archive cannot contain live Attempts, leases, processes, device paths, or credentials.",
    );
  }
  const serialized = canonicalJson(archive);
  if (/(?:^|["\s])(?:file:\/\/|\/\/|[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"'<>|]*/iu.test(serialized)) {
    throw new DurableStoreError(
      "INVALID_TARGET",
      "A portable Archive cannot contain a device-local path.",
    );
  }
  for (const evidence of archive.evidence) {
    for (const text of [evidence.summary, evidence.capture.capturedText]) {
      if (text === undefined) continue;
      const detected = redactPortableText(text).categories;
      if (
        detected.some((category) =>
          [
            "CREDENTIAL",
            "SENSITIVE_QUERY",
            "ENVIRONMENT_DUMP",
            "PRIVATE_PATH",
            "PRIVATE_PROMPT",
          ].includes(category),
        )
      ) {
        throw new DurableStoreError(
          "INVALID_TARGET",
          "A portable Archive cannot contain credential, private prompt, environment, or device-path text.",
        );
      }
    }
    if (
      ["PRIVATE_PROMPT", "ENVIRONMENT_DUMP", "CREDENTIAL_MATERIAL"].includes(
        evidence.contentClass,
      ) &&
      evidence.capture.retentionStatus !== "DIGEST_ONLY"
    ) {
      throw new DurableStoreError(
        "INVALID_TARGET",
        "Portable Archive Evidence must retain forbidden content classes as digests only.",
      );
    }
  }
}

function assertArchiveProjection(
  projection: RunProjection,
  events: readonly WorkflowEvent[],
  evidence: readonly EvidenceEnvelope[],
  distributionReleaseId: string,
): void {
  assertRunProjectionIntegrity(projection);
  if (
    !terminalOutcomes.has(projection.run.lifecycle) ||
    projection.run.archiveStatus !== "UNARCHIVED"
  ) {
    throw new DurableStoreError(
      "INVALID_TARGET",
      "Only an ended, unarchived Run can be finalized into an Archive.",
    );
  }
  if (events.length !== projection.eventCursor) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "Archive event count does not match the projection cursor.",
    );
  }
  const replayed = replayWorkflowEvents(events);
  if (canonicalJson(replayed) !== canonicalJson(projection)) {
    throw new DurableStoreError(
      "IDENTITY_CONFLICT",
      "Archive events do not replay to the supplied projection.",
    );
  }
  const evidenceById = new Map<string, EvidenceEnvelope>();
  for (const envelope of evidence) {
    if (evidenceById.has(envelope.evidenceId)) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "Archive Evidence identities must be unique.",
      );
    }
    if (
      envelope.scope.runId !== projection.run.runId ||
      envelope.sourceFingerprint !== projection.run.sourceFingerprint
    ) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "Archive Evidence must bind the exact Run and source.",
      );
    }
    evidenceById.set(envelope.evidenceId, envelope);
  }
  const referencedEvidenceIds = new Set([
    ...projection.attempts.flatMap((attempt) => attempt.failureEvidenceIds ?? []),
    ...projection.observations.flatMap((observation) => observation.evidenceIds),
    ...projection.attemptFinalityReceipts.flatMap((receipt) => receipt.evidenceIds),
    ...projection.verificationReceipts.flatMap((receipt) => receipt.evidenceIds),
    ...projection.humanReceipts.flatMap((receipt) => receipt.evidenceIds),
    ...projection.reviewReceipts.flatMap((receipt) => [
      ...receipt.evidenceIds,
      ...receipt.findings.flatMap((finding) => finding.evidenceIds),
    ]),
  ]);
  if ([...referencedEvidenceIds].some((evidenceId) => !evidenceById.has(evidenceId))) {
    throw new DurableStoreError("IDENTITY_CONFLICT", "Archive omitted referenced Evidence.");
  }
  distributionReleaseIdSchema.parse(distributionReleaseId);
}

export function assertArchivePackage(archive: ArchivePackage): void {
  const { manifest, projection, events, evidence } = archive;
  assertArchiveProjection(projection, events, evidence, manifest.distributionReleaseId);
  if (
    manifest.runId !== projection.run.runId ||
    manifest.changeId !== projection.change.changeId ||
    manifest.planRevisionId !== projection.planRevision.planRevisionId ||
    manifest.sourceFingerprint !== projection.run.sourceFingerprint ||
    manifest.workspaceFingerprint !== projection.run.workspaceFingerprint ||
    manifest.outcome !== projection.run.lifecycle
  ) {
    throw new DurableStoreError(
      "IDENTITY_CONFLICT",
      "Archive manifest does not bind the exact workflow projection.",
    );
  }
  const expectedEventDigest = sha256Fingerprint(canonicalJson(events));
  const expectedProjectionDigest = sha256Fingerprint(canonicalJson(projection));
  const expectedEvidenceDigest = sha256Fingerprint(canonicalJson(evidence));
  if (
    manifest.eventCursor !== projection.eventCursor ||
    manifest.eventDigest !== expectedEventDigest ||
    manifest.projectionDigest !== expectedProjectionDigest ||
    manifest.evidenceDigest !== expectedEvidenceDigest
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "Archive manifest digest or event cursor does not match its contents.",
    );
  }
  const expectedAttemptIds = projection.attempts.map((attempt) => attempt.attemptId);
  const expectedCheckpointIds = projection.checkpoints.map((checkpoint) => checkpoint.checkpointId);
  const expectedEvidence = evidence.map((envelope) => ({
    evidenceId: envelope.evidenceId,
    digest: sha256Fingerprint(canonicalJson(envelope)),
  }));
  if (
    canonicalJson(manifest.attemptIds) !== canonicalJson(expectedAttemptIds) ||
    canonicalJson(manifest.checkpointIds) !== canonicalJson(expectedCheckpointIds) ||
    canonicalJson(manifest.evidence) !== canonicalJson(expectedEvidence)
  ) {
    throw new DurableStoreError(
      "IDENTITY_CONFLICT",
      "Archive manifest does not enumerate the exact workflow facts.",
    );
  }
}

function manifestFor(request: z.infer<typeof archiveFinalizeRequestSchema>): ArchiveManifest {
  const parsedEvents = request.events.map((event) => workflowEventSchema.parse(event));
  const parsedEvidence = request.evidence.map((envelope) => evidenceEnvelopeSchema.parse(envelope));
  const parsedProjection = runProjectionSchema.parse(request.projection);
  return archiveManifestSchema.parse({
    schemaVersion: "hpi-archive.v1",
    archiveId: request.archiveId,
    runId: parsedProjection.run.runId,
    changeId: parsedProjection.change.changeId,
    planRevisionId: parsedProjection.planRevision.planRevisionId,
    distributionReleaseId: request.distributionReleaseId,
    outcome: parsedProjection.run.lifecycle,
    archiveStatus: "ARCHIVED",
    archivedAt: request.archivedAt,
    sourceFingerprint: parsedProjection.run.sourceFingerprint,
    workspaceFingerprint: parsedProjection.run.workspaceFingerprint,
    eventCursor: parsedProjection.eventCursor,
    eventDigest: sha256Fingerprint(canonicalJson(parsedEvents)),
    projectionDigest: sha256Fingerprint(canonicalJson(parsedProjection)),
    evidenceDigest: sha256Fingerprint(canonicalJson(parsedEvidence)),
    attemptIds: parsedProjection.attempts.map((attempt) => attempt.attemptId),
    checkpointIds: parsedProjection.checkpoints.map((checkpoint) => checkpoint.checkpointId),
    evidence: parsedEvidence.map((envelope) => ({
      evidenceId: envelope.evidenceId,
      digest: sha256Fingerprint(canonicalJson(envelope)),
    })),
    recoveryLimits: request.recoveryLimits,
    finalizationOperationId: request.operationId,
    finalizationOperationFingerprint: request.operationFingerprint,
  });
}

function packageFor(request: z.infer<typeof archiveFinalizeRequestSchema>): ArchivePackage {
  const manifest = manifestFor(request);
  const activeAttemptIds = request.projection.attempts
    .filter((attempt) =>
      ["PENDING", "STARTING", "RUNNING", "WAITING_INPUT"].includes(attempt.executionStatus),
    )
    .map((attempt) => attempt.attemptId);
  const activeOperationReceiptIds = request.projection.checkpoints.flatMap(
    (checkpoint) => checkpoint.activeOperationReceiptIds,
  );
  const unknownOperationIds = request.projection.checkpoints.flatMap(
    (checkpoint) => checkpoint.unknownOperationIds,
  );
  const heldWriterLeaseIds = request.projection.checkpoints.flatMap(
    (checkpoint) => checkpoint.heldWriterLeaseIds,
  );
  const processReferences = request.projection.checkpoints.flatMap((checkpoint) => [
    ...checkpoint.processReferences,
    ...(checkpoint.engine.sessionReference === undefined
      ? []
      : [checkpoint.engine.sessionReference]),
  ]);
  const archive = archivePackageSchema.parse({
    schemaVersion: "hpi-archive-package.v1",
    manifest,
    projection: request.projection,
    events: request.events,
    evidence: request.evidence,
    portability: {
      activeAttemptIds,
      activeOperationReceiptIds,
      unknownOperationIds,
      heldWriterLeaseIds,
      processReferences,
      deviceLocalPaths: [],
      credentialMaterial: request.evidence.some(
        (envelope) =>
          envelope.contentClass === "CREDENTIAL_MATERIAL" &&
          envelope.capture.retentionStatus !== "DIGEST_ONLY",
      ),
    },
  });
  assertPortableArchive(archive);
  assertArchivePackage(archive);
  return archive;
}

export interface FileRunArchiveStoreOptions {
  readonly stateRoot: string;
  readonly storage?: LocalStorageController;
  readonly kernel?: WorkflowKernel;
}

export class FileRunArchiveStore implements RunArchiveStore {
  readonly #stateRoot: string;
  readonly #storage: LocalStorageController;
  readonly #kernel: WorkflowKernel | undefined;

  public constructor(options: FileRunArchiveStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#storage = options.storage ?? new LocalStorageController({ stateRoot: this.#stateRoot });
    this.#kernel = options.kernel;
  }

  public async finalize(request: ArchiveFinalizeRequest): Promise<ArchiveManifest> {
    const parsed = archiveFinalizeRequestSchema.parse(request);
    return withArchiveOperationLock(`${this.#stateRoot}:archive:${parsed.archiveId}`, () =>
      withDurableMutationLock(join(this.#stateRoot, ".mutation-lock"), () =>
        this.#finalizeParsed(parsed),
      ),
    );
  }

  async #finalizeParsed(
    parsed: z.infer<typeof archiveFinalizeRequestSchema>,
  ): Promise<ArchiveManifest> {
    await assertSafeDirectoryPath(this.#stateRoot);
    assertArchiveProjection(
      parsed.projection,
      parsed.events,
      parsed.evidence,
      parsed.distributionReleaseId,
    );
    const archive = packageFor(parsed);
    const existing = await this.#readPackageOptional(parsed.archiveId);
    if (this.#kernel === undefined) {
      throw new DurableStoreError(
        "INVALID_TARGET",
        "Archive finalization requires a canonical Workflow Kernel binding.",
      );
    }
    const canonical = await this.#kernel.project(parsed.projection.run.runId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(archive)) {
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "Archive identity is already bound to different facts.",
        );
      }
      if (
        canonical.run.archiveStatus === "ARCHIVED" &&
        canonical.run.archiveId === parsed.archiveId
      ) {
        return existing.manifest;
      }
    }
    if (
      canonical.run.archiveStatus !== "UNARCHIVED" ||
      canonicalJson(canonical) !== canonicalJson(parsed.projection)
    ) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "Archive finalization does not bind the current canonical Run projection.",
      );
    }
    if (existing === undefined) await this.#writePackage(archive);
    await this.#kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "ARCHIVE_RUN",
      runId: parsed.projection.run.runId,
      archiveId: parsed.archiveId,
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      archivedAt: parsed.archivedAt,
    });
    const archivedProjection = await this.#kernel.project(parsed.projection.run.runId);
    if (
      archivedProjection.run.archiveStatus !== "ARCHIVED" ||
      archivedProjection.run.archiveId !== parsed.archiveId
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "Canonical Workflow Kernel did not persist the Archive identity.",
      );
    }
    return archive.manifest;
  }

  public async read(archiveId: string): Promise<ArchiveManifest> {
    await assertSafeDirectoryPath(this.#stateRoot);
    const package_ = await this.#readPackageOptional(archiveId);
    if (package_ === undefined) {
      throw new DurableStoreError("NOT_FOUND", "The requested Archive identity was not found.");
    }
    await this.#assertCanonicalArchive(package_);
    return package_.manifest;
  }

  public async export(request: ArchiveExportRequest): Promise<ArchiveExportReceipt> {
    const parsed = archiveExportRequestSchema.parse(request);
    return withArchiveOperationLock(`${this.#stateRoot}:export:${parsed.targetReference}`, () =>
      withDurableMutationLock(join(this.#stateRoot, ".mutation-lock"), () =>
        this.#exportParsed(parsed),
      ),
    );
  }

  async #exportParsed(
    parsed: z.infer<typeof archiveExportRequestSchema>,
  ): Promise<ArchiveExportReceipt> {
    await assertSafeDirectoryPath(this.#stateRoot);
    const archive = await this.#readPackage(parsed.archiveId);
    assertPortableArchive(archive);
    assertArchivePackage(archive);
    await this.#assertCanonicalArchive(archive);
    const artifact: ArchiveExportArtifact = {
      schemaVersion: "hpi-archive-export-artifact.v1",
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      archive,
    };
    const artifactFingerprint = sha256Fingerprint(canonicalJson(artifact));
    const priorDeleteReceipt = await this.#readDeleteReceiptOptional(parsed.targetReference);
    const priorDeletePending = await this.#readDeletePendingOptional(parsed.targetReference);
    if (priorDeleteReceipt !== undefined || priorDeletePending !== undefined) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "An Archive export target is already bound to a delete operation.",
      );
    }
    const targetPath = this.#exportPath(parsed.targetReference);
    const existing = await this.#readExportOptional(targetPath);
    if (existing !== undefined) {
      if (
        existing.operationId !== parsed.operationId ||
        existing.operationFingerprint !== parsed.operationFingerprint ||
        canonicalJson(existing.archive) !== canonicalJson(archive)
      ) {
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "Export target is already bound to another operation.",
        );
      }
      return archiveExportReceiptSchema.parse({
        schemaVersion: "hpi-archive-export-receipt.v1",
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        archiveId: parsed.archiveId,
        targetReference: parsed.targetReference,
        artifactFingerprint,
        outcome: "NOOP",
        observedAt: new Date().toISOString(),
      });
    }
    await this.#storage.writeCritical(() =>
      writeImmutableAtomically({
        directory: join(this.#stateRoot, "exports"),
        filename: `${parsed.targetReference}.json`,
        content: `${canonicalJson(artifact)}\n`,
      }),
    );
    return archiveExportReceiptSchema.parse({
      schemaVersion: "hpi-archive-export-receipt.v1",
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      archiveId: parsed.archiveId,
      targetReference: parsed.targetReference,
      artifactFingerprint,
      outcome: "APPLIED",
      observedAt: new Date().toISOString(),
    });
  }

  public async import(request: ArchiveImportRequest): Promise<ArchiveImportReceipt> {
    const parsed = archiveImportRequestSchema.parse(request);
    return withArchiveOperationLock(
      `${this.#stateRoot}:archive:${parsed.archive.manifest.archiveId}`,
      () =>
        withDurableMutationLock(join(this.#stateRoot, ".mutation-lock"), () =>
          this.#importParsed(parsed),
        ),
    );
  }

  async #importParsed(
    parsed: z.infer<typeof archiveImportRequestSchema>,
  ): Promise<ArchiveImportReceipt> {
    await assertSafeDirectoryPath(this.#stateRoot);
    assertPortableArchive(parsed.archive);
    assertArchivePackage(parsed.archive);
    const artifactFingerprint = archivePackageFingerprint(parsed.archive);
    const archiveId = parsed.archive.manifest.archiveId;
    const priorReceipt = await this.#readImportReceiptOptional(archiveId);
    if (priorReceipt !== undefined) {
      assertOperationIdentity(priorReceipt, parsed);
      if (priorReceipt.artifactFingerprint !== artifactFingerprint) {
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "The imported Archive identity is already bound to different facts.",
        );
      }
      const existing = await this.#readPackageOptional(archiveId);
      if (existing === undefined) await this.#writePackage(parsed.archive);
      else if (canonicalJson(existing) !== canonicalJson(parsed.archive)) {
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "Imported Archive identity is already bound to other facts.",
        );
      }
      return existing === undefined || priorReceipt.outcome === "NOOP"
        ? priorReceipt
        : archiveImportReceiptSchema.parse({ ...priorReceipt, outcome: "NOOP" });
    }
    const existing = await this.#readPackageOptional(archiveId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(parsed.archive)) {
        throw new DurableStoreError(
          "IDENTITY_CONFLICT",
          "Imported Archive identity is already bound to other facts.",
        );
      }
      const receipt = archiveImportReceiptSchema.parse({
        schemaVersion: "hpi-archive-import-receipt.v1",
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        archiveId: parsed.archive.manifest.archiveId,
        artifactFingerprint,
        outcome: "NOOP",
        observedAt: new Date().toISOString(),
      });
      await this.#writeImportReceipt(receipt);
      return receipt;
    }
    const receipt = archiveImportReceiptSchema.parse({
      schemaVersion: "hpi-archive-import-receipt.v1",
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      archiveId: parsed.archive.manifest.archiveId,
      artifactFingerprint,
      outcome: "APPLIED",
      observedAt: new Date().toISOString(),
    });
    await this.#writeImportReceipt(receipt);
    await this.#writePackage(parsed.archive);
    return receipt;
  }

  public async deleteExport(
    request: ArchiveDeleteExportRequest,
  ): Promise<ArchiveDeleteExportReceipt> {
    const parsed = archiveDeleteExportRequestSchema.parse(request);
    return withDurableMutationLock(join(this.#stateRoot, ".mutation-lock"), () =>
      this.#deleteExportParsed(parsed),
    );
  }

  async #deleteExportParsed(
    parsed: z.infer<typeof archiveDeleteExportRequestSchema>,
  ): Promise<ArchiveDeleteExportReceipt> {
    await assertSafeDirectoryPath(this.#stateRoot);
    await assertSafeDirectoryPath(join(this.#stateRoot, "exports"));
    const targetPath = this.#exportPath(parsed.targetReference);
    const priorReceipt = await this.#readDeleteReceiptOptional(parsed.targetReference);
    if (priorReceipt !== undefined) {
      assertOperationIdentity(priorReceipt, parsed);
      return priorReceipt.outcome === "APPLIED"
        ? archiveDeleteExportReceiptSchema.parse({ ...priorReceipt, outcome: "NOOP" })
        : priorReceipt;
    }
    const pending = await this.#readDeletePendingOptional(parsed.targetReference);
    if (pending !== undefined) assertOperationIdentity(pending, parsed);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(targetPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        const receipt = archiveDeleteExportReceiptSchema.parse({
          schemaVersion: "hpi-archive-delete-export-receipt.v2",
          operationId: parsed.operationId,
          operationFingerprint: parsed.operationFingerprint,
          targetReference: parsed.targetReference,
          archiveId: pending?.archiveId ?? null,
          artifactFingerprint: pending?.artifactFingerprint ?? null,
          outcome: "NOOP",
          observedAt: new Date().toISOString(),
        });
        await this.#writeDeleteReceipt(receipt);
        return receipt;
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      const receipt = archiveDeleteExportReceiptSchema.parse({
        schemaVersion: "hpi-archive-delete-export-receipt.v2",
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        targetReference: parsed.targetReference,
        archiveId: null,
        artifactFingerprint: null,
        outcome: "BLOCKED",
        observedAt: new Date().toISOString(),
      });
      await this.#writeDeleteReceipt(receipt);
      return receipt;
    }
    const exportsRoot = await realpath(join(this.#stateRoot, "exports"));
    const targetParent = await realpath(join(targetPath, ".."));
    if (exportsRoot !== targetParent) {
      throw new DurableStoreError(
        "INVALID_TARGET",
        "Export deletion target escaped its exact root.",
      );
    }
    const exported = await this.#readExportOptional(targetPath);
    if (exported === undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "The export target disappeared before its exact envelope could be validated.",
      );
    }
    const artifactFingerprint = sha256Fingerprint(canonicalJson(exported));
    const archiveId = exported.archive.manifest.archiveId;
    if (
      pending !== undefined &&
      (pending.artifactFingerprint !== artifactFingerprint || pending.archiveId !== archiveId)
    ) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The pending delete operation is bound to a different export artifact.",
      );
    }
    if (pending === undefined) {
      await this.#writeDeletePending({
        schemaVersion: "hpi-archive-delete-pending.v1",
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        targetReference: parsed.targetReference,
        archiveId,
        artifactFingerprint,
      });
    }
    await rm(targetPath, { force: false });
    const receipt = archiveDeleteExportReceiptSchema.parse({
      schemaVersion: "hpi-archive-delete-export-receipt.v2",
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      targetReference: parsed.targetReference,
      archiveId,
      artifactFingerprint,
      outcome: "APPLIED",
      observedAt: new Date().toISOString(),
    });
    await this.#writeDeleteReceipt(receipt);
    return receipt;
  }

  async #writePackage(archive: ArchivePackage): Promise<void> {
    const parsed = archivePackageSchema.parse(archive);
    await this.#storage.writeCritical(() =>
      writeImmutableAtomically({
        directory: archiveDirectory(this.#stateRoot, parsed.manifest.archiveId),
        filename: archivePackageFilename(),
        content: `${canonicalJson(parsed)}\n`,
      }),
    );
  }

  async #readPackage(archiveId: string): Promise<ArchivePackage> {
    const parsedArchiveId = archiveIdSchema.parse(archiveId);
    const package_ = await this.#readPackageOptional(parsedArchiveId);
    if (package_ === undefined) {
      throw new DurableStoreError("NOT_FOUND", "The requested Archive identity was not found.");
    }
    return package_;
  }

  async #assertCanonicalArchive(archive: ArchivePackage): Promise<void> {
    if (this.#kernel === undefined) {
      throw new DurableStoreError(
        "INVALID_TARGET",
        "Archive read/export requires a canonical Workflow Kernel binding.",
      );
    }
    const canonical = await this.#kernel.project(archive.manifest.runId);
    if (
      canonical.run.archiveStatus !== "ARCHIVED" ||
      canonical.run.archiveId !== archive.manifest.archiveId
    ) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "Archive is not bound to an archived canonical Run identity.",
      );
    }
    const expectedArchivedProjection = runProjectionSchema.parse({
      ...archive.projection,
      eventCursor: archive.projection.eventCursor + 1,
      run: {
        ...archive.projection.run,
        archiveStatus: "ARCHIVED",
        archiveId: archive.manifest.archiveId,
      },
    });
    if (canonicalJson(canonical) !== canonicalJson(expectedArchivedProjection)) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "Archive projection does not match the canonical Workflow Kernel projection.",
      );
    }
  }

  async #readPackageOptional(archiveId: string): Promise<ArchivePackage | undefined> {
    const parsedArchiveId = archiveIdSchema.parse(archiveId);
    const directory = archiveDirectory(this.#stateRoot, parsedArchiveId);
    try {
      await assertSafeDirectoryPath(join(this.#stateRoot, "archives"));
      await assertSafeDirectoryPath(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      const committed = entries.filter((entry) => !entry.name.startsWith(".pending-"));
      if (committed.some((entry) => !entry.isFile() || entry.name !== archivePackageFilename())) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "Archive directory contains an unexpected entry.",
        );
      }
      if (committed.length === 0) return undefined;
      const archive = archivePackageSchema.parse(
        parseJson(await readFile(join(directory, archivePackageFilename()), "utf8")),
      );
      assertPortableArchive(archive);
      assertArchivePackage(archive);
      return archive;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  #exportPath(targetReference: string): string {
    const target = targetReferenceSchema.parse(targetReference);
    return join(this.#stateRoot, "exports", `${target}.json`);
  }

  async #readExportOptional(path: string): Promise<ArchiveExportArtifact | undefined> {
    try {
      await assertSafeDirectoryPath(join(this.#stateRoot, "exports"));
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "Archive export target must be an exact regular file.",
        );
      }
      return archiveExportArtifactSchema.parse(parseJson(await readFile(path, "utf8")));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  async #readImportReceiptOptional(archiveId: string) {
    const receipt = await readImmutableJsonOptional(
      operationReceiptPath(this.#stateRoot, "imports", archiveId),
      archiveImportReceiptSchema,
    );
    if (receipt !== undefined && receipt.archiveId !== archiveId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "An import receipt is bound to a different Archive identity than its path.",
      );
    }
    return receipt;
  }

  async #writeImportReceipt(receipt: ArchiveImportReceipt): Promise<void> {
    await this.#storage.writeCritical(() =>
      writeImmutableAtomically({
        directory: dirname(operationReceiptPath(this.#stateRoot, "imports", receipt.archiveId)),
        filename: `${receipt.archiveId}.json`,
        content: `${canonicalJson(receipt)}\n`,
      }),
    );
  }

  async #readDeleteReceiptOptional(targetReference: string) {
    const receipt = await readImmutableJsonOptional(
      operationReceiptPath(this.#stateRoot, "deletes", targetReference),
      archiveDeleteExportReceiptSchema,
    );
    if (receipt !== undefined && receipt.targetReference !== targetReference) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "A delete receipt is bound to a different target than its path.",
      );
    }
    return receipt;
  }

  async #writeDeleteReceipt(receipt: ArchiveDeleteExportReceipt): Promise<void> {
    await this.#storage.writeCritical(() =>
      writeImmutableAtomically({
        directory: dirname(
          operationReceiptPath(this.#stateRoot, "deletes", receipt.targetReference),
        ),
        filename: `${receipt.targetReference}.json`,
        content: `${canonicalJson(receipt)}\n`,
      }),
    );
  }

  async #readDeletePendingOptional(targetReference: string) {
    const pending = await readImmutableJsonOptional(
      operationPendingPath(this.#stateRoot, targetReference),
      archiveDeletePendingSchema,
    );
    if (pending !== undefined && pending.targetReference !== targetReference) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "A pending delete intent is bound to a different target than its path.",
      );
    }
    return pending;
  }

  async #writeDeletePending(pending: z.infer<typeof archiveDeletePendingSchema>): Promise<void> {
    await this.#storage.writeCritical(() =>
      writeImmutableAtomically({
        directory: dirname(operationPendingPath(this.#stateRoot, pending.targetReference)),
        filename: `${pending.targetReference}.pending.json`,
        content: `${canonicalJson(pending)}\n`,
      }),
    );
  }
}
