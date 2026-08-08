import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  pluginManifestV2Schema,
  pluginSourceSchema,
  type PluginManifestV2,
  type PluginResource,
  type PluginSource,
} from "@hunter-pi/plugin-manager";
import { withDurableMutationLock } from "@hunter-pi/evidence";
import { z } from "zod";

import { HpiPluginOperationError, hpiPluginOperationError } from "./plugin-errors.js";
import {
  PI_PACKAGE_INSTALL_WORKER_ARGUMENT,
  encodePiPackageInstallWorkerPayload,
} from "./pi-package-install-contract.js";

declare const HPI_BUNDLED_ARTIFACT: boolean | undefined;

const PI_PACKAGE_SPECIFIER = ["@earendil-works", "pi-coding-agent"].join("/");

interface ResolvedResource {
  readonly path: string;
  readonly enabled: boolean;
}

interface ResolvedPaths {
  readonly extensions: readonly ResolvedResource[];
  readonly skills: readonly ResolvedResource[];
  readonly prompts: readonly ResolvedResource[];
  readonly themes: readonly ResolvedResource[];
}

interface PackageManagerPort {
  resolveExtensionSources(
    sources: string[],
    options?: { readonly local?: boolean; readonly temporary?: boolean },
  ): Promise<ResolvedPaths>;
  install(source: string, options?: { readonly local?: boolean }): Promise<void>;
  getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

interface PiPackageModule {
  readonly DefaultPackageManager: new (options: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly settingsManager: unknown;
  }) => PackageManagerPort;
  readonly SettingsManager: {
    inMemory(
      settings?: Readonly<Record<string, unknown>>,
      options?: Readonly<Record<string, unknown>>,
    ): unknown;
  };
}

const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_INSTALL_MAX_ENTRIES = 100_000;
const DEFAULT_INSTALL_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_INSTALL_MINIMUM_FREE_BYTES = 512 * 1024 * 1024;
const DEFAULT_INSTALL_MAX_OUTPUT_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

const packageJsonSchema = z.looseObject({
  name: z.string().trim().min(1).max(214),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
  license: z.string().trim().min(1).max(4_096).optional(),
  hunterPi: z
    .strictObject({
      tools: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(128),
            description: z.string().min(1).max(4_096),
          }),
        )
        .default([]),
      hooks: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(128),
            description: z.string().min(1).max(4_096),
          }),
        )
        .default([]),
    })
    .optional(),
});

type PackageJson = z.infer<typeof packageJsonSchema>;

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const status = await lstat(absolute);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Pi Package root must be a physical directory");
  }
  const canonical = await realpath(absolute);
  if (comparablePath(canonical) !== comparablePath(absolute)) {
    throw new Error("Pi Package root must not use a path alias");
  }
  return canonical;
}

function containedRelativePath(root: string, target: string): string {
  const relativePath = relative(root, target);
  if (relativePath.length === 0) return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Pi Package resource escaped the exact package root");
  }
  return relativePath.split(sep).join("/");
}

interface TreeEntry {
  readonly relativePath: string;
  readonly contentFingerprint: `sha256:${string}`;
  readonly bytes: number;
}

interface TreeScanBudget {
  entries: number;
  bytes: number;
}

async function collectTreeEntries(
  root: string,
  current = root,
  budget: TreeScanBudget = { entries: 0, bytes: 0 },
): Promise<readonly TreeEntry[]> {
  const names = [];
  const directory = await opendir(current);
  for await (const name of directory) {
    if (name.name === ".git" || name.name === "node_modules") continue;
    budget.entries += 1;
    if (budget.entries > MAX_PACKAGE_FILES) {
      throw hpiPluginOperationError("RESOURCE_LIMIT");
    }
    names.push(name);
  }
  const entries: TreeEntry[] = [];
  for (const name of names.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = resolve(current, name.name);
    const relativePath = containedRelativePath(root, target);
    const status = await lstat(target);
    if (status.isSymbolicLink()) {
      throw new Error(`Pi Package contains a symbolic link: ${relativePath}`);
    }
    if (status.isDirectory()) {
      entries.push(...(await collectTreeEntries(root, target, budget)));
      continue;
    }
    if (!status.isFile()) {
      throw new Error(`Pi Package contains an unsupported filesystem entry: ${relativePath}`);
    }
    if (status.nlink !== 1) {
      throw new Error(`Pi Package file must have exactly one physical link: ${relativePath}`);
    }
    if (budget.bytes + status.size > MAX_PACKAGE_BYTES) {
      throw hpiPluginOperationError("RESOURCE_LIMIT");
    }
    const content = await readFile(target);
    budget.bytes += content.byteLength;
    if (budget.bytes > MAX_PACKAGE_BYTES) {
      throw hpiPluginOperationError("RESOURCE_LIMIT");
    }
    entries.push({ relativePath, contentFingerprint: sha256(content), bytes: content.byteLength });
  }
  return entries;
}

