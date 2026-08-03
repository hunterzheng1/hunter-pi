import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  createIsolatedFixtureGitEnvironment,
  createPiProbeFixtureWithGitRunner,
  removePiProbeFixture,
} from "./fixture.js";
import {
  assertHpiRuntimePathsSafe,
  createInteractiveTuiConfigurationFingerprint,
  loadHpiConfiguration,
  providerDisclosureRequired,
  type HpiConfiguration,
  type HpiPaths,
} from "./configuration.js";
import { PI_CANDIDATE } from "./schemas.js";
import { HPI_CORE_EXTENSION_VERSION } from "./core-extension.js";
import {
  classifyPiProviderDestination,
  resolveBundledCoreExtensionPath,
  resolvePiProviderDestination,
  type PiProviderDestination,
} from "./product-launcher.js";

export const hpiDoctorStatusSchema = z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN", "INCOMPATIBLE"]);
export type HpiDoctorStatus = z.infer<typeof hpiDoctorStatusSchema>;

const hpiDoctorCheckSchema = z.strictObject({
  id: z.enum([
    "node",
    "git_fixture",
    "engine_release",
    "configuration",
    "provider_disclosure",
    "provider_auth",
    "core_extension",
    "interactive_tui",
  ]),
  status: hpiDoctorStatusSchema,
  summary: z.string().min(1),
  nextAction: z.string().min(1).nullable(),
});

export const hpiDoctorReportSchema = z.strictObject({
  schemaVersion: z.literal("hpi-doctor.v1"),
  product: z.literal("Hunter Pi"),
  observedAt: z.iso.datetime({ offset: true }),
  overallStatus: hpiDoctorStatusSchema,
  fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_GIT_ONLY"),
  checks: z.array(hpiDoctorCheckSchema).min(1),
});
export type HpiDoctorReport = z.infer<typeof hpiDoctorReportSchema>;

export interface PiProviderAuthMetadata {
  readonly configured: boolean;
  readonly source?:
    "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  readonly label?: string;
}

export interface HpiProductIdentity {
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly sourceState: "CLEAN" | "DIRTY" | "NOT_STAMPED";
  readonly coreExtensionIntegrity?: string | null;
  readonly productShellIntegrity?: string | null;
}

interface DoctorCheck {
  readonly id: z.infer<typeof hpiDoctorCheckSchema>["id"];
  readonly status: HpiDoctorStatus;
  readonly summary: string;
  readonly nextAction: string | null;
}

export interface RunHpiDoctorOptions {
  readonly paths: HpiPaths;
  readonly observedAt?: string;
  readonly nodeVersion?: string;
  readonly gitExecutable?: string;
  readonly temporaryParent?: string;
  readonly readProviderAuthStatus?: (
    paths: HpiPaths,
    providerId: string,
  ) => Promise<PiProviderAuthMetadata>;
  readonly resolveProviderDestination?: (
    paths: HpiPaths,
    providerId: string,
    modelId: string,
  ) => Promise<PiProviderDestination>;
  readonly inspectEngineRelease?: () => Promise<{
    readonly detected: boolean;
    readonly version?: string;
  }>;
  readonly coreExtensionPath?: string;
  readonly inspectCoreExtension?: () => Promise<{
    readonly detected: boolean;
    readonly version?: string;
    readonly integrity?: string;
  }>;
  readonly productIdentity?: HpiProductIdentity;
  readonly platform?: string;
}

function overallStatus(checks: readonly DoctorCheck[]): HpiDoctorStatus {
  const priority: Readonly<Record<HpiDoctorStatus, number>> = {
    DETECTED: 0,
    NOT_PROVEN: 1,
    BLOCKED: 2,
    INCOMPATIBLE: 3,
  };
  return checks.reduce<HpiDoctorStatus>(
    (current, check) => (priority[check.status] > priority[current] ? check.status : current),
    "DETECTED",
  );
}

function nodeCheck(version: string): DoctorCheck {
  const major = /^v?(\d+)\./u.exec(version)?.[1];
  if (major === "24") {
    return {
      id: "node",
      status: "DETECTED",
      summary: "Supported Node.js 24 runtime is active.",
      nextAction: null,
    };
  }
  return {
    id: "node",
    status: "INCOMPATIBLE",
    summary: "Hunter Pi requires Node.js 24.",
    nextAction: "Install Node.js 24 and rerun `hpi doctor`.",
  };
}

function runGit(gitExecutable: string, repository: string, arguments_: readonly string[]): void {
  const result = spawnSync(gitExecutable, ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: createIsolatedFixtureGitEnvironment(dirname(repository)),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("temporary Git fixture command failed");
  }
}

