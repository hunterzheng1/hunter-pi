import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  FilePiPackageBindingStore,
  PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
  PiPackageManifestResolver,
  Task6PiEngineHost,
  HPI_CORE_EXTENSION_VERSION,
  HpiLaunchBlockedError,
  HpiPluginOperationError,
  PiJsonEngineHost,
  QualifiedPiProcessBlockedError,
  acknowledgeProviderDisclosure,
  assertHpiSessionTreeSafe,
  createDefaultHpiConfiguration,
  createInteractiveTuiConfigurationFingerprint,
  createPiLaunchPlan,
  createLocalPiPluginSource,
  createQualifiedPiJsonProcess,
  createQuickSessionHeader,
  createQuickSessionProcessObservation,
  disableHpiPlugin,
  fingerprintNpmRegistryIntegrity,
  hpiConfigurationSchema,
  hpiPluginOperationError,
  inspectHpiPlugins,
  inspectBundledCoreExtension,
  launchPi,
  loadHpiConfiguration,
  prepareHpiRuntimeDirectories,
  prepareQualifiedPiPluginActivation,
  qualifyPiPackageInspection,
  providerDisclosureRequired,
  readPiProviderAuthMetadata,
  resolvePiProviderDestination,
  resolveBundledCoreExtensionPath,
  resolveHpiPaths,
  runHpiDoctor,
  saveHpiConfiguration,
  type HpiConfiguration,
  type HpiDoctorReport,
  type HpiPaths,
  type PiLaunchPlan,
  type PiPluginActivationCompatibilityContext,
  type PiProviderDestination,
  type PiProviderAuthMetadata,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { createFileLeaseManager } from "@hunter-pi/execution";
import {
  FilePluginManager,
  PluginJournalCorruptError,
  pluginInventorySchema,
  pluginRecordSchema,
  pluginSourceSchema,
  withPluginLifecycleTransaction,
  type PluginInventory,
  type PluginRecord,
  type PluginSource,
} from "@hunter-pi/plugin-manager";
import {
  RealManagedChangeBlockedError,
  realManagedChangeRequestSchema,
  runRealManagedChange,
  runTask6ManagedChange,
  task6OutputCaptureLimits,
} from "@hunter-pi/managed-change";
import {
  createPilotRepositoryTargetBlockedReceipt,
  createPilotRepositoryTargetReceipt,
  FilePilotArchiveStore,
  FilePilotCaptureCoordinator,
  PilotCaptureCoordinatorError,
  PilotEvaluator,
  PilotPlanCompiler,
  pilotCaptureObservationSchema,
  pilotExecutionPlanSchema,
  pilotTargetIdSchema,
  type PilotPlanInput,
  type PilotRepositoryTargetReceipt,
  type PilotPreflightFailure,
  type TrustedPilotArchive,
} from "@hunter-pi/pilot";
import { archiveIdSchema, operationIdSchema } from "@hunter-pi/domain";
import {
  FileUpdateManager,
  FileWindowsPortableReleaseAdapter,
  HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
  releaseCandidateSchema,
  type ReleaseCandidate,
  type ReleaseCheckResult,
  type UpdateManager,
  type UpdateReceipt,
} from "@hunter-pi/updater";

import { getHpiVersionInfo, type HpiVersionInfo } from "./version.js";

export interface HpiCliIo {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  confirm(question: string): Promise<boolean>;
}

export interface HpiRepositoryState {
  readonly root: string;
  readonly name: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export interface HpiCliDependencies {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly io: HpiCliIo;
  readonly now: () => string;
  readonly inspectRepository: (cwd: string) => Promise<HpiRepositoryState>;
  readonly inspectPilotTarget?: (
    repository: string,
    targetId: string,
  ) => Promise<PilotRepositoryTargetReceipt>;
  readonly readPilotArchive?: (path: string) => Promise<TrustedPilotArchive>;
  readonly readProviderAuthStatus: (
    paths: HpiPaths,
    providerId: string,
  ) => Promise<PiProviderAuthMetadata>;
  readonly resolveProviderDestination: (
    paths: HpiPaths,
    providerId: string,
    modelId: string,
  ) => Promise<PiProviderDestination>;
  readonly launch: (plan: PiLaunchPlan) => Promise<number>;
  readonly temporaryParent: string;
  readonly piCliPath?: string;
  readonly coreExtensionPath?: string;
  readonly platform: string;
  readonly getVersionInfo?: () => Promise<HpiVersionInfo>;
  readonly runTask6Process?: (request: Task6PiProcessRequest) => Promise<Task6PiProcessResult>;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly readBinaryFile?: (path: string) => Promise<Uint8Array>;
  readonly createUpdateManager?: (options: {
    readonly paths: HpiPaths;
    readonly artifactPath?: string;
  }) => Promise<UpdateManager | undefined>;
}

export function inspectHpiRepository(cwd: string): Promise<HpiRepositoryState> {
  const rootResult = runPilotGit(cwd, ["rev-parse", "--show-toplevel"]);
  const branchResult = runPilotGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const filterResult = runPilotGit(cwd, [
    "config",
    "--local",
    "--name-only",
    "--get-regexp",
    "^filter\\..*\\.(clean|process|smudge)$",
  ]);
  if (
    !rootResult.ok ||
    !branchResult.ok ||
    (filterResult.status !== 0 && filterResult.status !== 1) ||
    filterResult.stdout.trim().length > 0
  ) {
    throw new Error("Git repository inspection failed.");
  }
  const statusResult = runPilotGit(cwd, ["status", "--porcelain=v1"]);
  if (!statusResult.ok) {
    throw new Error("Git repository inspection failed.");
  }
  const root = rootResult.stdout.trim();
  const branch = branchResult.stdout.trim();
  const dirty = statusResult.stdout.length > 0;
  return Promise.resolve({ root, name: basename(root), branch, dirty });
}

function minimalPilotGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOGLOBAL: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
}

function runPilotGit(
  repository: string,
  arguments_: readonly string[],
): { readonly ok: boolean; readonly stdout: string; readonly status: number | null } {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      repository,
      ...arguments_,
    ],
    {
      env: minimalPilotGitEnvironment(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return {
    ok: result.error === undefined && result.status === 0,
    stdout: result.stdout,
    status: result.status,
  };
}

type PilotTargetSnapshot =
  | {
      readonly ok: true;
      readonly repository: string;
      readonly branch: string;
      readonly baseCommit: string;
      readonly baseTree: string;
      readonly dirty: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: Parameters<typeof createPilotRepositoryTargetBlockedReceipt>[1];
    };

function capturePilotTargetSnapshot(repository: string): PilotTargetSnapshot {
  const topLevel = runPilotGit(repository, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) return { ok: false, reason: "PILOT_TARGET_NOT_GIT_ROOT" };
  let topLevelPath: string;
  try {
    topLevelPath = resolve(topLevel.stdout.trim());
  } catch {
    return { ok: false, reason: "PILOT_TARGET_INSPECTION_FAILED" };
  }
  if (topLevelPath !== repository) return { ok: false, reason: "PILOT_TARGET_NOT_GIT_ROOT" };

  const baseCommit = runPilotGit(repository, ["rev-parse", "HEAD"]);
  const baseTree = runPilotGit(repository, ["rev-parse", "HEAD^{tree}"]);
  if (!baseCommit.ok || !baseTree.ok) {
    return { ok: false, reason: "PILOT_TARGET_INSPECTION_FAILED" };
  }
  const branch = runPilotGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch.ok) {
    const headName = runPilotGit(repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return {
      ok: false,
      reason:
        headName.ok && headName.stdout.trim() === "HEAD"
          ? "PILOT_TARGET_DETACHED_HEAD"
          : "PILOT_TARGET_INSPECTION_FAILED",
    };
  }
  const filterConfiguration = runPilotGit(repository, [
    "config",
    "--local",
    "--name-only",
    "--get-regexp",
    "^filter\\..*\\.(clean|process|smudge)$",
  ]);
  if (filterConfiguration.status !== 0 && filterConfiguration.status !== 1) {
    return { ok: false, reason: "PILOT_TARGET_INSPECTION_FAILED" };
  }
  if (filterConfiguration.stdout.trim().length > 0) {
    return { ok: false, reason: "PILOT_TARGET_EXTERNAL_FILTER_CONFIGURED" };
  }
  const status = runPilotGit(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) return { ok: false, reason: "PILOT_TARGET_INSPECTION_FAILED" };
  return {
    ok: true,
    repository,
    branch: branch.stdout.trim(),
    baseCommit: baseCommit.stdout.trim(),
    baseTree: baseTree.stdout.trim(),
    dirty: status.stdout.length > 0,
  };
}

export async function inspectHpiPilotTarget(
  repositoryInput: string,
  targetId: string,
): Promise<PilotRepositoryTargetReceipt> {
  pilotTargetIdSchema.parse(targetId);
  const blocked = (reason: Parameters<typeof createPilotRepositoryTargetBlockedReceipt>[1]) =>
    createPilotRepositoryTargetBlockedReceipt(targetId, reason);
  try {
    const resolved = resolve(repositoryInput);
    const stats = await lstat(resolved).catch(() => undefined);
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) {
      return blocked("PILOT_TARGET_NOT_GIT_ROOT");
    }
    const repository = await realpath(resolved).catch(() => undefined);
    if (repository === undefined) return blocked("PILOT_TARGET_NOT_GIT_ROOT");
    if (repository !== resolved) return blocked("PILOT_TARGET_NOT_CANONICAL");

    const first = capturePilotTargetSnapshot(repository);
    if (!first.ok) return blocked(first.reason);
    const second = capturePilotTargetSnapshot(repository);
    if (!second.ok) return blocked(second.reason);
    if (
      first.repository !== second.repository ||
      first.branch !== second.branch ||
      first.baseCommit !== second.baseCommit ||
      first.baseTree !== second.baseTree ||
      first.dirty !== second.dirty
    ) {
      return blocked("PILOT_TARGET_CHANGED_DURING_INSPECTION");
    }
    return createPilotRepositoryTargetReceipt({
      targetId,
      canonicalRepositoryIdentity: repository,
      branch: first.branch,
      baseCommit: first.baseCommit,
      baseTree: first.baseTree,
      dirty: first.dirty,
    });
  } catch {
    return blocked("PILOT_TARGET_INSPECTION_FAILED");
  }
}

function createProcessIo(): HpiCliIo {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    confirm: async (question) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return false;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await terminal.question(`${question} [y/N] `);
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        terminal.close();
      }
    },
  };
}

function defaultDependencies(): HpiCliDependencies {
  const dependencies: HpiCliDependencies = {
    cwd: process.cwd(),
    environment: process.env,
    homeDirectory: homedir(),
    io: createProcessIo(),
    now: () => new Date().toISOString(),
    inspectRepository: inspectHpiRepository,
    inspectPilotTarget: inspectHpiPilotTarget,
    readPilotArchive: (path) => Promise.resolve(FilePilotArchiveStore.readPackageFile(path)),
    readProviderAuthStatus: readPiProviderAuthMetadata,
    resolveProviderDestination: resolvePiProviderDestination,
    launch: launchPi,
    temporaryParent: tmpdir(),
    platform: process.platform,
    readTextFile: (path) => readFile(path, "utf8"),
    readBinaryFile: (path) => readFile(path),
    createUpdateManager: (options) => createDefaultUpdateManager(dependencies, options),
  };
  return dependencies;
}

