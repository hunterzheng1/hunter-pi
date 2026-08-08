import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { z } from "zod";

import { TrustedPilotEvidenceCapture } from "./capture.js";
import { type PilotEvidence, pilotEvidenceSchema } from "./contracts.js";
import { canonicalJson, pilotFingerprint } from "./serialization.js";

const archiveIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "pilot Archive identities must be path-free");
const pilotArchiveFactsSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pilot-archive.v1"),
    archiveId: archiveIdSchema,
    archiveStatus: z.literal("ARCHIVED"),
    provenance: z.enum(["REAL_WINDOWS_PILOT", "FIXTURE", "TEST"]),
    fixture: z.boolean(),
    planFingerprint: fingerprintSchema,
    evidenceFingerprint: fingerprintSchema,
    evidence: pilotEvidenceSchema,
    observedAt: timestampSchema,
  })
  .superRefine((facts, context) => {
    if (facts.evidenceFingerprint !== pilotFingerprint(facts.evidence)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceFingerprint"],
        message: "pilot Archive does not bind the exact Evidence digest",
      });
    }
    if (facts.planFingerprint !== facts.evidence.planFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["planFingerprint"],
        message: "pilot Archive does not bind the Evidence plan fingerprint",
      });
    }
  });
export type PilotArchiveFacts = z.infer<typeof pilotArchiveFactsSchema>;

const pilotArchiveStoreReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-store-receipt.v1"),
  archiveId: archiveIdSchema,
  archiveFingerprint: fingerprintSchema,
  observedAt: timestampSchema,
  proof: fingerprintSchema,
});

const pilotArchiveIdentityReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-archive-identity.v1"),
  archiveId: archiveIdSchema,
  archiveFingerprint: fingerprintSchema,
  observedAt: timestampSchema,
  proof: fingerprintSchema,
});
type PilotArchiveIdentityReceipt = z.infer<typeof pilotArchiveIdentityReceiptSchema>;

const pilotArchiveCommitReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-archive-commit.v1"),
  archiveId: archiveIdSchema,
  archiveFingerprint: fingerprintSchema,
  observedAt: timestampSchema,
  proof: fingerprintSchema,
});
type PilotArchiveCommitReceipt = z.infer<typeof pilotArchiveCommitReceiptSchema>;

export const pilotArchiveSchema = z
  .strictObject({
    ...pilotArchiveFactsSchema.shape,
    archiveFingerprint: fingerprintSchema,
    storeReceipt: pilotArchiveStoreReceiptSchema,
  })
  .superRefine((archive, context) => {
    const facts: PilotArchiveFacts = {
      schemaVersion: archive.schemaVersion,
      archiveId: archive.archiveId,
      archiveStatus: archive.archiveStatus,
      provenance: archive.provenance,
      fixture: archive.fixture,
      planFingerprint: archive.planFingerprint,
      evidenceFingerprint: archive.evidenceFingerprint,
      evidence: archive.evidence,
      observedAt: archive.observedAt,
    };
    if (archive.evidenceFingerprint !== pilotFingerprint(archive.evidence)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceFingerprint"],
        message: "pilot Archive does not bind the exact Evidence digest",
      });
    }
    if (archive.planFingerprint !== archive.evidence.planFingerprint) {
      context.addIssue({
        code: "custom",
        path: ["planFingerprint"],
        message: "pilot Archive does not bind the Evidence plan fingerprint",
      });
    }
    if (archive.archiveFingerprint !== pilotFingerprint(facts)) {
      context.addIssue({
        code: "custom",
        path: ["archiveFingerprint"],
        message: "pilot Archive fingerprint does not match its immutable facts",
      });
    }
    if (
      archive.storeReceipt.archiveId !== archive.archiveId ||
      archive.storeReceipt.archiveFingerprint !== archive.archiveFingerprint ||
      archive.storeReceipt.observedAt !== archive.observedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["storeReceipt"],
        message: "pilot Archive store receipt does not bind the exact immutable package",
      });
    }
  });