async function publishManagedPackageSnapshot(options: {
  readonly sourceRoot: string;
  readonly snapshotParent: string;
  readonly packageFingerprint: `sha256:${string}`;
}): Promise<string> {
  const snapshotName = options.packageFingerprint.slice("sha256:".length);
  await mkdir(options.snapshotParent, { recursive: true });
  const snapshotParent = await canonicalDirectory(options.snapshotParent);
  const finalPath = join(snapshotParent, snapshotName);
  try {
    const existing = await canonicalDirectory(finalPath);
    if ((await fingerprintPiPackageDirectory(existing)) !== options.packageFingerprint) {
      throw new Error("managed Pi Package snapshot changed after publication");
    }
    await setSnapshotReadOnly(existing);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = join(snapshotParent, `.pending-${randomUUID()}`);
  await mkdir(temporaryPath, { recursive: false, mode: 0o700 });
  try {
    const entries = await collectTreeEntries(options.sourceRoot);
    for (const entry of entries) {
      const sourcePath = resolve(options.sourceRoot, ...entry.relativePath.split("/"));
      const targetPath = resolve(temporaryPath, ...entry.relativePath.split("/"));
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const content = await readFile(sourcePath);
      if (sha256(content) !== entry.contentFingerprint) {
        throw new Error("Pi Package source changed while its managed snapshot was created");
      }
      const handle = await open(targetPath, "wx", 0o400);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(targetPath, 0o400);
    }
    if ((await fingerprintPiPackageDirectory(temporaryPath)) !== options.packageFingerprint) {
      throw new Error("managed Pi Package snapshot did not preserve the qualified content");
    }
    await setSnapshotReadOnly(temporaryPath);
    await rename(temporaryPath, finalPath);
    return await canonicalDirectory(finalPath);
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function setSnapshotReadOnly(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw hpiPluginOperationError("SOURCE_CHANGED");
  if (status.isFile()) {
    if (status.nlink !== 1) throw hpiPluginOperationError("SOURCE_CHANGED");
    await chmod(path, 0o400);
    return;
  }
  if (!status.isDirectory()) throw hpiPluginOperationError("SOURCE_CHANGED");
  const directory = await opendir(path);
  for await (const entry of directory) await setSnapshotReadOnly(join(path, entry.name));
  await chmod(path, 0o500);
}

export interface PiPackageInstallBudget {
  readonly timeoutMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly minimumFreeBytes: number;
  readonly maxOutputBytes: number;
}

const DEFAULT_INSTALL_BUDGET: PiPackageInstallBudget = {
  timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
  maxEntries: DEFAULT_INSTALL_MAX_ENTRIES,
  maxBytes: DEFAULT_INSTALL_MAX_BYTES,
  minimumFreeBytes: DEFAULT_INSTALL_MINIMUM_FREE_BYTES,
  maxOutputBytes: DEFAULT_INSTALL_MAX_OUTPUT_BYTES,
};

interface InstallFilesystemBudgetPort {
  opendir(path: string): Promise<AsyncIterable<{ readonly name: string }>>;
  lstat(path: string): Promise<{
    readonly size: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  statfs(path: string): Promise<{ readonly bavail: number; readonly bsize: number }>;
}

const installFilesystemBudgetPort: InstallFilesystemBudgetPort = {
  opendir: (path) => opendir(path),
  lstat: (path) => lstat(path),
  statfs: (path) => statfs(path),
};

function isDisappearedInstallEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function assertInstallFilesystemBudget(
  root: string,
  budget: PiPackageInstallBudget,
  filesystem: InstallFilesystemBudgetPort = installFilesystemBudgetPort,
): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let directory: AsyncIterable<{ readonly name: string }>;
    try {
      directory = await filesystem.opendir(current);
    } catch (error) {
      if (current !== root && isDisappearedInstallEntry(error)) continue;
      throw error;
    }
    for await (const entry of directory) {
      entries += 1;
      if (entries > budget.maxEntries) throw hpiPluginOperationError("RESOURCE_LIMIT");
      const path = join(current, entry.name);
      let status: Awaited<ReturnType<InstallFilesystemBudgetPort["lstat"]>>;
      try {
        status = await filesystem.lstat(path);
      } catch (error) {
        if (isDisappearedInstallEntry(error)) continue;
        throw error;
      }
      bytes += status.size;
      if (bytes > budget.maxBytes) throw hpiPluginOperationError("RESOURCE_LIMIT");
      if (status.isDirectory() && !status.isSymbolicLink()) pending.push(path);
    }
  }
  const filesystemStatus = await filesystem.statfs(root);
  if (filesystemStatus.bavail * filesystemStatus.bsize < budget.minimumFreeBytes) {
    throw hpiPluginOperationError("RESOURCE_LIMIT");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function assertPiPackageInstallDeadline(
  startedAt: number,
  timeoutMs: number,
  observedAt = Date.now(),
): void {
  if (observedAt - startedAt > timeoutMs) {
    throw hpiPluginOperationError("INSTALL_TIMEOUT");
  }
}

interface InstallWorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

async function terminateInstallWorker(
  child: ChildProcess,
  exit: Promise<InstallWorkerExit>,
): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 10_000,
        windowsHide: true,
      }).catch(() => child.kill("SIGKILL"));
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  const closed = await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    delay(10_000).then(() => false),
  ]);
  if (!closed) {
    throw new Error("Pi Package install worker termination was not confirmed");
  }
}