function createDefaultUpdateManager(
  dependencies: HpiCliDependencies,
  options: { readonly paths: HpiPaths; readonly artifactPath?: string },
): Promise<UpdateManager | undefined> {
  const portableRoot = dependencies.environment["HUNTER_PI_PORTABLE_ROOT"];
  if (
    dependencies.platform !== "win32" ||
    process.arch !== "x64" ||
    portableRoot === undefined ||
    !isAbsolute(portableRoot)
  ) {
    return Promise.resolve(undefined);
  }
  const adapter = new FileWindowsPortableReleaseAdapter({
    installationRoot: resolve(portableRoot),
    mutableStateDirectory: options.paths.root,
    now: dependencies.now,
  });
  return Promise.resolve(
    new FileUpdateManager({
      stateRoot: join(options.paths.root, "updates"),
      channel: "PREVIEW",
      adapter,
      artifacts: {
        read: async () => {
          if (options.artifactPath === undefined) {
            throw new Error("an update artifact file is required for this operation");
          }
          return dependencies.readBinaryFile === undefined
            ? await readFile(options.artifactPath)
            : await dependencies.readBinaryFile(options.artifactPath);
        },
      },
      qualificationVerifierFingerprint: HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      now: dependencies.now,
    }),
  );
}

function line(io: HpiCliIo, text: string): void {
  io.writeStdout(`${text}\n`);
}

function errorLine(io: HpiCliIo, text: string): void {
  io.writeStderr(`${text}\n`);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function updateCandidatePresentation(candidate: ReleaseCandidate): Record<string, unknown> {
  return {
    releaseId: candidate.releaseId,
    productVersion: candidate.productVersion,
    channel: candidate.channel,
    artifactFingerprint: candidate.artifact.fingerprint,
    artifactByteLength: candidate.artifact.byteLength,
    engine: candidate.engine,
    qualification: {
      status: candidate.qualification.status,
      verifierFingerprint: candidate.qualification.verifierFingerprint,
      checks: candidate.qualification.checks.map((check) => ({
        name: check.name,
        outcome: check.outcome,
        evidenceIds: check.evidenceIds,
      })),
    },
    updatePolicy: candidate.updatePolicy,
    licenses: candidate.licenses,
  };
}

function updateStatusResult(
  status: "NOT_CONFIGURED" | "EMPTY" | "READY",
  reason?: string,
): Record<string, unknown> {
  return {
    schemaVersion: "hpi-update-status.v1",
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function readUpdateCandidate(
  path: string,
  dependencies: HpiCliDependencies,
): Promise<ReleaseCandidate> {
  const raw = await (
    dependencies.readTextFile ?? ((filePath: string) => readFile(filePath, "utf8"))
  )(path);
  return releaseCandidateSchema.parse(JSON.parse(raw) as unknown);
}

function updateOperationFingerprint(action: "CHECK" | "APPLY" | "ROLLBACK", value: unknown) {
  return sha256(`hpi-update\0${action}\0${JSON.stringify(value)}`);
}

function updateOutcomeExitCode(outcome: UpdateReceipt["outcome"]): number {
  return outcome === "APPLIED" || outcome === "NOOP" ? 0 : 2;
}

async function updateCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const subcommand = arguments_[0];
  const artifactPath =
    subcommand === "check" || subcommand === "apply"
      ? optionValue(arguments_.slice(1), "--artifact")
      : undefined;
  const manager = await dependencies.createUpdateManager?.({
    paths,
    ...(artifactPath === undefined ? {} : { artifactPath }),
  });
  if (manager === undefined) {
    line(
      dependencies.io,
      JSON.stringify(
        updateStatusResult(
          "NOT_CONFIGURED",
          "a Windows x64 portable installation is not configured for updates",
        ),
      ),
    );
    return 2;
  }

  try {
    if (subcommand === "status") {
      const reconciled = await manager.reconcile();
      const current = await manager.current();
      const history = await manager.history();
      line(
        dependencies.io,
        JSON.stringify({
          ...updateStatusResult(current.releaseId === undefined ? "EMPTY" : "READY"),
          currentReleaseId: current.releaseId ?? null,
          history: history.map(updateCandidatePresentation),
          reconciled,
        }),
      );
      return 0;
    }

    if (subcommand === "check" || subcommand === "apply") {
      const candidatePath = optionValue(arguments_.slice(1), "--candidate");
      if (candidatePath === undefined || artifactPath === undefined) throw new HpiCliUsageError();
      const candidate = await readUpdateCandidate(candidatePath, dependencies);
      if (subcommand === "check") {
        const result: ReleaseCheckResult = await manager.check(candidate);
        line(dependencies.io, JSON.stringify(result));
        return result.status === "AVAILABLE" ? 0 : 2;
      }
      const receipt = await manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: operationIdSchema.parse(`op_update-apply-${randomUUID()}`),
        operationFingerprint: updateOperationFingerprint("APPLY", candidate),
        candidate,
        observedAt: dependencies.now(),
      });
      line(dependencies.io, JSON.stringify(receipt));
      return updateOutcomeExitCode(receipt.outcome);
    }

    if (subcommand === "rollback") {
      const targetReleaseId = arguments_[1];
      if (targetReleaseId === undefined) throw new HpiCliUsageError();
      const receipt = await manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: operationIdSchema.parse(`op_update-rollback-${randomUUID()}`),
        operationFingerprint: updateOperationFingerprint("ROLLBACK", targetReleaseId),
        targetReleaseId,
        observedAt: dependencies.now(),
      });
      line(dependencies.io, JSON.stringify(receipt));
      return updateOutcomeExitCode(receipt.outcome);
    }
    throw new HpiCliUsageError();
  } catch (error) {
    if (error instanceof HpiCliUsageError) throw error;
    line(
      dependencies.io,
      JSON.stringify({
        schemaVersion: "hpi-update-operation.v1",
        status: "BLOCKED",
        reason: "update input or operation could not be completed",
      }),
    );
    return 2;
  }
}

function createPluginCompatibilityContext(
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
  version: HpiVersionInfo,
): PiPluginActivationCompatibilityContext {
  const sourceIdentity = /^[a-f0-9]{40}$/u.test(version.sourceCommit)
    ? version.sourceCommit.slice(0, 20)
    : "workspace";
  return {
    qualificationStateRoot: join(paths.pluginRegistryDirectory, "qualification"),
    distributionReleaseId: `release_hunter-pi-${version.productVersion}-${sourceIdentity}`,
    engineReleaseId: `engine-release_pi-${version.engine.version}`,
    engineReleaseFingerprint: sha256(
      JSON.stringify({
        packageName: version.engine.packageName,
        version: version.engine.version,
      }),
    ),
    platformFingerprint: sha256(
      JSON.stringify({
        architecture: process.arch,
        node: process.versions.node,
        platform: dependencies.platform,
      }),
    ),
    compatibilityVerifierFingerprint: PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
  };
}

function pluginManagerCompatibilityOptions(context: PiPluginActivationCompatibilityContext) {
  return {
    distributionReleaseId: context.distributionReleaseId,
    engineReleaseId: context.engineReleaseId,
    engineReleaseFingerprint: context.engineReleaseFingerprint,
    platformFingerprint: context.platformFingerprint,
    compatibilityVerifierFingerprint: context.compatibilityVerifierFingerprint,
  };
}

export interface PluginRegistryPresentation {
  readonly records: readonly unknown[];
  readonly inventory: PluginInventory | undefined;
}

export function createPluginRegistryPresentation(
  recordsInput: readonly PluginRecord[],
  inventoryInput?: PluginInventory,
): PluginRegistryPresentation {
  const records = recordsInput.map((record) => pluginRecordSchema.parse(record));
  const legacyPluginIds = new Set<string>(
    records
      .filter((record) => record.schemaVersion === "hpi-plugin-record.v1")
      .map((record) => record.pluginId),
  );
  const presentationRecords = records.map((record) =>
    record.schemaVersion === "hpi-plugin-record.v2"
      ? record
      : {
          schemaVersion: record.schemaVersion,
          pluginId: record.pluginId,
          state: record.state,
          installedAt: record.installedAt,
          lastOperationId: record.lastOperationId,
          manifest: {
            schemaVersion: record.manifest.schemaVersion,
            pluginId: record.manifest.pluginId,
            version: record.manifest.version,
            packageFingerprint: record.manifest.packageFingerprint,
            sourceKind: record.manifest.source.kind,
            legacyMetadata: "REDACTED",
          },
          assurance: {
            compatibility: record.assurance.compatibility,
            trust: record.assurance.trust,
            isolation: record.assurance.isolation,
            assessedAt: record.assurance.assessedAt,
          },
        },
  );
  if (inventoryInput === undefined) {
    return { records: presentationRecords, inventory: undefined };
  }
  const inventory = pluginInventorySchema.parse(inventoryInput);
  const redactLegacyDescriptions = <
    T extends { readonly pluginId: string; readonly description: string },
  >(
    resources: readonly T[],
  ): readonly T[] =>
    resources.map((resource) =>
      legacyPluginIds.has(resource.pluginId)
        ? { ...resource, description: "REDACTED_LEGACY_METADATA" }
        : resource,
    );
  return {
    records: presentationRecords,
    inventory: pluginInventorySchema.parse({
      ...inventory,
      declaredTools: redactLegacyDescriptions(inventory.declaredTools),
      declaredHooks: redactLegacyDescriptions(inventory.declaredHooks),
      effectiveTools: redactLegacyDescriptions(inventory.effectiveTools),
      effectiveHooks: redactLegacyDescriptions(inventory.effectiveHooks),
    }),
  };
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

class HpiCliUsageError extends Error {}

function assertUniqueFlags(arguments_: readonly string[], allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const argument of arguments_) {
    if (!allowed.has(argument) || seen.has(argument)) throw new HpiCliUsageError();
    seen.add(argument);
  }
}

function assertValueOptions(arguments_: readonly string[], allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !allowed.has(option) ||
      seen.has(option) ||
      value.startsWith("-")
    ) {
      throw new HpiCliUsageError();
    }
    seen.add(option);
  }
}

function assertPilotJsonOptions(
  arguments_: readonly string[],
  requiredValueOptions: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  let jsonSeen = false;
  for (let index = 0; index < arguments_.length;) {
    const option = arguments_[index];
    if (option === "--json") {
      if (jsonSeen) throw new HpiCliUsageError();
      jsonSeen = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !requiredValueOptions.has(option) ||
      seen.has(option) ||
      value.startsWith("-")
    ) {
      throw new HpiCliUsageError();
    }
    seen.add(option);
    index += 2;
  }
  if (!jsonSeen || seen.size !== requiredValueOptions.size) throw new HpiCliUsageError();
}

function assertPilotTargetOptions(arguments_: readonly string[]): void {
  assertPilotJsonOptions(arguments_, new Set(["--repo", "--target-id"]));
  const targetId = optionValue(arguments_, "--target-id");
  if (targetId === undefined || !pilotTargetIdSchema.safeParse(targetId).success) {
    throw new HpiCliUsageError();
  }
}

