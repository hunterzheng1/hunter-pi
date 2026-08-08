import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  fingerprintSchema,
  pluginIdSchema,
  timestampSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import {
  pluginCompatibilityConfigurationFingerprint,
  type PluginInventory,
  type PluginRecord,
  pluginInventorySchema,
  pluginRecordSchema,
} from "@hunter-pi/plugin-manager";
import { z } from "zod";

import {
  fingerprintPiPackageDirectory,
  fingerprintPiPackageResource,
  type PiPackageRuntimeBinding,
  type PiPackageRuntimeResource,
} from "./pi-package-resolver.js";
import { hpiPluginOperationError } from "./plugin-errors.js";
import {
  fingerprintPiPackageManifest,
  readPiPackageQualificationReceipt,
} from "./plugin-qualification.js";

const runtimeResourceSchema = z.strictObject({
  absolutePath: z.string().min(1).max(32_768),
  contentFingerprint: fingerprintSchema,
  enabled: z.boolean(),
});

export const piPackageRuntimeBindingReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pi-runtime-binding.v1"),
  pluginId: pluginIdSchema,
  packageRoot: z.string().min(1).max(32_768),
  packageFingerprint: fingerprintSchema,
  extensions: z.array(runtimeResourceSchema),
  skills: z.array(runtimeResourceSchema),
  prompts: z.array(runtimeResourceSchema),
  themes: z.array(runtimeResourceSchema),
  observedAt: timestampSchema,
});
export type PiPackageRuntimeBindingReceipt = z.infer<typeof piPackageRuntimeBindingReceiptSchema>;

function receiptFilename(pluginId: string, packageFingerprint: string): string {
  return `${pluginId}-${packageFingerprint.slice("sha256:".length)}.json`;
}

