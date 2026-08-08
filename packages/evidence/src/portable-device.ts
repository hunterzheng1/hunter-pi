import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  archiveIdSchema,
  fingerprintSchema,
  operationIdSchema,
  planRevisionIdSchema,
  runIdSchema,
  timestampSchema,
} from "@hunter-pi/domain";

import {
  archivePackageFingerprint,
  archivePackageSchema,
  assertArchivePackage,
  assertPortableArchive,
  type ArchiveImportReceipt,
  type ImportedArchiveProjection,
  type RunArchiveStore,
} from "./archive.js";
import {
  assertSafeDirectoryPath,
  withDurableMutationLock,
  writeImmutableAtomically,
} from "./atomic-write.js";
import { DurableStoreError, isErrnoException, storeErrorFrom } from "./errors.js";
import { canonicalJson, sha256Fingerprint } from "./serialization.js";
import { LocalStorageController } from "./storage-policy.js";

const profileIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "device profile must be a stable identifier");
const readinessSchema = z.enum(["PASS", "BLOCKED", "NOT_PROVEN"]);
const policyResolutionSchema = z.enum([
  "CLONED",
  "RECONCILED_EXACT",
  "RECONCILED_CONFLICT",
  "RECONCILIATION_NOT_PROVEN",
]);
const archivedRunOutcomeSchema = z.enum(["READY", "BLOCKED", "FAILED", "CANCELLED", "INCOMPLETE"]);

export const portableDeviceImportRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  profileId: profileIdSchema,
  projectPolicy: z.strictObject({
    schemaVersion: z.literal("hpi-project-policy.v1"),
    policyFingerprint: fingerprintSchema,
  }),
  archive: archivePackageSchema,
  observedAt: timestampSchema,
});
export type PortableDeviceImportRequest = z.input<typeof portableDeviceImportRequestSchema>;

export const portableDeviceImportBindingSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import-binding.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  profileId: profileIdSchema,
  projectPolicyFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  artifactFingerprint: fingerprintSchema,
  runId: runIdSchema,
  planRevisionId: planRevisionIdSchema,
  sourceFingerprint: fingerprintSchema,
  archivedRunOutcome: archivedRunOutcomeSchema,
});
export type PortableDeviceImportBinding = z.infer<typeof portableDeviceImportBindingSchema>;

const portableDeviceImportIntentFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import-intent.v1"),
  binding: portableDeviceImportBindingSchema,
});

function portableDeviceImportIntentFingerprint(
  value: z.infer<typeof portableDeviceImportIntentFactsSchema>,
) {
  return sha256Fingerprint(
    canonicalJson(
      portableDeviceImportIntentFactsSchema.parse({
        schemaVersion: value.schemaVersion,
        binding: value.binding,
      }),
    ),
  );
}

const portableDeviceImportIntentSchema = z
  .strictObject({
    ...portableDeviceImportIntentFactsSchema.shape,
    intentFingerprint: fingerprintSchema,
  })
  .superRefine((intent, context) => {
    if (intent.intentFingerprint !== portableDeviceImportIntentFingerprint(intent)) {
      context.addIssue({
        code: "custom",
        path: ["intentFingerprint"],
        message: "Device import intent fingerprint does not match its immutable binding",
      });
    }
  });
type PortableDeviceImportIntent = z.infer<typeof portableDeviceImportIntentSchema>;

const portableDeviceImportReceiptFactsSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import-receipt.v3"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  profileId: profileIdSchema,
  projectPolicyFingerprint: fingerprintSchema,
  archiveId: archiveIdSchema,
  artifactFingerprint: fingerprintSchema,
  runId: runIdSchema,
  planRevisionId: planRevisionIdSchema,
  sourceFingerprint: fingerprintSchema,
  archivedRunOutcome: archivedRunOutcomeSchema,
  readOnlyProjectionFingerprint: fingerprintSchema,
  recordedArchiveOutcome: z.enum(["APPLIED", "NOOP"]),
  policyOutcome: readinessSchema,
  policyResolution: policyResolutionSchema,
  policyResolutionFingerprint: fingerprintSchema,
  doctorStatus: readinessSchema,
  loginReadiness: readinessSchema,
  outcome: z.enum(["READY", "BLOCKED", "NOT_PROVEN"]),
  observedAt: timestampSchema,
});