function assertChangeOptions(arguments_: readonly string[]): void {
  const seen = new Set<string>();
  let jsonSeen = false;
  let allowProviderRequestSeen = false;
  for (let index = 0; index < arguments_.length;) {
    const option = arguments_[index];
    if (option === "--json") {
      if (jsonSeen) throw new HpiCliUsageError();
      jsonSeen = true;
      index += 1;
      continue;
    }
    if (option === "--allow-provider-request") {
      if (allowProviderRequestSeen) throw new HpiCliUsageError();
      allowProviderRequestSeen = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !new Set(["--repo", "--plan", "--run-archive-id"]).has(option) ||
      seen.has(option) ||
      value.startsWith("-")
    ) {
      throw new HpiCliUsageError();
    }
    seen.add(option);
    index += 2;
  }
  if (!jsonSeen || !seen.has("--repo") || !seen.has("--plan") || seen.size > 3) {
    throw new HpiCliUsageError();
  }
  const runArchiveId = optionValue(arguments_, "--run-archive-id");
  if (runArchiveId !== undefined && !archiveIdSchema.safeParse(runArchiveId).success) {
    throw new HpiCliUsageError();
  }
}

function assertUpdateOptions(arguments_: readonly string[]): void {
  const subcommand = arguments_[0];
  if (subcommand === "status") {
    assertUniqueFlags(arguments_.slice(1), new Set(["--json"]));
    if (arguments_.length !== 2 || arguments_[1] !== "--json") throw new HpiCliUsageError();
    return;
  }
  if (subcommand === "check" || subcommand === "apply") {
    assertPilotJsonOptions(arguments_.slice(1), new Set(["--candidate", "--artifact"]));
    return;
  }
  if (subcommand === "rollback") {
    if (
      arguments_.length !== 3 ||
      arguments_[1] === undefined ||
      arguments_[1].startsWith("-") ||
      arguments_[2] !== "--json"
    ) {
      throw new HpiCliUsageError();
    }
    return;
  }
  throw new HpiCliUsageError();
}

function assertPluginOptions(options: readonly string[], valueOptions: ReadonlySet<string>): void {
  const booleanOptions = new Set(["--acknowledge-provenance", "--allow-process-authority"]);
  const seen = new Set<string>();
  for (let index = 0; index < options.length;) {
    const option = options[index];
    if (option === undefined || seen.has(option)) throw new HpiCliUsageError();
    seen.add(option);
    if (booleanOptions.has(option)) {
      index += 1;
      continue;
    }
    const value = options[index + 1];
    if (value === undefined || value.startsWith("-") || !valueOptions.has(option)) {
      throw new HpiCliUsageError();
    }
    index += 2;
  }
}

function validateCliArguments(arguments_: readonly string[]): void {
  const command = arguments_[0];
  if (command === "--help" || command === "-h") {
    if (arguments_.length !== 1) throw new HpiCliUsageError();
    return;
  }
  if (command === undefined || command.startsWith("-")) {
    assertUniqueFlags(arguments_, new Set(["--safe-mode", "--continue", "-c", "--resume", "-r"]));
    if (
      (arguments_.includes("--continue") && arguments_.includes("-c")) ||
      (arguments_.includes("--resume") && arguments_.includes("-r"))
    ) {
      throw new HpiCliUsageError();
    }
    return;
  }
  if (command === "setup") {
    assertValueOptions(
      arguments_.slice(1),
      new Set([
        "--provider",
        "--model",
        "--policy-reference",
        "--endpoint-category",
        "--destination-origin",
        "--permission",
      ]),
    );
    return;
  }
  if (command === "doctor") {
    assertUniqueFlags(arguments_.slice(1), new Set(["--json"]));
    return;
  }
  if (command === "pilot" && arguments_[1] === "compile") {
    assertPilotJsonOptions(arguments_.slice(2), new Set(["--input"]));
    return;
  }
  if (command === "pilot" && arguments_[1] === "capture") {
    const action = arguments_[2];
    const options = arguments_.slice(3);
    if (action === "open") {
      assertPilotJsonOptions(options, new Set(["--plan", "--session-id", "--archive-id"]));
      return;
    }
    if (action === "record") {
      assertPilotJsonOptions(options, new Set(["--session-id", "--operation-id", "--observation"]));
      return;
    }
    if (action === "managed-task") {
      assertPilotJsonOptions(
        options,
        new Set(["--session-id", "--operation-id", "--task-id", "--archive-ids", "--metrics"]),
      );
      return;
    }
    if (action === "status" || action === "finalize") {
      assertPilotJsonOptions(options, new Set(["--session-id"]));
      return;
    }
    throw new HpiCliUsageError();
  }
  if (command === "pilot" && arguments_[1] === "target") {
    assertPilotTargetOptions(arguments_.slice(2));
    return;
  }
  if (command === "pilot" && arguments_[1] === "evaluate") {
    assertPilotJsonOptions(arguments_.slice(2), new Set(["--plan", "--evidence", "--archive"]));
    return;
  }
  if (command === "pilot" && arguments_[1] === "preflight") {
    const options = arguments_.slice(2);
    const planIndex = options.indexOf("--plan");
    const planPath = options[planIndex + 1];
    const remaining = [...options.slice(0, planIndex), ...options.slice(planIndex + 2)];
    if (
      planIndex < 0 ||
      planPath === undefined ||
      planPath.startsWith("-") ||
      remaining.length !== 1 ||
      remaining[0] !== "--json"
    ) {
      throw new HpiCliUsageError();
    }
    return;
  }
  if (command === "change") {
    assertChangeOptions(arguments_.slice(1));
    return;
  }
  if (command === "update") {
    assertUpdateOptions(arguments_.slice(1));
    return;
  }
  if (command === "version") {
    assertUniqueFlags(arguments_.slice(1), new Set(["--json"]));
    return;
  }
  if (command === "login" || command === "help") {
    if (arguments_.length !== 1) throw new HpiCliUsageError();
    return;
  }
  if (command === "managed" && arguments_[1] === "fixture") {
    const options = arguments_.slice(2);
    assertUniqueFlags(options, new Set(["--json", "--allow-provider-request"]));
    if (!options.includes("--json")) throw new HpiCliUsageError();
    return;
  }
  if (
    (command === "smoke" && arguments_.length === 2 && arguments_[1] === "tui") ||
    (command === "plugin" &&
      arguments_.length === 2 &&
      ["doctor", "list"].includes(arguments_[1] ?? "")) ||
    (command === "plugin" &&
      arguments_.length === 3 &&
      ["disable", "remove"].includes(arguments_[1] ?? ""))
  ) {
    return;
  }
  if (command === "plugin" && arguments_[1] === "install") {
    const sourceKind = arguments_[2];
    const sourceValue = arguments_[3];
    if (sourceValue === undefined || !["local", "npm", "git"].includes(sourceKind ?? "")) {
      throw new HpiCliUsageError();
    }
    const valueOptions =
      sourceKind === "local"
        ? new Set(["--label"])
        : sourceKind === "npm"
          ? new Set(["--integrity", "--registry"])
          : new Set(["--commit", "--tree-fingerprint"]);
    assertPluginOptions(arguments_.slice(4), valueOptions);
    return;
  }
  if (command === "plugin" && arguments_[1] === "import-pi") {
    if (arguments_[2] === undefined) throw new HpiCliUsageError();
    assertPluginOptions(arguments_.slice(3), new Set(["--package", "--integrity"]));
    return;
  }
  throw new HpiCliUsageError();
}

function configuredForSetup(
  arguments_: readonly string[],
  existing: HpiConfiguration | null,
): HpiConfiguration {
  const base = existing ?? createDefaultHpiConfiguration();
  const providerId = optionValue(arguments_, "--provider") ?? base.provider.id;
  const endpoint = optionValue(arguments_, "--endpoint-category") ?? base.provider.endpointCategory;
  if (endpoint !== "PROVIDER_MANAGED" && endpoint !== "CUSTOM" && endpoint !== "LOCAL") {
    throw new Error("Endpoint category must be PROVIDER_MANAGED, CUSTOM, or LOCAL.");
  }
  const suppliedPolicy = optionValue(arguments_, "--policy-reference");
  const suppliedDestination = optionValue(arguments_, "--destination-origin");
  if (endpoint === "PROVIDER_MANAGED" && suppliedDestination !== undefined) {
    throw new Error("Provider-managed endpoints do not accept --destination-origin.");
  }
  const destinationOrigin =
    endpoint === "PROVIDER_MANAGED"
      ? null
      : (suppliedDestination ??
        (endpoint === base.provider.endpointCategory ? base.provider.destinationOrigin : null));
  if (
    (providerId !== base.provider.id ||
      endpoint !== base.provider.endpointCategory ||
      destinationOrigin !== base.provider.destinationOrigin) &&
    suppliedPolicy === undefined
  ) {
    throw new Error("A changed Provider or endpoint requires --policy-reference.");
  }
  const selectedModel = optionValue(arguments_, "--model") ?? base.provider.selectedModel;
  const rawPermission = optionValue(arguments_, "--permission")?.toUpperCase().replaceAll("-", "_");
  const permission = rawPermission ?? base.permissionProfile;
  if (permission !== "SAFE" && permission !== "BALANCED" && permission !== "FULL_ACCESS") {
    throw new Error("Permission must be safe, balanced, or full-access.");
  }
  const providerChanged =
    providerId !== base.provider.id ||
    endpoint !== base.provider.endpointCategory ||
    destinationOrigin !== base.provider.destinationOrigin;
  const policyReference = suppliedPolicy ?? base.provider.policyReference;
  const disclosureChanged = providerChanged || policyReference !== base.provider.policyReference;
  return hpiConfigurationSchema.parse({
    ...base,
    setupCompletedAt: null,
    provider: {
      id: providerId,
      selectedModel,
      endpointCategory: endpoint,
      destinationOrigin,
      policyReference,
    },
    providerReadiness: providerChanged
      ? { providerId, status: "NOT_CHECKED", checkedAt: null }
      : base.providerReadiness,
    permissionProfile: permission,
    disclosure: disclosureChanged ? { ...base.disclosure, acknowledgement: null } : base.disclosure,
  });
}

function printDisclosure(
  io: HpiCliIo,
  configuration: HpiConfiguration,
  resolvedDestinationOrigin: string,
): void {
  line(io, "Hunter Pi — Provider data disclosure");
  line(io, `Provider=${configuration.provider.id}`);
  line(io, `EndpointCategory=${configuration.provider.endpointCategory}`);
  line(io, `Destination=${resolvedDestinationOrigin}`);
  line(io, `PolicyReference=${configuration.provider.policyReference}`);
  line(io, `Categories=${configuration.disclosure.categories.join(",")}`);
  line(io, `ExternalRetention=${configuration.disclosure.externalRetention}`);
  line(io, `TrainingUse=${configuration.disclosure.trainingUse}`);
  line(io, `AccountControls=${configuration.disclosure.accountControls}`);
  line(io, "Complete repository files may enter model context when selected by the Agent.");
  line(
    io,
    "HunterTelemetry=DISABLED PiStartupNetwork=OFFLINE ProviderRequests=ENABLED_AFTER_CONSENT",
  );
  line(
    io,
    "Hunter Pi cannot enforce the Provider's external policy; account, plan, region, and Provider controls apply.",
  );
}

