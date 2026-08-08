import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { z } from "zod";

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
  readonly evidence: PilotEvidence;
  readonly observedAt: string;
}

export class PilotArchiveStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PilotArchiveStoreError";
  }
}

const storeKeyFilename = ".pilot-store-key";
const packageFilename = "package.json";
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
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch {
      // Another writer may have created the key. The exact file is verified below.
    }
  }
  return readStoreKey(stateRoot);
}

function packagePath(stateRoot: string, archiveId: string): string {
  return join(stateRoot, "archives", archiveId, packageFilename);
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

export class TrustedPilotArchive {
  readonly #archive: PilotArchive;

  private constructor(archive: PilotArchive) {
    this.#archive = archive;
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

export class FilePilotArchiveStore {
  readonly #stateRoot: string;

  public constructor(options: { readonly stateRoot: string }) {
    this.#stateRoot = resolve(options.stateRoot);
  }

  public write(input: PilotArchiveWriteInput): TrustedPilotArchive {
    const evidence = pilotEvidenceSchema.parse(input.evidence);
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
    ensureExactDirectory(join(this.#stateRoot, "archives"), "pilot Archive directory is not exact");
    ensureExactDirectory(dirname(path), "pilot Archive identity directory is not exact");
    if (existsSync(path)) {
      const existing = parseTrustedPackage(path, key).archive;
      if (canonicalJson(existing) !== canonicalJson(archive)) {
        throw new PilotArchiveStoreError("pilot Archive identity is already bound to other facts");
      }
      return createTrustedPilotArchive(existing);
    }
    try {
      writeFileSync(path, JSON.stringify(archive), { flag: "wx", mode: 0o600 });
    } catch {
      throw new PilotArchiveStoreError("pilot Archive package could not be written immutably");
    }
    return createTrustedPilotArchive(archive);
  }

  public read(archiveId: string): TrustedPilotArchive {
    const parsedArchiveId = archiveIdSchema.parse(archiveId);
    return parseTrustedPackage(
      packagePath(this.#stateRoot, parsedArchiveId),
      readStoreKey(this.#stateRoot),
    );
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