function portableDeviceReceiptFingerprint(
  value: z.infer<typeof portableDeviceImportReceiptFactsSchema>,
) {
  return sha256Fingerprint(
    canonicalJson(
      portableDeviceImportReceiptFactsSchema.parse({
        schemaVersion: value.schemaVersion,
        operationId: value.operationId,
        operationFingerprint: value.operationFingerprint,
        profileId: value.profileId,
        projectPolicyFingerprint: value.projectPolicyFingerprint,
        archiveId: value.archiveId,
        artifactFingerprint: value.artifactFingerprint,
        runId: value.runId,
        planRevisionId: value.planRevisionId,
        sourceFingerprint: value.sourceFingerprint,
        archivedRunOutcome: value.archivedRunOutcome,
        readOnlyProjectionFingerprint: value.readOnlyProjectionFingerprint,
        recordedArchiveOutcome: value.recordedArchiveOutcome,
        policyOutcome: value.policyOutcome,
        policyResolution: value.policyResolution,
        policyResolutionFingerprint: value.policyResolutionFingerprint,
        doctorStatus: value.doctorStatus,
        loginReadiness: value.loginReadiness,
        outcome: value.outcome,
        observedAt: value.observedAt,
      }),
    ),
  );
}

export const portableDeviceImportReceiptSchema = z
  .strictObject({
    ...portableDeviceImportReceiptFactsSchema.shape,
    archiveOutcome: z.enum(["APPLIED", "NOOP"]),
    receiptFingerprint: fingerprintSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.receiptFingerprint !== portableDeviceReceiptFingerprint(receipt)) {
      context.addIssue({
        code: "custom",
        path: ["receiptFingerprint"],
        message: "Device import receipt fingerprint does not match its immutable facts",
      });
    }
  });
export type PortableDeviceImportReceipt = z.infer<typeof portableDeviceImportReceiptSchema>;

const rollbackFunctionSchema = z.custom<() => Promise<void>>(
  (value) => typeof value === "function",
  "policy clone rollback must be a function",
);

export const projectPolicyCloneResultSchema = z.strictObject({
  status: readinessSchema,
  policyFingerprint: fingerprintSchema,
  rollback: rollbackFunctionSchema.optional(),
});
export type ProjectPolicyCloneResult = z.infer<typeof projectPolicyCloneResultSchema>;

export const projectPolicyReconciliationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ABSENT"), policyFingerprint: z.null() }),
  z.strictObject({ status: z.literal("EXACT"), policyFingerprint: fingerprintSchema }),
  z.strictObject({ status: z.literal("CONFLICT"), policyFingerprint: fingerprintSchema }),
  z.strictObject({ status: z.literal("NOT_PROVEN"), policyFingerprint: z.null() }),
]);
export type ProjectPolicyReconciliationResult = z.infer<
  typeof projectPolicyReconciliationResultSchema
>;

export interface ProjectPolicyCloner {
  reconcile(input: {
    readonly profileId: string;
    readonly policyFingerprint: string;
  }): Promise<ProjectPolicyReconciliationResult>;
  clone(input: {
    readonly profileId: string;
    readonly policyFingerprint: string;
  }): Promise<ProjectPolicyCloneResult>;
}

export interface DeviceDoctor {
  run(input: { readonly profileId: string }): Promise<z.infer<typeof readinessSchema>>;
}

export interface DeviceLoginReadiness {
  check(input: { readonly profileId: string }): Promise<z.infer<typeof readinessSchema>>;
}

export interface PortableDeviceImportReceiptResolution {
  readonly receipt: PortableDeviceImportReceipt;
  readonly replayed: boolean;
}