async function setupCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const current = await loadHpiConfiguration(paths);
  const proposed = configuredForSetup(arguments_, current);
  await prepareRuntimeDirectories(paths);
  const resolvedDestination = await resolveLaunchDestination(proposed, dependencies, paths);
  const destinationClassMatches =
    proposed.provider.endpointCategory === "PROVIDER_MANAGED"
      ? resolvedDestination.pristineOrigin !== null &&
        resolvedDestination.configuredOrigin === resolvedDestination.pristineOrigin
      : resolvedDestination.configuredOrigin === proposed.provider.destinationOrigin;
  if (!destinationClassMatches) {
    throw new HpiLaunchBlockedError(
      "PROVIDER_DESTINATION_NOT_ALLOWED",
      "The resolved Provider origin does not match the declared endpoint category/destination.",
    );
  }
  printDisclosure(dependencies.io, proposed, resolvedDestination.configuredOrigin);
  const accepted = await dependencies.io.confirm(
    `Acknowledge disclosure ${proposed.disclosure.version} for ${proposed.provider.id}?`,
  );
  if (!accepted) {
    errorLine(
      dependencies.io,
      "SetupStatus=BLOCKED NextAction=Run `hpi setup` when you are ready to review and accept the disclosure.",
    );
    return 2;
  }
  const acknowledged = acknowledgeProviderDisclosure(proposed, {
    acceptedAt: dependencies.now(),
    resolvedDestinationOrigin: resolvedDestination.configuredOrigin,
  });
  await saveHpiConfiguration(paths, {
    ...acknowledged,
    setupCompletedAt: dependencies.now(),
  });
  line(dependencies.io, "SetupStatus=DETECTED");
  line(
    dependencies.io,
    "NextAction=Run `hpi login`; authentication remains owned by Pi and the Provider.",
  );
  return 0;
}

function printDoctor(report: HpiDoctorReport, io: HpiCliIo, json: boolean): void {
  if (json) {
    line(io, JSON.stringify(report));
    return;
  }
  line(io, `Hunter Pi Doctor: ${report.overallStatus}`);
  for (const check of report.checks) {
    line(io, `${check.id}: ${check.status} — ${check.summary}`);
    if (check.nextAction !== null) {
      line(io, `  Next: ${check.nextAction}`);
    }
  }
}

async function doctorCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const report = await createDoctorReport(dependencies, paths);
  printDoctor(report, dependencies.io, arguments_.includes("--json"));
  return report.overallStatus === "DETECTED" ? 0 : 2;
}

async function createDoctorReport(
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<HpiDoctorReport> {
  const version = await (dependencies.getVersionInfo ?? getHpiVersionInfo)();
  return runHpiDoctor({
    paths,
    observedAt: dependencies.now(),
    temporaryParent: dependencies.temporaryParent,
    readProviderAuthStatus: dependencies.readProviderAuthStatus,
    resolveProviderDestination: dependencies.resolveProviderDestination,
    productIdentity: {
      productVersion: version.productVersion,
      sourceCommit: version.sourceCommit,
      sourceState: version.sourceState,
      coreExtensionIntegrity: version.coreExtensionIntegrity,
      productShellIntegrity: version.productShellIntegrity,
    },
    platform: dependencies.platform,
    ...(dependencies.coreExtensionPath === undefined
      ? {}
      : { coreExtensionPath: dependencies.coreExtensionPath }),
  });
}

async function prepareRuntimeDirectories(paths: HpiPaths): Promise<void> {
  await prepareHpiRuntimeDirectories(paths);
}

async function assertCoreExtensionIntegrity(
  dependencies: HpiCliDependencies,
): Promise<HpiVersionInfo> {
  const version = await (dependencies.getVersionInfo ?? getHpiVersionInfo)();
  const inspection = await inspectBundledCoreExtension(
    dependencies.coreExtensionPath ?? resolveBundledCoreExtensionPath(),
  );
  if (!inspection.detected || inspection.version !== HPI_CORE_EXTENSION_VERSION) {
    throw new HpiLaunchBlockedError(
      "CORE_EXTENSION_INCOMPATIBLE",
      "The bundled Core Extension is missing or has an incompatible version.",
    );
  }
  if (
    version.coreExtensionIntegrity !== null &&
    inspection.integrity !== version.coreExtensionIntegrity
  ) {
    throw new HpiLaunchBlockedError(
      "CORE_EXTENSION_INCOMPATIBLE",
      "The bundled Core Extension integrity does not match the package identity.",
    );
  }
  return version;
}

async function resolveLaunchDestination(
  configuration: HpiConfiguration,
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<PiProviderDestination> {
  if (configuration.provider.selectedModel === null) {
    throw new HpiLaunchBlockedError(
      "PROVIDER_DESTINATION_NOT_ALLOWED",
      "Provider launches require an explicitly selected model.",
    );
  }
  return dependencies.resolveProviderDestination(
    paths,
    configuration.provider.id,
    configuration.provider.selectedModel,
  );
}

async function loginCommand(dependencies: HpiCliDependencies, paths: HpiPaths): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration?.setupCompletedAt == null) {
    errorLine(dependencies.io, "LoginStatus=BLOCKED NextAction=Run `hpi setup` first.");
    return 2;
  }
  if (providerDisclosureRequired(configuration)) {
    errorLine(
      dependencies.io,
      "LoginStatus=BLOCKED NextAction=Run `hpi setup` and acknowledge the current disclosure.",
    );
    return 2;
  }
  await assertCoreExtensionIntegrity(dependencies);
  await prepareRuntimeDirectories(paths);
  await assertHpiSessionTreeSafe(paths);
  const resolvedProviderDestination = await resolveLaunchDestination(
    configuration,
    dependencies,
    paths,
  );
  line(
    dependencies.io,
    `Opening the Provider-owned Pi login flow for ${configuration.provider.id}.`,
  );
  line(
    dependencies.io,
    "Inside Pi, run `/login`, complete or cancel the Provider flow, then exit Pi.",
  );
  const plan = createPiLaunchPlan({
    paths,
    configuration,
    cwd: dependencies.cwd,
    purpose: "LOGIN",
    safeMode: true,
    blockPromptInput: true,
    providerAuthConfigured: false,
    sessionTreeInspected: true,
    resolvedProviderDestination,
    displayHeader: [
      "Hunter Pi | Mode=LOGIN",
      `Provider=${configuration.provider.id} Permission=SAFE`,
      "Core Compatibility=UNVERIFIED Trust=BUNDLED Isolation=PROCESS_AUTHORITY",
      "PiBuiltins=USER_DIRECTED CoreMediation=NOT_GLOBAL",
      "VerifiedChange=NOT_CLAIMED",
    ].join("\n"),
    ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
    ...(dependencies.coreExtensionPath === undefined
      ? {}
      : { coreExtensionPath: dependencies.coreExtensionPath }),
  });
  const exitCode = await dependencies.launch(plan);
  if (exitCode !== 0) {
    errorLine(
      dependencies.io,
      "LoginStatus=BLOCKED Reason=PROCESS_ERROR NextAction=Rerun `hpi login` and complete or cancel the Provider flow explicitly.",
    );
    return 2;
  }
  const confirmed = await dependencies.io.confirm(
    "Did you complete the selected Provider login flow in Pi?",
  );
  if (!confirmed) {
    errorLine(
      dependencies.io,
      "LoginStatus=BLOCKED Receipt=DECLINED NextAction=Rerun `hpi login` when you want to complete the Provider flow.",
    );
    return 2;
  }
  const metadata = await dependencies.readProviderAuthStatus(paths, configuration.provider.id);
  const checkedAt = dependencies.now();
  await saveHpiConfiguration(paths, {
    ...configuration,
    providerReadiness: {
      providerId: configuration.provider.id,
      status: metadata.configured ? "DETECTED" : "BLOCKED",
      checkedAt,
    },
  });
  if (!metadata.configured) {
    errorLine(
      dependencies.io,
      "LoginStatus=BLOCKED NextAction=Rerun `hpi login` and complete the Provider flow.",
    );
    return 2;
  }
  line(
    dependencies.io,
    "LoginStatus=DETECTED (Pi Engine managed credentials; Hunter host received metadata only)",
  );
  return 0;
}

async function managedFixtureCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration?.setupCompletedAt == null) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=SETUP_REQUIRED NextAction=Run `hpi setup` first.",
    );
    return 2;
  }
  if (!arguments_.includes("--allow-provider-request")) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_REQUEST_NOT_AUTHORIZED NextAction=Rerun with `--allow-provider-request` only after confirming the declared Provider scope.",
    );
    return 2;
  }
  const auth = await dependencies.readProviderAuthStatus(paths, configuration.provider.id);
  if (!auth.configured) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_AUTH_REQUIRED NextAction=Run `hpi login` first.",
    );
    return 2;
  }
  const confirmed = await dependencies.io.confirm(
    "This disposable fixture will send one Provider request. Continue?",
  );
  if (!confirmed) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_REQUEST_NOT_ACKNOWLEDGED NextAction=Rerun only after explicitly acknowledging the Provider request.",
    );
    return 2;
  }
  const version = await assertCoreExtensionIntegrity(dependencies);
  if (!/^[a-f0-9]{40}$/u.test(version.sourceCommit) || version.sourceState !== "CLEAN") {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=UNSTAMPED_OR_DIRTY_PRODUCT NextAction=Use an exact clean packaged Hunter Pi artifact.",
    );
    return 2;
  }
  await prepareRuntimeDirectories(paths);
  await assertHpiSessionTreeSafe(paths);
  const resolvedProviderDestination = await resolveLaunchDestination(
    configuration,
    dependencies,
    paths,
  );
  const managedConfiguration = hpiConfigurationSchema.parse({
    ...configuration,
    permissionProfile: "FULL_ACCESS",
  });
  const host = new Task6PiEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve(
        createPiLaunchPlan({
          paths,
          configuration: managedConfiguration,
          cwd: workspace,
          purpose: "QUICK",
          safeMode: false,
          providerAuthConfigured: true,
          sessionTreeInspected: true,
          resolvedProviderDestination,
          displayHeader: [
            "Hunter Pi | Mode=MANAGED_FIXTURE Permission=FULL_ACCESS",
            "Scope=AUTOMATIC_TEMPORARY_GIT_ONLY AgentReturn=OBSERVATION_ONLY",
            "IndependentVerification=REQUIRED RemoteWrite=PROHIBITED",
          ].join("\n"),
          ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
          ...(dependencies.coreExtensionPath === undefined
            ? {}
            : { coreExtensionPath: dependencies.coreExtensionPath }),
        }),
      ),
    ...(dependencies.runTask6Process === undefined
      ? {}
      : { runProcess: dependencies.runTask6Process }),
    now: dependencies.now,
    processTimeoutMs: 300_000,
    maximumOutputBytes: task6OutputCaptureLimits.engine,
  });
  const environmentFingerprint = sha256(
    JSON.stringify({
      platform: dependencies.platform,
      node: process.version,
      productVersion: version.productVersion,
      productShellIntegrity: version.productShellIntegrity,
      coreExtensionIntegrity: version.coreExtensionIntegrity,
      engine: version.engine,
      provider: configuration.provider.id,
      model: configuration.provider.selectedModel,
      permissionProfile: "FULL_ACCESS",
      fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
    }),
  );
  const artifact = await runTask6ManagedChange({
    parentDirectory: dependencies.temporaryParent,
    engineHost: host,
    productSource: { commit: version.sourceCommit, state: version.sourceState },
    engineRelease: version.engine,
    providerId: configuration.provider.id,
    environmentFingerprint,
    now: dependencies.now,
  });
  line(dependencies.io, JSON.stringify(artifact));
  return artifact.taskResult === "GO" ? 0 : 2;
}

