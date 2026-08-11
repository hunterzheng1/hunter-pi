import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  distributionReleaseIdSchema,
  fingerprintSchema,
  timestampSchema,
  type DistributionReleaseId,
  type Fingerprint,
} from "@hunter-pi/domain";
import {
  canonicalJson,
  redactPortableText,
  sha256Fingerprint,
  withDurableMutationLock,
} from "@hunter-pi/evidence";

import {
  releaseCandidateSchema,
  type MigrationTransaction,
  type ReleaseAdapter,
  type ReleaseCandidate,
  type StagedRelease,
  type UpdateReconciliation,
} from "./contracts.js";
import {
  decodePortableBundle,
  extractPortableBundle,
  type PortableBundleManifest,
} from "./portable-bundle.js";

const execFileAsync = promisify(execFile);

const activePointerSchema = z.strictObject({
  schemaVersion: z.literal("hpi-portable-active.v1"),
  releaseId: distributionReleaseIdSchema,
  artifactFingerprint: fingerprintSchema,
  productVersion: z.string().min(1),
  activatedAt: timestampSchema,
});
type ActivePointer = z.infer<typeof activePointerSchema>;

const activationIntentSchema = z.strictObject({
  schemaVersion: z.literal("hpi-portable-activation-intent.v1"),
  candidate: releaseCandidateSchema,
  previousReleaseId: distributionReleaseIdSchema.nullable(),
  createdAt: timestampSchema,
});
type ActivationIntent = z.infer<typeof activationIntentSchema>;

const migrationStateSchema = z.strictObject({
  schemaVersion: z.literal("hpi-portable-migration.v1"),
  backupId: z.string().regex(/^[a-f0-9-]{36}$/u),
  candidateReleaseId: distributionReleaseIdSchema,
  previousReleaseId: distributionReleaseIdSchema.nullable(),
  stateFingerprint: fingerprintSchema,
  status: z.enum(["PREPARED", "COMMITTED", "ROLLED_BACK"]),
});
type MigrationState = z.infer<typeof migrationStateSchema>;

export interface FileWindowsPortableReleaseAdapterOptions {
  readonly installationRoot: string;
  readonly mutableStateDirectory?: string;
  readonly targetPlatform?: "win32-x64";
  readonly now?: () => string;
  readonly healthCheck?: (
    release: StagedRelease,
    directory: string,
  ) => Promise<{ readonly status: "PASS" } | { readonly status: "FAIL"; readonly reason: string }>;
  /** A deterministic interruption seam used by the crash-reconciliation contract tests. */
  readonly afterActivePointerPublished?: () => Promise<void>;
}

export interface WindowsPortableQualificationPromotionOptions {
  readonly installationRoot: string;
  readonly candidate: ReleaseCandidate;
  readonly qualificationVerifierFingerprint: Fingerprint;
}

export const windowsPortableQualificationPromotionReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-portable-qualification-promotion.v1"),
  outcome: z.enum(["PROMOTED", "NOOP"]),
  releaseId: distributionReleaseIdSchema,
  artifactFingerprint: fingerprintSchema,
  candidateFingerprint: fingerprintSchema,
});
export type WindowsPortableQualificationPromotionReceipt = z.infer<
  typeof windowsPortableQualificationPromotionReceiptSchema
>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safeReason(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  const redaction = redactPortableText(raw);
  const categories = redaction.categories.map((category) => `[REDACTED:${category}]`).join(" ");
  return `${fallback}${categories.length === 0 ? "" : ` ${categories}`}`.slice(0, 4_096);
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true });
  return existingCanonicalDirectory(absolute);
}

async function existingCanonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const status = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    comparablePath(canonical) !== comparablePath(absolute)
  ) {
    throw new Error("portable update state contains a symbolic link or non-directory");
  }
  return canonical;
}

async function readPhysicalFile(path: string): Promise<Uint8Array> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("portable qualification input is not a physical file");
  }
  return readFile(path);
}

