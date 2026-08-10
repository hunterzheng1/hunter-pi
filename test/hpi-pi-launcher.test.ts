import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HPI_CORE_EXTENSION_ID,
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  createPiLaunchPlan,
  createRawPiLaunchPlan,
  createQuickSessionHeader,
  createQuickSessionProcessObservation,
  disableHpiPlugin,
  inspectHpiPlugins,
  resolveHpiPaths,
  resolveBundledPiCliPath,
  type HpiConfiguration,
} from "@hunter-pi/pi-host";
import {
  createHunterCoreExtension,
  evaluateHunterToolCall,
  evaluateHunterToolCallWithFilesystem,
} from "../packages/pi-host/src/core-extension.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const createdRoots: string[] = [];
const managedDestination = {
  configuredOrigin: "https://provider-managed.example",
  pristineOrigin: "https://provider-managed.example",
} as const;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly paths: ReturnType<typeof resolveHpiPaths>;
  readonly repository: string;
  readonly coreExtensionPath: string;
  readonly throwingPluginPath: string;
  readonly configuration: HpiConfiguration;
}> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-launch-test-");
  createdRoots.push(root);
  const repository = join(root, "daily-repository");
  const coreExtensionPath = join(root, "core-extension.js");
  const throwingPluginPath = join(root, "throwing-plugin.js");
  await mkdir(repository);
  await writeFile(coreExtensionPath, "export default () => {};\n", "utf8");
  await writeFile(throwingPluginPath, 'throw new Error("must not run in safe mode");\n', "utf8");
  const configuration = {
    ...acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
      acceptedAt: "2026-08-03T12:00:00.000Z",
      resolvedDestinationOrigin: managedDestination.configuredOrigin,
    }),
    setupCompletedAt: "2026-08-03T12:01:00.000Z",
    plugins: [
      {
        id: "fixture/throwing",
        entrypoint: throwingPluginPath,
        enabled: true,
        compatibility: "UNVERIFIED" as const,
        trust: "USER_APPROVED" as const,
        isolation: "PROCESS_AUTHORITY" as const,
      },
    ],
  };
  return {
    root,
    paths: resolveHpiPaths({ env: { HUNTER_PI_HOME: join(root, "profile") } }),
    repository,
    coreExtensionPath,
    throwingPluginPath,
    configuration,
  };
}

function extensionArguments(arguments_: readonly string[]): string[] {
  return arguments_.flatMap((argument, index) =>
    argument === "--extension" ? [arguments_[index + 1] ?? "<missing>"] : [],
  );
}