async function realChangeCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration?.setupCompletedAt == null) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=SETUP_REQUIRED NextAction=Run `hpi setup` first.",
    );
    return 2;
  }
  if (!arguments_.includes("--allow-provider-request")) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_REQUEST_NOT_AUTHORIZED NextAction=Rerun with `--allow-provider-request` only after confirming the explicit repository target and plan.",
    );
    return 2;
  }
  if (providerDisclosureRequired(configuration)) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_DISCLOSURE_REQUIRED NextAction=Run `hpi setup` and acknowledge the current Provider disclosure.",
    );
    return 2;
  }
  const planPath = optionValue(arguments_, "--plan");
  const repositoryInput = optionValue(arguments_, "--repo");
  if (planPath === undefined || repositoryInput === undefined) throw new HpiCliUsageError();
  const rawPlan = await readPilotJsonFile(planPath, dependencies);
  if (rawPlan.failure !== undefined) {
    errorLine(
      dependencies.io,
      `ManagedChangeStatus=BLOCKED Reason=PLAN_${rawPlan.failure} NextAction=Provide a readable valid JSON Managed Change plan.`,
    );
    return 2;
  }
  const parsedPlan = realManagedChangeRequestSchema.safeParse(rawPlan.value);
  if (!parsedPlan.success) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PLAN_INVALID NextAction=Use hpi-managed-change-request.v2 with an explicit check, allowedPaths, and frozen target identity.",
    );
    return 2;
  }
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(resolve(repositoryInput));
  } catch {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=REPOSITORY_NOT_FOUND NextAction=Select one existing physical Git repository root with --repo.",
    );
    return 2;
  }
  const repository = await dependencies.inspectRepository(repositoryPath);
  if (resolve(repository.root) !== repositoryPath) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=REPOSITORY_NOT_ROOT NextAction=Pass the exact Git repository root with --repo.",
    );
    return 2;
  }
  const auth = await dependencies.readProviderAuthStatus(paths, configuration.provider.id);
  if (!auth.configured) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_AUTH_REQUIRED NextAction=Run `hpi login` first.",
    );
    return 2;
  }
  const confirmed = await dependencies.io.confirm(
    `This explicitly selected ${repository.name} repository on ${repository.branch} may send one bounded Provider request and modify only the declared paths. Continue?`,
  );
  if (!confirmed) {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_REQUEST_NOT_ACKNOWLEDGED NextAction=Rerun only after explicitly acknowledging the target, plan, and Provider request.",
    );
    return 2;
  }
  const version = await assertCoreExtensionIntegrity(dependencies);
  if (!/^[a-f0-9]{40}$/u.test(version.sourceCommit) || version.sourceState !== "CLEAN") {
    errorLine(
      dependencies.io,
      "ManagedChangeStatus=BLOCKED Reason=UNSTAMPED_OR_DIRTY_PRODUCT NextAction=Use an exact clean packaged Hunter Pi artifact.",
    );
    return 2;
  }
  await prepareRuntimeDirectories(paths);
  await assertHpiSessionTreeSafe(paths);
  const resolvedProviderDestination = await resolveLaunchDestination(
    configuration,
    dependencies,
    paths,
  );
  const managedConfiguration = hpiConfigurationSchema.parse({
    ...configuration,
    permissionProfile: "FULL_ACCESS",
  });
  const leaseRoot = join(paths.root, "leases");
  await mkdir(leaseRoot, { recursive: true });
  const writerLeaseManager = await createFileLeaseManager({
    leaseRoot,
    now: dependencies.now,
  });
  const writerLeaseOwnerFingerprint = sha256(
    `hpi-real-writer-owner\0${String(process.pid)}\0${randomUUID()}`,
  );
  const qualifiedProcess =
    dependencies.runTask6Process ??
    (await createQualifiedPiJsonProcess({ leaseRoot, now: dependencies.now }));
  const host = new PiJsonEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve(
        createPiLaunchPlan({
          paths,
          configuration: managedConfiguration,
          cwd: workspace,
          purpose: "MANAGED",
          safeMode: false,
          providerAuthConfigured: true,
          sessionTreeInspected: true,
          resolvedProviderDestination,
          displayHeader: [
            "Hunter Pi | Mode=MANAGED Permission=FULL_ACCESS",
            "Scope=EXPLICIT_OPERATOR_SELECTED AgentReturn=OBSERVATION_ONLY",
            "IndependentVerification=REQUIRED CommitPushPublishDeploy=PROHIBITED",
          ].join("\n"),
          ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
          ...(dependencies.coreExtensionPath === undefined
            ? {}
            : { coreExtensionPath: dependencies.coreExtensionPath }),
        }),
      ),
    runProcess: qualifiedProcess,
    now: dependencies.now,
    processTimeoutMs: 300_000,
    maximumOutputBytes: 229_376,
    requireQualifiedProcess: dependencies.runTask6Process === undefined,
  });
  const environmentFingerprint = sha256(
    JSON.stringify({
      platform: dependencies.platform,
      node: process.version,
      productVersion: version.productVersion,
      productShellIntegrity: version.productShellIntegrity,
      coreExtensionIntegrity: version.coreExtensionIntegrity,
      engine: version.engine,
      provider: configuration.provider.id,
      model: configuration.provider.selectedModel,
      permissionProfile: "FULL_ACCESS",
      executionScope: "EXPLICIT_OPERATOR_SELECTED",
      repositoryBranch: repository.branch,
    }),
  );
  const runArchiveId = optionValue(arguments_, "--run-archive-id");
  const artifact = await runRealManagedChange({
    repository: repository.root,
    request: parsedPlan.data,
    engineHost: host,
    providerAuthConfigured: true,
    productSource: { commit: version.sourceCommit, state: version.sourceState },
    engineRelease: version.engine,
    providerId: configuration.provider.id,
    environmentFingerprint,
    writerLeaseManager,
    writerLeaseOwnerFingerprint,
    ...(runArchiveId === undefined
      ? {}
      : {
          durableArchive: {
            stateRoot: join(paths.root, "pilot", "managed-runs"),
            archiveId: runArchiveId,
            distributionReleaseId: `release_hunter-pi-${version.productVersion}`,
            operationId: `op_real-archive-${sha256(runArchiveId).slice(
              "sha256:".length,
              "sha256:".length + 24,
            )}`,
          },
        }),
    now: dependencies.now,
  });
  line(dependencies.io, JSON.stringify(artifact));
  return artifact.taskResult === "GO" ? 0 : 2;
}

async function firstRunCommand(dependencies: HpiCliDependencies, paths: HpiPaths): Promise<number> {
  line(dependencies.io, "Hunter Pi — First Run");
  line(
    dependencies.io,
    "Step 1/7 Environment — checking Node, fixed Pi Engine, Git fixture, and Core.",
  );
  const initialDoctor = await createDoctorReport(dependencies, paths);
  printDoctor(initialDoctor, dependencies.io, false);
  const requiredEnvironmentChecks = new Set([
    "node",
    "git_fixture",
    "engine_release",
    "core_extension",
  ]);
  if (
    initialDoctor.checks.some(
      (check) =>
        requiredEnvironmentChecks.has(check.id) &&
        check.status !== "DETECTED" &&
        !(check.id === "core_extension" && check.status === "NOT_PROVEN"),
    )
  ) {
    errorLine(
      dependencies.io,
      "FirstRunStatus=BLOCKED NextAction=Repair the environment check above and rerun `hpi`.",
    );
    return 2;
  }

  const defaults = createDefaultHpiConfiguration();
  line(
    dependencies.io,
    `Step 2/7 Provider — default ${defaults.provider.id}/${defaults.provider.selectedModel ?? "NOT_SELECTED"}; use explicit \`hpi setup\` options to choose another supported target.`,
  );
  line(dependencies.io, "Step 3/7 Data disclosure — explicit acknowledgement is required.");
  const setupExit = await setupCommand([], dependencies, paths);
  if (setupExit !== 0) return setupExit;
  line(dependencies.io, "Step 4/7 Authentication — Pi Engine owns the selected Provider flow.");
  const openLogin = await dependencies.io.confirm(
    "Open the selected Provider login TUI now? No model request will be sent by the wizard.",
  );
  if (!openLogin) {
    errorLine(
      dependencies.io,
      "FirstRunStatus=BLOCKED Stage=AUTHENTICATION NextAction=Run `hpi login` when ready.",
    );
    return 2;
  }
  const loginExit = await loginCommand(dependencies, paths);
  if (loginExit !== 0) return loginExit;

  line(
    dependencies.io,
    `Step 5/7 Defaults — Model=${defaults.provider.selectedModel ?? "NOT_SELECTED"} Permission=${defaults.permissionProfile} Thinking=PI_DEFAULT_NOT_CLAIMED`,
  );
  line(
    dependencies.io,
    "Step 6/7 Plugins — exact Pi Packages are metadata-qualified; executable extensions remain quarantined unless separately verified.",
  );

  line(
    dependencies.io,
    "Step 7/7 Verification — rerunning Doctor after setup and Provider readiness metadata.",
  );
  const finalDoctor = await createDoctorReport(dependencies, paths);
  printDoctor(finalDoctor, dependencies.io, false);
  line(
    dependencies.io,
    "FirstRunStatus=CONFIGURED InteractiveTui=NOT_PROVEN NextAction=Run `hpi smoke tui`, then run `hpi` again.",
  );
  return 0;
}