async function readJsonIfPresent<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await canonicalDirectory(directory);
  const temporary = join(directory, `.pending-${randomUUID()}`);
  await writeFile(temporary, canonicalJson(value) + "\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function containedReleasePath(versionsRoot: string, releaseId: string): string {
  const parsed = distributionReleaseIdSchema.parse(releaseId);
  const target = resolve(versionsRoot, parsed);
  const relativeTarget = relative(resolve(versionsRoot), target);
  if (
    relativeTarget.length === 0 ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget) ||
    relativeTarget.includes(sep)
  ) {
    throw new Error("portable release id escaped the versions directory");
  }
  return target;
}

function qualificationNeutralCandidate(candidate: ReleaseCandidate): string {
  return canonicalJson({
    schemaVersion: candidate.schemaVersion,
    releaseId: candidate.releaseId,
    productVersion: candidate.productVersion,
    channel: candidate.channel,
    artifact: candidate.artifact,
    engine: candidate.engine,
    updatePolicy: candidate.updatePolicy,
    licenses: candidate.licenses,
  });
}

export async function promoteWindowsPortableQualification(
  options: WindowsPortableQualificationPromotionOptions,
): Promise<WindowsPortableQualificationPromotionReceipt> {
  const candidate = releaseCandidateSchema.parse(options.candidate);
  const qualificationVerifierFingerprint = fingerprintSchema.parse(
    options.qualificationVerifierFingerprint,
  );
  if (
    candidate.qualification.status !== "PASS" ||
    candidate.qualification.verifierFingerprint !== qualificationVerifierFingerprint
  ) {
    throw new Error("portable qualification promotion requires a trusted PASS candidate");
  }
  const installationRoot = await existingCanonicalDirectory(options.installationRoot);
  const stateRoot = await existingCanonicalDirectory(join(installationRoot, ".hpi-update"));
  const versionsRoot = await existingCanonicalDirectory(join(installationRoot, "versions"));
  const versionDirectory = await existingCanonicalDirectory(
    containedReleasePath(versionsRoot, candidate.releaseId),
  );
  const rootCandidatePath = join(installationRoot, "portable-release-candidate.json");
  const installedCandidatePath = join(versionDirectory, ".hpi-candidate.json");
  const candidateFingerprint = sha256Fingerprint(canonicalJson(candidate));

  return withDurableMutationLock(join(stateRoot, ".portable-mutation-lock"), async () => {
    const rootCandidate = releaseCandidateSchema.parse(
      JSON.parse(
        Buffer.from(await readPhysicalFile(rootCandidatePath)).toString("utf8"),
      ) as unknown,
    );
    const installedCandidate = releaseCandidateSchema.parse(
      JSON.parse(
        Buffer.from(await readPhysicalFile(installedCandidatePath)).toString("utf8"),
      ) as unknown,
    );
    const expectedIdentity = qualificationNeutralCandidate(candidate);
    if (
      qualificationNeutralCandidate(rootCandidate) !== expectedIdentity ||
      qualificationNeutralCandidate(installedCandidate) !== expectedIdentity
    ) {
      throw new Error("portable qualification candidate changes immutable release metadata");
    }

    for (const artifact of [
      await readPhysicalFile(join(installationRoot, "update.bundle.tgz")),
      await readPhysicalFile(join(versionDirectory, ".hpi-artifact")),
    ]) {
      if (
        artifact.byteLength !== candidate.artifact.byteLength ||
        sha256Fingerprint(artifact) !== candidate.artifact.fingerprint
      ) {
        throw new Error("portable qualification artifact does not match the release candidate");
      }
    }

    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const verified = await adapter.installedCandidate({ releaseId: candidate.releaseId });
    if (verified === undefined || qualificationNeutralCandidate(verified) !== expectedIdentity) {
      throw new Error("portable qualification could not verify the installed release");
    }

    if (
      canonicalJson(rootCandidate) === canonicalJson(candidate) &&
      canonicalJson(installedCandidate) === canonicalJson(candidate)
    ) {
      return windowsPortableQualificationPromotionReceiptSchema.parse({
        schemaVersion: "hpi-portable-qualification-promotion.v1",
        outcome: "NOOP",
        releaseId: candidate.releaseId,
        artifactFingerprint: candidate.artifact.fingerprint,
        candidateFingerprint,
      });
    }

    await writeJsonAtomically(rootCandidatePath, candidate);
    try {
      await writeJsonAtomically(installedCandidatePath, candidate);
      const promotedRoot = releaseCandidateSchema.parse(
        JSON.parse(
          Buffer.from(await readPhysicalFile(rootCandidatePath)).toString("utf8"),
        ) as unknown,
      );
      const promotedInstalled = await adapter.installedCandidate({
        releaseId: candidate.releaseId,
      });
      if (
        canonicalJson(promotedRoot) !== canonicalJson(candidate) ||
        promotedInstalled === undefined ||
        canonicalJson(promotedInstalled) !== canonicalJson(candidate)
      ) {
        throw new Error("portable qualification promotion did not persist the exact candidate");
      }
    } catch (error) {
      const restoration = await Promise.allSettled([
        writeJsonAtomically(rootCandidatePath, rootCandidate),
        writeJsonAtomically(installedCandidatePath, installedCandidate),
      ]);
      if (restoration.some((result) => result.status === "rejected")) {
        throw new Error("portable qualification promotion and metadata restoration failed", {
          cause: error,
        });
      }
      throw error;
    }

    return windowsPortableQualificationPromotionReceiptSchema.parse({
      schemaVersion: "hpi-portable-qualification-promotion.v1",
      outcome: "PROMOTED",
      releaseId: candidate.releaseId,
      artifactFingerprint: candidate.artifact.fingerprint,
      candidateFingerprint,
    });
  });
}