function bindingIdentity(receipt: PiPackageRuntimeBindingReceipt): unknown {
  return {
    schemaVersion: receipt.schemaVersion,
    pluginId: receipt.pluginId,
    packageRoot: receipt.packageRoot,
    packageFingerprint: receipt.packageFingerprint,
    extensions: receipt.extensions,
    skills: receipt.skills,
    prompts: receipt.prompts,
    themes: receipt.themes,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

async function readPhysicalBinding(path: string): Promise<PiPackageRuntimeBindingReceipt> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  return piPackageRuntimeBindingReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export class FilePiPackageBindingStore {
  readonly #stateRoot: string;
  readonly #managedPackageRoot: string;

  public constructor(options: { readonly stateRoot: string; readonly managedPackageRoot: string }) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#managedPackageRoot = resolve(options.managedPackageRoot);
  }

  public async put(
    binding: PiPackageRuntimeBinding,
    observedAt: string,
  ): Promise<"CREATED" | "EXISTING"> {
    const receipt = piPackageRuntimeBindingReceiptSchema.parse({
      schemaVersion: "hpi-pi-runtime-binding.v1",
      ...binding,
      observedAt,
    });
    const managedSnapshot = await assertManagedSnapshotLocation(
      this.#managedPackageRoot,
      receipt.packageRoot,
    );
    if (
      basename(managedSnapshot) !== receipt.packageFingerprint.slice("sha256:".length) ||
      (await fingerprintPiPackageDirectory(managedSnapshot)) !== receipt.packageFingerprint
    ) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    await mkdir(this.#stateRoot, { recursive: true });
    const rootStatus = await lstat(this.#stateRoot);
    const canonicalRoot = await realpath(this.#stateRoot);
    if (
      !rootStatus.isDirectory() ||
      rootStatus.isSymbolicLink() ||
      comparablePath(canonicalRoot) !== comparablePath(this.#stateRoot)
    ) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    const filename = receiptFilename(receipt.pluginId, receipt.packageFingerprint);
    const finalPath = join(this.#stateRoot, filename);
    try {
      const existing = await readPhysicalBinding(finalPath);
      if (canonicalJson(bindingIdentity(existing)) !== canonicalJson(bindingIdentity(receipt))) {
        throw hpiPluginOperationError("BINDING_TAMPERED");
      }
      return "EXISTING";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporaryPath = join(this.#stateRoot, `.pending-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let outcome: "CREATED" | "EXISTING" = "CREATED";
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        outcome = "EXISTING";
        const existing = await readPhysicalBinding(finalPath);
        if (canonicalJson(bindingIdentity(existing)) !== canonicalJson(bindingIdentity(receipt))) {
          throw hpiPluginOperationError("BINDING_TAMPERED", error);
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return outcome;
  }

  public async get(
    pluginId: string,
    packageFingerprint: Fingerprint,
  ): Promise<PiPackageRuntimeBindingReceipt> {
    const rootStatus = await lstat(this.#stateRoot);
    const canonicalRoot = await realpath(this.#stateRoot);
    if (
      !rootStatus.isDirectory() ||
      rootStatus.isSymbolicLink() ||
      comparablePath(canonicalRoot) !== comparablePath(this.#stateRoot)
    ) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    const parsedPluginId = pluginIdSchema.parse(pluginId);
    const parsedFingerprint = fingerprintSchema.parse(packageFingerprint);
    const path = join(this.#stateRoot, receiptFilename(parsedPluginId, parsedFingerprint));
    try {
      const receipt = await readPhysicalBinding(path);
      if (receipt.pluginId !== parsedPluginId || receipt.packageFingerprint !== parsedFingerprint) {
        throw hpiPluginOperationError("BINDING_TAMPERED");
      }
      await assertManagedSnapshotLocation(this.#managedPackageRoot, receipt.packageRoot);
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw hpiPluginOperationError("BINDING_TAMPERED", error);
      }
      throw error;
    }
  }

  public async removeManagedSnapshots(pluginId: string): Promise<{
    readonly bindingsDeleted: number;
    readonly snapshotsDeleted: number;
  }> {
    const parsedPluginId = pluginIdSchema.parse(pluginId);
    try {
      await assertPhysicalCanonicalDirectory(this.#stateRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { bindingsDeleted: 0, snapshotsDeleted: 0 };
      }
      throw error;
    }
    const names: string[] = [];
    const directory = await opendir(this.#stateRoot);
    for await (const entry of directory) {
      const prefix = `${parsedPluginId}-`;
      const fingerprintSuffix = entry.name.endsWith(".json")
        ? entry.name.slice(prefix.length, -".json".length)
        : "";
      if (
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        /^[a-f0-9]{64}$/u.test(fingerprintSuffix)
      ) {
        names.push(entry.name);
      }
    }
    const removalPlan: {
      readonly bindingPath: string;
      readonly binding: PiPackageRuntimeBindingReceipt | undefined;
    }[] = [];
    for (const name of names.sort()) {
      const bindingPath = join(this.#stateRoot, name);
      let binding: PiPackageRuntimeBindingReceipt | undefined;
      try {
        binding = await readPhysicalBinding(bindingPath);
      } catch {
        // The exact binding file is Hunter-owned metadata. Removing it is safe even when its
        // contents are corrupt; no untrusted target is followed in that case.
      }
      if (binding !== undefined) {
        if (
          binding.pluginId !== parsedPluginId ||
          receiptFilename(binding.pluginId, binding.packageFingerprint) !== name
        ) {
          throw hpiPluginOperationError("BINDING_TAMPERED");
        }
        await validateManagedSnapshotForRemoval(
          this.#managedPackageRoot,
          binding.packageRoot,
          binding.packageFingerprint,
        );
      }
      removalPlan.push({ bindingPath, binding });
    }
    let bindingsDeleted = 0;
    let snapshotsDeleted = 0;
    for (const planned of removalPlan) {
      if (planned.binding !== undefined) {
        const currentBinding = await readPhysicalBinding(planned.bindingPath);
        if (
          canonicalJson(bindingIdentity(currentBinding)) !==
          canonicalJson(bindingIdentity(planned.binding))
        ) {
          throw hpiPluginOperationError("BINDING_TAMPERED");
        }
        snapshotsDeleted += await removeManagedSnapshot(
          this.#managedPackageRoot,
          planned.binding.packageRoot,
          planned.binding.packageFingerprint,
        );
      }
      await rm(planned.bindingPath);
      bindingsDeleted += 1;
    }
    return { bindingsDeleted, snapshotsDeleted };
  }
}

export interface QualifiedPiPluginActivation {
  readonly pluginIds: readonly string[];
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly themes: readonly string[];
}

export interface PiPluginActivationCompatibilityContext {
  readonly qualificationStateRoot: string;
  readonly distributionReleaseId: string;
  readonly engineReleaseId: string;
  readonly engineReleaseFingerprint: Fingerprint;
  readonly platformFingerprint: Fingerprint;
  readonly compatibilityVerifierFingerprint: Fingerprint;
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function assertPhysicalCanonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const status = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    comparablePath(canonical) !== comparablePath(absolute)
  ) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  return canonical;
}

async function removeWritableTree(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    if (!status.isSymbolicLink()) await chmod(path, 0o600).catch(() => undefined);
    await rm(path, { force: true });
    return;
  }
  const canonical = await realpath(path);
  if (comparablePath(canonical) !== comparablePath(resolve(path))) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  await chmod(path, 0o700).catch(() => undefined);
  const directory = await opendir(path);
  for await (const entry of directory) await removeWritableTree(join(path, entry.name));
  await rmdir(path);
}

async function removeManagedSnapshot(
  managedPackageRoot: string,
  packageRoot: string,
  packageFingerprint: Fingerprint,
): Promise<0 | 1> {
  const target = await validateManagedSnapshotForRemoval(
    managedPackageRoot,
    packageRoot,
    packageFingerprint,
  );
  if (target === undefined) return 0;
  try {
    await removeWritableTree(target);
    return 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function validateManagedSnapshotForRemoval(
  managedPackageRoot: string,
  packageRoot: string,
  packageFingerprint: Fingerprint,
): Promise<string | undefined> {
  let target: string;
  try {
    target = await assertManagedSnapshotLocation(managedPackageRoot, packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (basename(target) !== packageFingerprint.slice("sha256:".length)) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  try {
    if ((await fingerprintPiPackageDirectory(target)) !== packageFingerprint) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && "code" in error && error.code === "BINDING_TAMPERED") {
      throw error;
    }
    throw hpiPluginOperationError("BINDING_TAMPERED", error);
  }
  return target;
}

async function assertManagedSnapshotLocation(
  managedPackageRoot: string,
  packageRoot: string,
): Promise<string> {
  const managedRoot = await assertPhysicalCanonicalDirectory(managedPackageRoot);
  const target = resolve(packageRoot);
  const fromManagedRoot = relative(managedRoot, target);
  const segments = fromManagedRoot.split(sep);
  if (
    segments.length !== 4 ||
    segments[0] !== "package-staging" ||
    !/^[a-f0-9]{32}$/u.test(segments[1] ?? "") ||
    segments[2] !== "snapshots" ||
    !/^[a-f0-9]{64}$/u.test(segments[3] ?? "")
  ) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  const parent = dirname(target);
  const canonicalParent = await assertPhysicalCanonicalDirectory(parent);
  if (comparablePath(canonicalParent) !== comparablePath(parent)) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  return target;
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("Pi Package runtime resource escaped its exact package root");
  }
}

async function verifyResource(
  packageRoot: string,
  resource: {
    readonly absolutePath: string;
    readonly contentFingerprint: Fingerprint;
    readonly enabled: boolean;
  },
): Promise<void> {
  if (!isAbsolute(resource.absolutePath)) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  const absolute = resolve(resource.absolutePath);
  const status = await lstat(absolute);
  if (status.isSymbolicLink()) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  const canonical = await realpath(absolute);
  if (comparablePath(canonical) !== comparablePath(absolute)) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
  assertContained(packageRoot, canonical);
  if ((await fingerprintPiPackageResource(canonical)) !== resource.contentFingerprint) {
    throw hpiPluginOperationError("BINDING_TAMPERED");
  }
}

function expectedRuntimeResources(
  packageRoot: string,
  resources: readonly {
    readonly relativePath: string;
    readonly contentFingerprint: Fingerprint;
    readonly enabled: boolean;
  }[],
): readonly PiPackageRuntimeResource[] {
  return resources.map((resource) => ({
    absolutePath:
      resource.relativePath === "."
        ? packageRoot
        : resolve(packageRoot, ...resource.relativePath.split("/")),
    contentFingerprint: resource.contentFingerprint as `sha256:${string}`,
    enabled: resource.enabled,
  }));
}

async function verifyCurrentCompatibility(
  record: Extract<PluginRecord, { schemaVersion: "hpi-plugin-record.v2" }>,
  contextInput: PiPluginActivationCompatibilityContext,
): Promise<void> {
  const context = {
    qualificationStateRoot: resolve(contextInput.qualificationStateRoot),
    distributionReleaseId: distributionReleaseIdSchema.parse(contextInput.distributionReleaseId),
    engineReleaseId: engineReleaseIdSchema.parse(contextInput.engineReleaseId),
    engineReleaseFingerprint: fingerprintSchema.parse(contextInput.engineReleaseFingerprint),
    platformFingerprint: fingerprintSchema.parse(contextInput.platformFingerprint),
    compatibilityVerifierFingerprint: fingerprintSchema.parse(
      contextInput.compatibilityVerifierFingerprint,
    ),
  };
  const compatibility = record.assurance.compatibilityReceipt;
  if (
    compatibility.pluginId !== record.pluginId ||
    compatibility.pluginVersion !== record.manifest.version ||
    compatibility.pluginReleaseFingerprint !== record.manifest.packageFingerprint ||
    compatibility.distributionReleaseId !== context.distributionReleaseId ||
    compatibility.engineReleaseId !== context.engineReleaseId ||
    compatibility.engineReleaseFingerprint !== context.engineReleaseFingerprint ||
    compatibility.platformFingerprint !== context.platformFingerprint ||
    compatibility.configurationFingerprint !==
      pluginCompatibilityConfigurationFingerprint(record.manifest) ||
    compatibility.outcome !== "VERIFIED"
  ) {
    throw new Error("Plugin compatibility is not bound to the current runtime context");
  }

  const qualificationEvidenceIds = [
    ...new Set([...compatibility.evidenceIds, ...record.assurance.evidenceIds]),
  ].filter((evidenceId) => evidenceId.startsWith("evidence_plugin-qualification-"));
  const evidenceId = qualificationEvidenceIds[0];
  if (
    qualificationEvidenceIds.length !== 1 ||
    evidenceId === undefined ||
    !compatibility.evidenceIds.includes(evidenceId) ||
    !record.assurance.evidenceIds.includes(evidenceId)
  ) {
    throw new Error("Plugin compatibility lacks one exact qualification Evidence identity");
  }
  const qualification = await readPiPackageQualificationReceipt({
    stateRoot: context.qualificationStateRoot,
    evidenceId,
  });
  if (
    qualification.evidenceId !== evidenceId ||
    qualification.pluginId !== record.pluginId ||
    qualification.pluginVersion !== record.manifest.version ||
    qualification.packageFingerprint !== record.manifest.packageFingerprint ||
    qualification.manifestFingerprint !== fingerprintPiPackageManifest(record.manifest) ||
    qualification.verifierFingerprint !== context.compatibilityVerifierFingerprint ||
    qualification.compatibility !== "VERIFIED" ||
    qualification.observedAt !== compatibility.checkedAt
  ) {
    throw new Error("Plugin qualification does not match the current compatibility receipt");
  }
}

export async function prepareQualifiedPiPluginActivation(options: {
  readonly records: readonly PluginRecord[];
  readonly inventory: PluginInventory;
  readonly bindingStore: FilePiPackageBindingStore;
  readonly compatibilityContext: PiPluginActivationCompatibilityContext;
}): Promise<QualifiedPiPluginActivation> {
  const records = options.records.map((record) => pluginRecordSchema.parse(record));
  const inventory = pluginInventorySchema.parse(options.inventory);
  if (inventory.safeMode) {
    throw new Error("Plugin registry requires Safe Mode before any user Plugin is evaluated");
  }

  const activeV2Records = records.filter(
    (record): record is Extract<PluginRecord, { schemaVersion: "hpi-plugin-record.v2" }> =>
      record.schemaVersion === "hpi-plugin-record.v2" && record.state === "ENABLED",
  );
  if (activeV2Records.length > 0) {
    if (inventory.schemaVersion !== "hpi-plugin-inventory.v2") {
      throw new Error("Plugin registry inventory does not expose the active Pi resources");
    }
    const inventoryFields = {
      extensions: "effectiveExtensions",
      skills: "effectiveSkills",
      prompts: "effectivePrompts",
      themes: "effectiveThemes",
    } as const;
    for (const [kind, inventoryField] of Object.entries(inventoryFields) as readonly [
      keyof typeof inventoryFields,
      (typeof inventoryFields)[keyof typeof inventoryFields],
    ][]) {
      const expected = activeV2Records.flatMap((record) =>
        record.manifest.resources[kind].map((resource) => ({
          pluginId: record.pluginId,
          ...resource,
        })),
      );
      if (canonicalJson(expected) !== canonicalJson(inventory[inventoryField])) {
        throw new Error("Plugin registry records and effective runtime inventory are inconsistent");
      }
    }
  }

  const activation = {
    pluginIds: [] as string[],
    extensions: [] as string[],
    skills: [] as string[],
    prompts: [] as string[],
    themes: [] as string[],
  };
  for (const record of records) {
    if (record.state === "DISABLED") continue;
    if (
      record.schemaVersion !== "hpi-plugin-record.v2" ||
      record.state !== "ENABLED" ||
      record.assurance.compatibility !== "VERIFIED" ||
      record.assurance.trust === "QUARANTINED" ||
      record.assurance.isolation === "NOT_PROVEN"
    ) {
      throw new Error("Plugin registry contains an unqualified activation candidate");
    }
    await verifyCurrentCompatibility(record, options.compatibilityContext);
    const binding = await options.bindingStore.get(
      record.pluginId,
      record.manifest.packageFingerprint,
    );
    const packageRoot = resolve(binding.packageRoot);
    const packageStatus = await lstat(packageRoot);
    if (!packageStatus.isDirectory() || packageStatus.isSymbolicLink()) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    const canonicalRoot = await realpath(packageRoot);
    if (comparablePath(canonicalRoot) !== comparablePath(packageRoot)) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    if ((await fingerprintPiPackageDirectory(canonicalRoot)) !== binding.packageFingerprint) {
      throw hpiPluginOperationError("BINDING_TAMPERED");
    }
    const kinds = ["extensions", "skills", "prompts", "themes"] as const;
    for (const kind of kinds) {
      const expected = expectedRuntimeResources(canonicalRoot, record.manifest.resources[kind]);
      if (canonicalJson(expected) !== canonicalJson(binding[kind])) {
        throw hpiPluginOperationError("BINDING_TAMPERED");
      }
      for (const resource of binding[kind]) await verifyResource(canonicalRoot, resource);
      activation[kind].push(
        ...binding[kind]
          .filter((resource) => resource.enabled)
          .map((resource) => resource.absolutePath),
      );
    }
    activation.pluginIds.push(record.pluginId);
  }
  return activation;
}