export type PilotArchive = z.infer<typeof pilotArchiveSchema>;

export interface PilotArchiveWriteInput {
  readonly archiveId: string;
  readonly planFingerprint: Fingerprint;
  readonly capture: TrustedPilotEvidenceCapture;
  readonly observedAt: string;
}

export class PilotArchiveStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PilotArchiveStoreError";
  }
}

const storeKeyFilename = ".pilot-store-key";
const archiveDirectoryName = "archives";
const packageFilename = "package.json";
const archiveIdentityFilenameSuffix = ".identity.json";
const archiveCommitFilenameSuffix = ".committed.json";
const trustedStoreToken = Symbol("trusted-pilot-archive-store");

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function storeProof(
  key: Uint8Array,
  archiveId: string,
  archiveFingerprint: Fingerprint,
  observedAt: string,
): Fingerprint {
  const payload = canonicalJson({
    schemaVersion: "hpi-pilot-store-proof.v1",
    archiveId,
    archiveFingerprint,
    observedAt,
  });
  return fingerprintSchema.parse(
    `sha256:${createHmac("sha256", key).update(payload, "utf8").digest("hex")}`,
  );
}

function assertExactRegularFile(path: string, message: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new PilotArchiveStoreError(message);
    }
    if (realpathSync(path) !== resolve(path)) {
      throw new PilotArchiveStoreError(message);
    }
  } catch (error) {
    if (error instanceof PilotArchiveStoreError) throw error;
    throw new PilotArchiveStoreError(message);
  }
}

function assertExactDirectory(path: string, message: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PilotArchiveStoreError(message);
    }
    if (realpathSync(path) !== resolve(path)) {
      throw new PilotArchiveStoreError(message);
    }
  } catch (error) {
    if (error instanceof PilotArchiveStoreError) throw error;
    throw new PilotArchiveStoreError(message);
  }
}

function ensureExactDirectory(path: string, message: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path);
    } catch {
      if (!existsSync(path)) throw new PilotArchiveStoreError(message);
    }
  }
  assertExactDirectory(path, message);
}

function readStoreKey(stateRoot: string): Buffer {
  const path = join(stateRoot, storeKeyFilename);
  assertExactRegularFile(path, "pilot Archive store key is not an exact regular file");
  try {
    const key = readFileSync(path);
    if (key.byteLength !== 32) throw new Error("invalid key length");
    return key;
  } catch {
    throw new PilotArchiveStoreError("pilot Archive store key is unreadable");
  }
}

function loadOrCreateStoreKey(stateRoot: string): Buffer {
  mkdirSync(stateRoot, { recursive: true });
  assertExactDirectory(stateRoot, "pilot Archive store root is not an exact directory");
  const path = join(stateRoot, storeKeyFilename);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600, flush: true });
    } catch {
      // Another writer may have created the key. The exact file is verified below.
    }
  }
  return readStoreKey(stateRoot);
}

function packagePath(stateRoot: string, archiveId: string): string {
  return join(stateRoot, archiveDirectoryName, archiveId, packageFilename);
}

function identityReceiptPath(stateRoot: string, archiveId: string): string {
  return join(stateRoot, archiveDirectoryName, `${archiveId}${archiveIdentityFilenameSuffix}`);
}

function commitReceiptPath(stateRoot: string, archiveId: string): string {
  return join(stateRoot, archiveDirectoryName, `${archiveId}${archiveCommitFilenameSuffix}`);
}

function writeImmutableAtomically(path: string, content: string): void {
  const temporaryPath = join(dirname(path), `.pending-${randomBytes(16).toString("hex")}`);
  try {
    // Node's flush option uses the platform-supported file flush primitive;
    // direct fsyncSync reports EPERM for ordinary files on Windows.
    writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600, flush: true });
    linkSync(temporaryPath, path);
  } catch {
    throw new PilotArchiveStoreError("pilot Archive file could not be written immutably");
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup; the pending file cannot become the final path.
    }
  }
}

