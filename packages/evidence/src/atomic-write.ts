import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";

import { DurableStoreError, isErrnoException, storeErrorFrom } from "./errors.js";
import { canonicalJson, sha256Fingerprint } from "./serialization.js";

export const atomicWriteBoundaries = [
  "BEFORE_TEMP_WRITE",
  "AFTER_TEMP_WRITE",
  "AFTER_TEMP_SYNC",
  "AFTER_PUBLISH",
] as const;
export type AtomicWriteBoundary = (typeof atomicWriteBoundaries)[number];
export type AtomicWriteFaultInjector = (boundary: AtomicWriteBoundary) => Promise<void> | void;

const lockIdentitySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
const durableMutationLockOwnerSchema = z.strictObject({
  schemaVersion: z.literal("hpi-durable-mutation-lock-owner.v1"),
  lockId: lockIdentitySchema,
  ownerPid: z.number().int().positive(),
  acquiredAt: timestampSchema,
});
type DurableMutationLockOwner = z.infer<typeof durableMutationLockOwnerSchema>;

const durableMutationLockReconciliationClaimSchema = z.strictObject({
  schemaVersion: z.literal("hpi-durable-mutation-lock-reconciliation-claim.v1"),
  claimId: lockIdentitySchema,
  staleLockId: lockIdentitySchema,
  staleOwnerPid: z.number().int().positive(),
  ownerRecordFingerprint: fingerprintSchema,
  reconcilerPid: z.number().int().positive(),
  observedAt: timestampSchema,
});
type DurableMutationLockReconciliationClaim = z.infer<
  typeof durableMutationLockReconciliationClaimSchema
>;

export const durableMutationLockReconciliationReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-durable-mutation-lock-reconciliation-receipt.v1"),
  receiptId: fingerprintSchema,
  staleLockId: lockIdentitySchema,
  staleOwnerPid: z.number().int().positive(),
  ownerRecordFingerprint: fingerprintSchema,
  reconcilerPid: z.number().int().positive(),
  observedAt: timestampSchema,
  outcome: z.literal("OWNER_PID_NOT_FOUND"),
});
export type DurableMutationLockReconciliationReceipt = z.infer<
  typeof durableMutationLockReconciliationReceiptSchema
>;

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OwnerSnapshot {
  readonly identity: FileIdentity;
  readonly owner: DurableMutationLockOwner;
  readonly fingerprint: ReturnType<typeof sha256Fingerprint>;
}

type OwnerSnapshotResult =
  | { readonly state: "ABSENT" }
  | { readonly state: "INVALID" }
  | { readonly snapshot: OwnerSnapshot; readonly state: "VALID" };

interface OwnedReconciliationClaim {
  readonly claim: DurableMutationLockReconciliationClaim;
  readonly sourcePath: string;
}

const mutationLockAttemptLimit = 200;
const mutationLockRetryDelayMs = 5;
const mutationLockMetadataDirectoryName = ".pending-hpi-mutation-lock-metadata";

function mutationLockMetadataRoot(lockPath: string): string {
  return join(dirname(lockPath), mutationLockMetadataDirectoryName);
}

function ownerSourcePath(metadataRoot: string, lockId: string): string {
  return join(metadataRoot, `owner-${lockId}`);
}

function claimSourcePath(metadataRoot: string, claimId: string): string {
  return join(metadataRoot, `claim-${claimId}`);
}

function reconciliationClaimPath(lockPath: string): string {
  const lockScope = sha256Fingerprint(lockPath).slice("sha256:".length);
  return join(mutationLockMetadataRoot(lockPath), `active-claim-${lockScope}`);
}

function reconciliationReceiptPath(
  lockPath: string,
  staleLockId: string,
): { readonly directory: string; readonly filename: string; readonly path: string } {
  const directory = join(mutationLockMetadataRoot(lockPath), "receipts");
  const filename = `${staleLockId}.json`;
  return { directory, filename, path: join(directory, filename) };
}