export function createSanitizedPiPackageInstallEnvironment(
  stagingRoot: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "node_extra_ca_certs",
  ]);
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    const normalizedKey = key.toLowerCase();
    if (value === undefined || !allowed.has(normalizedKey)) continue;
    if (normalizedKey === "http_proxy" || normalizedKey === "https_proxy") {
      try {
        const proxy = new URL(value);
        if (
          !["http:", "https:"].includes(proxy.protocol) ||
          proxy.username.length > 0 ||
          proxy.password.length > 0
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }
    environment[key] = value;
  }
  const privateHome = join(stagingRoot, ".install-home");
  const privateTemporary = join(stagingRoot, ".install-tmp");
  environment["HOME"] = privateHome;
  environment["USERPROFILE"] = privateHome;
  environment["APPDATA"] = join(privateHome, "AppData", "Roaming");
  environment["LOCALAPPDATA"] = join(privateHome, "AppData", "Local");
  environment["TEMP"] = privateTemporary;
  environment["TMP"] = privateTemporary;
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = join(stagingRoot, ".gitconfig");
  environment["CI"] = "1";
  environment["NO_UPDATE_NOTIFIER"] = "1";
  environment["npm_config_ignore_scripts"] = "true";
  environment["npm_config_audit"] = "false";
  environment["npm_config_fund"] = "false";
  environment["npm_config_cache"] = join(stagingRoot, ".npm-cache");
  environment["npm_config_userconfig"] = join(stagingRoot, ".npmrc");
  environment["npm_config_globalconfig"] = join(stagingRoot, ".npm-globalrc");
  return environment;
}