function parseIdentityReceipt(path: string, key: Uint8Array): PilotArchiveIdentityReceipt {
  assertExactRegularFile(path, "pilot Archive identity receipt is not an exact regular file");
  let receipt: PilotArchiveIdentityReceipt;
  try {
    receipt = pilotArchiveIdentityReceiptSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    throw new PilotArchiveStoreError("pilot Archive identity receipt is invalid or corrupt");
  }
  if (
    receipt.proof !==
    storeProof(key, receipt.archiveId, receipt.archiveFingerprint, receipt.observedAt)
  ) {
    throw new PilotArchiveStoreError("pilot Archive identity receipt proof is invalid");
  }
  return receipt;
}

function identityReceiptFor(
  archiveId: string,
  archiveFingerprint: Fingerprint,
  observedAt: string,
  key: Uint8Array,
): PilotArchiveIdentityReceipt {
  return pilotArchiveIdentityReceiptSchema.parse({
    schemaVersion: "hpi-pilot-archive-identity.v1",
    archiveId,
    archiveFingerprint,
    observedAt,
    proof: storeProof(key, archiveId, archiveFingerprint, observedAt),
  });
}

function commitReceiptFor(
  archiveId: string,
  archiveFingerprint: Fingerprint,
  observedAt: string,
  key: Uint8Array,
): PilotArchiveCommitReceipt {
  return pilotArchiveCommitReceiptSchema.parse({
    schemaVersion: "hpi-pilot-archive-commit.v1",
    archiveId,
    archiveFingerprint,
    observedAt,
    proof: storeProof(key, archiveId, archiveFingerprint, observedAt),
  });
}

function assertIdentityReceiptMatches(
  receipt: Pick<PilotArchiveIdentityReceipt, "archiveId" | "archiveFingerprint" | "observedAt">,
  archive: Pick<PilotArchive, "archiveId" | "archiveFingerprint" | "observedAt">,
): void {
  if (
    receipt.archiveId !== archive.archiveId ||
    receipt.archiveFingerprint !== archive.archiveFingerprint ||
    receipt.observedAt !== archive.observedAt
  ) {
    throw new PilotArchiveStoreError("pilot Archive identity is already bound to other facts");
  }
}