export interface PortableDeviceImportReceiptStore {
  recordOnce(
    binding: PortableDeviceImportBinding,
    createReceipt: () => Promise<PortableDeviceImportReceipt>,
  ): Promise<PortableDeviceImportReceiptResolution>;
}

export interface FilePortableDeviceImportReceiptStoreOptions {
  readonly stateRoot: string;
  readonly storage?: LocalStorageController;
}

function receiptDirectory(stateRoot: string): string {
  return join(stateRoot, ".operation-receipts", "device-imports");
}

function intentDirectory(stateRoot: string): string {
  return join(stateRoot, ".operation-receipts", "device-import-intents");
}

const atomicWritePendingNamePattern =
  /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function reconcileAtomicWriteRemnants<Output>(
  directory: string,
  schema: z.ZodType<Output>,
  finalFilename: (value: Output) => string,
): Promise<void> {
  let entries: Dirent[];
  try {
    await assertSafeDirectoryPath(directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(".pending-")) continue;
    if (!atomicWritePendingNamePattern.test(entry.name)) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "A device import directory contains an invalid atomic-write remnant.",
      );
    }
    const pendingPath = join(directory, entry.name);
    const pendingStats = await lstat(pendingPath, { bigint: true });
    if (
      !pendingStats.isFile() ||
      pendingStats.isSymbolicLink() ||
      pendingStats.ino === 0n ||
      (pendingStats.nlink !== 1n && pendingStats.nlink !== 2n)
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "A device import atomic-write remnant is not an exact private staging file.",
      );
    }
    if (pendingStats.nlink === 2n) {
      const value = schema.parse(JSON.parse(await readFile(pendingPath, "utf8")) as unknown);
      const finalPath = join(directory, finalFilename(value));
      const finalStats = await lstat(finalPath, { bigint: true });
      if (
        !finalStats.isFile() ||
        finalStats.isSymbolicLink() ||
        finalStats.nlink !== 2n ||
        finalStats.dev !== pendingStats.dev ||
        finalStats.ino !== pendingStats.ino
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "A published device import remnant is not bound to its exact final receipt.",
        );
      }
    }
    await unlink(pendingPath);
  }
}

function createImportIntent(binding: PortableDeviceImportBinding): PortableDeviceImportIntent {
  const facts = portableDeviceImportIntentFactsSchema.parse({
    schemaVersion: "hpi-device-import-intent.v1",
    binding,
  });
  return portableDeviceImportIntentSchema.parse({
    ...facts,
    intentFingerprint: portableDeviceImportIntentFingerprint(facts),
  });
}

function bindingFromReceipt(receipt: PortableDeviceImportReceipt): PortableDeviceImportBinding {
  return portableDeviceImportBindingSchema.parse({
    schemaVersion: "hpi-device-import-binding.v1",
    operationId: receipt.operationId,
    operationFingerprint: receipt.operationFingerprint,
    profileId: receipt.profileId,
    projectPolicyFingerprint: receipt.projectPolicyFingerprint,
    archiveId: receipt.archiveId,
    artifactFingerprint: receipt.artifactFingerprint,
    runId: receipt.runId,
    planRevisionId: receipt.planRevisionId,
    sourceFingerprint: receipt.sourceFingerprint,
    archivedRunOutcome: receipt.archivedRunOutcome,
  });
}

function assertBindingIdentity(
  receipt: PortableDeviceImportReceipt,
  requested: PortableDeviceImportBinding,
): void {
  if (canonicalJson(bindingFromReceipt(receipt)) !== canonicalJson(requested)) {
    throw new DurableStoreError(
      "IDENTITY_CONFLICT",
      "The device import operation or profile is already bound to different immutable facts.",
    );
  }
}

export class FilePortableDeviceImportReceiptStore implements PortableDeviceImportReceiptStore {
  readonly #stateRoot: string;
  readonly #storage: LocalStorageController;

  public constructor(options: FilePortableDeviceImportReceiptStoreOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#storage = options.storage ?? new LocalStorageController({ stateRoot: this.#stateRoot });
  }