async function copyTree(source: string, destination: string): Promise<void> {
  const status = await lstat(source);
  if (status.isSymbolicLink()) throw new Error("portable mutable state contains a symbolic link");
  if (status.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      await copyTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!status.isFile()) throw new Error("portable mutable state contains a non-file entry");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, await readFile(source), { flag: "wx", mode: 0o600 });
}

async function clearTree(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await rm(path, { force: true });
      } else if (entry.isDirectory()) {
        await clearTree(path);
        await rm(path, { force: true });
      } else {
        await rm(path, { force: true });
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function fingerprintTree(path: string): Promise<ReturnType<typeof sha256Fingerprint>> {
  const records: {
    readonly path: string;
    readonly fingerprint: string;
    readonly byteLength: number;
  }[] = [];
  async function visit(root: string, current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(current, entry.name);
      const status = await lstat(child);
      if (status.isSymbolicLink())
        throw new Error("portable mutable state contains a symbolic link");
      if (status.isDirectory()) {
        await visit(root, child);
      } else if (status.isFile()) {
        const bytes = await readFile(child);
        records.push({
          path: relative(root, child).split(sep).join("/"),
          fingerprint: sha256Fingerprint(bytes),
          byteLength: bytes.byteLength,
        });
      } else {
        throw new Error("portable mutable state contains a non-file entry");
      }
    }
  }
  await visit(resolve(path), resolve(path));
  return sha256Fingerprint(canonicalJson(records));
}

async function removeWritableTree(path: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (status.isDirectory()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path)) await removeWritableTree(join(path, entry));
    await rm(path, { force: true });
    return;
  }
  await chmod(path, 0o600).catch(() => undefined);
  await rm(path, { force: true });
}

export class FileWindowsPortableReleaseAdapter implements ReleaseAdapter {
  readonly #installationRoot: string;
  readonly #stateRoot: string;
  readonly #versionsRoot: string;
  readonly #activePath: string;
  readonly #activationIntentPath: string;
  readonly #migrationPath: string;
  readonly #migrationRoot: string;
  readonly #mutableStateDirectory: string | undefined;
  readonly #now: () => string;
  readonly #healthCheck: FileWindowsPortableReleaseAdapterOptions["healthCheck"];
  readonly #afterActivePointerPublished: (() => Promise<void>) | undefined;

