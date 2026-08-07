import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  Task6PiEngineHost,
  HPI_CORE_EXTENSION_VERSION,
  HpiLaunchBlockedError,
  PiJsonEngineHost,
  QualifiedPiProcessBlockedError,
  acknowledgeProviderDisclosure,
  assertHpiSessionTreeSafe,
  createDefaultHpiConfiguration,
  createInteractiveTuiConfigurationFingerprint,
  createPiLaunchPlan,
  createQualifiedPiJsonProcess,
  createQuickSessionHeader,
  createQuickSessionProcessObservation,
  disableHpiPlugin,
  hpiConfigurationSchema,
  inspectHpiPlugins,
  inspectBundledCoreExtension,
  launchPi,
  loadHpiConfiguration,
  prepareHpiRuntimeDirectories,
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
  type PiProviderDestination,
  type PiProviderAuthMetadata,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { createFileLeaseManager } from "@hunter-pi/execution";
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
  PilotEvaluator,
  PilotPlanCompiler,
  pilotTargetIdSchema,
  type PilotPlanInput,
  type PilotRepositoryTargetReceipt,
  type PilotPreflightFailure,
} from "@hunter-pi/pilot";

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
  return {
    cwd: process.cwd(),
    environment: process.env,
    homeDirectory: homedir(),
    io: createProcessIo(),
    now: () => new Date().toISOString(),
    inspectRepository: inspectHpiRepository,
    inspectPilotTarget: inspectHpiPilotTarget,
    readProviderAuthStatus: readPiProviderAuthMetadata,
    resolveProviderDestination: resolvePiProviderDestination,
    launch: launchPi,
    temporaryParent: tmpdir(),
    platform: process.platform,
    readTextFile: (path) => readFile(path, "utf8"),
  };
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
      !new Set(["--repo", "--plan"]).has(option) ||
      seen.has(option) ||
      value.startsWith("-")
    ) {
      throw new HpiCliUsageError();
    }
    seen.add(option);
    index += 2;
  }
  if (!jsonSeen || seen.size !== 2) throw new HpiCliUsageError();
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
  if (command === "pilot" && arguments_[1] === "target") {
    assertPilotTargetOptions(arguments_.slice(2));
    return;
  }
  if (command === "pilot" && arguments_[1] === "evaluate") {
    assertPilotJsonOptions(arguments_.slice(2), new Set(["--plan", "--evidence"]));
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
    (command === "plugin" && arguments_.length === 2 && arguments_[1] === "doctor") ||
    (command === "plugin" && arguments_.length === 3 && arguments_[1] === "disable")
  ) {
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
    "Step 6/7 Plugins — Core-only; user plugin activation is blocked in this developer preview.",
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
): Promise<number> {
  const configuration = await loadHpiConfiguration(paths);
  if (configuration === null) {
    errorLine(dependencies.io, "PluginStatus=BLOCKED NextAction=Run `hpi setup` first.");
    return 2;
  }
  const action = arguments_[1];
  if (action === "doctor") {
    const inspections = await inspectHpiPlugins(configuration);
    line(dependencies.io, JSON.stringify({ plugins: inspections }));
    return inspections.some((plugin) => plugin.entrypointStatus === "BLOCKED") ? 2 : 0;
  }
  if (action === "disable") {
    const pluginId = arguments_[2];
    if (pluginId === undefined) {
      errorLine(dependencies.io, "PluginStatus=BLOCKED NextAction=Specify a plugin id.");
      return 2;
    }
    await saveHpiConfiguration(paths, disableHpiPlugin(configuration, pluginId));
    line(dependencies.io, `PluginStatus=DISABLED Plugin=${pluginId} FilesDeleted=NO`);
    return 0;
  }
  errorLine(
    dependencies.io,
    "Unknown plugin command. Use `hpi plugin doctor` or `hpi plugin disable <id>`. ",
  );
  return 2;
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
  const safeMode = arguments_.includes("--safe-mode");
  await assertCoreExtensionIntegrity(dependencies);
  await prepareRuntimeDirectories(paths);
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
  const header = createQuickSessionHeader({ configuration, repository, safeMode });
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
    ...(dependencies.piCliPath === undefined ? {} : { piCliPath: dependencies.piCliPath }),
    ...(dependencies.coreExtensionPath === undefined
      ? {}
      : { coreExtensionPath: dependencies.coreExtensionPath }),
  });
  line(dependencies.io, header);
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
  line(io, "       hpi smoke tui");
  line(io, "       hpi change --repo <directory> --plan <file> --json --allow-provider-request");
  line(io, "       hpi managed fixture --json [--allow-provider-request]");
  line(io, "       hpi plugin doctor | plugin disable <id>");
  line(io, "       hpi pilot compile --input <file> --json");
  line(io, "       hpi pilot target --repo <directory> --target-id <id> --json");
  line(io, "       hpi pilot evaluate --plan <file> --evidence <file> --json");
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
  if (planPath === undefined || evidencePath === undefined) throw new HpiCliUsageError();
  const [plan, evidence] = await Promise.all([
    readPilotJsonFile(planPath, dependencies),
    readPilotJsonFile(evidencePath, dependencies),
  ]);
  const decision = new PilotEvaluator().evaluate(evidence.value, plan.value);
  line(dependencies.io, JSON.stringify(decision));
  return decision.outcome === "GO" ? 0 : 2;
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
    if (command === "plugin") {
      return await pluginCommand(arguments_, dependencies, paths);
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