function isMissing(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return isErrnoException(error) && error.code === "EEXIST";
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.inode !== 0n && left.device === right.device && left.inode === right.inode;
}

async function readFileIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function removeIfSameFile(referencePath: string, targetPath: string): Promise<boolean> {
  const [reference, targetIdentity] = await Promise.all([
    readFileIdentity(referencePath),
    readFileIdentity(targetPath),
  ]);
  if (
    reference === undefined ||
    targetIdentity === undefined ||
    !sameFileIdentity(reference, targetIdentity)
  ) {
    return false;
  }
  await rm(targetPath);
  return true;
}

async function removeIfIdentity(identity: FileIdentity, targetPath: string): Promise<boolean> {
  const targetIdentity = await readFileIdentity(targetPath);
  if (targetIdentity === undefined || !sameFileIdentity(identity, targetIdentity)) return false;
  await rm(targetPath);
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeCompletePrivateFile(path: string, content: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createOwnerCandidate(metadataRoot: string): Promise<{
  readonly sourcePath: string;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = durableMutationLockOwnerSchema.parse({
      schemaVersion: "hpi-durable-mutation-lock-owner.v1",
      lockId: randomUUID(),
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    const sourcePath = ownerSourcePath(metadataRoot, owner.lockId);
    try {
      await writeCompletePrivateFile(sourcePath, `${canonicalJson(owner)}\n`);
      return { sourcePath };
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    }
  }
  throw new DurableStoreError(
    "STORE_BUSY",
    "A unique durable mutation-lock owner record could not be prepared.",
  );
}

async function readOwnerSnapshot(lockPath: string): Promise<OwnerSnapshotResult> {
  let initialStats: Awaited<ReturnType<typeof lstat>>;
  try {
    initialStats = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return { state: "ABSENT" };
    throw error;
  }
  if (!initialStats.isFile() || initialStats.isSymbolicLink() || initialStats.ino === 0n) {
    return { state: "INVALID" };
  }
  const firstIdentity = { device: initialStats.dev, inode: initialStats.ino };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isMissing(error)) return { state: "ABSENT" };
    return { state: "INVALID" };
  }
  const parsed = durableMutationLockOwnerSchema.safeParse(parsedJson);
  if (!parsed.success) return { state: "INVALID" };
  const secondIdentity = await readFileIdentity(lockPath);
  if (secondIdentity === undefined || !sameFileIdentity(firstIdentity, secondIdentity)) {
    return { state: "ABSENT" };
  }
  return {
    state: "VALID",
    snapshot: {
      identity: secondIdentity,
      owner: parsed.data,
      fingerprint: sha256Fingerprint(canonicalJson(parsed.data)),
    },
  };
}

function probeOwnerPid(ownerPid: number): "ALIVE" | "NOT_FOUND" | "UNKNOWN" {
  try {
    process.kill(ownerPid, 0);
    return "ALIVE";
  } catch (error) {
    return isErrnoException(error) && error.code === "ESRCH" ? "NOT_FOUND" : "UNKNOWN";
  }
}

async function createReconciliationClaim(
  metadataRoot: string,
  snapshot: OwnerSnapshot,
): Promise<OwnedReconciliationClaim> {
  const claim = durableMutationLockReconciliationClaimSchema.parse({
    schemaVersion: "hpi-durable-mutation-lock-reconciliation-claim.v1",
    claimId: randomUUID(),
    staleLockId: snapshot.owner.lockId,
    staleOwnerPid: snapshot.owner.ownerPid,
    ownerRecordFingerprint: snapshot.fingerprint,
    reconcilerPid: process.pid,
    observedAt: new Date().toISOString(),
  });
  const sourcePath = claimSourcePath(metadataRoot, claim.claimId);
  await writeCompletePrivateFile(sourcePath, `${canonicalJson(claim)}\n`);
  return { claim, sourcePath };
}

function receiptIdentity(claim: DurableMutationLockReconciliationClaim) {
  return {
    schemaVersion: "hpi-durable-mutation-lock-reconciliation-receipt.v1",
    staleLockId: claim.staleLockId,
    staleOwnerPid: claim.staleOwnerPid,
    ownerRecordFingerprint: claim.ownerRecordFingerprint,
    outcome: "OWNER_PID_NOT_FOUND",
  } as const;
}

async function readReconciliationReceipt(
  path: string,
): Promise<DurableMutationLockReconciliationReceipt> {
  const identity = await readFileIdentity(path);
  if (identity === undefined) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock reconciliation receipt is missing or invalid.",
    );
  }
  try {
    return durableMutationLockReconciliationReceiptSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock reconciliation receipt is unreadable.",
      error,
    );
  }
}