  public constructor(options: FileWindowsPortableReleaseAdapterOptions) {
    this.#installationRoot = resolve(options.installationRoot);
    this.#stateRoot = join(this.#installationRoot, ".hpi-update");
    this.#versionsRoot = join(this.#installationRoot, "versions");
    this.#activePath = join(this.#stateRoot, "active.json");
    this.#activationIntentPath = join(this.#stateRoot, "activation-intent.json");
    this.#migrationPath = join(this.#stateRoot, "migration.json");
    this.#migrationRoot = join(this.#stateRoot, "migrations");
    this.#mutableStateDirectory =
      options.mutableStateDirectory === undefined
        ? undefined
        : resolve(options.mutableStateDirectory);
    const targetPlatform =
      options.targetPlatform ??
      (process.platform === "win32" && process.arch === "x64" ? "win32-x64" : undefined);
    if (targetPlatform !== "win32-x64") {
      throw new Error("Windows portable updates require Windows x64");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#healthCheck = options.healthCheck;
    this.#afterActivePointerPublished = options.afterActivePointerPublished;
  }

  async #ensureRoots(): Promise<void> {
    await canonicalDirectory(this.#installationRoot);
    await canonicalDirectory(this.#stateRoot);
    await canonicalDirectory(this.#versionsRoot);
    await canonicalDirectory(this.#migrationRoot);
  }

  async #readArtifact(
    candidate: ReleaseCandidate,
    directory: string,
    expectedArtifactFingerprint?: string,
  ): Promise<Uint8Array> {
    const artifact = await readFile(join(directory, ".hpi-artifact"));
    const artifactFingerprint = sha256Fingerprint(artifact);
    if (
      artifactFingerprint !== candidate.artifact.fingerprint ||
      artifact.byteLength !== candidate.artifact.byteLength ||
      (expectedArtifactFingerprint !== undefined &&
        artifactFingerprint !== expectedArtifactFingerprint)
    ) {
      throw new Error("portable release artifact bytes failed integrity verification");
    }
    return artifact;
  }

  async #readActive(
    options: { readonly verifyFiles?: boolean } = {},
  ): Promise<ActivePointer | undefined> {
    const active = await readJsonIfPresent(this.#activePath, activePointerSchema);
    if (active === undefined) return undefined;
    const candidate = await this.#readCandidate(active.releaseId);
    if (options.verifyFiles === false) {
      await this.#readArtifact(
        candidate,
        containedReleasePath(this.#versionsRoot, candidate.releaseId),
        active.artifactFingerprint,
      );
    } else {
      await this.#verifyRelease(candidate, active.artifactFingerprint);
    }
    if (candidate.productVersion !== active.productVersion) {
      throw new Error("portable active pointer does not bind the candidate version");
    }
    return active;
  }

  async #readCandidate(releaseId: string): Promise<ReleaseCandidate> {
    const directory = containedReleasePath(this.#versionsRoot, releaseId);
    return releaseCandidateSchema.parse(
      JSON.parse(await readFile(join(directory, ".hpi-candidate.json"), "utf8")) as unknown,
    );
  }

  #verifyManifest(candidate: ReleaseCandidate, manifest: PortableBundleManifest): void {
    if (
      manifest.releaseId !== candidate.releaseId ||
      manifest.productVersion !== candidate.productVersion ||
      manifest.engineReleaseId !== candidate.engine.releaseId ||
      manifest.engineReleaseFingerprint !== candidate.engine.fingerprint
    ) {
      throw new Error("portable bundle manifest does not bind the release candidate");
    }
  }

  async #verifyReleaseDirectory(
    candidate: ReleaseCandidate,
    directory: string,
    expectedArtifactFingerprint?: string,
  ): Promise<string> {
    const artifact = await this.#readArtifact(candidate, directory, expectedArtifactFingerprint);
    const bundle = decodePortableBundle(artifact);
    this.#verifyManifest(candidate, bundle.manifest);
    const observed = new Set<string>();
    for (const file of bundle.files) {
      const target = resolve(directory, ...file.path.split("/"));
      const relativeTarget = relative(directory, target);
      if (
        relativeTarget.length === 0 ||
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${sep}`) ||
        isAbsolute(relativeTarget)
      ) {
        throw new Error("portable release file escaped its version directory");
      }
      const status = await lstat(target);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error("portable release file is missing or linked");
      }
      const bytes = await readFile(target);
      if (sha256Fingerprint(bytes) !== sha256Fingerprint(file.bytes)) {
        throw new Error("portable release extracted file failed integrity verification");
      }
      observed.add(relativeTarget.split(sep).join("/"));
    }
    const actualFiles: string[] = [];
    async function visit(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = join(current, entry.name);
        if (entry.name === ".hpi-artifact" || entry.name === ".hpi-candidate.json") continue;
        const status = await lstat(child);
        if (status.isSymbolicLink()) throw new Error("portable release contains a symbolic link");
        if (status.isDirectory()) await visit(child);
        else if (status.isFile()) actualFiles.push(relative(directory, child).split(sep).join("/"));
        else throw new Error("portable release contains a non-file entry");
      }
    }
    await visit(directory);
    if (actualFiles.length !== observed.size || actualFiles.some((path) => !observed.has(path))) {
      throw new Error("portable release contains an unexpected extracted file");
    }
    return directory;
  }

  async #verifyRelease(
    candidate: ReleaseCandidate,
    expectedArtifactFingerprint?: string,
  ): Promise<string> {
    return this.#verifyReleaseDirectory(
      candidate,
      containedReleasePath(this.#versionsRoot, candidate.releaseId),
      expectedArtifactFingerprint,
    );
  }

  async current(): Promise<DistributionReleaseId | undefined> {
    await this.#ensureRoots();
    return (await this.#readActive({ verifyFiles: false }))?.releaseId;
  }

  async installedCandidate(release: StagedRelease): Promise<ReleaseCandidate | undefined> {
    await this.#ensureRoots();
    try {
      const candidate = await this.#readCandidate(release.releaseId);
      await this.#verifyRelease(candidate, candidate.artifact.fingerprint);
      return candidate;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async stage(candidateInput: ReleaseCandidate, artifact: Uint8Array): Promise<StagedRelease> {
    await this.#ensureRoots();
    const candidate = releaseCandidateSchema.parse(candidateInput);
    if (
      artifact.byteLength !== candidate.artifact.byteLength ||
      sha256Fingerprint(artifact) !== candidate.artifact.fingerprint
    ) {
      throw new Error("portable release artifact bytes do not match the candidate");
    }
    const bundle = decodePortableBundle(artifact);
    this.#verifyManifest(candidate, bundle.manifest);
    const finalDirectory = containedReleasePath(this.#versionsRoot, candidate.releaseId);
    try {
      const existing = await lstat(finalDirectory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("portable release version directory is not physical");
      }
      const existingCandidate = await this.#readCandidate(candidate.releaseId);
      if (canonicalJson(existingCandidate) !== canonicalJson(candidate)) {
        throw new Error("portable release id is already bound to a different candidate");
      }
      await this.#verifyRelease(candidate, candidate.artifact.fingerprint);
      return { releaseId: candidate.releaseId };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const stagingDirectory = join(this.#versionsRoot, `.staging-${randomUUID()}`);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      await extractPortableBundle(artifact, stagingDirectory);
      await writeJsonAtomically(join(stagingDirectory, ".hpi-candidate.json"), candidate);
      await writeFile(join(stagingDirectory, ".hpi-artifact"), artifact, {
        flag: "wx",
        mode: 0o600,
      });
      await this.#verifyReleaseDirectory(
        candidate,
        stagingDirectory,
        candidate.artifact.fingerprint,
      );
      await rename(stagingDirectory, finalDirectory);
      return { releaseId: candidate.releaseId };
    } catch (error) {
      await removeWritableTree(stagingDirectory).catch(() => undefined);
      throw error;
    }
  }

  async healthCheck(
    release: StagedRelease,
  ): Promise<{ readonly status: "PASS" } | { readonly status: "FAIL"; readonly reason: string }> {
    try {
      const candidate = await this.#readCandidate(release.releaseId);
      const directory = await this.#verifyRelease(candidate, candidate.artifact.fingerprint);
      if (this.#healthCheck !== undefined) return await this.#healthCheck(release, directory);
      const output = await execFileAsync(
        join(directory, "node.exe"),
        [
          join(directory, "node_modules", "@hunter-pi", "cli", "dist", "hpi.js"),
          "version",
          "--json",
        ],
        { cwd: directory, encoding: "utf8", timeout: 30_000, windowsHide: true },
      );
      const value = JSON.parse(output.stdout) as { product?: string; productVersion?: string };
      if (value.product !== "Hunter Pi" || value.productVersion !== candidate.productVersion) {
        return {
          status: "FAIL",
          reason: "portable health probe returned the wrong product identity",
        };
      }
      return { status: "PASS" };
    } catch (error) {
      return { status: "FAIL", reason: safeReason(error, "portable health probe failed") };
    }
  }

  async migrate(
    release: StagedRelease,
    previousReleaseId: DistributionReleaseId | undefined,
  ): Promise<MigrationTransaction | undefined> {
    if (this.#mutableStateDirectory === undefined) return undefined;
    await this.#ensureRoots();
    const stateDirectory = await canonicalDirectory(this.#mutableStateDirectory);
    const backupId = randomUUID();
    const backupDirectory = join(this.#migrationRoot, backupId);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await copyTree(stateDirectory, backupDirectory);
    const migration = migrationStateSchema.parse({
      schemaVersion: "hpi-portable-migration.v1",
      backupId,
      candidateReleaseId: release.releaseId,
      previousReleaseId: previousReleaseId ?? null,
      stateFingerprint: await fingerprintTree(stateDirectory),
      status: "PREPARED",
    });
    await writeJsonAtomically(this.#migrationPath, migration);
    let finished = false;
    return {
      rollback: async () => {
        if (finished) return;
        const currentState = await canonicalDirectory(stateDirectory);
        await clearTree(currentState);
        await copyTree(backupDirectory, currentState);
        await writeJsonAtomically(this.#migrationPath, { ...migration, status: "ROLLED_BACK" });
        finished = true;
      },
      commit: async () => {
        if (finished) return;
        await writeJsonAtomically(this.#migrationPath, { ...migration, status: "COMMITTED" });
        finished = true;
      },
    };
  }

  async activate(release: StagedRelease): Promise<void> {
    await this.#ensureRoots();
    const candidate = await this.#readCandidate(release.releaseId);
    await this.#verifyRelease(candidate, candidate.artifact.fingerprint);
    const previous = await this.#readActive();
    const intent: ActivationIntent = activationIntentSchema.parse({
      schemaVersion: "hpi-portable-activation-intent.v1",
      candidate,
      previousReleaseId: previous?.releaseId ?? null,
      createdAt: this.#now(),
    });
    await writeJsonAtomically(this.#activationIntentPath, intent);
    await writeJsonAtomically(this.#activePath, {
      schemaVersion: "hpi-portable-active.v1",
      releaseId: candidate.releaseId,
      artifactFingerprint: candidate.artifact.fingerprint,
      productVersion: candidate.productVersion,
      activatedAt: this.#now(),
    });
    await this.#afterActivePointerPublished?.();
    await this.#readActive();
    await rm(this.#activationIntentPath, { force: true });
  }

  async restore(release: StagedRelease): Promise<void> {
    await this.#ensureRoots();
    const candidate = await this.#readCandidate(release.releaseId);
    await this.#verifyRelease(candidate, candidate.artifact.fingerprint);
    await writeJsonAtomically(this.#activePath, {
      schemaVersion: "hpi-portable-active.v1",
      releaseId: candidate.releaseId,
      artifactFingerprint: candidate.artifact.fingerprint,
      productVersion: candidate.productVersion,
      activatedAt: this.#now(),
    });
    await rm(this.#activationIntentPath, { force: true });
    await this.#readActive();
  }

  async discard(release: StagedRelease): Promise<void> {
    await this.#ensureRoots();
    const active = await readJsonIfPresent(this.#activePath, activePointerSchema);
    if (active?.releaseId === release.releaseId) {
      throw new Error("cannot discard the active portable release");
    }
    await removeWritableTree(containedReleasePath(this.#versionsRoot, release.releaseId));
  }

  async reconcile(): Promise<UpdateReconciliation> {
    await this.#ensureRoots();
    return withDurableMutationLock(join(this.#stateRoot, ".portable-mutation-lock"), async () => {
      const intent = await readJsonIfPresent(this.#activationIntentPath, activationIntentSchema);
      const migration = await readJsonIfPresent(this.#migrationPath, migrationStateSchema);
      const active = await this.#readActive({
        verifyFiles: intent !== undefined || migration?.status === "PREPARED",
      });
      if (intent !== undefined) {
        if (active?.releaseId === intent.candidate.releaseId) {
          if (
            migration?.status === "PREPARED" &&
            migration.candidateReleaseId === intent.candidate.releaseId
          ) {
            await writeJsonAtomically(this.#migrationPath, { ...migration, status: "COMMITTED" });
          }
          await rm(this.#activationIntentPath, { force: true });
          return {
            status: "RECOVERED",
            candidate: intent.candidate,
            ...(intent.previousReleaseId === null
              ? {}
              : { previousReleaseId: intent.previousReleaseId }),
            activeReleaseId: active.releaseId,
          } satisfies UpdateReconciliation;
        }
        if (active?.releaseId === (intent.previousReleaseId ?? undefined)) {
          if (migration?.status === "PREPARED") await this.#rollbackMigrationState(migration);
          await rm(this.#activationIntentPath, { force: true });
          return {
            status: "ABORTED",
            candidate: intent.candidate,
            ...(intent.previousReleaseId === null
              ? {}
              : { previousReleaseId: intent.previousReleaseId }),
            ...(active === undefined ? {} : { activeReleaseId: active.releaseId }),
            reason: "portable activation did not publish its candidate; previous release retained",
          } satisfies UpdateReconciliation;
        }
        throw new Error("portable activation intent disagrees with the active release");
      }
      if (migration?.status === "PREPARED") {
        const candidate = await this.#readCandidate(migration.candidateReleaseId);
        if (active?.releaseId === migration.candidateReleaseId) {
          await writeJsonAtomically(this.#migrationPath, { ...migration, status: "COMMITTED" });
          return {
            status: "RECOVERED",
            candidate,
            ...(migration.previousReleaseId === null
              ? {}
              : { previousReleaseId: migration.previousReleaseId }),
            activeReleaseId: active.releaseId,
          } satisfies UpdateReconciliation;
        }
        await this.#rollbackMigrationState(migration);
        return {
          status: "ABORTED",
          candidate,
          ...(migration.previousReleaseId === null
            ? {}
            : { previousReleaseId: migration.previousReleaseId }),
          ...(active === undefined ? {} : { activeReleaseId: active.releaseId }),
          reason:
            "portable state migration was prepared without an active candidate; state restored",
        } satisfies UpdateReconciliation;
      }
      return { status: "NONE" } satisfies UpdateReconciliation;
    });
  }

  async #rollbackMigrationState(migration: MigrationState): Promise<void> {
    if (this.#mutableStateDirectory === undefined) {
      await writeJsonAtomically(this.#migrationPath, { ...migration, status: "ROLLED_BACK" });
      return;
    }
    const stateDirectory = await canonicalDirectory(this.#mutableStateDirectory);
    const backupDirectory = join(this.#migrationRoot, migration.backupId);
    await clearTree(stateDirectory);
    await copyTree(backupDirectory, stateDirectory);
    await writeJsonAtomically(this.#migrationPath, { ...migration, status: "ROLLED_BACK" });
  }
}
