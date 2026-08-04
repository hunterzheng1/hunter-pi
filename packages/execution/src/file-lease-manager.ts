import { createHash, randomUUID } from "node:crypto";
import { open, link, lstat, mkdir, readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  fingerprintSchema,
  operationIdSchema,
  timestampSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type Fingerprint,
  type OperationId,
  type WriterLeaseId,
} from "@hunter-pi/domain";

import {
  leaseAcquireReceiptSchema,
  leaseAcquireRequestSchema,
  leaseMutationReceiptSchema,
  leaseReleaseRequestSchema,
  leaseResourceSchema,
  leaseRenewRequestSchema,
  leaseStatusReceiptSchema,
  type LeaseAcquireReceipt,
  type LeaseAcquireRequest,
  type LeaseManager,
  type LeaseMutationReceipt,
  type LeaseReleaseRequest,
  type LeaseReasonCode,
  type LeaseResource,
  type LeaseRenewRequest,
  type LeaseStatusReceipt,
} from "./contracts.js";
import { LeaseError } from "./errors.js";

const leaseRecordPayloadSchema = z.strictObject({
  schemaVersion: z.literal("hpi-local-lease-record.v1"),
  leaseId: writerLeaseIdSchema,
  workspaceId: workspaceIdSchema,
  ownerFingerprint: fingerprintSchema,
  resources: z.array(leaseResourceSchema),
  resourceSetFingerprint: fingerprintSchema,
  generation: z.number().int().positive(),
  state: z.enum(["ACTIVE", "REVOKED", "RELEASED"]),
  acquiredAt: timestampSchema,
  renewedAt: timestampSchema,
  expiresAt: timestampSchema,
  observedAt: timestampSchema,
  previousRecordFingerprint: fingerprintSchema.nullable(),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
});
const leaseRecordSchema = leaseRecordPayloadSchema.safeExtend({
  recordFingerprint: fingerprintSchema,
});
type LeaseRecord = z.infer<typeof leaseRecordSchema>;

const leaseOperationRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-local-lease-operation.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
  receipt: z.union([leaseAcquireReceiptSchema, leaseMutationReceiptSchema]),
  operationRecordFingerprint: fingerprintSchema,
});
type LeaseOperationRecord = z.infer<typeof leaseOperationRecordSchema>;

export interface FileLeaseManagerOptions {
  readonly leaseRoot: string;
  readonly now?: () => string;
  readonly reconcileOwner?: (
    ownerFingerprint: Fingerprint,
  ) => Promise<"ALIVE" | "DEAD" | "NOT_PROVEN">;
}

interface LeaseState {
  readonly histories: ReadonlyMap<WriterLeaseId, readonly LeaseRecord[]>;
  readonly operations: ReadonlyMap<OperationId, LeaseOperationRecord>;
  readonly latestObservedAt: string | undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function leaseRecordPayload(record: LeaseRecord): z.infer<typeof leaseRecordPayloadSchema> {
  const payload: Record<string, unknown> = { ...record };
  delete payload["recordFingerprint"];
  return leaseRecordPayloadSchema.parse(payload);
}

function operationRecordPayload(
  record: LeaseOperationRecord,
): Omit<LeaseOperationRecord, "operationRecordFingerprint"> {
  const payload: Record<string, unknown> = { ...record };
  delete payload["operationRecordFingerprint"];
  return leaseOperationRecordSchema.omit({ operationRecordFingerprint: true }).parse(payload);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isStrictlyContained(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return !(
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  );
}

async function requirePhysicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new LeaseError("LEASE_STORE_CORRUPT", `${label} must be absolute`);
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new LeaseError("LEASE_STORE_CORRUPT", `${label} must be a physical directory`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw new LeaseError("LEASE_STORE_CORRUPT", `${label} must not use a path alias`);
  }
  return canonical;
}

async function requireRegularSingleLinkFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new LeaseError("LEASE_STORE_CORRUPT", "lease state contains an aliased record");
  }
}