async function pluginCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
  lifecycleTransactionHeld = false,
): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration === null) {
    errorLine(dependencies.io, "PluginStatus=BLOCKED NextAction=Run `hpi setup` first.");
    return 2;
  }
  await prepareHpiRuntimeDirectories(paths);
  const action = arguments_[1];
  if (
    !lifecycleTransactionHeld &&
    (action === "install" || action === "import-pi" || action === "disable" || action === "remove")
  ) {
    return withPluginLifecycleTransaction(paths.pluginRegistryDirectory, () =>
      pluginCommand(arguments_, dependencies, paths, true),
    );
  }
  const readOnlyManager = () =>
    new FilePluginManager({
      stateRoot: paths.pluginRegistryDirectory,
      resolve: () => Promise.reject(new Error("read-only Plugin registry cannot resolve sources")),
    });
  if (action === "list") {
    const manager = readOnlyManager();
    const records = await manager.list();
    const presentation = createPluginRegistryPresentation(records, await manager.inventory());
    line(
      dependencies.io,
      JSON.stringify({
        records: presentation.records,
        inventory: presentation.inventory,
        startup: await manager.startup(),
      }),
    );
    return 0;
  }
  if (action === "doctor") {
    const inspections = await inspectHpiPlugins(configuration);
    const manager = readOnlyManager();
    const startup = await manager.startup();
    const records = startup.mode === "SAFE_MODE" ? [] : await manager.list();
    line(
      dependencies.io,
      JSON.stringify({
        legacyPlugins: inspections,
        records: createPluginRegistryPresentation(records).records,
        startup,
      }),
    );
    return inspections.some((plugin) => plugin.entrypointStatus === "BLOCKED") ||
      startup.mode === "SAFE_MODE"
      ? 2
      : 0;
  }
  if (action === "disable") {
    const pluginId = arguments_[2];
    if (pluginId === undefined) {
      errorLine(dependencies.io, "PluginStatus=BLOCKED NextAction=Specify a plugin id.");
      return 2;
    }
    const manager = readOnlyManager();
    const registered = (await manager.list()).find((record) => record.pluginId === pluginId);
    if (registered !== undefined) {
      await manager.disable({
        schemaVersion: "hpi-plugin-disable.v1",
        operationId: `op_plugin-disable-${randomUUID()}`,
        operationFingerprint: sha256(`plugin-disable\0${pluginId}`),
        pluginId: registered.pluginId,
        observedAt: dependencies.now(),
      });
      line(dependencies.io, `PluginStatus=DISABLED Plugin=${pluginId} FilesDeleted=NO`);
      return 0;
    }
    await saveHpiConfiguration(paths, disableHpiPlugin(configuration, pluginId));
    line(dependencies.io, `PluginStatus=DISABLED Plugin=${pluginId} FilesDeleted=NO`);
    return 0;
  }
  if (action === "remove") {
    const pluginId = arguments_[2];
    if (pluginId === undefined) {
      errorLine(dependencies.io, "PluginStatus=BLOCKED NextAction=Specify a plugin id.");
      return 2;
    }
    const manager = readOnlyManager();
    const receipt = await manager.remove({
      schemaVersion: "hpi-plugin-remove.v1",
      operationId: `op_plugin-remove-${randomUUID()}`,
      operationFingerprint: sha256(`plugin-remove\0${pluginId}`),
      pluginId,
      observedAt: dependencies.now(),
    });
    const removed = await new FilePiPackageBindingStore({
      stateRoot: paths.pluginBindingDirectory,
      managedPackageRoot: paths.pluginPackageDirectory,
    }).removeManagedSnapshots(pluginId);
    line(
      dependencies.io,
      JSON.stringify({
        receipt,
        filesDeleted: removed.bindingsDeleted > 0 || removed.snapshotsDeleted > 0,
        managedBindingsDeleted: removed.bindingsDeleted,
        managedSnapshotsDeleted: removed.snapshotsDeleted,
        journalHistoryRetained: true,
      }),
    );
    return 0;
  }
  if (action === "install" || action === "import-pi") {
    const acknowledged = arguments_.includes("--acknowledge-provenance");
    const processAuthorityAllowed = arguments_.includes("--allow-process-authority");
    if (!acknowledged || !processAuthorityAllowed) {
      errorLine(
        dependencies.io,
        "PluginStatus=BLOCKED NextAction=Review provenance and pass --acknowledge-provenance --allow-process-authority.",
      );
      return 2;
    }
    const sourceKind = action === "import-pi" ? "pi" : arguments_[2];
    const sourceValue = action === "import-pi" ? arguments_[2] : arguments_[3];
    if (sourceKind === undefined || sourceValue === undefined) throw new HpiCliUsageError();
    let source: PluginSource;
    let localPackages: ReadonlyMap<string, string> = new Map();
    let importedPiPackages: ReadonlyMap<string, string> = new Map();
    if (sourceKind === "local") {
      const label = optionValue(arguments_, "--label");
      if (label === undefined) throw new HpiCliUsageError();
      source = await createLocalPiPluginSource({ label, packageRoot: sourceValue });
      localPackages = new Map([[label, sourceValue]]);
    } else if (sourceKind === "npm") {
      const separator = sourceValue.lastIndexOf("@");
      const registryIntegrity = optionValue(arguments_, "--integrity");
      if (separator <= 0 || registryIntegrity === undefined) throw new HpiCliUsageError();
      source = pluginSourceSchema.parse({
        kind: "NPM",
        registry: optionValue(arguments_, "--registry") ?? "https://registry.npmjs.org",
        packageName: sourceValue.slice(0, separator),
        version: sourceValue.slice(separator + 1),
        integrity: fingerprintNpmRegistryIntegrity(registryIntegrity),
      });
    } else if (sourceKind === "git") {
      const commit = optionValue(arguments_, "--commit");
      const treeFingerprint = optionValue(arguments_, "--tree-fingerprint");
      if (commit === undefined || treeFingerprint === undefined) throw new HpiCliUsageError();
      source = pluginSourceSchema.parse({
        kind: "GIT",
        remote: sourceValue,
        commit,
        treeFingerprint,
      });
    } else if (sourceKind === "pi") {
      const packageSpec = optionValue(arguments_, "--package");
      const integrity = optionValue(arguments_, "--integrity");
      const separator = packageSpec?.lastIndexOf("@") ?? -1;
      if (packageSpec === undefined || integrity === undefined || separator <= 0) {
        throw new HpiCliUsageError();
      }
      const packageName = packageSpec.slice(0, separator);
      const version = packageSpec.slice(separator + 1);
      source = pluginSourceSchema.parse({ kind: "PI", packageName, version, integrity });
      importedPiPackages = new Map([[`${packageName}@${version}`, sourceValue]]);
    } else {
      throw new HpiCliUsageError();
    }

    const resolver = new PiPackageManifestResolver({
      stateRoot: paths.pluginPackageDirectory,
      localPackages,
      importedPiPackages,
    });
    const inspection = await resolver.inspect(source);
    const observedAt = dependencies.now();
    const bindingStore = new FilePiPackageBindingStore({
      stateRoot: paths.pluginBindingDirectory,
      managedPackageRoot: paths.pluginPackageDirectory,
    });
    const bindingOutcome = await bindingStore.put(inspection.runtimeBinding, observedAt);
    let registryCommitted = false;
    try {
      const qualification = await qualifyPiPackageInspection({
        inspection,
        stateRoot: join(paths.pluginRegistryDirectory, "qualification"),
        observedAt,
      });
      const version = await (dependencies.getVersionInfo ?? getHpiVersionInfo)();
      const compatibilityContext = createPluginCompatibilityContext(dependencies, paths, version);
      const manager = new FilePluginManager({
        stateRoot: paths.pluginRegistryDirectory,
        resolve: (candidate) => resolver.resolve(candidate),
        ...pluginManagerCompatibilityOptions(compatibilityContext),
        verifyCompatibility: (candidate) =>
          JSON.stringify(candidate) === JSON.stringify(inspection.manifest)
            ? {
                outcome: qualification.compatibility,
                verifierFingerprint: qualification.verifierFingerprint,
                evidenceIds: [qualification.evidenceId],
              }
            : {
                outcome: "UNVERIFIED",
                verifierFingerprint: qualification.verifierFingerprint,
                evidenceIds: [],
              },
      });
      const operationId = `op_plugin-${action}-${randomUUID()}`;
      const request = {
        operationId,
        operationFingerprint: sha256(
          JSON.stringify({ action, source, qualification: qualification.receiptFingerprint }),
        ),
        source,
        trust: "USER_APPROVED" as const,
        provenanceAcknowledged: true,
        requestedIsolation: "PROCESS_AUTHORITY" as const,
        compatibility: qualification.compatibility,
        evidenceIds: [qualification.evidenceId],
        observedAt,
      };
      const receipt =
        action === "import-pi"
          ? await manager.importFromPi({ schemaVersion: "hpi-plugin-import-pi.v1", ...request })
          : await manager.install({ schemaVersion: "hpi-plugin-install.v1", ...request });
      registryCommitted = true;
      line(
        dependencies.io,
        JSON.stringify({
          status: qualification.compatibility === "VERIFIED" ? "ENABLED" : "QUARANTINED",
          manifest: inspection.manifest,
          qualification,
          receipt,
        }),
      );
      return 0;
    } catch (error) {
      if (!registryCommitted && bindingOutcome === "CREATED") {
        try {
          await bindingStore.removeManagedSnapshots(inspection.manifest.pluginId);
        } catch (cleanupError) {
          throw hpiPluginOperationError(
            "BINDING_TAMPERED",
            new AggregateError([error, cleanupError]),
          );
        }
      }
      throw error;
    }
  }
  errorLine(
    dependencies.io,
    "Unknown plugin command. Use `hpi plugin list|doctor|install|import-pi|disable|remove`. ",
  );
  return 2;
}

function normalizePluginCommandError(error: unknown): HpiPluginOperationError {
  if (error instanceof HpiPluginOperationError) return error;
  if (error instanceof PluginJournalCorruptError) {
    return hpiPluginOperationError("JOURNAL_INCOMPATIBLE", error);
  }
  const message = error instanceof Error ? error.message : "";
  if (/journal|immutable chain|sequence|entry fingerprint/iu.test(message)) {
    return hpiPluginOperationError("JOURNAL_INCOMPATIBLE", error);
  }
  if (/integrity|\bSRI\b/iu.test(message)) {
    return hpiPluginOperationError("SRI_MISMATCH", error);
  }
  if (/limit|ENOSPC|no space|quota/iu.test(message)) {
    return hpiPluginOperationError("RESOURCE_LIMIT", error);
  }
  if (/binding|snapshot|fingerprint changed|symbolic link|path alias|single-link/iu.test(message)) {
    return hpiPluginOperationError("BINDING_TAMPERED", error);
  }
  if (/source|manifest|invalid|expected/iu.test(message)) {
    return hpiPluginOperationError("SOURCE_INVALID", error);
  }
  return hpiPluginOperationError("INSTALL_FAILED", error);
}