async function runBoundedInstallWorker(options: {
  readonly stagingRoot: string;
  readonly source: string;
  readonly registry?: string;
  readonly budget: PiPackageInstallBudget;
}): Promise<void> {
  const privateHome = join(options.stagingRoot, ".install-home");
  const privateTemporary = join(options.stagingRoot, ".install-tmp");
  await Promise.all([
    mkdir(privateHome, { recursive: true, mode: 0o700 }),
    mkdir(privateTemporary, { recursive: true, mode: 0o700 }),
    writeFile(join(options.stagingRoot, ".npmrc"), "ignore-scripts=true\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(join(options.stagingRoot, ".npm-globalrc"), "ignore-scripts=true\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
    writeFile(join(options.stagingRoot, ".gitconfig"), "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  await assertInstallFilesystemBudget(options.stagingRoot, options.budget);
  const payload = encodePiPackageInstallWorkerPayload({
    stagingRoot: options.stagingRoot,
    source: options.source,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const child = spawn(process.execPath, createPiPackageInstallWorkerArguments(payload), {
    cwd: options.stagingRoot,
    detached: process.platform !== "win32",
    env: createSanitizedPiPackageInstallEnvironment(options.stagingRoot),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer | string) => {
      outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8");
    });
  }
  const exit = new Promise<InstallWorkerExit>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
  const startedAt = Date.now();
  try {
    for (;;) {
      assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
      const remaining = Math.max(1, startedAt + options.budget.timeoutMs - Date.now() + 1);
      const outcome = await Promise.race([
        exit,
        delay(Math.min(250, remaining)).then(() => undefined),
      ]);
      assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
      if (outcome !== undefined) {
        if (outputBytes > options.budget.maxOutputBytes) {
          throw hpiPluginOperationError("RESOURCE_LIMIT");
        }
        if (outcome.code !== 0) throw hpiPluginOperationError("INSTALL_FAILED");
        break;
      }
      if (outputBytes > options.budget.maxOutputBytes) {
        throw hpiPluginOperationError("RESOURCE_LIMIT");
      }
      await assertInstallFilesystemBudget(options.stagingRoot, options.budget);
      assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
    }
    await assertInstallFilesystemBudget(options.stagingRoot, options.budget);
    assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
  } catch (error) {
    try {
      await terminateInstallWorker(child, exit);
    } catch (terminationError) {
      throw hpiPluginOperationError(
        "INSTALL_FAILED",
        new AggregateError([error, terminationError], "Pi Package worker escaped termination"),
      );
    }
    if (error instanceof HpiPluginOperationError) throw error;
    throw hpiPluginOperationError("INSTALL_FAILED", error);
  }
}

export function createPiPackageInstallWorkerArguments(
  encodedPayload: string,
  options: { readonly bundledArtifact?: boolean; readonly moduleUrl?: string } = {},
): readonly string[] {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const bundledArtifact =
    options.bundledArtifact ??
    (typeof HPI_BUNDLED_ARTIFACT !== "undefined" && HPI_BUNDLED_ARTIFACT);
  if (bundledArtifact) {
    return [fileURLToPath(moduleUrl), PI_PACKAGE_INSTALL_WORKER_ARGUMENT, encodedPayload];
  }
  return [fileURLToPath(new URL("./pi-package-install-worker.js", moduleUrl)), encodedPayload];
}

async function runBoundedInjectedInstall(options: {
  readonly install: () => Promise<void>;
  readonly stagingRoot: string;
  readonly budget: PiPackageInstallBudget;
}): Promise<void> {
  const installation = options.install().then(
    () => ({ status: "PASS" as const }),
    (error: unknown) => ({ status: "FAIL" as const, error }),
  );
  const startedAt = Date.now();
  for (;;) {
    assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
    const remaining = Math.max(1, startedAt + options.budget.timeoutMs - Date.now() + 1);
    const outcome = await Promise.race([
      installation,
      delay(Math.min(25, remaining)).then(() => undefined),
    ]);
    assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
    if (outcome !== undefined) {
      if (outcome.status === "FAIL") throw hpiPluginOperationError("INSTALL_FAILED", outcome.error);
      await assertInstallFilesystemBudget(options.stagingRoot, options.budget);
      assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
      return;
    }
    await assertInstallFilesystemBudget(options.stagingRoot, options.budget);
    assertPiPackageInstallDeadline(startedAt, options.budget.timeoutMs);
  }
}

export async function fingerprintPiPackageDirectory(
  packageRoot: string,
): Promise<`sha256:${string}`> {
  const root = await canonicalDirectory(packageRoot);
  const entries = await collectTreeEntries(root);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (entries.length === 0) throw new Error("Pi Package root is empty");
  if (totalBytes > MAX_PACKAGE_BYTES) {
    throw hpiPluginOperationError("RESOURCE_LIMIT");
  }
  const canonical = entries
    .map((entry) => `${entry.relativePath}\0${entry.contentFingerprint}\0${String(entry.bytes)}`)
    .join("\n");
  return sha256(canonical);
}

export async function createLocalPiPluginSource(options: {
  readonly label: string;
  readonly packageRoot: string;
}): Promise<Extract<PluginSource, { kind: "LOCAL" }>> {
  const packageRoot = await canonicalDirectory(options.packageRoot);
  return pluginSourceSchema.parse({
    kind: "LOCAL",
    label: options.label,
    pathFingerprint: sha256(`physical-package-root\0${comparablePath(packageRoot)}`),
    contentFingerprint: await fingerprintPiPackageDirectory(packageRoot),
  }) as Extract<PluginSource, { kind: "LOCAL" }>;
}

export function fingerprintNpmRegistryIntegrity(integrity: string): `sha256:${string}` {
  if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/u.test(integrity)) {
    throw hpiPluginOperationError("SOURCE_INVALID");
  }
  return sha256(`npm-registry-integrity\0${integrity}`);
}

export function createPiPackageNpmCommand(registry?: string): readonly string[] {
  return [
    "npm",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    ...(registry === undefined ? [] : [`--registry=${registry}`]),
  ];
}

function pluginIdFor(
  packageJson: PackageJson,
  packageFingerprint: string,
  source: PluginSource,
): string {
  const stableName = packageJson.name
    .toLowerCase()
    .replace(/^@/u, "")
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  const identity = sha256(
    JSON.stringify({ packageName: packageJson.name, packageFingerprint, source }),
  );
  const suffix = identity.slice("sha256:".length, "sha256:".length + 24);
  return `plugin_${stableName.length === 0 ? "package" : stableName}-${suffix}`;
}

export async function fingerprintPiPackageResource(path: string): Promise<`sha256:${string}`> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error("Pi Package resource must not be a symbolic link");
  if (status.isFile()) return sha256(await readFile(path));
  if (status.isDirectory()) return fingerprintPiPackageDirectory(path);
  throw new Error("Pi Package resource must be a physical file or directory");
}

async function portableResources(
  packageRoot: string,
  resources: readonly ResolvedResource[],
): Promise<
  readonly { relativePath: string; contentFingerprint: `sha256:${string}`; enabled: boolean }[]
> {
  const portable = await Promise.all(
    resources.map(async (resource) => {
      const canonical = await realpath(resource.path);
      const relativePath = containedRelativePath(packageRoot, canonical);
      if (
        relativePath.split("/").some((segment) => segment === ".git" || segment === "node_modules")
      ) {
        throw hpiPluginOperationError("SOURCE_INVALID");
      }
      return {
        relativePath,
        contentFingerprint: await fingerprintPiPackageResource(canonical),
        enabled: resource.enabled,
      };
    }),
  );
  return portable.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function sourceReference(source: PluginSource): string {
  switch (source.kind) {
    case "LOCAL":
      return `LOCAL package ${source.label}`;
    case "NPM":
      return `npm package ${source.packageName}@${source.version}`;
    case "GIT":
      return `${source.remote} commit ${source.commit}`;
    case "PI":
      return `Pi package ${source.packageName}@${source.version}`;
  }
}

function sourceFingerprint(source: PluginSource): `sha256:${string}` {
  switch (source.kind) {
    case "LOCAL":
      return source.contentFingerprint as `sha256:${string}`;
    case "NPM":
    case "PI":
      return source.integrity as `sha256:${string}`;
    case "GIT":
      return source.treeFingerprint as `sha256:${string}`;
  }
}

export interface PiPackageManifestResolverOptions {
  readonly stateRoot: string;
  readonly localPackages?: ReadonlyMap<string, string>;
  readonly importedPiPackages?: ReadonlyMap<string, string>;
  readonly provenance?: {
    readonly upstreamName: string;
    readonly sourceReference: string;
    readonly license: string;
    readonly licenseReference: string;
  };
  readonly createPackageManager?: (options: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly registry?: string;
  }) => PackageManagerPort | Promise<PackageManagerPort>;
  readonly readGitHead?: (packageRoot: string) => Promise<string>;
  readonly installBudget?: Partial<PiPackageInstallBudget>;
}

export interface PiPackageRuntimeResource {
  readonly absolutePath: string;
  readonly contentFingerprint: `sha256:${string}`;
  readonly enabled: boolean;
}

export interface PiPackageRuntimeBinding {
  readonly pluginId: PluginManifestV2["pluginId"];
  readonly packageRoot: string;
  readonly packageFingerprint: PluginManifestV2["packageFingerprint"];
  readonly extensions: readonly PiPackageRuntimeResource[];
  readonly skills: readonly PiPackageRuntimeResource[];
  readonly prompts: readonly PiPackageRuntimeResource[];
  readonly themes: readonly PiPackageRuntimeResource[];
}

export interface PiPackageInspection {
  readonly manifest: PluginManifestV2;
  readonly runtimeBinding: PiPackageRuntimeBinding;
}

const resolverInspectionIdentities = new WeakMap<
  PiPackageInspection,
  { readonly fingerprint: string; readonly productionAttested: boolean }
>();

export function assertResolverPiPackageInspection(inspection: PiPackageInspection): void {
  const expected = resolverInspectionIdentities.get(inspection);
  if (expected?.productionAttested === false) {
    throw new Error("Pi Package qualification requires the locked public Pi Package resolver");
  }
  if (expected?.fingerprint !== sha256(JSON.stringify(inspection))) {
    throw new Error("Pi Package qualification requires an unchanged resolver inspection");
  }
}

export class PiPackageManifestResolver {
  readonly #stateRoot: string;
  readonly #localPackages: ReadonlyMap<string, string>;
  readonly #importedPiPackages: ReadonlyMap<string, string>;
  readonly #provenance: PiPackageManifestResolverOptions["provenance"];
  readonly #createPackageManager: NonNullable<
    PiPackageManifestResolverOptions["createPackageManager"]
  >;
  readonly #readGitHead: NonNullable<PiPackageManifestResolverOptions["readGitHead"]>;
  readonly #installBudget: PiPackageInstallBudget;
  readonly #useInstallWorker: boolean;
  readonly #productionAttested: boolean;

  public constructor(options: PiPackageManifestResolverOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#localPackages = options.localPackages ?? new Map();
    this.#importedPiPackages = options.importedPiPackages ?? new Map();
    this.#provenance = options.provenance;
    this.#useInstallWorker = options.createPackageManager === undefined;
    this.#productionAttested =
      options.createPackageManager === undefined && options.readGitHead === undefined;
    this.#installBudget = { ...DEFAULT_INSTALL_BUDGET, ...options.installBudget };
    if (
      !Object.values(this.#installBudget).every((value) => Number.isSafeInteger(value) && value > 0)
    ) {
      throw hpiPluginOperationError("SOURCE_INVALID");
    }
    this.#createPackageManager =
      options.createPackageManager ??
      (async (managerOptions) => {
        const pi = (await import(PI_PACKAGE_SPECIFIER)) as unknown as PiPackageModule;
        const npmCommand = createPiPackageNpmCommand(managerOptions.registry);
        const settingsManager = pi.SettingsManager.inMemory(
          { npmCommand },
          { projectTrusted: true },
        );
        return new pi.DefaultPackageManager({ ...managerOptions, settingsManager });
      });
    this.#readGitHead =
      options.readGitHead ??
      (async (packageRoot) => {
        const result = await execFileAsync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        });
        return result.stdout.trim();
      });
  }

  public async resolve(source: PluginSource): Promise<PluginManifestV2> {
    return (await this.inspect(source)).manifest;
  }

  public async inspect(source: PluginSource): Promise<PiPackageInspection> {
    let parsedSource: PluginSource;
    try {
      parsedSource = pluginSourceSchema.parse(source);
    } catch (error) {
      throw hpiPluginOperationError("SOURCE_INVALID", error);
    }
    await mkdir(this.#stateRoot, { recursive: true });
    const canonicalStateRoot = await canonicalDirectory(this.#stateRoot);
    const fingerprintPrefixLength = "sha256:".length;
    const stagingIdentity = sha256(JSON.stringify(parsedSource)).slice(
      fingerprintPrefixLength,
      fingerprintPrefixLength + 32,
    );
    const sourceStateRootPath = join(canonicalStateRoot, "package-staging", stagingIdentity);
    await mkdir(sourceStateRootPath, { recursive: true });
    const sourceStateRoot = await canonicalDirectory(sourceStateRootPath);
    return withDurableMutationLock(join(sourceStateRoot, ".package-inspection-lock"), async () => {
      const generationRoot = join(sourceStateRoot, `.generation-${randomUUID()}`);
      await mkdir(generationRoot, { recursive: false, mode: 0o700 });
      try {
        const packageManager = await this.#createPackageManager({
          cwd: generationRoot,
          agentDir: generationRoot,
          ...(parsedSource.kind === "NPM" ? { registry: parsedSource.registry } : {}),
        });
        const packageRoot = await this.#resolvePackageRoot(
          parsedSource,
          packageManager,
          generationRoot,
        );
        const packageFingerprint = await fingerprintPiPackageDirectory(packageRoot);
        if (
          parsedSource.kind === "LOCAL" &&
          packageFingerprint !== parsedSource.contentFingerprint
        ) {
          throw hpiPluginOperationError("SOURCE_CHANGED");
        }
        if (parsedSource.kind === "PI" && packageFingerprint !== parsedSource.integrity) {
          throw hpiPluginOperationError("SOURCE_CHANGED");
        }
        if (parsedSource.kind === "GIT" && packageFingerprint !== parsedSource.treeFingerprint) {
          throw hpiPluginOperationError("SOURCE_CHANGED");
        }
        const resolvedPaths: ResolvedPaths = await packageManager.resolveExtensionSources(
          [packageRoot],
          { temporary: true },
        );
        const packageJson = packageJsonSchema.parse(
          JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")),
        );
        this.#assertPackageIdentity(parsedSource, packageJson);
        const resources = {
          tools: (packageJson.hunterPi?.tools ?? []) as readonly PluginResource[],
          hooks: (packageJson.hunterPi?.hooks ?? []) as readonly PluginResource[],
          extensions: await portableResources(packageRoot, resolvedPaths.extensions),
          skills: await portableResources(packageRoot, resolvedPaths.skills),
          prompts: await portableResources(packageRoot, resolvedPaths.prompts),
          themes: await portableResources(packageRoot, resolvedPaths.themes),
        };
        const executableSurface =
          resources.extensions.length === 0
            ? "NONE"
            : resources.tools.length > 0 || resources.hooks.length > 0
              ? "DECLARED_NOT_EXECUTED"
              : "UNKNOWN_NOT_EXECUTED";
        const provenance = this.#provenance ?? {
          upstreamName: packageJson.name,
          sourceReference: sourceReference(parsedSource),
          license: packageJson.license ?? "LICENSE_NOT_DECLARED",
          licenseReference: "package.json license field",
        };

        const manifest = pluginManifestV2Schema.parse({
          schemaVersion: "hpi-plugin-manifest.v2",
          pluginId: pluginIdFor(packageJson, packageFingerprint, parsedSource),
          version: packageJson.version,
          source: parsedSource,
          packageFingerprint,
          license: provenance.license,
          provenance: {
            upstreamName: provenance.upstreamName,
            sourceReference: provenance.sourceReference,
            sourceFingerprint: sourceFingerprint(parsedSource),
            licenseReference: provenance.licenseReference,
          },
          resources,
          executableSurface,
        });
        const snapshotRoot = await publishManagedPackageSnapshot({
          sourceRoot: packageRoot,
          snapshotParent: join(sourceStateRoot, "snapshots"),
          packageFingerprint,
        });
        const runtimeResources = (
          entries: readonly {
            readonly relativePath: string;
            readonly contentFingerprint: string;
            readonly enabled: boolean;
          }[],
        ): readonly PiPackageRuntimeResource[] =>
          entries.map((entry) => ({
            absolutePath:
              entry.relativePath === "."
                ? snapshotRoot
                : resolve(snapshotRoot, ...entry.relativePath.split("/")),
            contentFingerprint: entry.contentFingerprint as `sha256:${string}`,
            enabled: entry.enabled,
          }));
        const inspection: PiPackageInspection = {
          manifest,
          runtimeBinding: {
            pluginId: manifest.pluginId,
            packageRoot: snapshotRoot,
            packageFingerprint: manifest.packageFingerprint,
            extensions: runtimeResources(manifest.resources.extensions),
            skills: runtimeResources(manifest.resources.skills),
            prompts: runtimeResources(manifest.resources.prompts),
            themes: runtimeResources(manifest.resources.themes),
          },
        };
        resolverInspectionIdentities.set(inspection, {
          fingerprint: sha256(JSON.stringify(inspection)),
          productionAttested: this.#productionAttested,
        });
        return inspection;
      } finally {
        await rm(generationRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async #resolvePackageRoot(
    source: PluginSource,
    packageManager: PackageManagerPort,
    stagingRoot: string,
  ): Promise<string> {
    if (source.kind === "LOCAL") {
      const configuredRoot = this.#localPackages.get(source.label);
      if (configuredRoot === undefined) {
        throw hpiPluginOperationError("SOURCE_INVALID");
      }
      const packageRoot = await canonicalDirectory(configuredRoot);
      const observedPathFingerprint = sha256(
        `physical-package-root\0${comparablePath(packageRoot)}`,
      );
      if (observedPathFingerprint !== source.pathFingerprint) {
        throw hpiPluginOperationError("SOURCE_CHANGED");
      }
      return packageRoot;
    }
    if (source.kind === "PI") {
      const packageRoot = this.#importedPiPackages.get(`${source.packageName}@${source.version}`);
      if (packageRoot === undefined) {
        throw hpiPluginOperationError("SOURCE_INVALID");
      }
      return canonicalDirectory(packageRoot);
    }

    const packageManagerSource =
      source.kind === "NPM"
        ? `npm:${source.packageName}@${source.version}`
        : `git:${source.remote}@${source.commit}`;
    if (this.#useInstallWorker) {
      await runBoundedInstallWorker({
        stagingRoot,
        source: packageManagerSource,
        ...(source.kind === "NPM" ? { registry: source.registry } : {}),
        budget: this.#installBudget,
      });
    } else {
      await runBoundedInjectedInstall({
        install: () => packageManager.install(packageManagerSource),
        stagingRoot,
        budget: this.#installBudget,
      });
    }
    const installedPath = packageManager.getInstalledPath(packageManagerSource, "user");
    if (installedPath === undefined) {
      throw hpiPluginOperationError("INSTALL_FAILED");
    }
    const packageRoot = await canonicalDirectory(installedPath);
    if (containedRelativePath(stagingRoot, packageRoot) === ".") {
      throw hpiPluginOperationError("INSTALL_FAILED");
    }
    if (source.kind === "NPM") {
      const lockPath = join(stagingRoot, "npm", "package-lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        readonly packages?: Readonly<Record<string, { readonly integrity?: string }>>;
      };
      const integrity = lock.packages?.[`node_modules/${source.packageName}`]?.integrity;
      if (
        integrity === undefined ||
        fingerprintNpmRegistryIntegrity(integrity) !== source.integrity
      ) {
        throw hpiPluginOperationError("SRI_MISMATCH");
      }
    } else {
      const head = await this.#readGitHead(packageRoot);
      if (head !== source.commit) {
        throw hpiPluginOperationError("SOURCE_CHANGED");
      }
    }
    return packageRoot;
  }

  #assertPackageIdentity(source: PluginSource, packageJson: PackageJson): void {
    if (
      (source.kind === "NPM" || source.kind === "PI") &&
      (packageJson.name !== source.packageName || packageJson.version !== source.version)
    ) {
      throw hpiPluginOperationError("SOURCE_CHANGED");
    }
  }
}