async function gitFixtureCheck(
  temporaryParent: string,
  gitExecutable: string,
): Promise<DoctorCheck> {
  let fixture: Awaited<ReturnType<typeof createPiProbeFixtureWithGitRunner>> | undefined;
  try {
    fixture = await createPiProbeFixtureWithGitRunner(temporaryParent, (repository, arguments_) => {
      runGit(gitExecutable, repository, arguments_);
    });
    runGit(gitExecutable, fixture.repository, ["status", "--porcelain=v1"]);
    return {
      id: "git_fixture",
      status: "DETECTED",
      summary: "Git initialized and inspected an automatically created temporary fixture.",
      nextAction: null,
    };
  } catch {
    return {
      id: "git_fixture",
      status: "BLOCKED",
      summary: "Git could not initialize the temporary Doctor fixture.",
      nextAction: "Install Git, place it on PATH, and rerun `hpi doctor`.",
    };
  } finally {
    if (fixture !== undefined) {
      await removePiProbeFixture(fixture.root);
    }
  }
}

async function configurationChecks(
  paths: HpiPaths,
  resolveProviderDestinationForDoctor: (
    paths: HpiPaths,
    providerId: string,
    modelId: string,
  ) => Promise<PiProviderDestination>,
): Promise<{
  readonly configuration: HpiConfiguration | null;
  readonly checks: readonly DoctorCheck[];
}> {
  let configuration: HpiConfiguration | null;
  try {
    configuration = await loadHpiConfiguration(paths);
  } catch {
    return {
      configuration: null,
      checks: [
        {
          id: "configuration",
          status: "INCOMPATIBLE",
          summary: "Hunter Pi configuration is invalid or unreadable.",
          nextAction: "Repair the isolated configuration or move it aside, then run `hpi setup`.",
        },
        {
          id: "provider_disclosure",
          status: "BLOCKED",
          summary: "Provider disclosure cannot be validated while configuration is invalid.",
          nextAction: "Repair the isolated configuration before starting a Provider session.",
        },
      ],
    };
  }

  if (configuration === null) {
    return {
      configuration,
      checks: [
        {
          id: "configuration",
          status: "BLOCKED",
          summary: "Hunter Pi first-run configuration is missing.",
          nextAction: "Run `hpi setup`.",
        },
        {
          id: "provider_disclosure",
          status: "BLOCKED",
          summary: "Provider data disclosure has not been acknowledged.",
          nextAction: "Run `hpi setup` and review the Provider data disclosure.",
        },
      ],
    };
  }

  const configurationReady = configuration.setupCompletedAt !== null;
  let disclosureCheck: DoctorCheck;
  if (providerDisclosureRequired(configuration)) {
    disclosureCheck = {
      id: "provider_disclosure",
      status: "BLOCKED",
      summary: "Provider data disclosure has not been acknowledged for the current selection.",
      nextAction: "Run `hpi setup` and review the Provider data disclosure.",
    };
  } else if (configuration.provider.selectedModel === null) {
    disclosureCheck = {
      id: "provider_disclosure",
      status: "BLOCKED",
      summary: "Provider disclosure cannot be validated without an exact selected model.",
      nextAction: "Run `hpi setup` and select an exact Provider model.",
    };
  } else {
    try {
      const destination = await resolveProviderDestinationForDoctor(
        paths,
        configuration.provider.id,
        configuration.provider.selectedModel,
      );
      const disposition = classifyPiProviderDestination(configuration, destination);
      disclosureCheck =
        disposition === "MATCH"
          ? {
              id: "provider_disclosure",
              status: "DETECTED",
              summary:
                "Current Provider data disclosure matches the currently resolved destination.",
              nextAction: null,
            }
          : disposition === "DISCLOSURE_REQUIRED"
            ? {
                id: "provider_disclosure",
                status: "BLOCKED",
                summary: "The currently resolved Provider origin changed after acknowledgement.",
                nextAction:
                  "Run `hpi setup` and review the current Provider data disclosure again.",
              }
            : {
                id: "provider_disclosure",
                status: "BLOCKED",
                summary:
                  "The currently resolved Provider destination violates its endpoint policy.",
                nextAction:
                  "Repair the isolated Provider model configuration and rerun `hpi setup`.",
              };
    } catch {
      disclosureCheck = {
        id: "provider_disclosure",
        status: "NOT_PROVEN",
        summary:
          "The current Provider destination could not be resolved for disclosure validation.",
        nextAction: "Repair the selected Provider/model configuration and rerun `hpi doctor`.",
      };
    }
  }

  return {
    configuration,
    checks: [
      configurationReady
        ? {
            id: "configuration",
            status: "DETECTED",
            summary: "Strict isolated Hunter Pi configuration is available.",
            nextAction: null,
          }
        : {
            id: "configuration",
            status: "BLOCKED",
            summary: "Hunter Pi first-run setup is incomplete.",
            nextAction: "Run `hpi setup`.",
          },
      disclosureCheck,
    ],
  };
}

