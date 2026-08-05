import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
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
  leaseBindReceiptSchema,
  leaseBindRequestSchema,
  leaseMutationReceiptSchema,
  leaseReleaseRequestSchema,
  leaseResourceSchema,
  leaseRenewRequestSchema,
  leaseStatusReceiptSchema,
  type LeaseAcquireReceipt,
  type LeaseAcquireRequest,
  type LeaseBindRequest,
  type LeaseBindResult,
  type LeaseManager,
  type LeaseMutationReceipt,
  type LeaseReasonCode,
  type LeaseReleaseRequest,
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
  bindingFingerprint: fingerprintSchema.nullable(),
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
const ownerLivenessSchema = z.enum(["ALIVE", "DEAD", "NOT_PROVEN"]);

const transactionReceiptSchema = z.union([
  leaseAcquireReceiptSchema,
  leaseBindReceiptSchema,
  leaseMutationReceiptSchema,
]);
const leaseTransactionPayloadSchema = z.strictObject({
  schemaVersion: z.literal("hpi-local-lease-transaction.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
  receipt: transactionReceiptSchema,
  mutations: z.array(leaseRecordSchema),
});
const leaseTransactionSchema = leaseTransactionPayloadSchema.safeExtend({
  transactionFingerprint: fingerprintSchema,
});
type LeaseTransaction = z.infer<typeof leaseTransactionSchema>;

export interface FileLeaseManagerOptions {
  readonly leaseRoot: string;
  readonly now?: () => string;
  readonly reconcileOwner?: (
    ownerFingerprint: Fingerprint,
  ) => Promise<"ALIVE" | "DEAD" | "NOT_PROVEN">;
}

interface LeaseState {
  readonly histories: ReadonlyMap<WriterLeaseId, readonly LeaseRecord[]>;
  readonly operations: ReadonlyMap<OperationId, LeaseTransaction>;
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

function transactionPayload(
  transaction: LeaseTransaction,
): z.infer<typeof leaseTransactionPayloadSchema> {
  const payload: Record<string, unknown> = { ...transaction };
  delete payload["transactionFingerprint"];
  return leaseTransactionPayloadSchema.parse(payload);
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

async function writeAtomicTransaction(
  directory: string,
  filename: string,
  content: string,
): Promise<void> {
  const pendingPath = join(directory, `.pending-${randomUUID()}`);
  const finalPath = join(directory, filename);
  try {
    await lstat(finalPath);
    throw new LeaseError("LEASE_OPERATION_CONFLICT", "lease operation identity already exists");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(pendingPath, finalPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(pendingPath).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

function parseTransaction(text: string): LeaseTransaction {
  try {
    return leaseTransactionSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new LeaseError("LEASE_STORE_CORRUPT", "lease transaction schema is invalid");
  }
}

function compareTimestamps(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

class FileLeaseManager implements LeaseManager {
  readonly #root: string;
  readonly #transactionsRoot: string;
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
    this.#transactionsRoot = join(root, "transactions");
    this.#lockPath = join(root, ".mutation-lock");
    this.#now = now;
    this.#reconcileOwner = reconcileOwner;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#transactionsRoot, { recursive: true });
    await requirePhysicalDirectory(this.#transactionsRoot, "transactions root");
    await this.#withMutationLock(async () => {
      for (const entry of await readdir(this.#transactionsRoot, { withFileTypes: true })) {
        if (!entry.name.startsWith(".pending-")) continue;
        const path = join(this.#transactionsRoot, entry.name);
        if (!entry.isFile()) {
          throw new LeaseError("LEASE_STORE_CORRUPT", "pending lease transaction is not a file");
        }
        await requireRegularSingleLinkFile(path);
        await unlink(path);
      }
      await this.#readState();
    });
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
        this.#assertReplay(
          replay,
          parsed.operationFingerprint,
          requestFingerprint,
          "lease acquisition",
        );
        return { receipt: leaseAcquireReceiptSchema.parse(replay.receipt) };
      }
      const observedAt = this.#assertClock(state);
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
          const ownerStateResult = ownerLivenessSchema.safeParse(
            await this.#reconcileOwner(record.ownerFingerprint),
          );
          const ownerState = ownerStateResult.success ? ownerStateResult.data : "NOT_PROVEN";
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

      const mutations: z.infer<typeof leaseRecordPayloadSchema>[] = deadConflicts.map((record) =>
        leaseRecordPayloadSchema.parse({
          ...leaseRecordPayload(record),
          generation: record.generation + 1,
          state: "REVOKED",
          bindingFingerprint: null,
          observedAt,
          previousRecordFingerprint: record.recordFingerprint,
          operationId: parsed.operationId,
          operationFingerprint: parsed.operationFingerprint,
          requestFingerprint,
        }),
      );
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
      mutations.push(
        leaseRecordPayloadSchema.parse({
          schemaVersion: "hpi-local-lease-record.v1",
          leaseId: parsed.leaseId,
          workspaceId: parsed.workspaceId,
          ownerFingerprint: parsed.ownerFingerprint,
          resources,
          resourceSetFingerprint,
          generation: 1,
          state: "ACTIVE",
          bindingFingerprint: null,
          acquiredAt: observedAt,
          renewedAt: observedAt,
          expiresAt,
          observedAt,
          previousRecordFingerprint: null,
          operationId: parsed.operationId,
          operationFingerprint: parsed.operationFingerprint,
          requestFingerprint,
        }),
      );
      await this.#commitTransaction({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
        mutations,
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
      const observedAt = this.#assertClock(state);
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
          bindingFingerprint: record.bindingFingerprint,
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
      const receipt = this.#mutationReceipt("RENEW", payload);
      await this.#commitTransaction({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
        mutations: [payload],
      });
      return { receipt };
    });
  }

  public async bind(request: LeaseBindRequest): Promise<LeaseBindResult> {
    const parsed = leaseBindRequestSchema.parse(request);
    const leases = [...parsed.leases].sort((left, right) =>
      left.leaseId.localeCompare(right.leaseId),
    );
    const requestFingerprint = sha256(
      canonicalJson({
        schemaVersion: parsed.schemaVersion,
        bindingFingerprint: parsed.bindingFingerprint,
        leases,
      }),
    );
    return this.#withMutationLock(async () => {
      const state = await this.#readState();
      const replay = state.operations.get(parsed.operationId);
      if (replay !== undefined) {
        this.#assertReplay(
          replay,
          parsed.operationFingerprint,
          requestFingerprint,
          "lease binding",
        );
        return { receipt: leaseBindReceiptSchema.parse(replay.receipt), application: "REPLAYED" };
      }
      const observedAt = this.#assertClock(state);
      const records = leases.map((lease) => {
        const record = this.#requireOwnedActiveLease(state, lease.leaseId, lease.ownerFingerprint);
        if (compareTimestamps(record.expiresAt, observedAt) <= 0) {
          throw new LeaseError("LEASE_EXPIRED", "an expired lease cannot be bound");
        }
        if (record.bindingFingerprint !== null) {
          throw new LeaseError("LEASE_ALREADY_BOUND", "lease is already bound to a session");
        }
        return record;
      });
      const mutations = records.map((record) =>
        leaseRecordPayloadSchema.parse({
          ...leaseRecordPayload(record),
          generation: record.generation + 1,
          bindingFingerprint: parsed.bindingFingerprint,
          observedAt,
          previousRecordFingerprint: record.recordFingerprint,
          operationId: parsed.operationId,
          operationFingerprint: parsed.operationFingerprint,
          requestFingerprint,
        }),
      );
      const receipt = leaseBindReceiptSchema.parse({
        schemaVersion: "hpi-lease-bind-receipt.v1",
        action: "BIND",
        outcome: "BOUND",
        bindingFingerprint: parsed.bindingFingerprint,
        leaseSetFingerprint: sha256(canonicalJson(leases)),
        leaseCount: leases.length,
        observedAt,
      });
      await this.#commitTransaction({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
        mutations,
      });
      return { receipt, application: "APPLIED" };
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
        bindingFingerprint: parsed.bindingFingerprint,
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
      if (record.bindingFingerprint !== parsed.bindingFingerprint) {
        throw new LeaseError(
          "LEASE_BINDING_MISMATCH",
          "lease binding identity did not match the release request",
        );
      }
      const payload = leaseRecordPayloadSchema.parse({
        ...leaseRecordPayload(record),
        generation: record.generation + 1,
        state: "RELEASED",
        bindingFingerprint: null,
        observedAt,
        previousRecordFingerprint: record.recordFingerprint,
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
      });
      const receipt = this.#mutationReceipt("RELEASE", payload);
      await this.#commitTransaction({
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        receipt,
        mutations: [payload],
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

  #assertReplay(
    replay: LeaseTransaction,
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
    label: string,
  ): void {
    if (
      replay.operationFingerprint !== operationFingerprint ||
      replay.requestFingerprint !== requestFingerprint
    ) {
      throw new LeaseError(
        "LEASE_OPERATION_CONFLICT",
        `${label} replay changed its fingerprint or canonical request`,
      );
    }
  }

  #replayMutation(
    state: LeaseState,
    operationId: OperationId,
    operationFingerprint: Fingerprint,
    requestFingerprint: Fingerprint,
  ): { readonly receipt: LeaseMutationReceipt } | undefined {
    const replay = state.operations.get(operationId);
    if (replay === undefined) return undefined;
    this.#assertReplay(replay, operationFingerprint, requestFingerprint, "lease operation");
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
      bindingFingerprint: record.bindingFingerprint,
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
    await this.#commitTransaction({
      operationId: options.parsed.operationId,
      operationFingerprint: options.parsed.operationFingerprint,
      requestFingerprint: options.requestFingerprint,
      receipt,
      mutations: [],
    });
    return { receipt };
  }

  async #commitTransaction(options: {
    readonly operationId: OperationId;
    readonly operationFingerprint: Fingerprint;
    readonly requestFingerprint: Fingerprint;
    readonly receipt: z.infer<typeof transactionReceiptSchema>;
    readonly mutations: readonly z.infer<typeof leaseRecordPayloadSchema>[];
  }): Promise<void> {
    const mutations = options.mutations.map((payload) =>
      leaseRecordSchema.parse({
        ...payload,
        recordFingerprint: sha256(canonicalJson(payload)),
      }),
    );
    const payload = leaseTransactionPayloadSchema.parse({
      schemaVersion: "hpi-local-lease-transaction.v1",
      operationId: options.operationId,
      operationFingerprint: options.operationFingerprint,
      requestFingerprint: options.requestFingerprint,
      receipt: options.receipt,
      mutations,
    });
    const transaction = leaseTransactionSchema.parse({
      ...payload,
      transactionFingerprint: sha256(canonicalJson(payload)),
    });
    await writeAtomicTransaction(
      this.#transactionsRoot,
      `${options.operationId}.json`,
      `${canonicalJson(transaction)}\n`,
    );
  }

  async #readState(): Promise<LeaseState> {
    const [root, transactionsRoot] = await Promise.all([
      requirePhysicalDirectory(this.#root, "lease root"),
      requirePhysicalDirectory(this.#transactionsRoot, "transactions root"),
    ]);
    if (
      root !== this.#root ||
      transactionsRoot !== this.#transactionsRoot ||
      !isStrictlyContained(root, transactionsRoot)
    ) {
      throw new LeaseError("LEASE_STORE_CORRUPT", "lease storage identity changed");
    }
    const rootEntries = await readdir(this.#root, { withFileTypes: true });
    if (
      rootEntries.some((entry) => entry.name !== "transactions" && entry.name !== ".mutation-lock")
    ) {
      throw new LeaseError("LEASE_STORE_CORRUPT", "lease root contains an unknown entry");
    }

    const operations = new Map<OperationId, LeaseTransaction>();
    const histories = new Map<WriterLeaseId, LeaseRecord[]>();
    for (const entry of await readdir(this.#transactionsRoot, { withFileTypes: true })) {
      const operationName = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      const parsedOperationId = operationIdSchema.safeParse(operationName);
      if (!entry.isFile() || !parsedOperationId.success) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "transaction root contains a partial record");
      }
      const path = join(this.#transactionsRoot, entry.name);
      await requireRegularSingleLinkFile(path);
      const transaction = parseTransaction(await readFile(path, "utf8"));
      if (
        transaction.operationId !== parsedOperationId.data ||
        transaction.transactionFingerprint !==
          sha256(canonicalJson(transactionPayload(transaction)))
      ) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease transaction identity is invalid");
      }
      operations.set(parsedOperationId.data, transaction);
      for (const record of transaction.mutations) {
        if (
          record.operationId !== transaction.operationId ||
          record.operationFingerprint !== transaction.operationFingerprint ||
          record.requestFingerprint !== transaction.requestFingerprint ||
          record.recordFingerprint !== sha256(canonicalJson(leaseRecordPayload(record)))
        ) {
          throw new LeaseError("LEASE_STORE_CORRUPT", "lease mutation is not transaction-bound");
        }
        const history = histories.get(record.leaseId) ?? [];
        history.push(record);
        histories.set(record.leaseId, history);
      }
    }
    for (const history of histories.values()) {
      history.sort((left, right) => left.generation - right.generation);
      if (
        history.some(
          (record, index) =>
            record.generation !== index + 1 ||
            record.previousRecordFingerprint !==
              (index === 0 ? null : (history[index - 1]?.recordFingerprint ?? null)),
        )
      ) {
        throw new LeaseError("LEASE_STORE_CORRUPT", "lease history is incomplete or forked");
      }
    }
    const latestObservedAt = [...operations.values()]
      .map((transaction) => transaction.receipt.observedAt)
      .sort(compareTimestamps)
      .at(-1);
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