async function persistReconciliationReceipt(
  lockPath: string,
  claim: DurableMutationLockReconciliationClaim,
): Promise<DurableMutationLockReconciliationReceipt> {
  const identity = receiptIdentity(claim);
  const receipt = durableMutationLockReconciliationReceiptSchema.parse({
    ...identity,
    receiptId: sha256Fingerprint(canonicalJson(identity)),
    reconcilerPid: claim.reconcilerPid,
    observedAt: claim.observedAt,
  });
  const target = reconciliationReceiptPath(lockPath, claim.staleLockId);
  try {
    await writeImmutableAtomically({
      directory: target.directory,
      filename: target.filename,
      content: `${canonicalJson(receipt)}\n`,
    });
    return receipt;
  } catch (error) {
    if (!(error instanceof DurableStoreError && error.code === "IDENTITY_CONFLICT")) {
      throw error;
    }
  }
  const prior = await readReconciliationReceipt(target.path);
  if (
    prior.receiptId !== receipt.receiptId ||
    prior.staleLockId !== receipt.staleLockId ||
    prior.staleOwnerPid !== receipt.staleOwnerPid ||
    prior.ownerRecordFingerprint !== receipt.ownerRecordFingerprint
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock reconciliation receipt conflicts with the dead owner record.",
    );
  }
  return prior;
}

async function releaseOwnedClaim(lockPath: string, owned: OwnedReconciliationClaim): Promise<void> {
  const guardPath = reconciliationClaimPath(lockPath);
  const guardExists = await pathExists(guardPath);
  const guardChanged = guardExists && !(await removeIfSameFile(owned.sourcePath, guardPath));
  await rm(owned.sourcePath, { force: true });
  if (guardChanged) {
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable mutation-lock reconciliation claim changed before release.",
    );
  }
}

async function tryReconcileStaleOwner(
  lockPath: string,
  metadataRoot: string,
): Promise<OwnedReconciliationClaim | undefined> {
  const guardPath = reconciliationClaimPath(lockPath);
  if (await pathExists(guardPath)) return undefined;
  const observed = await readOwnerSnapshot(lockPath);
  if (observed.state === "ABSENT") return undefined;
  if (observed.state === "INVALID") {
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable mutation lock has no exact readable owner; recovery failed closed.",
    );
  }
  if (probeOwnerPid(observed.snapshot.owner.ownerPid) !== "NOT_FOUND") return undefined;

  const owned = await createReconciliationClaim(metadataRoot, observed.snapshot);
  let keepClaim = false;
  try {
    try {
      await link(owned.sourcePath, guardPath);
    } catch (error) {
      if (isAlreadyPresent(error)) return undefined;
      throw error;
    }
    const current = await readOwnerSnapshot(lockPath);
    if (
      current.state !== "VALID" ||
      !sameFileIdentity(observed.snapshot.identity, current.snapshot.identity) ||
      current.snapshot.fingerprint !== observed.snapshot.fingerprint ||
      probeOwnerPid(current.snapshot.owner.ownerPid) !== "NOT_FOUND"
    ) {
      return undefined;
    }
    await persistReconciliationReceipt(lockPath, owned.claim);
    if (!(await removeIfIdentity(current.snapshot.identity, lockPath))) return undefined;
    await removeIfIdentity(
      current.snapshot.identity,
      ownerSourcePath(metadataRoot, current.snapshot.owner.lockId),
    );
    keepClaim = true;
    return owned;
  } finally {
    if (!keepClaim) {
      await releaseOwnedClaim(lockPath, owned).catch(() => undefined);
    }
  }
}