  public async recordOnce(
    binding: PortableDeviceImportBinding,
    createReceipt: () => Promise<PortableDeviceImportReceipt>,
  ): Promise<PortableDeviceImportReceiptResolution> {
    const parsed = portableDeviceImportBindingSchema.parse(binding);
    return withDurableMutationLock(
      join(this.#stateRoot, ".operation-receipts", ".device-import-lock"),
      async () => {
        const [receipts, intents] = await Promise.all([this.#readReceipts(), this.#readIntents()]);
        const persistCreatedReceipt = async (): Promise<PortableDeviceImportReceiptResolution> => {
          const receipt = portableDeviceImportReceiptSchema.parse(await createReceipt());
          assertBindingIdentity(receipt, parsed);
          if (receipt.archiveOutcome !== receipt.recordedArchiveOutcome) {
            throw new DurableStoreError(
              "STORE_CORRUPT",
              "Only the immutable first device import outcome can be persisted.",
            );
          }
          await this.#storage.writeCritical(() =>
            writeImmutableAtomically({
              directory: receiptDirectory(this.#stateRoot),
              filename: `${receipt.profileId}.json`,
              content: `${canonicalJson(receipt)}\n`,
            }),
          );
          return { receipt, replayed: false };
        };
        const byOperation = receipts.find((receipt) => receipt.operationId === parsed.operationId);
        const byProfile = receipts.find((receipt) => receipt.profileId === parsed.profileId);
        const intentByOperation = intents.find(
          (intent) => intent.binding.operationId === parsed.operationId,
        );
        const intentByProfile = intents.find(
          (intent) => intent.binding.profileId === parsed.profileId,
        );
        if (byOperation !== undefined || byProfile !== undefined) {
          if (
            byOperation !== undefined &&
            byProfile !== undefined &&
            canonicalJson(byOperation) !== canonicalJson(byProfile)
          ) {
            throw new DurableStoreError(
              "IDENTITY_CONFLICT",
              "The device operation and profile resolve to different immutable receipts.",
            );
          }
          const receipt = byOperation ?? byProfile;
          if (receipt === undefined) {
            throw new DurableStoreError("STORE_CORRUPT", "The device receipt lookup was empty.");
          }
          assertBindingIdentity(receipt, parsed);
          const intent = intentByOperation ?? intentByProfile;
          if (
            intent === undefined ||
            canonicalJson(intent.binding) !== canonicalJson(parsed) ||
            (intentByOperation !== undefined &&
              intentByProfile !== undefined &&
              canonicalJson(intentByOperation) !== canonicalJson(intentByProfile))
          ) {
            throw new DurableStoreError(
              "STORE_CORRUPT",
              "A final device import receipt is missing its exact immutable operation intent.",
            );
          }
          return { receipt, replayed: true };
        }
        if (intentByOperation !== undefined || intentByProfile !== undefined) {
          const intent = intentByOperation ?? intentByProfile;
          if (
            intent === undefined ||
            canonicalJson(intent.binding) !== canonicalJson(parsed) ||
            (intentByOperation !== undefined &&
              intentByProfile !== undefined &&
              canonicalJson(intentByOperation) !== canonicalJson(intentByProfile))
          ) {
            throw new DurableStoreError(
              "IDENTITY_CONFLICT",
              "The device import operation or profile has a conflicting immutable intent.",
            );
          }
          return persistCreatedReceipt();
        }
        const intent = createImportIntent(parsed);
        await this.#storage.writeCritical(() =>
          writeImmutableAtomically({
            directory: intentDirectory(this.#stateRoot),
            filename: `${parsed.profileId}.json`,
            content: `${canonicalJson(intent)}\n`,
          }),
        );
        return persistCreatedReceipt();
      },
    );
  }

  async #readReceipts(): Promise<PortableDeviceImportReceipt[]> {
    const directory = receiptDirectory(this.#stateRoot);
    try {
      await assertSafeDirectoryPath(directory);
      await reconcileAtomicWriteRemnants(
        directory,
        portableDeviceImportReceiptSchema,
        (receipt) => `${receipt.profileId}.json`,
      );
      const entries = await readdir(directory, { withFileTypes: true });
      const receipts: PortableDeviceImportReceipt[] = [];
      const operationIds = new Set<string>();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "The device import receipt directory contains an unexpected entry.",
          );
        }
        const path = join(directory, entry.name);
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "A device import receipt must be an exact regular file.",
          );
        }
        const receipt = portableDeviceImportReceiptSchema.parse(
          JSON.parse(await readFile(path, "utf8")) as unknown,
        );
        if (
          entry.name !== `${receipt.profileId}.json` ||
          receipt.archiveOutcome !== receipt.recordedArchiveOutcome ||
          operationIds.has(receipt.operationId)
        ) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "A persisted device import receipt has conflicting identity or replay state.",
          );
        }
        operationIds.add(receipt.operationId);
        receipts.push(receipt);
      }
      return receipts;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return [];
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "A persisted device import receipt is corrupt or has an invalid fingerprint.",
          error,
        );
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }

  async #readIntents(): Promise<PortableDeviceImportIntent[]> {
    const directory = intentDirectory(this.#stateRoot);
    try {
      await assertSafeDirectoryPath(directory);
      await reconcileAtomicWriteRemnants(
        directory,
        portableDeviceImportIntentSchema,
        (intent) => `${intent.binding.profileId}.json`,
      );
      const entries = await readdir(directory, { withFileTypes: true });
      const intents: PortableDeviceImportIntent[] = [];
      const operationIds = new Set<string>();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "The device import intent directory contains an unexpected entry.",
          );
        }
        const path = join(directory, entry.name);
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "A device import intent must be an exact regular file.",
          );
        }
        const intent = portableDeviceImportIntentSchema.parse(
          JSON.parse(await readFile(path, "utf8")) as unknown,
        );
        if (
          entry.name !== `${intent.binding.profileId}.json` ||
          operationIds.has(intent.binding.operationId)
        ) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "A persisted device import intent has conflicting operation or profile identity.",
          );
        }
        operationIds.add(intent.binding.operationId);
        intents.push(intent);
      }
      return intents;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return [];
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "A persisted device import intent is corrupt or has an invalid fingerprint.",
          error,
        );
      }
      throw storeErrorFrom(error, "STORE_CORRUPT");
    }
  }
}

