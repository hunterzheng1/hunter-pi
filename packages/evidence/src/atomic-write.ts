import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { rmSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
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

export const durableMutationLockBoundaries = [
  "AFTER_RECONCILIATION_CLAIM_PUBLISH",
  "AFTER_RECONCILIATION_RECEIPT_PUBLISH",
  "AFTER_STALE_OWNER_REMOVE",
] as const;
export type DurableMutationLockBoundary = (typeof durableMutationLockBoundaries)[number];
export type DurableMutationLockFaultInjector = (
  boundary: DurableMutationLockBoundary,
) => Promise<void> | void;
export interface DurableMutationLockOptions {
  readonly faultInjector?: DurableMutationLockFaultInjector;
}

const lockIdentitySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
const livenessPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{40,256}$/u);
const durableMutationLockOwnerSchema = z.strictObject({
  schemaVersion: z.literal("hpi-durable-mutation-lock-owner.v2"),
  lockId: lockIdentitySchema,
  ownerPid: z.number().int().positive(),
  ownerLivenessId: lockIdentitySchema,
  ownerPublicKey: livenessPublicKeySchema,
  acquiredAt: timestampSchema,
});
type DurableMutationLockOwner = z.infer<typeof durableMutationLockOwnerSchema>;

const durableMutationLockReconciliationClaimSchema = z.strictObject({
  schemaVersion: z.literal("hpi-durable-mutation-lock-reconciliation-claim.v2"),
  claimId: lockIdentitySchema,
  staleLockId: lockIdentitySchema,
  staleOwnerPid: z.number().int().positive(),
  staleOwnerLivenessFingerprint: fingerprintSchema,
  ownerRecordFingerprint: fingerprintSchema,
  reconcilerPid: z.number().int().positive(),
  reconcilerLivenessId: lockIdentitySchema,
  reconcilerPublicKey: livenessPublicKeySchema,
  observedAt: timestampSchema,
});
type DurableMutationLockReconciliationClaim = z.infer<
  typeof durableMutationLockReconciliationClaimSchema
>;

export const durableMutationLockReconciliationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-durable-mutation-lock-reconciliation-receipt.v2"),
    receiptId: fingerprintSchema,
    receiptFingerprint: fingerprintSchema,
    staleLockId: lockIdentitySchema,
    staleOwnerPid: z.number().int().positive(),
    staleOwnerLivenessFingerprint: fingerprintSchema,
    ownerRecordFingerprint: fingerprintSchema,
    reconcilerPid: z.number().int().positive(),
    observedAt: timestampSchema,
    outcome: z.literal("OWNER_PROCESS_NOT_FOUND"),
  })
  .superRefine((receipt, context) => {
    if (receipt.receiptFingerprint !== reconciliationReceiptFingerprint(receipt)) {
      context.addIssue({
        code: "custom",
        path: ["receiptFingerprint"],
        message: "Mutation-lock reconciliation receipt fingerprint does not match its facts",
      });
    }
  });
export type DurableMutationLockReconciliationReceipt = z.infer<
  typeof durableMutationLockReconciliationReceiptSchema
>;

export const durableMutationLockClaimRecoveryReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-durable-mutation-lock-claim-recovery-receipt.v1"),
    receiptId: fingerprintSchema,
    claimId: lockIdentitySchema,
    staleLockId: lockIdentitySchema,
    staleReconcilerPid: z.number().int().positive(),
    staleReconcilerLivenessFingerprint: fingerprintSchema,
    claimRecordFingerprint: fingerprintSchema,
    observedAt: timestampSchema,
    outcome: z.literal("RECONCILER_PROCESS_NOT_FOUND"),
  })
  .superRefine((receipt, context) => {
    if (receipt.receiptId !== claimRecoveryReceiptFingerprint(receipt)) {
      context.addIssue({
        code: "custom",
        path: ["receiptId"],
        message: "Mutation-lock claim recovery receipt identity does not match its facts",
      });
    }
  });