describe("Hunter Pi launch planning", () => {
  it("resolves the fixed Pi ESM entry to its installed CLI", () => {
    expect(resolveBundledPiCliPath()).toMatch(/[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/u);
  });

  it("starts Safe Mode with only the explicitly bundled Core Extension", async () => {
    const fixture = await createFixture();

    const plan = createPiLaunchPlan({
      paths: fixture.paths,
      configuration: fixture.configuration,
      cwd: fixture.repository,
      coreExtensionPath: fixture.coreExtensionPath,
      piCliPath: join(fixture.root, "pi-cli.js"),
      purpose: "QUICK",
      providerAuthConfigured: false,
      resolvedProviderDestination: managedDestination,
      sessionTreeInspected: true,
      safeMode: true,
    });

    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        fixture.coreExtensionPath,
        "--model",
        "openai-codex/gpt-5.6-sol",
      ]),
    );
    expect(plan.arguments).not.toContain("--models");
    expect(extensionArguments(plan.arguments)).toEqual([fixture.coreExtensionPath]);
    expect(plan.arguments).not.toContain(fixture.throwingPluginPath);
    expect(plan.environment).toEqual({
      HUNTER_PI_CORE_EXTENSION_ID: HPI_CORE_EXTENSION_ID,
      HUNTER_PI_MODE: "QUICK",
      HUNTER_PI_PERMISSION_PROFILE: "SAFE",
      HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
      HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
      HUNTER_PI_PINNED_PROVIDER: "openai-codex",
      HUNTER_PI_SAFE_MODE: "1",
      PI_CODING_AGENT_DIR: fixture.paths.piAgentDirectory,
      PI_CODING_AGENT_SESSION_DIR: fixture.paths.sessionDirectory,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    });
    expect(Object.keys(plan.environment).join(" ")).not.toMatch(/token|cookie|secret|api.?key/iu);
  });

  it("builds a comparator launch with the same pinned Provider but no Hunter extension", async () => {
    const fixture = await createFixture();

    const plan = createRawPiLaunchPlan({
      paths: fixture.paths,
      configuration: fixture.configuration,
      cwd: fixture.repository,
      piCliPath: join(fixture.root, "pi-cli.js"),
      providerAuthConfigured: true,
      resolvedProviderDestination: managedDestination,
      sessionTreeInspected: true,
    });

    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--provider",
        "openai-codex",
        "--model",
        "openai-codex/gpt-5.6-sol",
      ]),
    );
    expect(plan.arguments).not.toContain("--extension");
    expect(plan.arguments).not.toContain(fixture.throwingPluginPath);
    expect(plan.environment).toEqual({
      PI_CODING_AGENT_DIR: fixture.paths.piAgentDirectory,
      PI_CODING_AGENT_SESSION_DIR: fixture.paths.sessionDirectory,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    });
    expect(Object.keys(plan.environment)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^HUNTER_PI_/u)]),
    );
  });

  it("blocks unqualified user plugin activation and exposes honest header dimensions", async () => {
    const fixture = await createFixture();

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration: fixture.configuration,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: true,
        resolvedProviderDestination: managedDestination,
        sessionTreeInspected: true,
        safeMode: false,
      }),
    ).toThrow(expect.objectContaining({ code: "PLUGIN_CONFIGURATION_INVALID" }));

    const plan = createPiLaunchPlan({
      paths: fixture.paths,
      configuration: {
        ...fixture.configuration,
        plugins: fixture.configuration.plugins.map((plugin) => ({ ...plugin, enabled: false })),
      },
      cwd: fixture.repository,
      coreExtensionPath: fixture.coreExtensionPath,
      piCliPath: join(fixture.root, "pi-cli.js"),
      purpose: "QUICK",
      providerAuthConfigured: true,
      resolvedProviderDestination: managedDestination,
      sessionTreeInspected: true,
      safeMode: false,
    });
    expect(extensionArguments(plan.arguments)).toEqual([fixture.coreExtensionPath]);
    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      ]),
    );

    const header = createQuickSessionHeader({
      configuration: fixture.configuration,
      repository: { name: "daily-repository", branch: "work", dirty: true },
      safeMode: false,
    });
    expect(header).toContain("Mode=QUICK");
    expect(header).toContain("Repository=daily-repository@work DIRTY");
    expect(header).toContain("Provider=openai-codex");
    expect(header).toContain("Permission=BALANCED");
    expect(header).toContain(
      "Core Compatibility=UNVERIFIED Trust=BUNDLED Isolation=PROCESS_AUTHORITY",
    );
    expect(header).toContain("CredentialGuard=NAMED_PATHS_ONLY ContentDetection=NOT_PROVEN");
    expect(header).toContain(
      "fixture/throwing Compatibility=UNVERIFIED Trust=USER_APPROVED Isolation=PROCESS_AUTHORITY",
    );
    expect(header).toContain("VerifiedChange=NOT_CLAIMED");
    expect(header).not.toContain(fixture.root);

    const sanitizedHeader = createQuickSessionHeader({
      configuration: fixture.configuration,
      repository: { name: "repo\u001b[31m", branch: "main\nforged", dirty: false },
      safeMode: false,
    });
    expect(
      Array.from(sanitizedHeader.replaceAll("\n", "")).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && (codePoint < 127 || codePoint > 159);
      }),
    ).toBe(true);
    expect(sanitizedHeader).not.toContain("\nforged");
  });

  it("rejects quarantined, incompatible, unproven, reserved, duplicate, or self-certified plugins", async () => {
    const fixture = await createFixture();
    const basePlugin = fixture.configuration.plugins[0];
    if (basePlugin === undefined) throw new Error("fixture plugin is missing");
    const invalidPluginSets = [
      [{ ...basePlugin, trust: "QUARANTINED" as const }],
      [{ ...basePlugin, compatibility: "INCOMPATIBLE" as const }],
      [{ ...basePlugin, isolation: "NOT_PROVEN" as const }],
      [{ ...basePlugin, id: "hunter-pi/core" }],
      [basePlugin, { ...basePlugin }],
      [
        {
          ...basePlugin,
          compatibility: "VERIFIED" as const,
          trust: "BUNDLED" as const,
          isolation: "CONTAINED" as const,
        },
      ],
    ];

    for (const plugins of invalidPluginSets) {
      expect(() =>
        createPiLaunchPlan({
          paths: fixture.paths,
          configuration: { ...fixture.configuration, plugins } as unknown as HpiConfiguration,
          cwd: fixture.repository,
          coreExtensionPath: fixture.coreExtensionPath,
          piCliPath: join(fixture.root, "pi-cli.js"),
          purpose: "QUICK",
          providerAuthConfigured: true,
          resolvedProviderDestination: managedDestination,
          safeMode: false,
        }),
      ).toThrow();
    }
  });

  it("blocks normal Provider launch until both disclosure and auth metadata are ready", async () => {
    const fixture = await createFixture();
    const withoutAcknowledgement = {
      ...createDefaultHpiConfiguration(),
      setupCompletedAt: "2026-08-03T12:01:00.000Z",
    };

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration: withoutAcknowledgement,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: true,
        safeMode: false,
      }),
    ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration: fixture.configuration,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: false,
        resolvedProviderDestination: managedDestination,
        safeMode: false,
      }),
    ).toThrow(expect.objectContaining({ code: "PROVIDER_AUTH_REQUIRED" }));
  });

  it("allows only the acknowledged resolved origin for local or custom providers", async () => {
    const fixture = await createFixture();
    const configuration = acknowledgeProviderDisclosure(
      {
        ...createDefaultHpiConfiguration(),
        setupCompletedAt: "2026-08-03T12:01:00.000Z",
        provider: {
          id: "local-fixture",
          selectedModel: "fixture-model",
          endpointCategory: "LOCAL",
          destinationOrigin: "http://127.0.0.1:43123",
          policyReference: "https://example.invalid/local-policy",
        },
      },
      {
        acceptedAt: "2026-08-03T12:00:00.000Z",
        resolvedDestinationOrigin: "http://127.0.0.1:43123",
      },
    );

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: true,
        resolvedProviderDestination: {
          configuredOrigin: "http://127.0.0.1:43124",
          pristineOrigin: null,
        },
        safeMode: false,
      }),
    ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: true,
        resolvedProviderDestination: {
          configuredOrigin: "http://127.0.0.1:43123",
          pristineOrigin: null,
        },
        sessionTreeInspected: true,
        safeMode: false,
      }),
    ).not.toThrow();

    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration,
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "LOGIN",
        providerAuthConfigured: false,
        resolvedProviderDestination: {
          configuredOrigin: "http://127.0.0.1:43124",
          pristineOrigin: null,
        },
        safeMode: true,
      }),
    ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));
  });

  it("fully qualifies and scopes a selected model to the acknowledged Provider", async () => {
    const fixture = await createFixture();
    const plan = createPiLaunchPlan({
      paths: fixture.paths,
      configuration: {
        ...fixture.configuration,
        plugins: [],
        provider: {
          ...fixture.configuration.provider,
          selectedModel: "other-provider/model",
        },
      },
      cwd: fixture.repository,
      coreExtensionPath: fixture.coreExtensionPath,
      piCliPath: join(fixture.root, "pi-cli.js"),
      purpose: "QUICK",
      providerAuthConfigured: true,
      resolvedProviderDestination: managedDestination,
      sessionTreeInspected: true,
      safeMode: false,
    });
    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--provider",
        "openai-codex",
        "--model",
        "openai-codex/other-provider/model",
        "--models",
        "openai-codex/other-provider/model",
      ]),
    );
  });

  it("records process return only as an observation and never as a verified Change", () => {
    expect(createQuickSessionProcessObservation(0)).toEqual({
      observation: "PROCESS_EXIT",
      exitCode: 0,
      sessionOutcome: "RETURNED",
      verifiedChange: "NOT_CLAIMED",
    });
    expect(createQuickSessionProcessObservation(17)).toEqual({
      observation: "PROCESS_EXIT",
      exitCode: 17,
      sessionOutcome: "PROCESS_ERROR",
      verifiedChange: "NOT_CLAIMED",
    });
  });

  it("rejects a Provider-managed destination changed by isolated models configuration", async () => {
    const fixture = await createFixture();
    expect(() =>
      createPiLaunchPlan({
        paths: fixture.paths,
        configuration: { ...fixture.configuration, plugins: [] },
        cwd: fixture.repository,
        coreExtensionPath: fixture.coreExtensionPath,
        piCliPath: join(fixture.root, "pi-cli.js"),
        purpose: "QUICK",
        providerAuthConfigured: true,
        safeMode: false,
        resolvedProviderDestination: {
          configuredOrigin: "http://127.0.0.1:43123",
          pristineOrigin: "https://provider-managed.example",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));
  });

  it("doctors and disables a throwing plugin without importing or deleting it", async () => {
    const fixture = await createFixture();

    expect(await inspectHpiPlugins(fixture.configuration)).toEqual([
      {
        id: "fixture/throwing",
        enabled: true,
        entrypointStatus: "DETECTED",
        compatibility: "UNVERIFIED",
        trust: "USER_APPROVED",
        isolation: "PROCESS_AUTHORITY",
      },
    ]);
    const disabled = disableHpiPlugin(fixture.configuration, "fixture/throwing");
    expect(disabled.plugins[0]?.enabled).toBe(false);
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(fixture.throwingPluginPath, "utf8"),
      ),
    ).toContain("must not run in safe mode");
  });
});

