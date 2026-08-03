import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const HPI_DISCLOSURE_VERSION = "2026-08-03.2" as const;

export const providerDisclosureCategories = [
  "PROMPTS",
  "CONVERSATION_CONTEXT",
  "REPOSITORY_CONTENT",
  "TOOL_RESULTS",
  "REQUEST_METADATA",
] as const;

const disclosureCategoriesSchema = z.tuple([
  z.literal("PROMPTS"),
  z.literal("CONVERSATION_CONTEXT"),
  z.literal("REPOSITORY_CONTENT"),
  z.literal("TOOL_RESULTS"),
  z.literal("REQUEST_METADATA"),
]);

function containsTerminalControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

const policyReferenceSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !containsTerminalControl(value), "Terminal control characters are forbidden.")
  .pipe(z.url())
  .superRefine((value, context) => {
    const reference = new URL(value);
    if (
      reference.protocol !== "https:" ||
      reference.username.length > 0 ||
      reference.password.length > 0 ||
      reference.search.length > 0 ||
      /token|key|secret|password|credential|authorization|cookie/iu.test(reference.hash)
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider policy references require HTTPS without credentials or query data.",
      });
    }
  });

export const hpiPluginConfigurationSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9._/-]*$/u)
    .refine((id) => !id.startsWith("hunter-pi/"), "Hunter Pi plugin ids are reserved."),
  entrypoint: z.string().min(1),
  enabled: z.boolean(),
  compatibility: z.enum(["UNVERIFIED", "INCOMPATIBLE"]),
  trust: z.enum(["USER_APPROVED", "QUARANTINED"]),
  isolation: z.enum(["PROCESS_AUTHORITY", "NOT_PROVEN"]),
});

const hpiPluginsSchema = z.array(hpiPluginConfigurationSchema).superRefine((plugins, context) => {
  const ids = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    if (ids.has(plugin.id)) {
      context.addIssue({
        code: "custom",
        message: "Hunter Pi plugin ids must be unique.",
        path: [index, "id"],
      });
    }
    ids.add(plugin.id);
  }
});

const disclosureAcknowledgementSchema = z.strictObject({
  version: z.string().min(1),
  providerId: z.string().min(1),
  endpointCategory: z.enum(["PROVIDER_MANAGED", "CUSTOM", "LOCAL"]),
  destinationOrigin: z.url().nullable(),
  resolvedDestinationOrigin: z
    .url()
    .refine((value) => new URL(value).origin === value, "Resolved destination must be an origin."),
  policyReference: policyReferenceSchema,
  externalRetention: z.enum(["NOT_PROVEN", "ACCOUNT_POLICY"]),
  trainingUse: z.enum(["NOT_PROVEN", "ACCOUNT_CONTROL"]),
  accountControls: z.literal("PROVIDER_OWNED"),
  acceptedAt: z.iso.datetime({ offset: true }),
});

const terminalSafeValueSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsTerminalControl(value), "Terminal control characters are forbidden.");

const exactModelIdSchema = terminalSafeValueSchema.regex(
  /^[-./0-9:@A-Z_a-z~]+$/u,
  "Model ids must use the fixed Pi catalog's exact-id character set without pattern syntax.",
);

const providerSelectionSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    selectedModel: exactModelIdSchema.nullable(),
    endpointCategory: z.enum(["PROVIDER_MANAGED", "CUSTOM", "LOCAL"]),
    destinationOrigin: z.url().nullable(),
    policyReference: policyReferenceSchema,
  })
  .superRefine((provider, context) => {
    if (provider.endpointCategory === "PROVIDER_MANAGED") {
      if (provider.destinationOrigin !== null) {
        context.addIssue({
          code: "custom",
          message: "Provider-managed endpoints must not accept a caller-authored origin.",
          path: ["destinationOrigin"],
        });
      }
      return;
    }
    if (provider.destinationOrigin === null) {
      context.addIssue({
        code: "custom",
        message: "Custom and local endpoints require an exact destination origin.",
        path: ["destinationOrigin"],
      });
      return;
    }
    const destination = new URL(provider.destinationOrigin);
    if (
      destination.origin !== provider.destinationOrigin ||
      destination.username.length > 0 ||
      destination.password.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "The destination must be a credential-free URL origin without path or query data.",
        path: ["destinationOrigin"],
      });
    }
    if (provider.endpointCategory === "CUSTOM" && destination.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Custom remote endpoints require HTTPS.",
        path: ["destinationOrigin"],
      });
    }
    if (
      provider.endpointCategory === "LOCAL" &&
      !["http:", "https:"].includes(destination.protocol)
    ) {
      context.addIssue({
        code: "custom",
        message: "Local endpoints require HTTP or HTTPS.",
        path: ["destinationOrigin"],
      });
    }
    if (
      provider.endpointCategory === "LOCAL" &&
      !["127.0.0.1", "::1", "[::1]", "localhost"].includes(destination.hostname)
    ) {
      context.addIssue({
        code: "custom",
        message: "Local endpoints must resolve to an explicit loopback host.",
        path: ["destinationOrigin"],
      });
    }
  });

export const hpiConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  updateChannel: z.literal("developer-preview"),
  setupCompletedAt: z.iso.datetime({ offset: true }).nullable(),
  provider: providerSelectionSchema,
  providerReadiness: z.strictObject({
    providerId: z.string().min(1).max(128),
    status: z.enum(["NOT_CHECKED", "DETECTED", "BLOCKED"]),
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  interactiveTuiReadiness: z.strictObject({
    status: z.enum(["DETECTED", "NOT_PROVEN"]),
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
    engineVersion: z.string().min(1).nullable(),
    productVersion: z.string().min(1).nullable(),
    sourceCommit: z
      .union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("NOT_STAMPED")])
      .nullable(),
    sourceState: z.enum(["CLEAN", "DIRTY", "NOT_STAMPED"]).nullable(),
    platform: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9._-]+$/u)
      .nullable(),
    terminalKind: z.literal("TTY").nullable(),
    coreExtensionIntegrity: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    productShellIntegrity: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    configurationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    receiptKind: z.enum(["MANUAL_ACKNOWLEDGEMENT", "NONE"]),
  }),
  permissionProfile: z.enum(["SAFE", "BALANCED", "FULL_ACCESS"]),
  disclosure: z.strictObject({
    version: z.string().min(1),
    categories: disclosureCategoriesSchema,
    completeFilesMayEnterContext: z.literal(true),
    hunterTelemetry: z.literal("DISABLED"),
    piStartupNetwork: z.literal("OFFLINE"),
    externalRetention: z.enum(["NOT_PROVEN", "ACCOUNT_POLICY"]),
    trainingUse: z.enum(["NOT_PROVEN", "ACCOUNT_CONTROL"]),
    accountControls: z.literal("PROVIDER_OWNED"),
    acknowledgement: disclosureAcknowledgementSchema.nullable(),
  }),
  plugins: hpiPluginsSchema,
});

export type HpiConfiguration = z.infer<typeof hpiConfigurationSchema>;
export type HpiPluginConfiguration = z.infer<typeof hpiPluginConfigurationSchema>;

export interface HpiPaths {
  readonly root: string;
  readonly configurationFile: string;
  readonly piAgentDirectory: string;
  readonly sessionDirectory: string;
}

export function resolveHpiPaths(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
  } = {},
): HpiPaths {
  const environment = options.env ?? process.env;
  const userHome = resolve(options.homeDirectory ?? homedir());
  const override = environment["HUNTER_PI_HOME"];
  if (override !== undefined && !isAbsolute(override)) {
    throw new Error("HUNTER_PI_HOME must be an absolute path.");
  }

  const root = resolve(override ?? join(userHome, ".hunter-pi"));
  if (root === parse(root).root) {
    throw new Error("Hunter Pi configuration root cannot be a filesystem root.");
  }

  return {
    root,
    configurationFile: join(root, "config.json"),
    piAgentDirectory: join(root, "engine", "agent"),
    sessionDirectory: join(root, "sessions"),
  };
}