async function quickSessionCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
  paths: HpiPaths,
): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration === null) {
    return firstRunCommand(dependencies, paths);
  }
  const requestedSafeMode = arguments_.includes("--safe-mode");
  const version = await assertCoreExtensionIntegrity(dependencies);
  await prepareRuntimeDirectories(paths);
  const compatibilityContext = createPluginCompatibilityContext(dependencies, paths, version);
  const pluginManager = new FilePluginManager({
    stateRoot: paths.pluginRegistryDirectory,
    resolve: () => Promise.reject(new Error("read-only Plugin registry cannot resolve sources")),
  });
  const pluginStartup = await pluginManager.startup();
  const legacyPluginRequiresSafeMode = configuration.plugins.some((plugin) => plugin.enabled);
  let safeMode =
    requestedSafeMode || pluginStartup.mode === "SAFE_MODE" || legacyPluginRequiresSafeMode;
  let activationRevalidationFailed = false;
  let pluginRecords = safeMode ? [] : await pluginManager.list();
  let pluginActivation: Awaited<ReturnType<typeof prepareQualifiedPiPluginActivation>> | undefined;
  if (!safeMode) {
    try {
      pluginActivation = await prepareQualifiedPiPluginActivation({
        records: pluginRecords,
        inventory: await pluginManager.inventory(),
        bindingStore: new FilePiPackageBindingStore({
          stateRoot: paths.pluginBindingDirectory,
          managedPackageRoot: paths.pluginPackageDirectory,
        }),
        compatibilityContext,
      });
    } catch {
      safeMode = true;
      activationRevalidationFailed = true;
      pluginRecords = [];
    }
  }
  const continueSession = arguments_.includes("--continue") || arguments_.includes("-c");
  const resumeSession = arguments_.includes("--resume") || arguments_.includes("-r");
  await assertHpiSessionTreeSafe(paths);
  const resolvedProviderDestination = await resolveLaunchDestination(
    configuration,
    dependencies,
    paths,
  );
  const auth = await dependencies.readProviderAuthStatus(paths, configuration.provider.id);
  const repository = await dependencies.inspectRepository(dependencies.cwd);
  const qualifiedPlugins = pluginRecords.flatMap((record) =>
    record.state === "ENABLED" &&
    record.assurance.compatibility === "VERIFIED" &&
    record.assurance.trust !== "QUARANTINED" &&
    record.assurance.isolation !== "NOT_PROVEN"
      ? [
          {
            pluginId: record.pluginId,
            compatibility: record.assurance.compatibility,
            trust: record.assurance.trust,
            isolation: record.assurance.isolation,
          },
        ]
      : [],
  );
  const header = createQuickSessionHeader({
    configuration,
    repository,
    safeMode,
    qualifiedPlugins,
  });
  const plan = createPiLaunchPlan({
    paths,
    configuration,
    cwd: repository.root,
    purpose: "QUICK",
    safeMode,
    providerAuthConfigured: auth.configured,
    displayHeader: header,
    continueSession,
    resumeSession,
    sessionTreeInspected: true,
    resolvedProviderDestination,
    ...(pluginActivation === undefined ? {} : { pluginActivation }),
    ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
    ...(dependencies.coreExtensionPath === undefined
      ? {}
      : { coreExtensionPath: dependencies.coreExtensionPath }),
  });
  line(dependencies.io, header);
  if (safeMode && !requestedSafeMode) {
    line(
      dependencies.io,
      `PluginStartup=SAFE_MODE Reasons=${
        activationRevalidationFailed
          ? "ACTIVATION_REVALIDATION_FAILED"
          : pluginStartup.reasons.join(",") || "LEGACY_UNQUALIFIED_PLUGIN"
      }`,
    );
  }
  line(
    dependencies.io,
    "Quick Session only: Agent return, terminal idle, or process exit is not verification.",
  );
  line(
    dependencies.io,
    "Pi built-in slash commands are direct user actions outside Hunter's global mediation boundary in this preview.",
  );
  line(
    dependencies.io,
    "Warning: Pi `/share` can upload the session through GitHub CLI without a Hunter confirmation or Receipt; do not use it in this preview.",
  );
  const exitCode = await dependencies.launch(plan);
  line(dependencies.io, JSON.stringify(createQuickSessionProcessObservation(exitCode)));
  return exitCode;
}

async function tuiSmokeCommand(dependencies: HpiCliDependencies, paths: HpiPaths): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration?.setupCompletedAt == null) {
    errorLine(dependencies.io, "TuiSmoke=BLOCKED NextAction=Run `hpi setup` first.");
    return 2;
  }
  const repository = await dependencies.inspectRepository(dependencies.cwd);
  const version = await assertCoreExtensionIntegrity(dependencies);
  if (version.coreExtensionIntegrity === null || version.productShellIntegrity === null) {
    throw new HpiLaunchBlockedError(
      "CORE_EXTENSION_INCOMPATIBLE",
      "TUI smoke acknowledgement requires the exact packaged Hunter Pi artifact.",
    );
  }
  await prepareRuntimeDirectories(paths);
  await assertHpiSessionTreeSafe(paths);
  const resolvedProviderDestination = await resolveLaunchDestination(
    configuration,
    dependencies,
    paths,
  );
  const header = createQuickSessionHeader({ configuration, repository, safeMode: true });
  const plan = createPiLaunchPlan({
    paths,
    configuration,
    cwd: repository.root,
    purpose: "QUICK",
    safeMode: true,
    blockPromptInput: true,
    providerAuthConfigured: false,
    sessionTreeInspected: true,
    displayHeader: header,
    resolvedProviderDestination,
    ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
    ...(dependencies.coreExtensionPath === undefined
      ? {}
      : { coreExtensionPath: dependencies.coreExtensionPath }),
  });
  line(dependencies.io, header);
  line(
    dependencies.io,
    "TUI smoke: do not send a model request. Run `/hunter-status`, confirm `HunterStatus=DETECTED Command=/hunter-status`, inspect the header, then exit Pi.",
  );
  const exitCode = await dependencies.launch(plan);
  if (exitCode !== 0) {
    errorLine(
      dependencies.io,
      "TuiSmoke=NOT_PROVEN Reason=PROCESS_ERROR NextAction=Rerun `hpi smoke tui` in a supported terminal.",
    );
    return 2;
  }
  const confirmed = await dependencies.io.confirm(
    "Did the Pi prompt, Hunter header, `/hunter-status`, and clean exit all work?",
  );
  if (!confirmed) {
    errorLine(
      dependencies.io,
      "TuiSmoke=NOT_PROVEN Receipt=DECLINED NextAction=Fix the observed issue and rerun `hpi smoke tui`.",
    );
    return 2;
  }
  await saveHpiConfiguration(paths, {
    ...configuration,
    interactiveTuiReadiness: {
      status: "DETECTED",
      checkedAt: dependencies.now(),
      engineVersion: "0.83.0",
      productVersion: version.productVersion,
      sourceCommit: version.sourceCommit,
      sourceState: version.sourceState,
      platform: dependencies.platform,
      terminalKind: "TTY",
      coreExtensionIntegrity: version.coreExtensionIntegrity,
      productShellIntegrity: version.productShellIntegrity,
      configurationFingerprint: createInteractiveTuiConfigurationFingerprint(configuration),
      receiptKind: "MANUAL_ACKNOWLEDGEMENT",
    },
  });
  line(
    dependencies.io,
    "TuiSmoke=DETECTED Acknowledgement=MANUAL Provider=NOT_PROVEN CoreCompatibility=UNVERIFIED",
  );
  return 0;
}

function printHelp(io: HpiCliIo): void {
  line(io, "Hunter Pi developer preview");
  line(io, "Usage: hpi [--safe-mode] [--continue|--resume]");
  line(
    io,
    "       hpi setup [--provider id --model exact-id --policy-reference URL --endpoint-category CATEGORY --destination-origin ORIGIN --permission safe|balanced|full-access]",
  );
  line(io, "       hpi login | doctor [--json] | version --json");
  line(io, "       hpi update status --json");
  line(io, "       hpi update check --candidate <file> --artifact <file> --json");
  line(io, "       hpi update apply --candidate <file> --artifact <file> --json");
  line(io, "       hpi update rollback <release-id> --json");
  line(io, "       hpi smoke tui");
  line(
    io,
    "       hpi change --repo <directory> --plan <file> [--run-archive-id <id>] --json --allow-provider-request",
  );
  line(io, "       hpi managed fixture --json [--allow-provider-request]");
  line(io, "       hpi plugin list | plugin doctor | plugin disable <id> | plugin remove <id>");
  line(
    io,
    "       hpi plugin install local <directory> --label <name> --acknowledge-provenance --allow-process-authority",
  );
  line(
    io,
    "       hpi plugin install npm <name@version> --integrity <registry-SRI> [--registry <https-url>] --acknowledge-provenance --allow-process-authority",
  );
  line(
    io,
    "       hpi plugin install git <https-url> --commit <sha> --tree-fingerprint <sha256> --acknowledge-provenance --allow-process-authority",
  );
  line(
    io,
    "       hpi plugin import-pi <directory> --package <name@version> --integrity <sha256> --acknowledge-provenance --allow-process-authority",
  );
  line(io, "       hpi pilot compile --input <file> --json");
  line(io, "       hpi pilot target --repo <directory> --target-id <id> --json");
  line(
    io,
    "       hpi pilot capture open --plan <file> --session-id <id> --archive-id <id> --json",
  );
  line(
    io,
    "       hpi pilot capture record --session-id <id> --operation-id <id> --observation <file> --json",
  );
  line(
    io,
    "       hpi pilot capture managed-task --session-id <id> --operation-id <id> --task-id <id> --archive-ids <id[,id]> --metrics <file> --json",
  );
  line(io, "       hpi pilot capture status --session-id <id> --json");
  line(io, "       hpi pilot capture finalize --session-id <id> --json");
  line(io, "       hpi pilot evaluate --plan <file> --evidence <file> --archive <file> --json");
  line(io, "       hpi pilot preflight --plan <file> --json");
}

interface PilotJsonFile {
  readonly value: unknown;
  readonly failure?: PilotPreflightFailure;
}

async function pilotTargetCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
): Promise<number> {
  const repository = optionValue(arguments_, "--repo");
  const targetId = optionValue(arguments_, "--target-id");
  if (repository === undefined || targetId === undefined) throw new HpiCliUsageError();
  const receipt = await (dependencies.inspectPilotTarget ?? inspectHpiPilotTarget)(
    repository,
    targetId,
  );
  line(dependencies.io, JSON.stringify(receipt));
  return receipt.status === "READY" ? 0 : 2;
}

async function readPilotJsonFile(
  path: string,
  dependencies: HpiCliDependencies,
): Promise<PilotJsonFile> {
  let raw: string;
  try {
    raw = await (dependencies.readTextFile ?? ((filePath: string) => readFile(filePath, "utf8")))(
      path,
    );
  } catch {
    return { value: null, failure: "FILE_UNREADABLE" };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { value: null, failure: "INVALID_JSON" };
  }
}

async function pilotPreflightCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
): Promise<number> {
  const planPath = optionValue(arguments_, "--plan");
  if (planPath === undefined) throw new HpiCliUsageError();
  const parsed = await readPilotJsonFile(planPath, dependencies);
  const receipt = new PilotPlanCompiler().preflight(parsed.value, parsed.failure);
  line(dependencies.io, JSON.stringify(receipt));
  return receipt.status === "READY" ? 0 : 2;
}

async function pilotCompileCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
): Promise<number> {
  const inputPath = optionValue(arguments_, "--input");
  if (inputPath === undefined) throw new HpiCliUsageError();
  const parsed = await readPilotJsonFile(inputPath, dependencies);
  const compiler = new PilotPlanCompiler();
  const receipt = compiler.preflight(parsed.value, parsed.failure);
  if (receipt.status !== "READY") {
    line(dependencies.io, JSON.stringify(receipt));
    return 2;
  }
  const plan = compiler.compile(parsed.value as PilotPlanInput);
  line(dependencies.io, JSON.stringify(plan));
  return 0;
}

async function pilotEvaluateCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
): Promise<number> {
  const planPath = optionValue(arguments_, "--plan");
  const evidencePath = optionValue(arguments_, "--evidence");
  const archivePath = optionValue(arguments_, "--archive");
  if (planPath === undefined || evidencePath === undefined || archivePath === undefined) {
    throw new HpiCliUsageError();
  }
  const [plan, evidence] = await Promise.all([
    readPilotJsonFile(planPath, dependencies),
    readPilotJsonFile(evidencePath, dependencies),
  ]);
  let trustedArchive: TrustedPilotArchive | undefined;
  try {
    const readPilotArchive =
      dependencies.readPilotArchive ??
      ((path: string) => Promise.resolve(FilePilotArchiveStore.readPackageFile(path)));
    trustedArchive = await readPilotArchive(archivePath);
  } catch {
    trustedArchive = undefined;
  }
  const decision = new PilotEvaluator().evaluate(evidence.value, plan.value, trustedArchive);
  line(dependencies.io, JSON.stringify(decision));
  return decision.outcome === "GO" ? 0 : 2;
}

