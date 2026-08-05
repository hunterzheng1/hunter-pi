import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { z } from "zod";

import {
  compatibilityReceiptSchema,
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  fingerprintSchema,
  pluginAssuranceReceiptSchema,
  type PluginCompatibility,
  pluginIdSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import { assertSafeDirectoryPath, withDurableMutationLock } from "@hunter-pi/evidence";

import {
  pluginDisableRequestSchema,
  pluginCompatibilityVerificationSchema,
  pluginImportFromPiRequestSchema,
  pluginInstallRequestSchema,
  pluginIsolationVerificationSchema,
  pluginInventorySchema,
  pluginJournalEntrySchema,
  pluginManifestSchema,
  pluginOperationReceiptSchema,
  pluginRecordSchema,
  pluginRemoveRequestSchema,
  pluginSafeModeRecoveryRequestSchema,
  pluginStartupDecisionSchema,
  type PluginDisableRequest,
  type PluginImportFromPiRequest,
  type PluginInstallRequest,
  type PluginInventory,
  type PluginCompatibilityVerification,
  type PluginIsolationVerification,
  type PluginJournalEntry,
  type PluginManager,
  type PluginManifest,
  type PluginOperationReceipt,
  type PluginRecord,
  type PluginRemoveRequest,
  type PluginSafeModeRecoveryRequest,
  type PluginSourceResolver,
} from "./contracts.js";

type PluginAction = PluginOperationReceipt["action"];
type ParsedInstallRequest =
  z.infer<typeof pluginInstallRequestSchema> | z.infer<typeof pluginImportFromPiRequestSchema>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function digestOf(value: unknown): Fingerprint {
  return fingerprintSchema.parse(
    `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`,
  );
}

function installRequestFingerprint(
  request: ParsedInstallRequest,
  action: Extract<PluginAction, "INSTALL" | "IMPORT_FROM_PI">,
): Fingerprint {
  return digestOf({
    action,
    source: request.source,
    trust: request.trust,
    provenanceAcknowledged: request.provenanceAcknowledged,
    requestedIsolation: request.requestedIsolation,
    compatibility: request.compatibility,
    evidenceIds: request.evidenceIds,
    ...(request.isolationEvidenceIds === undefined
      ? {}
      : { isolationEvidenceIds: request.isolationEvidenceIds }),
  });
}

function lifecycleRequestFingerprint(
  action: Extract<PluginAction, "DISABLE" | "REMOVE">,
  pluginId: string,
): Fingerprint {
  return digestOf({ action, pluginId });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const journalAppendLocks = new Map<string, Promise<void>>();

async function withJournalAppendLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = journalAppendLocks.get(key) ?? Promise.resolve();
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
  journalAppendLocks.set(key, current);
  try {
    return await turn;
  } finally {
    if (journalAppendLocks.get(key) === current) journalAppendLocks.delete(key);
  }
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
    throw new Error("plugin journal filename must be one contained path segment");
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

function entryPayload(entry: PluginJournalEntry): Omit<PluginJournalEntry, "entryFingerprint"> {
  return {
    schemaVersion: entry.schemaVersion,
    sequence: entry.sequence,
    operationId: entry.operationId,
    operationFingerprint: entry.operationFingerprint,
    requestFingerprint: entry.requestFingerprint,
    action: entry.action,
    pluginId: entry.pluginId,
    ...(entry.record === undefined ? {} : { record: entry.record }),
    receipt: entry.receipt,
    createdAt: entry.createdAt,
    previousEntryFingerprint: entry.previousEntryFingerprint,
  };
}

function entryFilename(entry: PluginJournalEntry): string {
  return `${entry.sequence.toString().padStart(12, "0")}-${entry.entryFingerprint.slice("sha256:".length)}.json`;
}

function generatedIdentity(prefix: "compat" | "assurance", value: unknown): string {
  return `${prefix}_${digestOf(value).slice("sha256:".length, 54)}`;
}

export interface FilePluginJournalOptions {
  readonly stateRoot: string;
}

export class FilePluginJournal {
  readonly #stateRoot: string;

  public constructor(options: FilePluginJournalOptions) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public async read(): Promise<readonly PluginJournalEntry[]> {
    await assertSafeDirectoryPath(this.#stateRoot);
    let entries: string[];
    try {
      const directoryEntries = await readdir(this.#stateRoot, { withFileTypes: true });
      if (
        directoryEntries.some(
          (entry) =>
            !entry.name.startsWith(".pending-") &&
            entry.name !== ".journal-mutation-lock" &&
            (!entry.isFile() || !entry.name.endsWith(".json")),
        )
      ) {
        throw new Error("plugin journal contains an unexpected committed entry");
      }
      entries = directoryEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const parsed = await Promise.all(
      entries.map(async (filename) => ({
        filename,
        entry: pluginJournalEntrySchema.parse(
          JSON.parse(await readFile(join(this.#stateRoot, filename), "utf8")) as unknown,
        ),
      })),
    );
    parsed.sort((left, right) => left.entry.sequence - right.entry.sequence);
    let previous: Fingerprint | null = null;
    for (const [index, item] of parsed.entries()) {
      const entry = item.entry;
      if (
        entry.sequence !== index + 1 ||
        entry.previousEntryFingerprint !== previous ||
        entry.entryFingerprint !== digestOf(entryPayload(entry)) ||
        entryFilename(entry) !== item.filename
      ) {
        throw new Error("plugin journal failed sequence, hash, or filename validation");
      }
      previous = entry.entryFingerprint;
    }
    return parsed.map((item) => item.entry);
  }

  public async append(entry: PluginJournalEntry): Promise<void> {
    const parsed = pluginJournalEntrySchema.parse(entry);
    return withJournalAppendLock(this.#stateRoot, () =>
      withDurableMutationLock(join(this.#stateRoot, ".journal-mutation-lock"), () =>
        this.#appendValidated(parsed),
      ),
    );
  }

  async #appendValidated(entry: PluginJournalEntry): Promise<void> {
    const entries = await this.read();
    const expectedSequence = entries.length + 1;
    const previousEntryFingerprint = entries.at(-1)?.entryFingerprint ?? null;
    if (
      entry.sequence !== expectedSequence ||
      entry.previousEntryFingerprint !== previousEntryFingerprint ||
      entry.entryFingerprint !== digestOf(entryPayload(entry))
    ) {
      throw new Error("plugin journal append does not continue its immutable chain");
    }
    await mkdir(this.#stateRoot, { recursive: true });
    await writeImmutableAtomically({
      directory: this.#stateRoot,
      filename: entryFilename(entry),
      content: `${canonicalJson(entry)}\n`,
    });
  }
}

export interface FilePluginManagerOptions {
  readonly stateRoot: string;
  readonly resolve: PluginSourceResolver["resolve"];
  readonly distributionReleaseId?: string;
  readonly engineReleaseId?: string;
  readonly engineReleaseFingerprint?: Fingerprint;
  readonly platformFingerprint?: Fingerprint;
  readonly compatibilityVerifierFingerprint?: Fingerprint;
  readonly isolationVerifierFingerprint?: Fingerprint;
  readonly reservedTools?: readonly string[];
  readonly reservedHooks?: readonly string[];
  readonly bundledPluginIds?: readonly string[];
  readonly verifyCompatibility?: (
    manifest: PluginManifest,
  ) =>
    | PluginCompatibilityVerification
    | PluginCompatibility
    | Promise<PluginCompatibilityVerification | PluginCompatibility>;
  readonly verifyIsolation?: (
    manifest: PluginManifest,
    request: ParsedInstallRequest,
  ) => boolean | PluginIsolationVerification | Promise<boolean | PluginIsolationVerification>;
}

export class FilePluginManager implements PluginManager {
  readonly #journal: FilePluginJournal;
  readonly #resolve: PluginSourceResolver["resolve"];
  readonly #distributionReleaseId: string;
  readonly #engineReleaseId: string;
  readonly #engineReleaseFingerprint: Fingerprint;
  readonly #platformFingerprint: Fingerprint;
  readonly #compatibilityVerifierFingerprint: Fingerprint | undefined;
  readonly #isolationVerifierFingerprint: Fingerprint | undefined;
  readonly #reservedTools: ReadonlySet<string>;
  readonly #reservedHooks: ReadonlySet<string>;
  readonly #bundledPluginIds: ReadonlySet<string>;
  readonly #verifyCompatibility: NonNullable<FilePluginManagerOptions["verifyCompatibility"]>;
  readonly #verifyIsolation: FilePluginManagerOptions["verifyIsolation"];
  readonly #operationKey: string;

  public constructor(options: FilePluginManagerOptions) {
    const stateRoot = resolve(options.stateRoot);
    this.#operationKey = stateRoot;
    this.#journal = new FilePluginJournal({ stateRoot: join(stateRoot, "journal") });
    this.#resolve = options.resolve;
    this.#distributionReleaseId = distributionReleaseIdSchema.parse(
      options.distributionReleaseId ?? "release_hunter-pi",
    );
    this.#engineReleaseId = engineReleaseIdSchema.parse(
      options.engineReleaseId ?? "engine-release_hunter-pi",
    );
    this.#engineReleaseFingerprint =
      options.engineReleaseFingerprint ?? digestOf("engine-release:hunter-pi");
    this.#platformFingerprint = options.platformFingerprint ?? digestOf("platform:node");
    this.#compatibilityVerifierFingerprint =
      options.compatibilityVerifierFingerprint === undefined
        ? undefined
        : fingerprintSchema.parse(options.compatibilityVerifierFingerprint);
    this.#isolationVerifierFingerprint =
      options.isolationVerifierFingerprint === undefined
        ? undefined
        : fingerprintSchema.parse(options.isolationVerifierFingerprint);
    this.#reservedTools = new Set(options.reservedTools ?? ["hunter-status", "workflow-status"]);
    this.#reservedHooks = new Set(options.reservedHooks ?? ["hunter-workflow-lifecycle"]);
    this.#bundledPluginIds = new Set(options.bundledPluginIds ?? []);
    this.#verifyCompatibility =
      options.verifyCompatibility ?? (() => Promise.resolve("UNVERIFIED" as const));
    this.#verifyIsolation = options.verifyIsolation;
  }

  public async list(): Promise<readonly PluginRecord[]> {
    return this.#sortedRecords(this.#project(await this.#journal.read()));
  }

  public async install(request: PluginInstallRequest): Promise<PluginOperationReceipt> {
    const parsed = pluginInstallRequestSchema.parse(request);
    return withJournalAppendLock(`manager:${this.#operationKey}`, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#install(parsed, "INSTALL"),
      ),
    );
  }

  public async importFromPi(request: PluginImportFromPiRequest): Promise<PluginOperationReceipt> {
    const parsed = pluginImportFromPiRequestSchema.parse(request);
    return withJournalAppendLock(`manager:${this.#operationKey}`, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#install(parsed, "IMPORT_FROM_PI"),
      ),
    );
  }

  public async disable(request: PluginDisableRequest): Promise<PluginOperationReceipt> {
    const parsed = pluginDisableRequestSchema.parse(request);
    return withJournalAppendLock(`manager:${this.#operationKey}`, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#disableParsed(parsed),
      ),
    );
  }

  async #disableParsed(
    parsed: z.infer<typeof pluginDisableRequestSchema>,
  ): Promise<PluginOperationReceipt> {
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      parsed.operationId,
      parsed.operationFingerprint,
      lifecycleRequestFingerprint("DISABLE", parsed.pluginId),
    );
    if (replay !== undefined) return replay;
    const records = this.#project(entries);
    const current = records.get(parsed.pluginId);
    if (current === undefined || current.state === "DISABLED") {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint: lifecycleRequestFingerprint("DISABLE", parsed.pluginId),
        action: "DISABLE",
        pluginId: parsed.pluginId,
        outcome: "NOOP",
        reason: current === undefined ? "plugin is not registered" : "plugin is already disabled",
        observedAt: parsed.observedAt,
      });
    }
    const record = pluginRecordSchema.parse({
      ...current,
      state: "DISABLED",
      lastOperationId: parsed.operationId,
    });
    return this.#append({
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint: lifecycleRequestFingerprint("DISABLE", parsed.pluginId),
      action: "DISABLE",
      pluginId: parsed.pluginId,
      outcome: "APPLIED",
      record,
      observedAt: parsed.observedAt,
    });
  }

  public async remove(request: PluginRemoveRequest): Promise<PluginOperationReceipt> {
    const parsed = pluginRemoveRequestSchema.parse(request);
    return withJournalAppendLock(`manager:${this.#operationKey}`, () =>
      withDurableMutationLock(join(this.#operationKey, ".manager-mutation-lock"), () =>
        this.#removeParsed(parsed),
      ),
    );
  }

  async #removeParsed(
    parsed: z.infer<typeof pluginRemoveRequestSchema>,
  ): Promise<PluginOperationReceipt> {
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      parsed.operationId,
      parsed.operationFingerprint,
      lifecycleRequestFingerprint("REMOVE", parsed.pluginId),
    );
    if (replay !== undefined) return replay;
    const records = this.#project(entries);
    if (!records.has(parsed.pluginId)) {
      return this.#append({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint: lifecycleRequestFingerprint("REMOVE", parsed.pluginId),
        action: "REMOVE",
        pluginId: parsed.pluginId,
        outcome: "NOOP",
        reason: "plugin is not registered",
        observedAt: parsed.observedAt,
      });
    }
    return this.#append({
      operationId: parsed.operationId,
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint: lifecycleRequestFingerprint("REMOVE", parsed.pluginId),
      action: "REMOVE",
      pluginId: parsed.pluginId,
      outcome: "APPLIED",
      observedAt: parsed.observedAt,
    });
  }

  public async inventory(): Promise<PluginInventory> {
    const records = this.#sortedRecords(this.#project(await this.#journal.read()));
    const conflicts = this.#conflicts(records);
    const quarantined = records.some((record) => record.state === "QUARANTINED");
    const safeMode = quarantined || conflicts.length > 0;
    return this.#inventoryFor(records, safeMode, conflicts);
  }

  public async startup() {
    try {
      const records = this.#sortedRecords(this.#project(await this.#journal.read()));
      const conflicts = this.#conflicts(records);
      const reasons = new Set<"PLUGIN_QUARANTINED" | "RESERVED_RESOURCE_COLLISION">();
      const pluginIds = new Set<string>();
      for (const record of records) {
        if (record.state === "QUARANTINED") {
          reasons.add("PLUGIN_QUARANTINED");
          pluginIds.add(record.pluginId);
        }
      }
      if (conflicts.length > 0) {
        reasons.add("RESERVED_RESOURCE_COLLISION");
        for (const conflict of conflicts) pluginIds.add(conflict.pluginId);
      }
      return pluginStartupDecisionSchema.parse({
        schemaVersion: "hpi-plugin-startup.v1",
        mode: reasons.size === 0 ? "NORMAL" : "SAFE_MODE",
        reasons: [...reasons],
        pluginIds: [...pluginIds].map((pluginId) => pluginIdSchema.parse(pluginId)),
      });
    } catch {
      return pluginStartupDecisionSchema.parse({
        schemaVersion: "hpi-plugin-startup.v1",
        mode: "SAFE_MODE",
        reasons: ["JOURNAL_CORRUPT"],
        pluginIds: [],
      });
    }
  }

  public async recoverSafeMode(
    request: PluginSafeModeRecoveryRequest,
  ): Promise<readonly PluginOperationReceipt[]> {
    const parsed = pluginSafeModeRecoveryRequestSchema.parse(request);
    const receipts: PluginOperationReceipt[] = [];
    for (const operation of parsed.operations) {
      receipts.push(await this.disable(operation));
    }
    return receipts;
  }

  async #install(
    request: ParsedInstallRequest,
    action: Extract<PluginAction, "INSTALL" | "IMPORT_FROM_PI">,
  ): Promise<PluginOperationReceipt> {
    const entries = await this.#journal.read();
    const replay = this.#replayedOperation(
      entries,
      request.operationId,
      request.operationFingerprint,
      installRequestFingerprint(request, action),
    );
    if (replay !== undefined) return replay;
    const manifest = pluginManifestSchema.parse(await this.#resolve(request.source));
    if (canonicalJson(manifest.source) !== canonicalJson(request.source)) {
      throw new Error("resolved Plugin Manifest does not bind the exact requested source");
    }
    const records = this.#project(entries);
    const current = records.get(manifest.pluginId);
    if (current !== undefined) {
      if (canonicalJson(current.manifest) !== canonicalJson(manifest)) {
        throw new Error("plugin identity is already bound to a different exact release");
      }
      return this.#append({
        operationId: request.operationId,
        operationFingerprint: request.operationFingerprint,
        requestFingerprint: installRequestFingerprint(request, action),
        action,
        pluginId: manifest.pluginId,
        outcome: "NOOP",
        reason: "exact Plugin release is already registered",
        record: current,
        observedAt: request.observedAt,
      });
    }
    const record = await this.#recordFor(manifest, request);
    return this.#append({
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      requestFingerprint: installRequestFingerprint(request, action),
      action,
      pluginId: manifest.pluginId,
      outcome: "APPLIED",
      record,
      observedAt: request.observedAt,
    });
  }

  async #recordFor(manifest: PluginManifest, request: ParsedInstallRequest): Promise<PluginRecord> {
    const conflicts = this.#resourceConflicts(manifest);
    let compatibilityVerification: PluginCompatibilityVerification = {
      outcome: "UNVERIFIED",
      verifierFingerprint: digestOf("compatibility-verifier-unavailable"),
      evidenceIds: [],
    };
    try {
      const parsedVerification = pluginCompatibilityVerificationSchema.safeParse(
        await this.#verifyCompatibility(manifest),
      );
      if (
        parsedVerification.success &&
        (parsedVerification.data.outcome !== "VERIFIED" ||
          (this.#compatibilityVerifierFingerprint !== undefined &&
            parsedVerification.data.verifierFingerprint ===
              this.#compatibilityVerifierFingerprint &&
            parsedVerification.data.evidenceIds.length > 0))
      ) {
        compatibilityVerification = parsedVerification.data;
      }
    } catch {
      compatibilityVerification = {
        outcome: "UNVERIFIED",
        verifierFingerprint: digestOf("compatibility-verifier-failed"),
        evidenceIds: [],
      };
    }
    const compatibility = conflicts.length > 0 ? "INCOMPATIBLE" : compatibilityVerification.outcome;
    const trust =
      request.trust === "BUNDLED" && this.#bundledPluginIds.has(manifest.pluginId)
        ? "BUNDLED"
        : request.trust === "USER_APPROVED" && request.provenanceAcknowledged
          ? "USER_APPROVED"
          : "QUARANTINED";
    let isolation = request.requestedIsolation;
    let isolationEvidenceIds: readonly string[] = [];
    if (request.requestedIsolation === "CONTAINED") {
      try {
        const parsedVerification = pluginIsolationVerificationSchema.safeParse(
          await this.#verifyIsolation?.(manifest, request),
        );
        if (
          parsedVerification.success &&
          this.#isolationVerifierFingerprint !== undefined &&
          parsedVerification.data.verifierFingerprint === this.#isolationVerifierFingerprint &&
          parsedVerification.data.evidenceIds.length > 0
        ) {
          isolation = "CONTAINED";
          isolationEvidenceIds = parsedVerification.data.evidenceIds;
        } else {
          isolation = "NOT_PROVEN";
        }
      } catch {
        isolation = "NOT_PROVEN";
      }
    }
    const evidenceIds = [
      ...new Set([
        ...request.evidenceIds,
        ...compatibilityVerification.evidenceIds,
        ...(request.isolationEvidenceIds ?? []),
        ...isolationEvidenceIds,
      ]),
    ];
    const compatibilityReceipt = compatibilityReceiptSchema.parse({
      schemaVersion: "1.0.0",
      compatibilityReceiptId: generatedIdentity("compat", {
        pluginId: manifest.pluginId,
        version: manifest.version,
        packageFingerprint: manifest.packageFingerprint,
        distributionReleaseId: this.#distributionReleaseId,
      }),
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      pluginReleaseFingerprint: manifest.packageFingerprint,
      distributionReleaseId: this.#distributionReleaseId,
      engineReleaseId: this.#engineReleaseId,
      engineReleaseFingerprint: this.#engineReleaseFingerprint,
      platformFingerprint: this.#platformFingerprint,
      configurationFingerprint: digestOf({
        source: manifest.source,
        resources: manifest.resources,
      }),
      outcome: compatibility,
      checkedAt: request.observedAt,
      evidenceIds,
    });
    const assurance = pluginAssuranceReceiptSchema.parse({
      schemaVersion: "1.0.0",
      pluginAssuranceReceiptId: generatedIdentity("assurance", {
        pluginId: manifest.pluginId,
        version: manifest.version,
        operationFingerprint: request.operationFingerprint,
      }),
      compatibilityReceipt,
      compatibility,
      trust,
      isolation,
      assessedAt: request.observedAt,
      evidenceIds,
    });
    const state =
      compatibility === "VERIFIED" && trust !== "QUARANTINED" && isolation !== "NOT_PROVEN"
        ? "ENABLED"
        : "QUARANTINED";
    return pluginRecordSchema.parse({
      schemaVersion: "hpi-plugin-record.v1",
      pluginId: manifest.pluginId,
      manifest,
      state,
      assurance,
      installedAt: request.observedAt,
      lastOperationId: request.operationId,
    });
  }

  #resourceConflicts(manifest: PluginManifest): readonly {
    readonly resourceKind: "TOOL" | "HOOK";
    readonly resourceName: string;
  }[] {
    const conflicts: { resourceKind: "TOOL" | "HOOK"; resourceName: string }[] = [];
    const seenTools = new Set<string>();
    for (const tool of manifest.resources.tools) {
      if (this.#reservedTools.has(tool.name) || seenTools.has(tool.name)) {
        conflicts.push({ resourceKind: "TOOL", resourceName: tool.name });
      }
      seenTools.add(tool.name);
    }
    const seenHooks = new Set<string>();
    for (const hook of manifest.resources.hooks) {
      if (this.#reservedHooks.has(hook.name) || seenHooks.has(hook.name)) {
        conflicts.push({ resourceKind: "HOOK", resourceName: hook.name });
      }
      seenHooks.add(hook.name);
    }
    return conflicts;
  }

  #conflicts(records: readonly PluginRecord[]) {
    const conflicts: PluginInventory["conflicts"] = [];
    const seenTools = new Map<string, string>();
    const seenHooks = new Map<string, string>();
    for (const record of records) {
      if (record.state === "DISABLED") continue;
      for (const conflict of this.#resourceConflicts(record.manifest)) {
        conflicts.push({
          pluginId: record.pluginId,
          resourceKind: conflict.resourceKind,
          resourceName: conflict.resourceName,
          reason: "reserved or duplicate Plugin resource",
        });
      }
      for (const tool of record.manifest.resources.tools) {
        const prior = seenTools.get(tool.name);
        if (prior !== undefined && prior !== record.pluginId) {
          conflicts.push({
            pluginId: record.pluginId,
            resourceKind: "TOOL",
            resourceName: tool.name,
            reason: `resource collides with ${prior}`,
          });
        }
        seenTools.set(tool.name, record.pluginId);
      }
      for (const hook of record.manifest.resources.hooks) {
        const prior = seenHooks.get(hook.name);
        if (prior !== undefined && prior !== record.pluginId) {
          conflicts.push({
            pluginId: record.pluginId,
            resourceKind: "HOOK",
            resourceName: hook.name,
            reason: `resource collides with ${prior}`,
          });
        }
        seenHooks.set(hook.name, record.pluginId);
      }
    }
    return conflicts;
  }

  #inventoryFor(
    records: readonly PluginRecord[],
    safeMode: boolean,
    conflicts: PluginInventory["conflicts"],
  ): PluginInventory {
    const declaredTools = records.flatMap((record) =>
      record.manifest.resources.tools.map((resource) => ({
        pluginId: record.pluginId,
        ...resource,
      })),
    );
    const declaredHooks = records.flatMap((record) =>
      record.manifest.resources.hooks.map((resource) => ({
        pluginId: record.pluginId,
        ...resource,
      })),
    );
    const conflictKeys = new Set(
      conflicts.map(
        (conflict) => `${conflict.resourceKind}:${conflict.pluginId}:${conflict.resourceName}`,
      ),
    );
    const effectiveTools = safeMode
      ? []
      : records.flatMap((record) =>
          record.state === "ENABLED"
            ? record.manifest.resources.tools
                .filter((resource) => !conflictKeys.has(`TOOL:${record.pluginId}:${resource.name}`))
                .map((resource) => ({ pluginId: record.pluginId, ...resource }))
            : [],
        );
    const effectiveHooks = safeMode
      ? []
      : records.flatMap((record) =>
          record.state === "ENABLED"
            ? record.manifest.resources.hooks
                .filter((resource) => !conflictKeys.has(`HOOK:${record.pluginId}:${resource.name}`))
                .map((resource) => ({ pluginId: record.pluginId, ...resource }))
            : [],
        );
    return pluginInventorySchema.parse({
      schemaVersion: "hpi-plugin-inventory.v1",
      safeMode,
      declaredTools,
      declaredHooks,
      effectiveTools,
      effectiveHooks,
      conflicts,
    });
  }

  #project(entries: readonly PluginJournalEntry[]): Map<string, PluginRecord> {
    const records = new Map<string, PluginRecord>();
    for (const entry of entries) {
      if (entry.action === "REMOVE") {
        records.delete(entry.pluginId);
      } else if (entry.record !== undefined) {
        records.set(entry.pluginId, pluginRecordSchema.parse(entry.record));
      }
    }
    return records;
  }

  #sortedRecords(records: Map<string, PluginRecord>): readonly PluginRecord[] {
    return [...records.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  #replayedOperation(
    entries: readonly PluginJournalEntry[],
    operationId: string,
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
  ): PluginOperationReceipt | undefined {
    const entry = entries.find((candidate) => candidate.operationId === operationId);
    if (entry === undefined) return undefined;
    if (
      entry.operationFingerprint !== operationFingerprint ||
      entry.requestFingerprint !== requestFingerprint
    ) {
      throw new Error("Plugin operation identity, request, or fingerprint changed during replay");
    }
    return entry.receipt;
  }

  async #append(input: {
    readonly operationId: PluginOperationReceipt["operationId"];
    readonly operationFingerprint: Fingerprint;
    readonly requestFingerprint: Fingerprint;
    readonly action: PluginAction;
    readonly pluginId: PluginOperationReceipt["pluginId"];
    readonly outcome: PluginOperationReceipt["outcome"];
    readonly record?: PluginRecord;
    readonly reason?: string;
    readonly observedAt: string;
  }): Promise<PluginOperationReceipt> {
    const receipt = pluginOperationReceiptSchema.parse({
      schemaVersion: "hpi-plugin-operation-receipt.v1",
      operationId: input.operationId,
      operationFingerprint: input.operationFingerprint,
      action: input.action,
      pluginId: input.pluginId,
      outcome: input.outcome,
      ...(input.record === undefined
        ? {}
        : {
            compatibility: input.record.assurance.compatibility,
            trust: input.record.assurance.trust,
            isolation: input.record.assurance.isolation,
          }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      observedAt: input.observedAt,
    });
    const entries = await this.#journal.read();
    const entryWithoutFingerprint = pluginJournalEntrySchema.parse({
      schemaVersion: "hpi-plugin-journal.v1",
      sequence: entries.length + 1,
      operationId: input.operationId,
      operationFingerprint: input.operationFingerprint,
      requestFingerprint: input.requestFingerprint,
      action: input.action,
      pluginId: input.pluginId,
      ...(input.record === undefined ? {} : { record: input.record }),
      receipt,
      createdAt: input.observedAt,
      previousEntryFingerprint: entries.at(-1)?.entryFingerprint ?? null,
      entryFingerprint: digestOf({
        schemaVersion: "hpi-plugin-journal.v1",
        sequence: entries.length + 1,
        operationId: input.operationId,
        operationFingerprint: input.operationFingerprint,
        requestFingerprint: input.requestFingerprint,
        action: input.action,
        pluginId: input.pluginId,
        ...(input.record === undefined ? {} : { record: input.record }),
        receipt,
        createdAt: input.observedAt,
        previousEntryFingerprint: entries.at(-1)?.entryFingerprint ?? null,
      }),
    });
    await this.#journal.append(entryWithoutFingerprint);
    return receipt;
  }
}