export function createDefaultHpiConfiguration(): HpiConfiguration {
  return {
    schemaVersion: 1,
    updateChannel: "developer-preview",
    setupCompletedAt: null,
    provider: {
      id: "openai-codex",
      selectedModel: "gpt-5.6-sol",
      endpointCategory: "PROVIDER_MANAGED",
      destinationOrigin: null,
      policyReference:
        "https://learn.chatgpt.com/docs/enterprise/work-admin-faq#how-does-chatgpt-work-support-enterprise-privacy-and-data-commitments",
    },
    providerReadiness: {
      providerId: "openai-codex",
      status: "NOT_CHECKED",
      checkedAt: null,
    },
    interactiveTuiReadiness: {
      status: "NOT_PROVEN",
      checkedAt: null,
      engineVersion: null,
      productVersion: null,
      sourceCommit: null,
      sourceState: null,
      platform: null,
      terminalKind: null,
      coreExtensionIntegrity: null,
      productShellIntegrity: null,
      configurationFingerprint: null,
      receiptKind: "NONE",
    },
    permissionProfile: "BALANCED",
    disclosure: {
      version: HPI_DISCLOSURE_VERSION,
      categories: [...providerDisclosureCategories],
      completeFilesMayEnterContext: true,
      hunterTelemetry: "DISABLED",
      piStartupNetwork: "OFFLINE",
      externalRetention: "NOT_PROVEN",
      trainingUse: "NOT_PROVEN",
      accountControls: "PROVIDER_OWNED",
      acknowledgement: null,
    },
    plugins: [],
  };
}

export function createInteractiveTuiConfigurationFingerprint(
  configuration: HpiConfiguration,
): string {
  const parsed = hpiConfigurationSchema.parse(configuration);
  const launchRelevantConfiguration = {
    schemaVersion: parsed.schemaVersion,
    provider: parsed.provider,
    disclosure: parsed.disclosure,
    mode: "SAFE",
  };
  return createHash("sha256")
    .update(JSON.stringify(launchRelevantConfiguration), "utf8")
    .digest("hex");
}

export function providerDisclosureRequired(configuration: HpiConfiguration): boolean {
  const acknowledgement = configuration.disclosure.acknowledgement;
  if (acknowledgement === null) {
    return true;
  }
  return (
    acknowledgement.version !== configuration.disclosure.version ||
    acknowledgement.providerId !== configuration.provider.id ||
    acknowledgement.endpointCategory !== configuration.provider.endpointCategory ||
    acknowledgement.destinationOrigin !== configuration.provider.destinationOrigin ||
    acknowledgement.policyReference !== configuration.provider.policyReference ||
    acknowledgement.externalRetention !== configuration.disclosure.externalRetention ||
    acknowledgement.trainingUse !== configuration.disclosure.trainingUse
  );
}

export function acknowledgeProviderDisclosure(
  configuration: HpiConfiguration,
  options: { readonly acceptedAt: string; readonly resolvedDestinationOrigin: string },
): HpiConfiguration {
  const parsed = hpiConfigurationSchema.parse(configuration);
  return hpiConfigurationSchema.parse({
    ...parsed,
    disclosure: {
      ...parsed.disclosure,
      acknowledgement: {
        version: parsed.disclosure.version,
        providerId: parsed.provider.id,
        endpointCategory: parsed.provider.endpointCategory,
        destinationOrigin: parsed.provider.destinationOrigin,
        resolvedDestinationOrigin: options.resolvedDestinationOrigin,
        policyReference: parsed.provider.policyReference,
        externalRetention: parsed.disclosure.externalRetention,
        trainingUse: parsed.disclosure.trainingUse,
        accountControls: parsed.disclosure.accountControls,
        acceptedAt: options.acceptedAt,
      },
    },
  });
}

function assertContainedPath(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Hunter Pi path escaped its isolated root.");
  }
}