function pilotCaptureBlocked(
  dependencies: HpiCliDependencies,
  code: string,
  nextAction: string,
): number {
  line(
    dependencies.io,
    JSON.stringify({
      schemaVersion: "hpi-pilot-capture-command.v1",
      status: "BLOCKED",
      code,
      nextAction,
    }),
  );
  return 2;
}

function pilotCaptureNextAction(error: PilotCaptureCoordinatorError): string {
  switch (error.code) {
    case "SESSION_NOT_FOUND":
      return "Open the intended capture session with its exact frozen plan.";
    case "SESSION_CONFLICT":
      return "Use the exact plan and Archive identity already bound to this session.";
    case "SESSION_CORRUPT":
      return "Stop using this session and preserve its state for integrity review.";
    case "OPERATION_CONFLICT":
    case "FACT_CONFLICT":
      return "Use a new identity only for a genuinely new observation; never rewrite prior facts.";
    case "SESSION_SEALED":
      return "Do not append observations after finalization has started.";
    case "OBSERVATION_INVALID":
      return "Provide one strict plan-bound capture observation without paths or credentials.";
    case "PROVIDER_BUDGET_EXCEEDED":
      return "Stop Provider work; the frozen pilot authorization budget is exhausted.";
    case "INCOMPLETE":
      return "Record every next action reported by capture status before finalizing.";
    case "WINDOWS_REQUIRED":
      return "Retry finalization on the frozen Windows pilot machine.";
    case "ARCHIVE_MISMATCH":
      return "Preserve both stores and stop; the committed Archive binding does not match.";
    case "STORE_FAILURE":
      return "Retry once after checking local storage health; preserve state if it repeats.";
  }
}

async function pilotCaptureCommand(
  arguments_: readonly string[],
  dependencies: HpiCliDependencies,
): Promise<number> {
  const action = arguments_[0];
  const options = arguments_.slice(1);
  const paths = resolveHpiPaths({
    env: dependencies.environment,
    homeDirectory: dependencies.homeDirectory,
  });
  const coordinator = new FilePilotCaptureCoordinator({
    stateRoot: join(paths.root, "pilot", "capture"),
    archiveStateRoot: join(paths.root, "pilot", "archive-store"),
    managedRunStateRoot: join(paths.root, "pilot", "managed-runs"),
    now: dependencies.now,
  });
  try {
    if (action === "open") {
      const planPath = optionValue(options, "--plan");
      const sessionId = optionValue(options, "--session-id");
      const archiveId = optionValue(options, "--archive-id");
      if (planPath === undefined || sessionId === undefined || archiveId === undefined) {
        throw new HpiCliUsageError();
      }
      const planFile = await readPilotJsonFile(planPath, dependencies);
      if (planFile.failure !== undefined) {
        return pilotCaptureBlocked(
          dependencies,
          `PLAN_${planFile.failure}`,
          "Provide one readable strict frozen pilot execution-plan JSON file.",
        );
      }
      const plan = pilotExecutionPlanSchema.safeParse(planFile.value);
      if (!plan.success) {
        return pilotCaptureBlocked(
          dependencies,
          "PLAN_INVALID",
          "Compile and preflight one strict frozen pilot execution plan.",
        );
      }
      const status = await coordinator.open({
        schemaVersion: "hpi-pilot-capture-open.v1",
        sessionId,
        archiveId,
        plan: plan.data,
      });
      line(dependencies.io, JSON.stringify(status));
      return 0;
    }
    const sessionId = optionValue(options, "--session-id");
    if (sessionId === undefined) throw new HpiCliUsageError();
    if (action === "status") {
      line(dependencies.io, JSON.stringify(await coordinator.status(sessionId)));
      return 0;
    }
    if (action === "record") {
      const operationId = optionValue(options, "--operation-id");
      const observationPath = optionValue(options, "--observation");
      if (operationId === undefined || observationPath === undefined) {
        throw new HpiCliUsageError();
      }
      const observationFile = await readPilotJsonFile(observationPath, dependencies);
      if (observationFile.failure !== undefined) {
        return pilotCaptureBlocked(
          dependencies,
          `OBSERVATION_${observationFile.failure}`,
          "Provide one readable strict capture-observation JSON file.",
        );
      }
      const observation = pilotCaptureObservationSchema.safeParse(observationFile.value);
      if (!observation.success) {
        return pilotCaptureBlocked(
          dependencies,
          "OBSERVATION_INVALID",
          "Provide one strict plan-bound capture observation without paths or credentials.",
        );
      }
      if (observation.data.kind === "TASK_CHAIN" || observation.data.kind === "RAW_PI_COMPARATOR") {
        return pilotCaptureBlocked(
          dependencies,
          "PRODUCT_CAPTURE_REQUIRED",
          "Record task and raw Pi facts through their product-derived capture commands.",
        );
      }
      const receipt = await coordinator.record({
        schemaVersion: "hpi-pilot-capture-record.v1",
        sessionId,
        operationId,
        observation: observation.data,
      });
      line(dependencies.io, JSON.stringify(receipt));
      return 0;
    }
    if (action === "managed-task") {
      const operationId = optionValue(options, "--operation-id");
      const taskId = optionValue(options, "--task-id");
      const archiveIdsValue = optionValue(options, "--archive-ids");
      const metricsPath = optionValue(options, "--metrics");
      if (
        operationId === undefined ||
        taskId === undefined ||
        archiveIdsValue === undefined ||
        metricsPath === undefined
      ) {
        throw new HpiCliUsageError();
      }
      const archiveIds = archiveIdsValue.split(",");
      if (archiveIds.some((archiveId) => !archiveIdSchema.safeParse(archiveId).success)) {
        throw new HpiCliUsageError();
      }
      const metrics = await readPilotJsonFile(metricsPath, dependencies);
      if (metrics.failure !== undefined) {
        return pilotCaptureBlocked(
          dependencies,
          `METRICS_${metrics.failure}`,
          "Provide one readable strict task-metrics JSON file.",
        );
      }
      const receipt = await coordinator.recordManagedTask({
        schemaVersion: "hpi-pilot-capture-managed-task.v1",
        sessionId,
        operationId,
        taskId,
        archiveIds,
        metrics: metrics.value,
      });
      line(dependencies.io, JSON.stringify(receipt));
      return 0;
    }
    if (action === "finalize") {
      const trusted = await coordinator.finalize(sessionId);
      line(
        dependencies.io,
        JSON.stringify({
          schemaVersion: "hpi-pilot-capture-command.v1",
          status: "ARCHIVED",
          archiveId: trusted.archive.archiveId,
          planFingerprint: trusted.archive.planFingerprint,
          evidenceFingerprint: trusted.archive.evidenceFingerprint,
          archiveFingerprint: trusted.archive.archiveFingerprint,
        }),
      );
      return 0;
    }
    throw new HpiCliUsageError();
  } catch (error) {
    if (error instanceof HpiCliUsageError) throw error;
    if (error instanceof PilotCaptureCoordinatorError) {
      return pilotCaptureBlocked(dependencies, error.code, pilotCaptureNextAction(error));
    }
    return pilotCaptureBlocked(
      dependencies,
      "STORE_FAILURE",
      "Retry once after checking local storage health; preserve state if it repeats.",
    );
  }
}

export async function runHpiCli(
  arguments_: readonly string[],
  providedDependencies?: HpiCliDependencies,
): Promise<number> {
  const dependencies = providedDependencies ?? defaultDependencies();
  try {
    validateCliArguments(arguments_);
    const command = arguments_[0];
    if (command === "version") {
      line(
        dependencies.io,
        JSON.stringify(await (dependencies.getVersionInfo ?? getHpiVersionInfo)()),
      );
      return 0;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      printHelp(dependencies.io);
      return 0;
    }
    if (command === "pilot" && arguments_[1] === "preflight") {
      return await pilotPreflightCommand(arguments_.slice(2), dependencies);
    }
    if (command === "pilot" && arguments_[1] === "target") {
      return await pilotTargetCommand(arguments_.slice(2), dependencies);
    }
    if (command === "pilot" && arguments_[1] === "compile") {
      return await pilotCompileCommand(arguments_.slice(2), dependencies);
    }
    if (command === "pilot" && arguments_[1] === "capture") {
      return await pilotCaptureCommand(arguments_.slice(2), dependencies);
    }
    if (command === "pilot" && arguments_[1] === "evaluate") {
      return await pilotEvaluateCommand(arguments_.slice(2), dependencies);
    }
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    if (command === "setup") {
      return await setupCommand(arguments_.slice(1), dependencies, paths);
    }
    if (command === "doctor") {
      return await doctorCommand(arguments_.slice(1), dependencies, paths);
    }
    if (command === "login") {
      return await loginCommand(dependencies, paths);
    }
    if (command === "managed" && arguments_[1] === "fixture") {
      return await managedFixtureCommand(arguments_.slice(2), dependencies, paths);
    }
    if (command === "change") {
      return await realChangeCommand(arguments_.slice(1), dependencies, paths);
    }
    if (command === "update") {
      return await updateCommand(arguments_.slice(1), dependencies, paths);
    }
    if (command === "plugin") {
      try {
        return await pluginCommand(arguments_, dependencies, paths);
      } catch (error) {
        if (error instanceof HpiCliUsageError) throw error;
        throw normalizePluginCommandError(error);
      }
    }
    if (command === "smoke" && arguments_[1] === "tui") {
      return await tuiSmokeCommand(dependencies, paths);
    }
    return await quickSessionCommand(arguments_, dependencies, paths);
  } catch (error) {
    if (error instanceof HpiCliUsageError) {
      errorLine(
        dependencies.io,
        "InvalidArguments=BLOCKED NextAction=Use only documented hpi commands and options.",
      );
      printHelp(dependencies.io);
      return 2;
    }
    if (error instanceof HpiLaunchBlockedError) {
      errorLine(
        dependencies.io,
        `LaunchStatus=BLOCKED Code=${error.code} NextAction=${error.message}`,
      );
      return 2;
    }
    if (error instanceof HpiPluginOperationError) {
      errorLine(
        dependencies.io,
        `PluginStatus=BLOCKED Code=${error.code} NextAction=${error.nextAction}`,
      );
      return 2;
    }
    if (error instanceof QualifiedPiProcessBlockedError) {
      const reason =
        error.reason === "LEASE_CONFLICT" ? "WORKSPACE_BUSY" : "PROCESS_FINALITY_NOT_PROVEN";
      errorLine(
        dependencies.io,
        `ManagedChangeStatus=BLOCKED Reason=${reason} NextAction=${error.message}`,
      );
      return 2;
    }
    if (error instanceof RealManagedChangeBlockedError) {
      const message = error.message.replace(/^[A-Z_]+:\s*/u, "");
      errorLine(
        dependencies.io,
        `ManagedChangeStatus=BLOCKED Reason=${error.reasonCode} NextAction=${message}`,
      );
      return 2;
    }
    errorLine(
      dependencies.io,
      "CommandStatus=INCOMPATIBLE NextAction=Run `hpi doctor`; repair the reported isolated configuration or prerequisite.",
    );
    return 1;
  }
}