export type DurableMutationLockClaimRecoveryReceipt = z.infer<
  typeof durableMutationLockClaimRecoveryReceiptSchema
>;

function reconciliationReceiptFingerprint(
  receipt: Omit<DurableMutationLockReconciliationReceipt, "receiptFingerprint">,
) {
  return sha256Fingerprint(
    canonicalJson({
      schemaVersion: receipt.schemaVersion,
      receiptId: receipt.receiptId,
      staleLockId: receipt.staleLockId,
      staleOwnerPid: receipt.staleOwnerPid,
      staleOwnerLivenessFingerprint: receipt.staleOwnerLivenessFingerprint,
      ownerRecordFingerprint: receipt.ownerRecordFingerprint,
      reconcilerPid: receipt.reconcilerPid,
      observedAt: receipt.observedAt,
      outcome: receipt.outcome,
    }),
  );
}

function claimRecoveryReceiptFingerprint(
  receipt: Omit<DurableMutationLockClaimRecoveryReceipt, "receiptId">,
) {
  return sha256Fingerprint(
    canonicalJson({
      schemaVersion: receipt.schemaVersion,
      claimId: receipt.claimId,
      staleLockId: receipt.staleLockId,
      staleReconcilerPid: receipt.staleReconcilerPid,
      staleReconcilerLivenessFingerprint: receipt.staleReconcilerLivenessFingerprint,
      claimRecordFingerprint: receipt.claimRecordFingerprint,
      observedAt: receipt.observedAt,
      outcome: receipt.outcome,
    }),
  );
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OwnerSnapshot {
  readonly identity: FileIdentity;
  readonly owner: DurableMutationLockOwner;
  readonly fingerprint: ReturnType<typeof sha256Fingerprint>;
}

interface ReconciliationClaimSnapshot {
  readonly identity: FileIdentity;
  readonly claim: DurableMutationLockReconciliationClaim;
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

interface ProcessLivenessAuthority {
  readonly livenessId: string;
  readonly publicKey: string;
}

type ProcessLivenessState = "ALIVE" | "NOT_FOUND" | "UNKNOWN";

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

function claimRecoveryReceiptPath(
  lockPath: string,
  claimId: string,
): { readonly directory: string; readonly filename: string; readonly path: string } {
  const directory = join(mutationLockMetadataRoot(lockPath), "claim-receipts");
  const filename = `${claimId}.json`;
  return { directory, filename, path: join(directory, filename) };
}

function livenessEndpoint(livenessId: string): string {
  const parsed = lockIdentitySchema.parse(livenessId);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\hunter-pi-lock-${parsed}`
    : join(tmpdir(), `hunter-pi-lock-${parsed}.sock`);
}

function livenessFingerprint(livenessId: string, publicKey: string) {
  return sha256Fingerprint(canonicalJson({ livenessId, publicKey }));
}

let processLivenessAuthorityPromise: Promise<ProcessLivenessAuthority> | undefined;

async function createProcessLivenessAuthority(): Promise<ProcessLivenessAuthority> {
  const livenessId = randomUUID();
  const endpoint = livenessEndpoint(livenessId);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const encodedPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  livenessPublicKeySchema.parse(encodedPublicKey);
  if (process.platform !== "win32") await rm(endpoint, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 256) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const challenge = input.slice(0, newline);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
        socket.destroy();
        return;
      }
      const signature = sign(null, Buffer.from(challenge, "base64url"), privateKey).toString(
        "base64url",
      );
      socket.end(`${signature}\n`);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  server.on("error", () => undefined);
  server.unref();
  if (process.platform !== "win32") {
    process.once("exit", () => {
      try {
        rmSync(endpoint, { force: true });
      } catch {
        // Process exit cleanup is best-effort; exact recovery removes stale endpoints.
      }
    });
  }
  return { livenessId, publicKey: encodedPublicKey };
}

function processLivenessAuthority(): Promise<ProcessLivenessAuthority> {
  processLivenessAuthorityPromise ??= createProcessLivenessAuthority();
  return processLivenessAuthorityPromise;
}

async function probeProcessLiveness(input: {
  readonly livenessId: string;
  readonly publicKey: string;
}): Promise<ProcessLivenessState> {
  let endpoint: string;
  let verifier: ReturnType<typeof createPublicKey>;
  try {
    endpoint = livenessEndpoint(input.livenessId);
    verifier = createPublicKey({
      format: "der",
      key: Buffer.from(livenessPublicKeySchema.parse(input.publicKey), "base64url"),
      type: "spki",
    });
  } catch {
    return "UNKNOWN";
  }
  const challenge = randomBytes(32).toString("base64url");
  const state = await new Promise<ProcessLivenessState>((resolvePromise) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let output = "";
    const settle = (value: ProcessLivenessState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      settle("UNKNOWN");
    }, 2_000);
    timer.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${challenge}\n`);
    });
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 512) {
        settle("UNKNOWN");
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const signature = Buffer.from(output.slice(0, newline), "base64url");
        settle(
          verify(null, Buffer.from(challenge, "base64url"), verifier, signature)
            ? "ALIVE"
            : "UNKNOWN",
        );
      } catch {
        settle("UNKNOWN");
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "NOT_FOUND" : "UNKNOWN");
    });
    socket.once("end", () => {
      if (!settled) settle("UNKNOWN");
    });
  });
  if (state === "NOT_FOUND" && process.platform !== "win32") {
    await rm(endpoint, { force: true }).catch(() => undefined);
  }
  return state;
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
  try {
    await rm(targetPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeIfIdentity(identity: FileIdentity, targetPath: string): Promise<boolean> {
  const targetIdentity = await readFileIdentity(targetPath);
  if (targetIdentity === undefined || !sameFileIdentity(identity, targetIdentity)) return false;
  try {
    await rm(targetPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
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
  const authority = await processLivenessAuthority();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = durableMutationLockOwnerSchema.parse({
      schemaVersion: "hpi-durable-mutation-lock-owner.v2",
      lockId: randomUUID(),
      ownerPid: process.pid,
      ownerLivenessId: authority.livenessId,
      ownerPublicKey: authority.publicKey,
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

async function createReconciliationClaim(
  metadataRoot: string,
  snapshot: OwnerSnapshot,
): Promise<OwnedReconciliationClaim> {
  const authority = await processLivenessAuthority();
  const claim = durableMutationLockReconciliationClaimSchema.parse({
    schemaVersion: "hpi-durable-mutation-lock-reconciliation-claim.v2",
    claimId: randomUUID(),
    staleLockId: snapshot.owner.lockId,
    staleOwnerPid: snapshot.owner.ownerPid,
    staleOwnerLivenessFingerprint: livenessFingerprint(
      snapshot.owner.ownerLivenessId,
      snapshot.owner.ownerPublicKey,
    ),
    ownerRecordFingerprint: snapshot.fingerprint,
    reconcilerPid: process.pid,
    reconcilerLivenessId: authority.livenessId,
    reconcilerPublicKey: authority.publicKey,
    observedAt: new Date().toISOString(),
  });
  const sourcePath = claimSourcePath(metadataRoot, claim.claimId);
  await writeCompletePrivateFile(sourcePath, `${canonicalJson(claim)}\n`);
  return { claim, sourcePath };
}

function receiptIdentity(claim: DurableMutationLockReconciliationClaim) {
  return {
    schemaVersion: "hpi-durable-mutation-lock-reconciliation-receipt.v2",
    staleLockId: claim.staleLockId,
    staleOwnerPid: claim.staleOwnerPid,
    staleOwnerLivenessFingerprint: claim.staleOwnerLivenessFingerprint,
    ownerRecordFingerprint: claim.ownerRecordFingerprint,
    outcome: "OWNER_PROCESS_NOT_FOUND",
  } as const;
}

async function readReconciliationReceipt(
  path: string,
): Promise<DurableMutationLockReconciliationReceipt> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock reconciliation receipt is missing or invalid.",
      error,
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
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
  const facts = {
    ...identity,
    receiptId: sha256Fingerprint(canonicalJson(identity)),
    reconcilerPid: claim.reconcilerPid,
    observedAt: claim.observedAt,
  } as const;
  const receipt = durableMutationLockReconciliationReceiptSchema.parse({
    ...facts,
    receiptFingerprint: reconciliationReceiptFingerprint(facts),
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
    prior.staleOwnerLivenessFingerprint !== receipt.staleOwnerLivenessFingerprint ||
    prior.ownerRecordFingerprint !== receipt.ownerRecordFingerprint
  ) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock reconciliation receipt conflicts with the dead owner record.",
    );
  }
  return prior;
}

async function readReconciliationClaimSnapshot(
  path: string,
): Promise<ReconciliationClaimSnapshot | undefined> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.ino === 0n) {
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable mutation-lock reconciliation claim is not an exact physical file.",
    );
  }
  let parsed: DurableMutationLockReconciliationClaim;
  try {
    parsed = durableMutationLockReconciliationClaimSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable mutation-lock reconciliation claim is unreadable.",
      error,
    );
  }
  const identity = await readFileIdentity(path);
  const initialIdentity = { device: initial.dev, inode: initial.ino };
  if (identity === undefined || !sameFileIdentity(initialIdentity, identity)) return undefined;
  return {
    identity,
    claim: parsed,
    fingerprint: sha256Fingerprint(canonicalJson(parsed)),
  };
}

function claimRecoveryIdentity(snapshot: ReconciliationClaimSnapshot) {
  return {
    schemaVersion: "hpi-durable-mutation-lock-claim-recovery-receipt.v1",
    claimId: snapshot.claim.claimId,
    staleLockId: snapshot.claim.staleLockId,
    staleReconcilerPid: snapshot.claim.reconcilerPid,
    staleReconcilerLivenessFingerprint: livenessFingerprint(
      snapshot.claim.reconcilerLivenessId,
      snapshot.claim.reconcilerPublicKey,
    ),
    claimRecordFingerprint: snapshot.fingerprint,
    observedAt: snapshot.claim.observedAt,
    outcome: "RECONCILER_PROCESS_NOT_FOUND",
  } as const;
}

async function readClaimRecoveryReceipt(
  path: string,
): Promise<DurableMutationLockClaimRecoveryReceipt> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "A durable mutation-lock claim recovery receipt is not an immutable regular file.",
      );
    }
    return durableMutationLockClaimRecoveryReceiptSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock claim recovery receipt is unreadable.",
      error,
    );
  }
}