async function assertDirectoryIsNotLink(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Hunter Pi configuration root must be a physical directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function assertPhysicalFileIfPresent(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new Error("Hunter Pi isolated files must be physical single-link files.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertPhysicalDirectoryChain(root: string, target: string): Promise<void> {
  assertContainedPath(root, target);
  const pathFromRoot = relative(root, target);
  let cursor = root;
  for (const segment of pathFromRoot.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const status = await lstat(cursor);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error("Hunter Pi runtime directories must be physical directories.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertPhysicalRuntimeTree(path: string): Promise<void> {
  for (const entry of await readdir(path)) {
    const entryPath = join(path, entry);
    const status = await lstat(entryPath);
    if (status.isSymbolicLink()) {
      throw new Error("Hunter Pi runtime tree rejects linked filesystem entries.");
    }
    if (status.isDirectory()) {
      await assertPhysicalRuntimeTree(entryPath);
      continue;
    }
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error("Hunter Pi runtime tree requires physical single-link files.");
    }
  }
}

export async function assertHpiRuntimePathsSafe(paths: HpiPaths): Promise<void> {
  assertContainedPath(paths.root, paths.configurationFile);
  assertContainedPath(paths.root, paths.piAgentDirectory);
  assertContainedPath(paths.root, paths.sessionDirectory);
  await assertDirectoryIsNotLink(paths.root);
  await Promise.all([
    assertPhysicalDirectoryChain(paths.root, paths.piAgentDirectory),
    assertPhysicalDirectoryChain(paths.root, paths.sessionDirectory),
    assertPhysicalFileIfPresent(paths.configurationFile),
    assertPhysicalFileIfPresent(join(paths.piAgentDirectory, "auth.json")),
    assertPhysicalFileIfPresent(join(paths.piAgentDirectory, "models.json")),
  ]);
  try {
    await assertPhysicalRuntimeTree(paths.piAgentDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertPhysicalSessionTree(path: string): Promise<void> {
  for (const entry of await readdir(path)) {
    const entryPath = join(path, entry);
    const status = await lstat(entryPath);
    if (status.isSymbolicLink()) {
      throw new Error("Hunter Pi session recovery rejects linked filesystem entries.");
    }
    if (status.isDirectory()) {
      await assertPhysicalSessionTree(entryPath);
      continue;
    }
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error("Hunter Pi session recovery requires physical single-link files.");
    }
  }
}

export async function assertHpiSessionTreeSafe(paths: HpiPaths): Promise<void> {
  await assertHpiRuntimePathsSafe(paths);
  try {
    await assertPhysicalSessionTree(paths.sessionDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadHpiConfiguration(paths: HpiPaths): Promise<HpiConfiguration | null> {
  await assertHpiRuntimePathsSafe(paths);
  try {
    return hpiConfigurationSchema.parse(
      JSON.parse(await readFile(paths.configurationFile, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveHpiConfiguration(
  paths: HpiPaths,
  configuration: HpiConfiguration,
): Promise<void> {
  const parsedConfiguration = hpiConfigurationSchema.parse(configuration);
  assertContainedPath(paths.root, paths.configurationFile);
  await assertHpiRuntimePathsSafe(paths);
  await mkdir(paths.root, { recursive: true });
  await assertHpiRuntimePathsSafe(paths);

  const temporaryFile = join(paths.root, `.config-${randomUUID()}.pending`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(parsedConfiguration, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, paths.configurationFile);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

async function ensurePhysicalDirectory(root: string, target: string): Promise<void> {
  assertContainedPath(root, target);
  await mkdir(root, { recursive: true });
  await assertDirectoryIsNotLink(root);
  const pathFromRoot = relative(root, target);
  let cursor = root;
  for (const segment of pathFromRoot.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const status = await lstat(cursor);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error("Hunter Pi runtime directories must be physical directories.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await mkdir(cursor);
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("Hunter Pi runtime directory creation was redirected.", { cause: error });
      }
    }
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
  assertContainedPath(canonicalRoot, canonicalTarget);
}

export async function prepareHpiRuntimeDirectories(paths: HpiPaths): Promise<void> {
  await ensurePhysicalDirectory(paths.root, paths.piAgentDirectory);
  await ensurePhysicalDirectory(paths.root, paths.sessionDirectory);
  await assertHpiRuntimePathsSafe(paths);
}