export async function inspectPiEngineRelease(): Promise<{
  readonly detected: boolean;
  readonly version?: string;
}> {
  try {
    const packageEntry = fileURLToPath(import.meta.resolve(PI_CANDIDATE.packageName));
    const packageRecord = z
      .looseObject({ name: z.string(), version: z.string() })
      .parse(JSON.parse(await readFile(join(dirname(packageEntry), "..", "package.json"), "utf8")));
    return packageRecord.name === PI_CANDIDATE.packageName
      ? { detected: true, version: packageRecord.version }
      : { detected: false };
  } catch {
    return { detected: false };
  }
}

async function engineReleaseCheck(
  inspector: () => Promise<{ readonly detected: boolean; readonly version?: string }>,
): Promise<DoctorCheck> {
  const installed = await inspector();
  if (!installed.detected) {
    return {
      id: "engine_release",
      status: "BLOCKED",
      summary: "The qualified Pi Engine Release is not installed with Hunter Pi.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    };
  }
  if (installed.version !== PI_CANDIDATE.version) {
    return {
      id: "engine_release",
      status: "INCOMPATIBLE",
      summary: "The installed Pi Engine Release does not match the qualified version.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    };
  }
  return {
    id: "engine_release",
    status: "DETECTED",
    summary: `Qualified Pi Engine Release ${PI_CANDIDATE.version} is installed.`,
    nextAction: null,
  };
}

export async function readPiProviderAuthMetadata(
  paths: HpiPaths,
  providerId: string,
): Promise<PiProviderAuthMetadata> {
  await assertHpiRuntimePathsSafe(paths);
  interface PiAuthRuntime {
    getProviderAuthStatus(provider: string): PiProviderAuthMetadata;
  }
  interface PiSdkRuntime {
    readonly ModelRuntime: {
      create(options: {
        authPath: string;
        modelsPath: string;
        allowModelNetwork: false;
      }): Promise<PiAuthRuntime>;
    };
  }
  const piSdkSpecifier = ["@earendil-works", "pi-coding-agent"].join("/");
  const { ModelRuntime } = (await import(piSdkSpecifier)) as unknown as PiSdkRuntime;
  const runtime = await ModelRuntime.create({
    authPath: join(paths.piAgentDirectory, "auth.json"),
    modelsPath: join(paths.piAgentDirectory, "models.json"),
    allowModelNetwork: false,
  });
  const status = runtime.getProviderAuthStatus(providerId);
  return status.source === undefined
    ? { configured: status.configured }
    : { configured: status.configured, source: status.source };
}

function providerAuthCheck(metadata: PiProviderAuthMetadata): DoctorCheck {
  if (!metadata.configured) {
    return {
      id: "provider_auth",
      status: "BLOCKED",
      summary: "Selected Provider authentication is not configured.",
      nextAction: "Run `hpi login` and complete the Provider-owned login flow.",
    };
  }
  const source = metadata.source ?? "provider metadata";
  return {
    id: "provider_auth",
    status: "DETECTED",
    summary: `Selected Provider authentication metadata is configured (${source}).`,
    nextAction: null,
  };
}

export async function inspectBundledCoreExtension(
  entrypoint = resolveBundledCoreExtensionPath(),
): Promise<{ readonly detected: boolean; readonly version?: string; readonly integrity?: string }> {
  try {
    const status = await lstat(entrypoint);
    return status.isFile() && !status.isSymbolicLink()
      ? {
          detected: true,
          version: HPI_CORE_EXTENSION_VERSION,
          integrity: `sha256:${createHash("sha256")
            .update(await readFile(entrypoint))
            .digest("hex")}`,
        }
      : { detected: false };
  } catch {
    return { detected: false };
  }
}

async function coreExtensionCheck(
  inspector: () => Promise<{
    readonly detected: boolean;
    readonly version?: string;
    readonly integrity?: string;
  }>,
  expectedIntegrity: string | null | undefined,
): Promise<DoctorCheck> {
  const inspection = await inspector();
  if (!inspection.detected) {
    return {
      id: "core_extension",
      status: "BLOCKED",
      summary: "The bundled Core Extension entrypoint is missing or invalid.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    };
  }
  if (inspection.version !== HPI_CORE_EXTENSION_VERSION) {
    return {
      id: "core_extension",
      status: "INCOMPATIBLE",
      summary: "The bundled Core Extension version does not match the product shell.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    };
  }
  if (expectedIntegrity == null || inspection.integrity === undefined) {
    return {
      id: "core_extension",
      status: "NOT_PROVEN",
      summary: "The Core Extension entrypoint is present, but packaged integrity is not stamped.",
      nextAction: "Use the exact packaged Hunter Pi artifact for a bundled integrity claim.",
    };
  }
  if (inspection.integrity !== expectedIntegrity) {
    return {
      id: "core_extension",
      status: "INCOMPATIBLE",
      summary: "The bundled Core Extension integrity does not match the package identity.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    };
  }
  return {
    id: "core_extension",
    status: "DETECTED",
    summary: `Bundled Core Extension ${HPI_CORE_EXTENSION_VERSION} entrypoint is present.`,
    nextAction: null,
  };
}

function interactiveTuiCheck(
  configuration: HpiConfiguration | null,
  productIdentity: HpiProductIdentity | undefined,
  platform: string,
): DoctorCheck {
  const readiness = configuration?.interactiveTuiReadiness;
  if (
    configuration !== null &&
    productIdentity !== undefined &&
    readiness?.status === "DETECTED" &&
    readiness.receiptKind === "MANUAL_ACKNOWLEDGEMENT" &&
    readiness.checkedAt !== null &&
    readiness.engineVersion === PI_CANDIDATE.version &&
    readiness.productVersion === productIdentity.productVersion &&
    readiness.sourceCommit === productIdentity.sourceCommit &&
    readiness.sourceState === productIdentity.sourceState &&
    readiness.platform === platform &&
    readiness.terminalKind === "TTY" &&
    readiness.coreExtensionIntegrity !== null &&
    readiness.coreExtensionIntegrity === productIdentity.coreExtensionIntegrity &&
    readiness.productShellIntegrity !== null &&
    readiness.productShellIntegrity === productIdentity.productShellIntegrity &&
    readiness.configurationFingerprint ===
      createInteractiveTuiConfigurationFingerprint(configuration)
  ) {
    return {
      id: "interactive_tui",
      status: "DETECTED",
      summary: "Interactive Pi TUI has an exact explicit manual smoke acknowledgement.",
      nextAction: null,
    };
  }
  return {
    id: "interactive_tui",
    status: "NOT_PROVEN",
    summary: "Interactive Pi TUI usability requires a separate real-terminal smoke.",
    nextAction: "Run `hpi smoke tui` in a real Windows terminal without sending a model request.",
  };
}

export async function runHpiDoctor(options: RunHpiDoctorOptions): Promise<HpiDoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck(options.nodeVersion ?? process.version)];
  checks.push(
    await gitFixtureCheck(options.temporaryParent ?? tmpdir(), options.gitExecutable ?? "git"),
  );
  checks.push(await engineReleaseCheck(options.inspectEngineRelease ?? inspectPiEngineRelease));

  const configurationResult = await configurationChecks(
    options.paths,
    options.resolveProviderDestination ?? resolvePiProviderDestination,
  );
  checks.push(...configurationResult.checks);
  if (configurationResult.configuration === null) {
    checks.push({
      id: "provider_auth",
      status: "BLOCKED",
      summary: "Provider authentication cannot be checked before valid setup.",
      nextAction: "Run `hpi setup` first.",
    });
  } else {
    try {
      await assertHpiRuntimePathsSafe(options.paths);
      const readStatus = options.readProviderAuthStatus ?? readPiProviderAuthMetadata;
      checks.push(
        providerAuthCheck(
          await readStatus(options.paths, configurationResult.configuration.provider.id),
        ),
      );
    } catch {
      checks.push({
        id: "provider_auth",
        status: "BLOCKED",
        summary: "Provider authentication metadata could not be inspected.",
        nextAction: "Check isolated configuration permissions and rerun `hpi doctor`.",
      });
    }
  }

  const inspectCore =
    options.inspectCoreExtension ??
    (() =>
      inspectBundledCoreExtension(options.coreExtensionPath ?? resolveBundledCoreExtensionPath()));
  checks.push(
    await coreExtensionCheck(inspectCore, options.productIdentity?.coreExtensionIntegrity),
    interactiveTuiCheck(
      configurationResult.configuration,
      options.productIdentity,
      options.platform ?? process.platform,
    ),
  );

  return hpiDoctorReportSchema.parse({
    schemaVersion: "hpi-doctor.v1",
    product: "Hunter Pi",
    observedAt: options.observedAt ?? new Date().toISOString(),
    overallStatus: overallStatus(checks),
    fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
    checks,
  });
}