export async function assertSafeDirectoryPath(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new DurableStoreError(
          "INVALID_TARGET",
          "An immutable state directory cannot contain a symbolic link or non-directory component.",
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function withDurableMutationLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const absoluteLockPath = resolve(lockPath);
  const parent = dirname(absoluteLockPath);
  await assertSafeDirectoryPath(parent);
  await mkdir(parent, { recursive: true });
  const metadataRoot = mutationLockMetadataRoot(absoluteLockPath);
  await assertSafeDirectoryPath(metadataRoot);
  await mkdir(metadataRoot, { recursive: true });
  const candidate = await createOwnerCandidate(metadataRoot);
  let acquired = false;
  let ownedClaim: OwnedReconciliationClaim | undefined;
  try {
    for (let attempt = 0; attempt < mutationLockAttemptLimit; attempt += 1) {
      try {
        await link(candidate.sourcePath, absoluteLockPath);
        if (
          ownedClaim === undefined &&
          (await pathExists(reconciliationClaimPath(absoluteLockPath)))
        ) {
          await removeIfSameFile(candidate.sourcePath, absoluteLockPath);
        } else {
          acquired = true;
          if (ownedClaim !== undefined) {
            await releaseOwnedClaim(absoluteLockPath, ownedClaim);
            ownedClaim = undefined;
          }
          break;
        }
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        ownedClaim ??= await tryReconcileStaleOwner(absoluteLockPath, metadataRoot);
      }
      await delay(mutationLockRetryDelayMs);
    }
    if (!acquired) {
      throw new DurableStoreError(
        "STORE_BUSY",
        "A durable state mutation lock could not be acquired; retry after the owner exits.",
      );
    }
    return await operation();
  } finally {
    if (acquired) {
      await removeIfSameFile(candidate.sourcePath, absoluteLockPath);
    }
    if (ownedClaim !== undefined) {
      await releaseOwnedClaim(absoluteLockPath, ownedClaim).catch(() => undefined);
    }
    await rm(candidate.sourcePath, { force: true });
  }
}

export async function writeImmutableAtomically(options: {
  readonly directory: string;
  readonly filename: string;
  readonly content: string;
  readonly faultInjector?: AtomicWriteFaultInjector;
}): Promise<void> {
  if (
    options.filename.length === 0 ||
    options.filename === "." ||
    options.filename === ".." ||
    options.filename.includes("/") ||
    options.filename.includes("\\") ||
    options.filename.includes("\0")
  ) {
    throw new DurableStoreError(
      "INVALID_TARGET",
      "An immutable write filename must be one contained path segment.",
    );
  }
  await assertSafeDirectoryPath(options.directory);
  await mkdir(options.directory, { recursive: true });
  const temporaryName = `.pending-${randomUUID()}`;
  const temporaryPath = join(options.directory, temporaryName);
  const finalPath = join(options.directory, options.filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await options.faultInjector?.("BEFORE_TEMP_WRITE");
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(options.content, "utf8");
    await options.faultInjector?.("AFTER_TEMP_WRITE");
    await handle.sync();
    await options.faultInjector?.("AFTER_TEMP_SYNC");
    await handle.close();
    handle = undefined;
    await link(temporaryPath, finalPath);
    await options.faultInjector?.("AFTER_PUBLISH");
  } catch (error) {
    throw storeErrorFrom(error, "FAULT_INJECTED");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
