import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHpiRuntimePathsSafe,
  hpiConfigurationSchema,
  providerDisclosureRequired,
  type HpiConfiguration,
  type HpiPaths,
} from "./configuration.js";
import { HPI_CORE_EXTENSION_ID } from "./core-extension.js";

export type HpiLaunchBlockCode =
  | "CONFIGURATION_REQUIRED"
  | "DISCLOSURE_REQUIRED"
  | "PROVIDER_AUTH_REQUIRED"
  | "PROVIDER_DESTINATION_NOT_ALLOWED"
  | "MODEL_SELECTION_REQUIRED"
  | "INVALID_LAUNCH_PATH"
  | "PLUGIN_CONFIGURATION_INVALID"
  | "CORE_EXTENSION_INCOMPATIBLE";

export class HpiLaunchBlockedError extends Error {
  readonly code: HpiLaunchBlockCode;

  constructor(code: HpiLaunchBlockCode, message: string) {
    super(message);
    this.name = "HpiLaunchBlockedError";
    this.code = code;
  }
}

export interface PiLaunchPlan {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CreatePiLaunchPlanOptions {
  readonly paths: HpiPaths;
  readonly configuration: HpiConfiguration;
  readonly cwd: string;
  readonly purpose: "QUICK" | "LOGIN";
  readonly safeMode: boolean;
  readonly providerAuthConfigured: boolean;
  readonly continueSession?: boolean;
  readonly resumeSession?: boolean;
  readonly sessionTreeInspected?: boolean;
  readonly coreExtensionPath?: string;
  readonly piCliPath?: string;
  readonly displayHeader?: string;
  readonly resolvedProviderDestination?: PiProviderDestination;
  readonly blockPromptInput?: boolean;
}

export interface PiProviderDestination {
  readonly configuredOrigin: string;
  readonly pristineOrigin: string | null;
}

export type PiProviderDestinationDisposition =
  "MATCH" | "DISCLOSURE_REQUIRED" | "DESTINATION_NOT_ALLOWED";

export function classifyPiProviderDestination(
  configurationInput: HpiConfiguration,
  resolvedDestination: PiProviderDestination | undefined,
): PiProviderDestinationDisposition {
  const configuration = hpiConfigurationSchema.parse(configurationInput);
  if (
    resolvedDestination !== undefined &&
    configuration.disclosure.acknowledgement?.resolvedDestinationOrigin !==
      resolvedDestination.configuredOrigin
  ) {
    return "DISCLOSURE_REQUIRED";
  }
  const providerManagedDestinationChanged =
    configuration.provider.endpointCategory === "PROVIDER_MANAGED" &&
    (resolvedDestination?.pristineOrigin === null ||
      resolvedDestination?.configuredOrigin !== resolvedDestination?.pristineOrigin);
  const configuredDestinationChanged =
    configuration.provider.endpointCategory !== "PROVIDER_MANAGED" &&
    resolvedDestination?.configuredOrigin !== configuration.provider.destinationOrigin;
  return resolvedDestination === undefined ||
    providerManagedDestinationChanged ||
    configuredDestinationChanged
    ? "DESTINATION_NOT_ALLOWED"
    : "MATCH";
}

export function resolveBundledPiCliPath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(packageEntry), "cli.js");
}

export function resolveBundledCoreExtensionPath(): string {
  return fileURLToPath(new URL("./core-extension.js", import.meta.url));
}

export async function resolvePiProviderDestination(
  paths: HpiPaths,
  providerId: string,
  modelId: string,
): Promise<PiProviderDestination> {
  await assertHpiRuntimePathsSafe(paths);
  interface PiDestinationRuntime {
    getModel(provider: string, model: string): { readonly baseUrl?: string } | undefined;
  }
  interface PiSdkRuntime {
    readonly ModelRuntime: {
      create(options: {
        authPath: string;
        modelsPath: string | null;
        allowModelNetwork: false;
      }): Promise<PiDestinationRuntime>;
    };
  }
  const piSdkSpecifier = ["@earendil-works", "pi-coding-agent"].join("/");
  const { ModelRuntime } = (await import(piSdkSpecifier)) as unknown as PiSdkRuntime;
  const authPath = join(paths.piAgentDirectory, "auth.json");
  const [configuredRuntime, pristineRuntime] = await Promise.all([
    ModelRuntime.create({
      authPath,
      modelsPath: join(paths.piAgentDirectory, "models.json"),
      allowModelNetwork: false,
    }),
    ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false }),
  ]);
  const toOrigin = (runtime: PiDestinationRuntime, required: boolean): string | null => {
    const baseUrl = runtime.getModel(providerId, modelId)?.baseUrl;
    if (baseUrl === undefined) {
      if (!required) return null;
      throw new HpiLaunchBlockedError(
        "PROVIDER_DESTINATION_NOT_ALLOWED",
        "The selected model does not expose a resolvable Provider destination.",
      );
    }
    try {
      return new URL(baseUrl).origin;
    } catch {
      throw new HpiLaunchBlockedError(
        "PROVIDER_DESTINATION_NOT_ALLOWED",
        "The selected model Provider destination is invalid.",
      );
    }
  };
  return {
    configuredOrigin: toOrigin(configuredRuntime, true) ?? "",
    pristineOrigin: toOrigin(pristineRuntime, false),
  };
}