describe("bundled Core Extension policy", () => {
  it("fails closed in Safe Mode and prompts for Balanced shell or sensitive access", () => {
    expect(
      evaluateHunterToolCall(
        { toolName: "read", input: { path: "src/index.ts" } },
        { cwd: "C:\\work\\repo", permissionProfile: "SAFE", safeMode: true },
      ),
    ).toEqual({ decision: "ALLOW" });
    expect(
      evaluateHunterToolCall(
        { toolName: "write", input: { path: "src/index.ts" } },
        { cwd: "C:\\work\\repo", permissionProfile: "SAFE", safeMode: true },
      ).decision,
    ).toBe("BLOCK");
    expect(
      evaluateHunterToolCall(
        { toolName: "bash", input: { command: "npm test" } },
        { cwd: "C:\\work\\repo", permissionProfile: "BALANCED", safeMode: false },
      ).decision,
    ).toBe("ASK");
    expect(
      evaluateHunterToolCall(
        { toolName: "read", input: { path: ".env" } },
        { cwd: "C:\\work\\repo", permissionProfile: "BALANCED", safeMode: false },
      ).decision,
    ).toBe("ASK");
    for (const sensitivePath of [
      ".npmrc",
      ".netrc",
      ".envrc",
      ".git-credentials",
      ".git/config",
      ".gitmodules",
      ".ssh/id_rsa",
      "certificates/client.p12",
      "config/secrets.json",
      "config/token.json",
      "config/service-account.json",
    ]) {
      for (const permissionProfile of ["BALANCED", "FULL_ACCESS"] as const) {
        expect(
          evaluateHunterToolCall(
            { toolName: "read", input: { path: sensitivePath } },
            { cwd: "C:\\work\\repo", permissionProfile, safeMode: false },
          ).decision,
        ).toBe("ASK");
      }
    }
    expect(
      evaluateHunterToolCall(
        { toolName: "read", input: { path: "C:\\Users\\fixture\\.npmrc" } },
        { cwd: "C:\\work\\repo", permissionProfile: "SAFE", safeMode: true },
      ).decision,
    ).toBe("BLOCK");
  });

  it("blocks repository writes that resolve through a symlink or junction", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-link-policy-test-");
    createdRoots.push(root);
    const repository = join(root, "repository");
    const outside = join(root, "outside");
    await Promise.all([mkdir(repository), mkdir(outside)]);
    await symlink(
      outside,
      join(repository, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    for (const permissionProfile of ["BALANCED", "SAFE"] as const) {
      await expect(
        evaluateHunterToolCallWithFilesystem(
          { toolName: "write", input: { path: "escape/secret.txt" } },
          { cwd: repository, permissionProfile, safeMode: false },
        ),
      ).resolves.toEqual({
        decision: "BLOCK",
        reason: "Repository file access traverses a symbolic link, junction, or hard link.",
      });
    }
  });

  it("blocks writes and Safe Mode reads through a hard-linked file", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-hardlink-policy-test-");
    createdRoots.push(root);
    const repository = join(root, "repository");
    const outside = join(root, "outside.txt");
    await mkdir(repository);
    await writeFile(outside, "outside\n", "utf8");
    await link(outside, join(repository, "shared.txt"));

    await expect(
      evaluateHunterToolCallWithFilesystem(
        { toolName: "write", input: { path: "shared.txt" } },
        { cwd: repository, permissionProfile: "BALANCED", safeMode: false },
      ),
    ).resolves.toEqual(expect.objectContaining({ decision: "BLOCK" }));
    await expect(
      evaluateHunterToolCallWithFilesystem(
        { toolName: "read", input: { path: "shared.txt" } },
        { cwd: repository, permissionProfile: "SAFE", safeMode: true },
      ),
    ).resolves.toEqual(expect.objectContaining({ decision: "BLOCK" }));
  });

  it("registers visible Core identity and status without claiming OS containment", async () => {
    const eventHandlers = new Map<string, (event: unknown, context: FakeContext) => unknown>();
    const commands = new Map<
      string,
      (arguments_: string, context: FakeContext) => Promise<void> | void
    >();
    const extension = createHunterCoreExtension({
      environment: {
        HUNTER_PI_MODE: "QUICK",
        HUNTER_PI_PERMISSION_PROFILE: "BALANCED",
        HUNTER_PI_SAFE_MODE: "0",
        HUNTER_PI_BLOCK_PROMPT_INPUT: "1",
        HUNTER_PI_PINNED_PROVIDER: "openai-codex",
        HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
        HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
        HUNTER_PI_HEADER: "Hunter Pi | Mode=QUICK\nVerifiedChange=NOT_CLAIMED",
      },
    });
    extension({
      on: (event, handler) => eventHandlers.set(event, handler),
      registerCommand: (name, options) => commands.set(name, options.handler),
    });

    const statuses = new Map<string, string | undefined>();
    const notifications: string[] = [];
    const widgets = new Map<string, string[]>();
    const context: FakeContext = {
      cwd: "C:\\work\\repo",
      hasUI: true,
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "https://provider-managed.example/v1",
      },
      shutdown: () => undefined,
      ui: {
        confirm: () => Promise.resolve(false),
        notify: (message) => notifications.push(message),
        setStatus: (key, text) => statuses.set(key, text),
        setWidget: (key, content) => widgets.set(key, content),
      },
    };
    await eventHandlers.get("session_start")?.({}, context);
    await commands.get("hunter-status")?.("", context);

    expect(statuses.get("hunter-pi/core")).toContain("QUICK/BALANCED");
    expect(notifications[0]).toMatch(
      /^HunterStatus=DETECTED Command=\/hunter-status \| Core=hunter-pi\/core@/u,
    );
    expect(notifications.join("\n")).toContain("Isolation=PROCESS_AUTHORITY");
    expect(notifications.join("\n")).toContain(
      "CredentialGuard=NAMED_PATHS_ONLY ContentDetection=NOT_PROVEN",
    );
    expect(notifications.join("\n")).toContain("VerifiedChange=NOT_CLAIMED");
    expect(widgets.get("hunter-pi/core")).toEqual([
      "Hunter Pi | Mode=QUICK",
      "VerifiedChange=NOT_CLAIMED",
    ]);
    expect(eventHandlers.get("input")?.({ text: "must not send" }, context)).toEqual({
      action: "handled",
    });
  });

  it("blocks every prompt-path input in LOGIN mode without shadowing Pi's interactive command layer", () => {
    const eventHandlers = new Map<string, (event: unknown, context: FakeContext) => unknown>();
    createHunterCoreExtension({
      environment: {
        HUNTER_PI_MODE: "LOGIN",
        HUNTER_PI_PERMISSION_PROFILE: "SAFE",
        HUNTER_PI_SAFE_MODE: "1",
        HUNTER_PI_BLOCK_PROMPT_INPUT: "1",
        HUNTER_PI_PINNED_PROVIDER: "openai-codex",
        HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
        HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
      },
    })({
      on: (event, handler) => eventHandlers.set(event, handler),
      registerCommand: () => undefined,
    });
    const context = {
      cwd: "C:\\work\\repo",
      hasUI: true,
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "https://provider-managed.example/v1",
      },
      shutdown: () => undefined,
      ui: {
        confirm: () => Promise.resolve(false),
        notify: () => undefined,
        setStatus: () => undefined,
      },
    };

    expect(eventHandlers.get("input")?.({ text: "/login" }, context)).toEqual({
      action: "handled",
    });
    expect(eventHandlers.get("input")?.({ text: "send a prompt" }, context)).toEqual({
      action: "handled",
    });
  });

  it("terminates on model drift and intercepts direct user shell commands", async () => {
    const eventHandlers = new Map<string, (event: unknown, context: FakeContext) => unknown>();
    createHunterCoreExtension({
      environment: {
        HUNTER_PI_MODE: "QUICK",
        HUNTER_PI_PERMISSION_PROFILE: "BALANCED",
        HUNTER_PI_SAFE_MODE: "1",
        HUNTER_PI_PINNED_PROVIDER: "openai-codex",
        HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
        HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
      },
    })({
      on: (event, handler) => eventHandlers.set(event, handler),
      registerCommand: () => undefined,
    });
    let shutdownCount = 0;
    const notifications: string[] = [];
    const context: FakeContext = {
      cwd: "C:\\work\\repo",
      hasUI: true,
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "https://provider-managed.example/v1",
      },
      shutdown: () => {
        shutdownCount += 1;
      },
      ui: {
        confirm: () => Promise.resolve(false),
        notify: (message) => notifications.push(message),
        setStatus: () => undefined,
      },
    };

    expect(eventHandlers.get("input")?.({ text: "safe prompt" }, context)).toBeUndefined();
    await eventHandlers.get("model_select")?.(
      { model: { provider: "other-provider", id: "other-model" } },
      context,
    );
    expect(shutdownCount).toBe(1);
    expect(notifications.join("\n")).toContain("model selection changed");

    const shellResult = await eventHandlers.get("user_bash")?.(
      { command: "node -e mutate", excludeFromContext: false, cwd: context.cwd },
      context,
    );
    expect(shellResult).toEqual({
      result: {
        output: "Hunter Pi blocked direct shell execution in Safe Mode.\n",
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    });

    context.model = {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      baseUrl: "https://different-origin.example/v1",
    };
    expect(eventHandlers.get("input")?.({ text: "must not send" }, context)).toEqual({
      action: "handled",
    });
    expect(shutdownCount).toBe(1);
  });

  it("keeps model, prompt, shell, and tool gates closed when extension UI methods fail", async () => {
    const eventHandlers = new Map<string, (event: unknown, context: FakeContext) => unknown>();
    createHunterCoreExtension({
      environment: {
        HUNTER_PI_MODE: "QUICK",
        HUNTER_PI_PERMISSION_PROFILE: "BALANCED",
        HUNTER_PI_SAFE_MODE: "0",
        HUNTER_PI_BLOCK_PROMPT_INPUT: "1",
        HUNTER_PI_PINNED_PROVIDER: "openai-codex",
        HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
        HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
      },
    })({
      on: (event, handler) => eventHandlers.set(event, handler),
      registerCommand: () => undefined,
    });
    const context: FakeContext = {
      cwd: "C:\\work\\repo",
      hasUI: true,
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "https://provider-managed.example/v1",
      },
      shutdown: () => {
        throw new Error("fixture shutdown failure");
      },
      ui: {
        confirm: () => Promise.reject(new Error("fixture confirm failure")),
        notify: () => {
          throw new Error("fixture notify failure");
        },
        setStatus: () => undefined,
      },
    };

    expect(eventHandlers.get("input")?.({ text: "must not send" }, context)).toEqual({
      action: "handled",
    });
    await expect(
      eventHandlers.get("user_bash")?.(
        { command: "mutate", excludeFromContext: false, cwd: context.cwd },
        context,
      ),
    ).resolves.toEqual({
      result: {
        output: "Hunter Pi blocked direct shell execution in Safe Mode.\n",
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    });

    const approvalHandlers = new Map<
      string,
      (event: unknown, approvalContext: FakeContext) => unknown
    >();
    createHunterCoreExtension({
      environment: {
        HUNTER_PI_MODE: "QUICK",
        HUNTER_PI_PERMISSION_PROFILE: "BALANCED",
        HUNTER_PI_SAFE_MODE: "0",
        HUNTER_PI_PINNED_PROVIDER: "openai-codex",
        HUNTER_PI_PINNED_MODEL: "gpt-5.6-sol",
        HUNTER_PI_PINNED_ORIGIN: "https://provider-managed.example",
      },
    })({
      on: (event, handler) => approvalHandlers.set(event, handler),
      registerCommand: () => undefined,
    });
    await expect(
      approvalHandlers.get("user_bash")?.(
        { command: "mutate", excludeFromContext: false, cwd: context.cwd },
        context,
      ),
    ).resolves.toEqual({
      result: {
        output: "Hunter Pi blocked direct shell execution in Safe Mode.\n",
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    });
    await expect(
      approvalHandlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "mutate" } },
        context,
      ),
    ).resolves.toEqual({ block: true, reason: "The interactive approval UI failed closed." });

    context.model = { provider: "other", id: "other" };
    expect(eventHandlers.get("input")?.({ text: "drifted" }, context)).toEqual({
      action: "handled",
    });
  });
});

interface FakeContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  model: { readonly provider: string; readonly id: string; readonly baseUrl?: string } | undefined;
  shutdown(): void;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget?(key: string, content: string[]): void;
  };
}