export interface PortableDeviceImporterOptions {
  readonly archiveStore: RunArchiveStore;
  readonly receiptStore: PortableDeviceImportReceiptStore;
  readonly clonePolicy: ProjectPolicyCloner;
  readonly doctor: DeviceDoctor;
  readonly loginReadiness: DeviceLoginReadiness;
}

function overallOutcome(
  policyOutcome: z.infer<typeof readinessSchema>,
  doctorStatus: z.infer<typeof readinessSchema>,
  loginReadiness: z.infer<typeof readinessSchema>,
): "READY" | "BLOCKED" | "NOT_PROVEN" {
  const statuses = [policyOutcome, doctorStatus, loginReadiness];
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("NOT_PROVEN")) return "NOT_PROVEN";
  return "READY";
}

function requestBinding(
  request: z.infer<typeof portableDeviceImportRequestSchema>,
): PortableDeviceImportBinding {
  return portableDeviceImportBindingSchema.parse({
    schemaVersion: "hpi-device-import-binding.v1",
    operationId: request.operationId,
    operationFingerprint: request.operationFingerprint,
    profileId: request.profileId,
    projectPolicyFingerprint: request.projectPolicy.policyFingerprint,
    archiveId: request.archive.manifest.archiveId,
    artifactFingerprint: archivePackageFingerprint(request.archive),
    runId: request.archive.manifest.runId,
    planRevisionId: request.archive.manifest.planRevisionId,
    sourceFingerprint: request.archive.manifest.sourceFingerprint,
    archivedRunOutcome: request.archive.manifest.outcome,
  });
}