function ensureIdentityReceipt(
  path: string,
  expected: PilotArchiveIdentityReceipt,
  key: Uint8Array,
): PilotArchiveIdentityReceipt {
  if (!existsSync(path)) {
    try {
      writeImmutableAtomically(path, `${JSON.stringify(expected)}\n`);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  const actual = parseIdentityReceipt(path, key);
  assertIdentityReceiptMatches(actual, expected);
  return actual;
}

function parseCommitReceipt(path: string, key: Uint8Array): PilotArchiveCommitReceipt {
  assertExactRegularFile(path, "pilot Archive commit receipt is not an exact regular file");
  let receipt: PilotArchiveCommitReceipt;
  try {
    receipt = pilotArchiveCommitReceiptSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    throw new PilotArchiveStoreError("pilot Archive commit receipt is invalid or corrupt");
  }
  if (
    receipt.proof !==
    storeProof(key, receipt.archiveId, receipt.archiveFingerprint, receipt.observedAt)
  ) {
    throw new PilotArchiveStoreError("pilot Archive commit receipt proof is invalid");
  }
  return receipt;
}

function ensureCommitReceipt(
  path: string,
  expected: PilotArchiveCommitReceipt,
  key: Uint8Array,
): PilotArchiveCommitReceipt {
  if (!existsSync(path)) {
    try {
      writeImmutableAtomically(path, `${JSON.stringify(expected)}\n`);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  const actual = parseCommitReceipt(path, key);
  assertIdentityReceiptMatches(actual, expected);
  return actual;
}

function createTrustedPilotArchive(archive: PilotArchive): TrustedPilotArchive {
  return TrustedPilotArchive.fromStore(deepFreeze(archive), trustedStoreToken);
}

function parseTrustedPackage(path: string, key: Uint8Array): TrustedPilotArchive {
  assertExactRegularFile(path, "pilot Archive package is not an exact regular file");
  let archive: PilotArchive;
  try {
    archive = pilotArchiveSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    throw new PilotArchiveStoreError("pilot Archive package is invalid or corrupt");
  }
  if (archive.provenance !== "REAL_WINDOWS_PILOT" || archive.fixture) {
    throw new PilotArchiveStoreError("pilot Archive fixture provenance is not trusted");
  }
  if (archive.evidence.captureProvenance !== "LIVE_WINDOWS_PILOT") {
    throw new PilotArchiveStoreError(
      "pilot Archive Evidence is not marked as a live Windows capture",
    );
  }
  const expectedProof = storeProof(
    key,
    archive.archiveId,
    archive.archiveFingerprint,
    archive.observedAt,
  );
  if (archive.storeReceipt.proof !== expectedProof) {
    throw new PilotArchiveStoreError("pilot Archive store proof is invalid");
  }
  return createTrustedPilotArchive(archive);
}

function parsePackageBoundToIdentity(
  stateRoot: string,
  archiveId: string,
  key: Uint8Array,
): TrustedPilotArchive {
  const identity = parseIdentityReceipt(identityReceiptPath(stateRoot, archiveId), key);
  const trusted = parseTrustedPackage(packagePath(stateRoot, archiveId), key);
  assertIdentityReceiptMatches(identity, trusted.archive);
  return trusted;
}

function parseBoundArchive(
  stateRoot: string,
  archiveId: string,
  key: Uint8Array,
): TrustedPilotArchive {
  const trusted = parsePackageBoundToIdentity(stateRoot, archiveId, key);
  const commit = parseCommitReceipt(commitReceiptPath(stateRoot, archiveId), key);
  assertIdentityReceiptMatches(commit, trusted.archive);
  return trusted;
}

export class TrustedPilotArchive {
  readonly #archive: PilotArchive;

  private constructor(archive: PilotArchive) {
    this.#archive = archive;
    Object.freeze(this);
  }

  public static isTrusted(value: unknown): value is TrustedPilotArchive {
    if (!(value instanceof TrustedPilotArchive)) return false;
    try {
      return value.#archive === value.archive;
    } catch {
      return false;
    }
  }

  public static fromStore(archive: PilotArchive, token: symbol): TrustedPilotArchive {
    if (token !== trustedStoreToken)
      throw new PilotArchiveStoreError("pilot Archive is not trusted");
    return new TrustedPilotArchive(archive);
  }

  public get archive(): PilotArchive {
    return this.#archive;
  }
}

export function isTrustedPilotArchive(value: unknown): value is TrustedPilotArchive {
  return TrustedPilotArchive.isTrusted(value);
}

export class FilePilotArchiveStore {
  readonly #stateRoot: string;

  public constructor(options: { readonly stateRoot: string }) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public write(input: PilotArchiveWriteInput): TrustedPilotArchive {
    if (!(input.capture instanceof TrustedPilotEvidenceCapture)) {
      throw new PilotArchiveStoreError("pilot Archive requires a trusted live capture authority");
    }
    let evidence: PilotEvidence;
    try {
      evidence = pilotEvidenceSchema.parse(input.capture.evidence);
    } catch {
      throw new PilotArchiveStoreError("pilot Archive capture authority is invalid");
    }
    if (evidence.captureProvenance !== "LIVE_WINDOWS_PILOT") {
      throw new PilotArchiveStoreError(
        "pilot Archive Evidence is not marked as a live Windows capture",
      );
    }
    if (input.observedAt !== evidence.observedAt) {
      throw new PilotArchiveStoreError(
        "pilot Archive observation time must bind the exact Evidence observation",
      );
    }
    const facts = pilotArchiveFactsSchema.parse({
      schemaVersion: "hpi-pilot-archive.v1",
      archiveId: input.archiveId,
      archiveStatus: "ARCHIVED",
      provenance: "REAL_WINDOWS_PILOT",
      fixture: false,
      planFingerprint: input.planFingerprint,
      evidenceFingerprint: pilotFingerprint(evidence),
      evidence,
      observedAt: input.observedAt,
    });
    const archiveFingerprint = pilotFingerprint(facts);
    const key = loadOrCreateStoreKey(this.#stateRoot);
    const archive = pilotArchiveSchema.parse({
      ...facts,
      archiveFingerprint,
      storeReceipt: {
        schemaVersion: "hpi-pilot-store-receipt.v1",
        archiveId: facts.archiveId,
        archiveFingerprint,
        observedAt: facts.observedAt,
        proof: storeProof(key, facts.archiveId, archiveFingerprint, facts.observedAt),
      },
    });
    const path = packagePath(this.#stateRoot, archive.archiveId);
    const archivesDirectory = join(this.#stateRoot, archiveDirectoryName);
    const identityPath = identityReceiptPath(this.#stateRoot, archive.archiveId);
    const commitPath = commitReceiptPath(this.#stateRoot, archive.archiveId);
    ensureExactDirectory(archivesDirectory, "pilot Archive directory is not exact");
    ensureExactDirectory(dirname(path), "pilot Archive identity directory is not exact");
    const packageExists = existsSync(path);
    const identityExists = existsSync(identityPath);
    const commitExists = existsSync(commitPath);
    if (packageExists && !identityExists) {
      throw new PilotArchiveStoreError("pilot Archive identity receipt is missing");
    }
    const identity = ensureIdentityReceipt(
      identityPath,
      identityReceiptFor(archive.archiveId, archive.archiveFingerprint, archive.observedAt, key),
      key,
    );
    const expectedCommit = commitReceiptFor(
      archive.archiveId,
      archive.archiveFingerprint,
      archive.observedAt,
      key,
    );
    if (commitExists) {
      const committed = parseCommitReceipt(commitPath, key);
      assertIdentityReceiptMatches(committed, archive);
      if (!existsSync(path)) {
        throw new PilotArchiveStoreError(
          "pilot Archive committed identity is reserved but its package is missing",
        );
      }
    }
    let storedArchive: TrustedPilotArchive;
    if (existsSync(path)) {
      storedArchive = parsePackageBoundToIdentity(this.#stateRoot, archive.archiveId, key);
    } else {
      try {
        writeImmutableAtomically(path, `${JSON.stringify(archive)}\n`);
        storedArchive = parsePackageBoundToIdentity(this.#stateRoot, archive.archiveId, key);
      } catch (error) {
        if (!existsSync(path)) throw error;
        storedArchive = parsePackageBoundToIdentity(this.#stateRoot, archive.archiveId, key);
      }
    }
    assertIdentityReceiptMatches(identity, storedArchive.archive);
    if (canonicalJson(storedArchive.archive) !== canonicalJson(archive)) {
      throw new PilotArchiveStoreError("pilot Archive identity is already bound to other facts");
    }
    ensureCommitReceipt(commitPath, expectedCommit, key);
    return parseBoundArchive(this.#stateRoot, archive.archiveId, key);
  }

  public read(archiveId: string): TrustedPilotArchive {
    const parsedArchiveId = archiveIdSchema.parse(archiveId);
    return parseBoundArchive(this.#stateRoot, parsedArchiveId, readStoreKey(this.#stateRoot));
  }

  public static readPackageFile(path: string): TrustedPilotArchive {
    const packageAbsolutePath = resolve(path);
    if (basename(packageAbsolutePath) !== packageFilename) {
      throw new PilotArchiveStoreError("pilot Archive package path is invalid");
    }
    const archiveDirectory = dirname(packageAbsolutePath);
    const archiveId = archiveDirectory.split(/[\\/]/u).at(-1);
    if (archiveId === undefined)
      throw new PilotArchiveStoreError("pilot Archive identity is missing");
    const stateRoot = dirname(dirname(archiveDirectory));
    const store = new FilePilotArchiveStore({ stateRoot });
    const expectedPath = packagePath(store.#stateRoot, archiveId);
    if (expectedPath !== packageAbsolutePath) {
      throw new PilotArchiveStoreError("pilot Archive package path is outside its trusted store");
    }
    return store.read(archiveId);
  }
}