function requireAbsolutePath(path: string, kind: string): void {
  if (!isAbsolute(path)) {
    throw new HpiLaunchBlockedError("INVALID_LAUNCH_PATH", `${kind} must be an absolute path.`);
  }
}

export function createPiLaunchPlan(options: CreatePiLaunchPlanOptions): PiLaunchPlan {
  const configuration = hpiConfigurationSchema.parse(options.configuration);
  if (configuration.setupCompletedAt === null) {
    throw new HpiLaunchBlockedError(
      "CONFIGURATION_REQUIRED",
      "Run `hpi setup` before starting Pi.",
    );
  }
  if (providerDisclosureRequired(configuration)) {
    throw new HpiLaunchBlockedError(
      "DISCLOSURE_REQUIRED",
      "Run `hpi setup` and acknowledge the current Provider data disclosure.",
    );
  }
  const resolvedDestination = options.resolvedProviderDestination;
  const destinationDisposition = classifyPiProviderDestination(configuration, resolvedDestination);
  if (destinationDisposition === "DISCLOSURE_REQUIRED") {
    throw new HpiLaunchBlockedError(
      "DISCLOSURE_REQUIRED",
      "The resolved Provider origin changed after acknowledgement; rerun `hpi setup`.",
    );
  }
  if (destinationDisposition === "DESTINATION_NOT_ALLOWED" || resolvedDestination === undefined) {
    throw new HpiLaunchBlockedError(
      "PROVIDER_DESTINATION_NOT_ALLOWED",
      configuration.provider.endpointCategory === "PROVIDER_MANAGED"
        ? "The configured Provider origin does not match the fixed Pi managed destination."
        : "The resolved custom/local Provider origin does not match the acknowledged destination.",
    );
  }
  if (options.purpose === "QUICK" && !options.safeMode && !options.providerAuthConfigured) {
    throw new HpiLaunchBlockedError(
      "PROVIDER_AUTH_REQUIRED",
      "Run `hpi login` before starting a normal Quick Session.",
    );
  }
  if (options.continueSession === true && options.resumeSession === true) {
    throw new HpiLaunchBlockedError(
      "INVALID_LAUNCH_PATH",
      "Choose either continue or resume, not both.",
    );
  }
  if (options.sessionTreeInspected !== true) {
    throw new HpiLaunchBlockedError(
      "INVALID_LAUNCH_PATH",
      "Every Hunter Pi TUI launch requires an isolated physical session-tree inspection before Pi starts.",
    );
  }
  if (configuration.provider.selectedModel === null) {
    throw new HpiLaunchBlockedError(
      "MODEL_SELECTION_REQUIRED",
      "Run `hpi setup --model <exact-model-id>` before starting Pi.",
    );
  }

  const piCliPath = options.piCliPath ?? resolveBundledPiCliPath();
  const coreExtensionPath = options.coreExtensionPath ?? resolveBundledCoreExtensionPath();
  requireAbsolutePath(piCliPath, "Pi CLI path");
  requireAbsolutePath(coreExtensionPath, "Core Extension path");
  requireAbsolutePath(options.cwd, "Workspace path");

  const arguments_: string[] = [
    piCliPath,
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--session-dir",
    options.paths.sessionDirectory,
    "--provider",
    configuration.provider.id,
  ];
  const qualifiedModel = `${configuration.provider.id}/${configuration.provider.selectedModel}`;
  arguments_.push("--model", qualifiedModel, "--models", qualifiedModel);
  if (options.safeMode) {
    arguments_.push("--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files");
  }
  arguments_.push("--extension", coreExtensionPath);

  if (!options.safeMode && configuration.plugins.some((entry) => entry.enabled)) {
    throw new HpiLaunchBlockedError(
      "PLUGIN_CONFIGURATION_INVALID",
      "User plugin activation is not qualified in this developer preview; disable plugins or use Safe Mode.",
    );
  }
  if (options.continueSession === true) {
    arguments_.push("--continue");
  }
  if (options.resumeSession === true) {
    arguments_.push("--resume");
  }

  const environment: Record<string, string> = {
    HUNTER_PI_CORE_EXTENSION_ID: HPI_CORE_EXTENSION_ID,
    HUNTER_PI_MODE: options.purpose,
    HUNTER_PI_PINNED_MODEL: configuration.provider.selectedModel,
    HUNTER_PI_PINNED_ORIGIN: resolvedDestination.configuredOrigin,
    HUNTER_PI_PINNED_PROVIDER: configuration.provider.id,
    HUNTER_PI_PERMISSION_PROFILE: options.safeMode ? "SAFE" : configuration.permissionProfile,
    HUNTER_PI_SAFE_MODE: options.safeMode ? "1" : "0",
    PI_CODING_AGENT_DIR: options.paths.piAgentDirectory,
    PI_CODING_AGENT_SESSION_DIR: options.paths.sessionDirectory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  if (options.displayHeader !== undefined) {
    environment["HUNTER_PI_HEADER"] = options.displayHeader;
  }
  if (options.blockPromptInput === true) {
    environment["HUNTER_PI_BLOCK_PROMPT_INPUT"] = "1";
  }
  return {
    executable: process.execPath,
    arguments: arguments_,
    cwd: options.cwd,
    environment,
  };
}

export interface HpiPluginInspection {
  readonly id: string;
  readonly enabled: boolean;
  readonly entrypointStatus: "DETECTED" | "BLOCKED";
  readonly compatibility: "VERIFIED" | "UNVERIFIED" | "INCOMPATIBLE";
  readonly trust: "BUNDLED" | "USER_APPROVED" | "QUARANTINED";
  readonly isolation: "CONTAINED" | "PROCESS_AUTHORITY" | "NOT_PROVEN";
}

export async function inspectHpiPlugins(
  configuration: HpiConfiguration,
): Promise<readonly HpiPluginInspection[]> {
  const parsed = hpiConfigurationSchema.parse(configuration);
  return Promise.all(
    parsed.plugins.map(async (plugin): Promise<HpiPluginInspection> => {
      let entrypointStatus: HpiPluginInspection["entrypointStatus"] = "BLOCKED";
      try {
        const status = await lstat(plugin.entrypoint);
        if (status.isFile() && !status.isSymbolicLink()) {
          entrypointStatus = "DETECTED";
        }
      } catch {
        // Inspection is intentionally metadata-only and never imports plugin code.
      }
      return {
        id: plugin.id,
        enabled: plugin.enabled,
        entrypointStatus,
        compatibility: plugin.compatibility,
        trust: plugin.trust,
        isolation: plugin.isolation,
      };
    }),
  );
}

export function disableHpiPlugin(
  configuration: HpiConfiguration,
  pluginId: string,
): HpiConfiguration {
  const parsed = hpiConfigurationSchema.parse(configuration);
  if (!parsed.plugins.some((plugin) => plugin.id === pluginId)) {
    throw new Error(`Unknown Hunter Pi plugin: ${pluginId}`);
  }
  return hpiConfigurationSchema.parse({
    ...parsed,
    plugins: parsed.plugins.map((plugin) =>
      plugin.id === pluginId ? { ...plugin, enabled: false } : plugin,
    ),
  });
}

export function createQuickSessionHeader(options: {
  readonly configuration: HpiConfiguration;
  readonly repository: { readonly name: string; readonly branch: string; readonly dirty: boolean };
  readonly safeMode: boolean;
}): string {
  const configuration = hpiConfigurationSchema.parse(options.configuration);
  const sanitizeDisplayValue = (value: string): string =>
    Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 ||
        (codePoint >= 127 && codePoint <= 159) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
        ? "�"
        : character;
    }).join("");
  const model = sanitizeDisplayValue(configuration.provider.selectedModel ?? "PI_DEFAULT");
  const permission = options.safeMode ? "SAFE" : configuration.permissionProfile;
  const pluginLines = options.safeMode
    ? ["UserPlugins=IGNORED_SAFE_MODE"]
    : configuration.plugins
        .filter((plugin) => plugin.enabled)
        .map(
          (plugin) =>
            `${sanitizeDisplayValue(plugin.id)} Compatibility=${plugin.compatibility} Trust=${plugin.trust} Isolation=${plugin.isolation}`,
        );
  return [
    `Hunter Pi | Mode=QUICK | Repository=${sanitizeDisplayValue(options.repository.name)}@${sanitizeDisplayValue(options.repository.branch)} ${options.repository.dirty ? "DIRTY" : "CLEAN"}`,
    `Provider=${sanitizeDisplayValue(configuration.provider.id)} Model=${model} Permission=${permission}`,
    "Core Compatibility=UNVERIFIED Trust=BUNDLED Isolation=PROCESS_AUTHORITY",
    "CredentialGuard=NAMED_PATHS_ONLY ContentDetection=NOT_PROVEN",
    "PiBuiltins=USER_DIRECTED CoreMediation=NOT_GLOBAL",
    "ShareCommand=NOT_MEDIATED RemoteWriteGuarantee=NOT_PROVEN",
    ...pluginLines,
    "VerifiedChange=NOT_CLAIMED",
  ].join("\n");
}

export function createQuickSessionProcessObservation(exitCode: number): {
  readonly observation: "PROCESS_EXIT";
  readonly exitCode: number;
  readonly sessionOutcome: "RETURNED" | "PROCESS_ERROR";
  readonly verifiedChange: "NOT_CLAIMED";
} {
  return {
    observation: "PROCESS_EXIT",
    exitCode,
    sessionOutcome: exitCode === 0 ? "RETURNED" : "PROCESS_ERROR",
    verifiedChange: "NOT_CLAIMED",
  };
}

export async function launchPi(plan: PiLaunchPlan): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.executable, [...plan.arguments], {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.environment },
      shell: false,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export function repositoryDisplayName(repositoryRoot: string): string {
  return basename(repositoryRoot);
}