export class PortableDeviceImporter {
  readonly #archiveStore: RunArchiveStore;
  readonly #receiptStore: PortableDeviceImportReceiptStore;
  readonly #clonePolicy: ProjectPolicyCloner;
  readonly #doctor: DeviceDoctor;
  readonly #loginReadiness: DeviceLoginReadiness;

  public constructor(options: PortableDeviceImporterOptions) {
    this.#archiveStore = options.archiveStore;
    this.#receiptStore = options.receiptStore;
    this.#clonePolicy = options.clonePolicy;
    this.#doctor = options.doctor;
    this.#loginReadiness = options.loginReadiness;
  }

  public async import(request: PortableDeviceImportRequest): Promise<PortableDeviceImportReceipt> {
    const parsed = portableDeviceImportRequestSchema.parse(request);
    assertPortableArchive(parsed.archive);
    assertArchivePackage(parsed.archive);
    const binding = requestBinding(parsed);
    const resolved = await this.#receiptStore.recordOnce(binding, () =>
      this.#applyImport(parsed, binding),
    );
    const projection = await this.#projectImported(binding);
    if (projection.projectionFingerprint !== resolved.receipt.readOnlyProjectionFingerprint) {
      throw new DurableStoreError(
        "IDENTITY_CONFLICT",
        "The persisted device receipt is bound to a different read-only projection.",
      );
    }
    return resolved.replayed
      ? portableDeviceImportReceiptSchema.parse({
          ...resolved.receipt,
          archiveOutcome: "NOOP",
        })
      : resolved.receipt;
  }

  async #applyImport(
    request: z.infer<typeof portableDeviceImportRequestSchema>,
    binding: PortableDeviceImportBinding,
  ): Promise<PortableDeviceImportReceipt> {
    const archiveReceipt = await this.#importArchive(request);
    const projection = await this.#projectImported(binding);
    let reconciliation: ProjectPolicyReconciliationResult;
    try {
      reconciliation = projectPolicyReconciliationResultSchema.parse(
        await this.#clonePolicy.reconcile({
          profileId: request.profileId,
          policyFingerprint: request.projectPolicy.policyFingerprint,
        }),
      );
    } catch (error) {
      throw new Error(
        "device policy reconciliation must prove absent, exact, conflicting, or not-proven state",
        { cause: error },
      );
    }
    let policyOutcome: z.infer<typeof readinessSchema>;
    let policyResolution: z.infer<typeof policyResolutionSchema>;
    let policyResolutionFingerprint: string;
    let rollbackPolicy: (() => Promise<void>) | undefined;
    if (reconciliation.status === "EXACT") {
      if (reconciliation.policyFingerprint !== request.projectPolicy.policyFingerprint) {
        throw new Error("device policy reconciliation did not bind the requested fingerprint");
      }
      policyOutcome = "PASS";
      policyResolution = "RECONCILED_EXACT";
      policyResolutionFingerprint = sha256Fingerprint(canonicalJson(reconciliation));
    } else if (reconciliation.status === "CONFLICT") {
      if (reconciliation.policyFingerprint === request.projectPolicy.policyFingerprint) {
        throw new Error("device policy reconciliation reported a contradictory conflict");
      }
      policyOutcome = "BLOCKED";
      policyResolution = "RECONCILED_CONFLICT";
      policyResolutionFingerprint = sha256Fingerprint(canonicalJson(reconciliation));
    } else if (reconciliation.status === "NOT_PROVEN") {
      policyOutcome = "NOT_PROVEN";
      policyResolution = "RECONCILIATION_NOT_PROVEN";
      policyResolutionFingerprint = sha256Fingerprint(canonicalJson(reconciliation));
    } else {
      let cloneResult: ProjectPolicyCloneResult;
      try {
        cloneResult = projectPolicyCloneResultSchema.parse(
          await this.#clonePolicy.clone({
            profileId: request.profileId,
            policyFingerprint: request.projectPolicy.policyFingerprint,
          }),
        );
      } catch (error) {
        throw new Error(
          "device policy clone result must include status and the exact policy fingerprint",
          { cause: error },
        );
      }
      policyOutcome = cloneResult.status;
      policyResolution = "CLONED";
      policyResolutionFingerprint = sha256Fingerprint(
        canonicalJson({
          reconciliation,
          cloneResult: {
            status: cloneResult.status,
            policyFingerprint: cloneResult.policyFingerprint,
          },
        }),
      );
      rollbackPolicy = cloneResult.rollback;
      if (cloneResult.policyFingerprint !== request.projectPolicy.policyFingerprint) {
        await rollbackPolicy?.();
        throw new Error("device policy clone did not bind the requested policy fingerprint");
      }
    }
    try {
      let doctorStatus: z.infer<typeof readinessSchema> = "NOT_PROVEN";
      let loginReadiness: z.infer<typeof readinessSchema> = "NOT_PROVEN";
      if (policyOutcome === "PASS") {
        doctorStatus = await this.#doctor.run({ profileId: request.profileId });
        if (doctorStatus === "PASS") {
          loginReadiness = await this.#loginReadiness.check({ profileId: request.profileId });
        }
      }
      return this.#receipt(
        request,
        archiveReceipt,
        projection,
        policyOutcome,
        policyResolution,
        policyResolutionFingerprint,
        doctorStatus,
        loginReadiness,
      );
    } catch (error) {
      try {
        await rollbackPolicy?.();
      } catch (rollbackError) {
        throw new Error("device import failed and policy rollback also failed", {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }

  async #importArchive(
    request: z.infer<typeof portableDeviceImportRequestSchema>,
  ): Promise<ArchiveImportReceipt> {
    return this.#archiveStore.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      archive: request.archive,
    });
  }

  async #projectImported(binding: PortableDeviceImportBinding): Promise<ImportedArchiveProjection> {
    return this.#archiveStore.projectImported({
      schemaVersion: "hpi-imported-archive-projection-request.v1",
      operationId: binding.operationId,
      operationFingerprint: binding.operationFingerprint,
      archiveId: binding.archiveId,
      artifactFingerprint: binding.artifactFingerprint,
    });
  }

  #receipt(
    request: z.infer<typeof portableDeviceImportRequestSchema>,
    archiveReceipt: ArchiveImportReceipt,
    projection: ImportedArchiveProjection,
    policyOutcome: z.infer<typeof readinessSchema>,
    policyResolution: z.infer<typeof policyResolutionSchema>,
    policyResolutionFingerprint: string,
    doctorStatus: z.infer<typeof readinessSchema>,
    loginReadiness: z.infer<typeof readinessSchema>,
  ): PortableDeviceImportReceipt {
    const facts = portableDeviceImportReceiptFactsSchema.parse({
      schemaVersion: "hpi-device-import-receipt.v3",
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      profileId: request.profileId,
      projectPolicyFingerprint: request.projectPolicy.policyFingerprint,
      archiveId: archiveReceipt.archiveId,
      artifactFingerprint: archiveReceipt.artifactFingerprint,
      runId: projection.runId,
      planRevisionId: projection.planRevisionId,
      sourceFingerprint: projection.sourceFingerprint,
      archivedRunOutcome: projection.archiveOutcome,
      readOnlyProjectionFingerprint: projection.projectionFingerprint,
      recordedArchiveOutcome: archiveReceipt.outcome,
      policyOutcome,
      policyResolution,
      policyResolutionFingerprint,
      doctorStatus,
      loginReadiness,
      outcome: overallOutcome(policyOutcome, doctorStatus, loginReadiness),
      observedAt: request.observedAt,
    });
    return portableDeviceImportReceiptSchema.parse({
      ...facts,
      archiveOutcome: facts.recordedArchiveOutcome,
      receiptFingerprint: portableDeviceReceiptFingerprint(facts),
    });
  }
}