async function persistClaimRecoveryReceipt(
  lockPath: string,
  snapshot: ReconciliationClaimSnapshot,
): Promise<void> {
  const identity = claimRecoveryIdentity(snapshot);
  const receipt = durableMutationLockClaimRecoveryReceiptSchema.parse({
    ...identity,
    receiptId: claimRecoveryReceiptFingerprint(identity),
  });
  const target = claimRecoveryReceiptPath(lockPath, snapshot.claim.claimId);
  try {
    await writeImmutableAtomically({
      directory: target.directory,
      filename: target.filename,
      content: `${canonicalJson(receipt)}\n`,
    });
    return;
  } catch (error) {
    if (!(error instanceof DurableStoreError && error.code === "IDENTITY_CONFLICT")) throw error;
  }
  const prior = await readClaimRecoveryReceipt(target.path);
  if (canonicalJson(prior) !== canonicalJson(receipt)) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "A durable mutation-lock claim recovery receipt conflicts with the stale claim.",
    );
  }
}

async function tryRecoverStaleClaim(lockPath: string): Promise<boolean> {
  const guardPath = reconciliationClaimPath(lockPath);
  const snapshot = await readReconciliationClaimSnapshot(guardPath);
  if (snapshot === undefined) return false;
  const liveness = await probeProcessLiveness({
    livenessId: snapshot.claim.reconcilerLivenessId,
    publicKey: snapshot.claim.reconcilerPublicKey,
  });
  if (liveness !== "NOT_FOUND") return false;
  await persistClaimRecoveryReceipt(lockPath, snapshot);
  const removed = await removeIfIdentity(snapshot.identity, guardPath);
  if (!removed) return false;
  await removeIfIdentity(
    snapshot.identity,
    claimSourcePath(mutationLockMetadataRoot(lockPath), snapshot.claim.claimId),
  );
  return true;
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
  options: DurableMutationLockOptions,
): Promise<OwnedReconciliationClaim | undefined> {
  const guardPath = reconciliationClaimPath(lockPath);
  if (await pathExists(guardPath)) {
    await tryRecoverStaleClaim(lockPath);
    if (await pathExists(guardPath)) return undefined;
  }
  const observed = await readOwnerSnapshot(lockPath);
  if (observed.state === "ABSENT") return undefined;
  if (observed.state === "INVALID") {
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable mutation lock has no exact readable owner; recovery failed closed.",
    );
  }
  if (
    (await probeProcessLiveness({
      livenessId: observed.snapshot.owner.ownerLivenessId,
      publicKey: observed.snapshot.owner.ownerPublicKey,
    })) !== "NOT_FOUND"
  ) {
    return undefined;
  }

  const owned = await createReconciliationClaim(metadataRoot, observed.snapshot);
  let keepClaim = false;
  try {
    try {
      await link(owned.sourcePath, guardPath);
    } catch (error) {
      if (isAlreadyPresent(error)) return undefined;
      throw error;
    }
    await options.faultInjector?.("AFTER_RECONCILIATION_CLAIM_PUBLISH");
    const current = await readOwnerSnapshot(lockPath);
    const currentLiveness =
      current.state === "VALID"
        ? await probeProcessLiveness({
            livenessId: current.snapshot.owner.ownerLivenessId,
            publicKey: current.snapshot.owner.ownerPublicKey,
          })
        : "UNKNOWN";
    if (
      current.state !== "VALID" ||
      !sameFileIdentity(observed.snapshot.identity, current.snapshot.identity) ||
      current.snapshot.fingerprint !== observed.snapshot.fingerprint ||
      currentLiveness !== "NOT_FOUND"
    ) {
      return undefined;
    }
    await persistReconciliationReceipt(lockPath, owned.claim);
    await options.faultInjector?.("AFTER_RECONCILIATION_RECEIPT_PUBLISH");
    if (!(await removeIfIdentity(current.snapshot.identity, lockPath))) return undefined;
    await options.faultInjector?.("AFTER_STALE_OWNER_REMOVE");
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

async function canonicalMutationLockPath(lockPath: string): Promise<string> {
  const requested = resolve(lockPath);
  const requestedParent = dirname(requested);
  await assertSafeDirectoryPath(requestedParent);
  await mkdir(requestedParent, { recursive: true });
  const physicalParent = await realpath(requestedParent);
  await assertSafeDirectoryPath(physicalParent);
  const requestedName = basename(requested);
  const physicalName = process.platform === "win32" ? requestedName.toLowerCase() : requestedName;
  return join(physicalParent, physicalName);
}

export async function withDurableMutationLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: DurableMutationLockOptions = {},
): Promise<T> {
  const absoluteLockPath = await canonicalMutationLockPath(lockPath);
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
          await tryRecoverStaleClaim(absoluteLockPath);
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
        ownedClaim ??= await tryReconcileStaleOwner(absoluteLockPath, metadataRoot, options);
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