async function writeImmutable(directory: string, filename: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const pendingPath = join(directory, `.pending-${randomUUID()}`);
  const finalPath = join(directory, filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(pendingPath, finalPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LeaseError("LEASE_STORE_CORRUPT", "lease state contains malformed JSON");
  }
}

function parseLeaseRecord(text: string): LeaseRecord {
  try {
    return leaseRecordSchema.parse(parseJson(text));
  } catch (error) {
    if (error instanceof LeaseError) throw error;
    throw new LeaseError("LEASE_STORE_CORRUPT", "lease record schema is invalid");
  }
}

function parseOperationRecord(text: string): LeaseOperationRecord {
  try {
    return leaseOperationRecordSchema.parse(parseJson(text));
  } catch (error) {
    if (error instanceof LeaseError) throw error;
    throw new LeaseError("LEASE_STORE_CORRUPT", "lease operation schema is invalid");
  }
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

class FileLeaseManager implements LeaseManager {
  readonly #root: string;
  readonly #leasesRoot: string;
  readonly #operationsRoot: string;
  readonly #lockPath: string;
  readonly #now: () => string;
  readonly #reconcileOwner: (
    ownerFingerprint: Fingerprint,
  ) => Promise<"ALIVE" | "DEAD" | "NOT_PROVEN">;

  public constructor(
    root: string,
    now: () => string,
    reconcileOwner: (ownerFingerprint: Fingerprint) => Promise<"ALIVE" | "DEAD" | "NOT_PROVEN">,
  ) {
    this.#root = root;
    this.#leasesRoot = join(root, "leases");
    this.#operationsRoot = join(root, "operations");
    this.#lockPath = join(root, ".mutation-lock");
    this.#now = now;
    this.#reconcileOwner = reconcileOwner;
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#leasesRoot, { recursive: true }),
      mkdir(this.#operationsRoot, { recursive: true }),
    ]);
    await Promise.all([
      requirePhysicalDirectory(this.#leasesRoot, "leases root"),
      requirePhysicalDirectory(this.#operationsRoot, "operations root"),
    ]);
  }

  public async acquire(
    request: LeaseAcquireRequest,
  ): Promise<{ readonly receipt: LeaseAcquireReceipt }> {
    const parsed = leaseAcquireRequestSchema.parse(request);
    const resources = [...parsed.resources].sort();
    const requestFingerprint = sha256(
      canonicalJson({
        schemaVersion: parsed.schemaVersion,
        leaseId: parsed.leaseId,
        workspaceId: parsed.workspaceId,
        ownerFingerprint: parsed.ownerFingerprint,
        resources,
        ttlMs: parsed.ttlMs,
      }),
    );
    return this.#withMutationLock(async () => {
      const state = await this.#readState();
      const replay = state.operations.get(parsed.operationId);
      if (replay !== undefined) {
        if (
          replay.operationFingerprint !== parsed.operationFingerprint ||
          replay.requestFingerprint !== requestFingerprint
        ) {
          throw new LeaseError(
            "LEASE_OPERATION_CONFLICT",
            "lease operation replay changed its fingerprint or canonical request",
          );
        }
        return { receipt: leaseAcquireReceiptSchema.parse(replay.receipt) };
      }
      const observedAt = timestampSchema.parse(this.#now());
      if (
        state.latestObservedAt !== undefined &&
        compareTimestamps(observedAt, state.latestObservedAt) < 0
      ) {
        throw new LeaseError("CLOCK_ROLLBACK", "lease clock moved behind committed state");
      }
      const resourceSetFingerprint = sha256(
        canonicalJson({ workspaceId: parsed.workspaceId, resources }),
      );
      if (state.histories.has(parsed.leaseId)) {
        return this.#commitBlockedAcquire({
          parsed,
          requestFingerprint,
          resourceSetFingerprint,
          resources,
          observedAt,
          reasonCode: "LEASE_ID_CONFLICT",
        });
      }
      const active = [...state.histories.values()]
        .map((history) => history.at(-1))
        .filter((record): record is LeaseRecord => record?.state === "ACTIVE");
      const conflicts = active.filter(
        (record) =>
          record.workspaceId === parsed.workspaceId ||
          record.resources.some((resource) => resources.includes(resource)),
      );
      const unexpired = conflicts.filter(
        (record) => compareTimestamps(record.expiresAt, observedAt) > 0,
      );
      let reasonCode: LeaseReasonCode | undefined;
      if (unexpired.some((record) => record.workspaceId === parsed.workspaceId)) {
        reasonCode = "WORKSPACE_CONFLICT";
      } else if (unexpired.length > 0) {
        reasonCode = "RESOURCE_CONFLICT";
      }
      const deadConflicts: LeaseRecord[] = [];
      if (reasonCode === undefined) {
        for (const record of conflicts) {
          const ownerState = await this.#reconcileOwner(record.ownerFingerprint);
          if (ownerState === "ALIVE") {
            reasonCode = "OWNER_STILL_LIVE";
            break;
          }
          if (ownerState === "NOT_PROVEN") {
            reasonCode = "OWNER_LIVENESS_NOT_PROVEN";
            break;
          }
          deadConflicts.push(record);
        }
      }
      if (reasonCode !== undefined) {
        return this.#commitBlockedAcquire({
          parsed,
          requestFingerprint,
          resourceSetFingerprint,
          resources,
          observedAt,
          reasonCode,
        });
      }
      for (const record of deadConflicts) {
        await this.#appendLeaseRecord(
          leaseRecordPayloadSchema.parse({
            ...leaseRecordPayload(record),
            generation: record.generation + 1,
            state: "REVOKED",
            observedAt,
            previousRecordFingerprint: record.recordFingerprint,
            operationId: parsed.operationId,
            operationFingerprint: parsed.operationFingerprint,
            requestFingerprint,
          }),
        );
      }

      const expiresAt = new Date(Date.parse(observedAt) + parsed.ttlMs).toISOString();
      const receipt = leaseAcquireReceiptSchema.parse({
        schemaVersion: "hpi-lease-receipt.v1",
        action: "ACQUIRE",
        outcome: "ACQUIRED",
        leaseId: parsed.leaseId,
        workspaceId: parsed.workspaceId,
        ownerFingerprint: parsed.ownerFingerprint,
        generation: 1,
        resourceSetFingerprint,
        resourceCount: resources.length,
        state: "ACTIVE",
        expiresAt,
        reasonCodes: [],
        observedAt,
      });
      const payload = leaseRecordPayloadSchema.parse({
        schemaVersion: "hpi-local-lease-record.v1",
        leaseId: parsed.leaseId,
        workspaceId: parsed.workspaceId,
        ownerFingerprint: parsed.ownerFingerprint,
        resources,
        resourceSetFingerprint,
        generation: 1,
        state: "ACTIVE",
        acquiredAt: observedAt,
        renewedAt: observedAt,
        expiresAt,
        observedAt,
        previousRecordFingerprint: null,
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
      });
      await mkdir(join(this.#leasesRoot, parsed.leaseId));
      await this.#appendLeaseRecord(payload);
      await this.#writeOperation({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
      });
      return { receipt };
    });
  }

  public async inspect(leaseId: WriterLeaseId): Promise<{ readonly receipt: LeaseStatusReceipt }> {
    const parsedLeaseId = writerLeaseIdSchema.parse(leaseId);
    return this.#withMutationLock(async () => {
      const state = await this.#readState();
      const record = state.histories.get(parsedLeaseId)?.at(-1);
      if (record === undefined) {
        throw new LeaseError("LEASE_NOT_FOUND", "lease identity is not committed");
      }
      const observedAt = timestampSchema.parse(this.#now());
      if (
        state.latestObservedAt !== undefined &&
        compareTimestamps(observedAt, state.latestObservedAt) < 0
      ) {
        throw new LeaseError("CLOCK_ROLLBACK", "lease clock moved behind committed state");
      }
      const stateAtObservation =
        record.state === "ACTIVE" && compareTimestamps(record.expiresAt, observedAt) <= 0
          ? "EXPIRED"
          : record.state;
      return {
        receipt: leaseStatusReceiptSchema.parse({
          schemaVersion: "hpi-lease-status.v1",
          leaseId: record.leaseId,
          workspaceId: record.workspaceId,
          ownerFingerprint: record.ownerFingerprint,
          generation: record.generation,
          resourceSetFingerprint: record.resourceSetFingerprint,
          resourceCount: record.resources.length,
          state: stateAtObservation,
          expiresAt: record.expiresAt,
          observedAt,
        }),
      };
    });
  }

  public async renew(
    request: LeaseRenewRequest,
  ): Promise<{ readonly receipt: LeaseMutationReceipt }> {
    const parsed = leaseRenewRequestSchema.parse(request);
    const requestFingerprint = sha256(
      canonicalJson({
        schemaVersion: parsed.schemaVersion,
        leaseId: parsed.leaseId,
        ownerFingerprint: parsed.ownerFingerprint,
        ttlMs: parsed.ttlMs,
      }),
    );
    return this.#withMutationLock(async () => {
      const state = await this.#readState();
      const replay = this.#replayMutation(
        state,
        parsed.operationId,
        parsed.operationFingerprint,
        requestFingerprint,
      );
      if (replay !== undefined) return replay;
      const observedAt = this.#assertClock(state);
      const record = this.#requireOwnedActiveLease(state, parsed.leaseId, parsed.ownerFingerprint);
      if (compareTimestamps(record.expiresAt, observedAt) <= 0) {
        throw new LeaseError("LEASE_EXPIRED", "an expired lease cannot be renewed");
      }
      const expiresAt = new Date(Date.parse(observedAt) + parsed.ttlMs).toISOString();
      if (compareTimestamps(expiresAt, record.expiresAt) <= 0) {
        throw new LeaseError(
          "LEASE_RENEWAL_NOT_MONOTONIC",
          "lease renewal must extend the committed expiration",
        );
      }
      const payload = leaseRecordPayloadSchema.parse({
        ...leaseRecordPayload(record),
        generation: record.generation + 1,
        state: "ACTIVE",
        renewedAt: observedAt,
        expiresAt,
        observedAt,
        previousRecordFingerprint: record.recordFingerprint,
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
      });
      await this.#appendLeaseRecord(payload);
      const receipt = this.#mutationReceipt("RENEW", payload);
      await this.#writeOperation({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
      });
      return { receipt };
    });
  }

  public async release(
    request: LeaseReleaseRequest,
  ): Promise<{ readonly receipt: LeaseMutationReceipt }> {
    const parsed = leaseReleaseRequestSchema.parse(request);
    const requestFingerprint = sha256(
      canonicalJson({
        schemaVersion: parsed.schemaVersion,
        leaseId: parsed.leaseId,
        ownerFingerprint: parsed.ownerFingerprint,
      }),
    );
    return this.#withMutationLock(async () => {
      const state = await this.#readState();
      const replay = this.#replayMutation(
        state,
        parsed.operationId,
        parsed.operationFingerprint,
        requestFingerprint,
      );
      if (replay !== undefined) return replay;
      const observedAt = this.#assertClock(state);
      const record = this.#requireOwnedActiveLease(state, parsed.leaseId, parsed.ownerFingerprint);
      const payload = leaseRecordPayloadSchema.parse({
        ...leaseRecordPayload(record),
        generation: record.generation + 1,
        state: "RELEASED",
        observedAt,
        previousRecordFingerprint: record.recordFingerprint,
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
      });
      await this.#appendLeaseRecord(payload);
      const receipt = this.#mutationReceipt("RELEASE", payload);
      await this.#writeOperation({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
      });
      return { receipt };
    });
  }

  #assertClock(state: LeaseState): string {
    const observedAt = timestampSchema.parse(this.#now());
    if (
      state.latestObservedAt !== undefined &&
      compareTimestamps(observedAt, state.latestObservedAt) < 0
    ) {
      throw new LeaseError("CLOCK_ROLLBACK", "lease clock moved behind committed state");
    }
    return observedAt;
  }

  #requireOwnedActiveLease(
    state: LeaseState,
    leaseId: WriterLeaseId,
    ownerFingerprint: Fingerprint,
  ): LeaseRecord {
    const record = state.histories.get(leaseId)?.at(-1);
    if (record === undefined) {
      throw new LeaseError("LEASE_NOT_FOUND", "lease identity is not committed");
    }
    if (record.ownerFingerprint !== ownerFingerprint) {
      throw new LeaseError("LEASE_OWNER_MISMATCH", "lease owner identity did not match");
    }
    if (record.state !== "ACTIVE") {
      throw new LeaseError("LEASE_NOT_ACTIVE", "lease is not active");
    }
    return record;
  }

  #replayMutation(
    state: LeaseState,
    operationId: OperationId,
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
  ): { readonly receipt: LeaseMutationReceipt } | undefined {
    const replay = state.operations.get(operationId);
    if (replay === undefined) return undefined;
    if (
      replay.operationFingerprint !== operationFingerprint ||
      replay.requestFingerprint !== requestFingerprint
    ) {
      throw new LeaseError(
        "LEASE_OPERATION_CONFLICT",
        "lease operation replay changed its fingerprint or canonical request",
      );
    }
    return { receipt: leaseMutationReceiptSchema.parse(replay.receipt) };
  }

  #mutationReceipt(
    action: "RENEW" | "RELEASE",
    record: z.infer<typeof leaseRecordPayloadSchema>,
  ): LeaseMutationReceipt {
    return leaseMutationReceiptSchema.parse({
      schemaVersion: "hpi-lease-mutation-receipt.v1",
      action,
      outcome: action === "RENEW" ? "RENEWED" : "RELEASED",
      leaseId: record.leaseId,
      workspaceId: record.workspaceId,
      ownerFingerprint: record.ownerFingerprint,
      generation: record.generation,
      resourceSetFingerprint: record.resourceSetFingerprint,
      resourceCount: record.resources.length,
      state: action === "RENEW" ? "ACTIVE" : "RELEASED",
      expiresAt: record.expiresAt,
      reasonCodes: [],
      observedAt: record.observedAt,
    });
  }

  async #commitBlockedAcquire(options: {
    readonly parsed: z.infer<typeof leaseAcquireRequestSchema>;
    readonly requestFingerprint: Fingerprint;
    readonly resourceSetFingerprint: Fingerprint;
    readonly resources: readonly LeaseResource[];
    readonly observedAt: string;
    readonly reasonCode: LeaseReasonCode;
  }): Promise<{ readonly receipt: LeaseAcquireReceipt }> {
    const receipt = leaseAcquireReceiptSchema.parse({
      schemaVersion: "hpi-lease-receipt.v1",
      action: "ACQUIRE",
      outcome: "BLOCKED",
      leaseId: options.parsed.leaseId,
      workspaceId: options.parsed.workspaceId,
      ownerFingerprint: options.parsed.ownerFingerprint,
      generation: 0,
      resourceSetFingerprint: options.resourceSetFingerprint,
      resourceCount: options.resources.length,
      state: "NOT_ACQUIRED",
      expiresAt: null,
      reasonCodes: [options.reasonCode],
      observedAt: options.observedAt,
    });
    await this.#writeOperation({
      operationId: options.parsed.operationId,
      operationFingerprint: options.parsed.operationFingerprint,
      requestFingerprint: options.requestFingerprint,
      receipt,
    });
    return { receipt };
  }

  async #appendLeaseRecord(payload: z.infer<typeof leaseRecordPayloadSchema>): Promise<void> {
    const record = leaseRecordSchema.parse({
      ...payload,
      recordFingerprint: sha256(canonicalJson(payload)),
    });
    await writeImmutable(
      join(this.#leasesRoot, payload.leaseId),
      `${payload.generation.toString().padStart(8, "0")}.json`,
      `${canonicalJson(record)}\n`,
    );
  }

  async #writeOperation(
    payload: Omit<LeaseOperationRecord, "schemaVersion" | "operationRecordFingerprint">,
  ): Promise<void> {
    const withoutFingerprint = {
      schemaVersion: "hpi-local-lease-operation.v1" as const,
      ...payload,
    };
    const record = leaseOperationRecordSchema.parse({
      ...withoutFingerprint,
      operationRecordFingerprint: sha256(canonicalJson(withoutFingerprint)),
    });
    await writeImmutable(
      this.#operationsRoot,
      `${payload.operationId}.json`,
      `${canonicalJson(record)}\n`,
    );
  }

  async #readState(): Promise<LeaseState> {
    const [root, leasesRoot, operationsRoot] = await Promise.all([
      requirePhysicalDirectory(this.#root, "lease root"),
      requirePhysicalDirectory(this.#leasesRoot, "leases root"),
      requirePhysicalDirectory(this.#operationsRoot, "operations root"),
    ]);
    if (
      root !== this.#root ||
      leasesRoot !== this.#leasesRoot ||
      operationsRoot !== this.#operationsRoot ||
      !isStrictlyContained(root, leasesRoot) ||
      !isStrictlyContained(root, operationsRoot)
    ) {
      throw new LeaseError("LEASE_STORE_CORRUPT", "lease storage identity changed");
    }
    const rootEntries = await readdir(this.#root, { withFileTypes: true });
    if (
      rootEntries.some(
        (entry) =>
          entry.name !== "leases" && entry.name !== "operations" && entry.name !== ".mutation-lock",
      )
    ) {
      throw new LeaseError("LEASE_STORE_CORRUPT", "lease root contains an unknown entry");
    }
    const histories = new Map<WriterLeaseId, readonly LeaseRecord[]>();
    for (const entry of await readdir(this.#leasesRoot, { withFileTypes: true })) {
      const parsedLeaseId = writerLeaseIdSchema.safeParse(entry.name);
      if (!entry.isDirectory() || !parsedLeaseId.success) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease root contains an invalid lease entry");
      }
      const directory = join(this.#leasesRoot, entry.name);
      const canonical = await requirePhysicalDirectory(directory, "lease record directory");
      if (!isStrictlyContained(this.#leasesRoot, canonical)) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease record directory escaped its root");
      }
      const records: LeaseRecord[] = [];
      for (const recordEntry of await readdir(directory, { withFileTypes: true })) {
        if (!recordEntry.isFile() || !/^\d{8}\.json$/u.test(recordEntry.name)) {
          throw new LeaseError("LEASE_STORE_CORRUPT", "lease history contains a partial record");
        }
        const path = join(directory, recordEntry.name);
        await requireRegularSingleLinkFile(path);
        const record = parseLeaseRecord(await readFile(path, "utf8"));
        if (
          record.leaseId !== parsedLeaseId.data ||
          recordEntry.name !== `${record.generation.toString().padStart(8, "0")}.json` ||
          record.recordFingerprint !== sha256(canonicalJson(leaseRecordPayload(record)))
        ) {
          throw new LeaseError("LEASE_STORE_CORRUPT", "lease record identity is invalid");
        }
        records.push(record);
      }
      records.sort((left, right) => left.generation - right.generation);
      if (
        records.length === 0 ||
        records.some(
          (record, index) =>
            record.generation !== index + 1 ||
            record.previousRecordFingerprint !==
              (index === 0 ? null : (records[index - 1]?.recordFingerprint ?? null)),
        )
      ) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease history is incomplete or forked");
      }
      histories.set(parsedLeaseId.data, records);
    }

    const operations = new Map<OperationId, LeaseOperationRecord>();
    for (const entry of await readdir(this.#operationsRoot, { withFileTypes: true })) {
      const operationName = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      const parsedOperationId = operationIdSchema.safeParse(operationName);
      if (!entry.isFile() || !parsedOperationId.success) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "operation history contains a partial record");
      }
      const path = join(this.#operationsRoot, entry.name);
      await requireRegularSingleLinkFile(path);
      const record = parseOperationRecord(await readFile(path, "utf8"));
      if (
        record.operationId !== parsedOperationId.data ||
        record.operationRecordFingerprint !== sha256(canonicalJson(operationRecordPayload(record)))
      ) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease operation identity is invalid");
      }
      operations.set(parsedOperationId.data, record);
    }

    const latestObservedAt = [...operations.values()]
      .map((record) => record.receipt.observedAt)
      .sort(compareTimestamps)
      .at(-1);
    for (const history of histories.values()) {
      for (const record of history) {
        const operation = operations.get(record.operationId);
        if (
          operation?.operationFingerprint !== record.operationFingerprint ||
          operation.requestFingerprint !== record.requestFingerprint
        ) {
          throw new LeaseError(
            "LEASE_STORE_CORRUPT",
            "lease record is not bound to a committed operation",
          );
        }
      }
    }
    return { histories, operations, latestObservedAt };
  }

  async #withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(this.#lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        await delay(5);
      }
    }
    if (!acquired) {
      throw new LeaseError("LEASE_STORE_BUSY", "lease mutation lock could not be reconciled");
    }
    try {
      return await operation();
    } finally {
      await rmdir(this.#lockPath);
    }
  }
}

export async function createFileLeaseManager(
  options: FileLeaseManagerOptions,
): Promise<LeaseManager> {
  const root = await requirePhysicalDirectory(options.leaseRoot, "leaseRoot");
  const manager = new FileLeaseManager(
    root,
    options.now ?? (() => new Date().toISOString()),
    options.reconcileOwner ?? (() => Promise.resolve("NOT_PROVEN")),
  );
  await manager.initialize();
  return manager;
}
