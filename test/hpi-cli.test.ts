import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHpiCli, type HpiCliDependencies, type HpiCliIo } from "@hunter-pi/cli";
import {
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  loadHpiConfiguration,
  prepareHpiRuntimeDirectories,
  resolveHpiPaths,
  saveHpiConfiguration,
  type PiLaunchPlan,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const createdRoots: string[] = [];
const coreFixtureSource = "export default () => {};\n";
const coreFixtureIntegrity = `sha256:${createHash("sha256").update(coreFixtureSource).digest("hex")}`;
const productShellFixtureIntegrity = `sha256:${"c".repeat(64)}`;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

interface CapturedIo extends HpiCliIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

function createIo(confirmed: boolean): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    confirm: () => Promise.resolve(confirmed),
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };
}

async function createDependencies(
  options: {
    readonly confirmed?: boolean;
    readonly authConfigured?: boolean;
    readonly launch?: (plan: PiLaunchPlan) => Promise<number>;
    readonly readTextFile?: HpiCliDependencies["readTextFile"];
    readonly readProviderAuthStatus?: HpiCliDependencies["readProviderAuthStatus"];
    readonly getVersionInfo?: HpiCliDependencies["getVersionInfo"];
  } = {},
): Promise<{
  readonly root: string;
  readonly io: CapturedIo;
  readonly dependencies: HpiCliDependencies;
}> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-cli-test-");
  createdRoots.push(root);
  const repository = join(root, "repository");
  const io = createIo(options.confirmed ?? true);
  const dependencies: HpiCliDependencies = {
    cwd: repository,
    environment: { HUNTER_PI_HOME: join(root, "profile") },
    homeDirectory: root,
    io,
    now: () => "2026-08-03T13:00:00.000Z",
    inspectRepository: () =>
      Promise.resolve({ root: repository, name: "repository", branch: "main", dirty: false }),
    readProviderAuthStatus:
      options.readProviderAuthStatus ??
      (() => Promise.resolve({ configured: options.authConfigured ?? false, source: "stored" })),
    resolveProviderDestination: (_paths, providerId) =>
      Promise.resolve(
        providerId === "openai-codex"
          ? {
              configuredOrigin: "https://provider-managed.example",
              pristineOrigin: "https://provider-managed.example",
            }
          : { configuredOrigin: "http://127.0.0.1:43123", pristineOrigin: null },
      ),
    launch: options.launch ?? (() => Promise.resolve(0)),
    piCliPath: join(root, "pi-cli.js"),
    coreExtensionPath: join(root, "core-extension.js"),
    temporaryParent: root,
    platform: process.platform,
    ...(options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile }),
    getVersionInfo:
      options.getVersionInfo ??
      (() =>
        Promise.resolve({
          product: "Hunter Pi",
          productVersion: "0.1.0-dev.0",
          engine: {
            packageName: "@earendil-works/pi-coding-agent",
            version: "0.83.0",
          },
          sourceCommit: "NOT_STAMPED",
          sourceState: "NOT_STAMPED",
          coreExtensionIntegrity: coreFixtureIntegrity,
          productShellIntegrity: productShellFixtureIntegrity,
          updateChannel: "developer-preview",
        })),
  };
  await writeFile(join(root, "core-extension.js"), coreFixtureSource, "utf8");
  return { root, io, dependencies };
}

async function writeReadyConfiguration(dependencies: HpiCliDependencies): Promise<void> {
  const paths = resolveHpiPaths({
    env: dependencies.environment,
    homeDirectory: dependencies.homeDirectory,
  });
  const acknowledged = acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
    acceptedAt: "2026-08-03T12:59:00.000Z",
    resolvedDestinationOrigin: "https://provider-managed.example",
  });
  await saveHpiConfiguration(paths, {
    ...acknowledged,
    setupCompletedAt: "2026-08-03T12:59:30.000Z",
  });
}

describe("hpi command", () => {
  it("documents exact model and permission setup options", async () => {
    for (const helpArgument of ["help", "--help", "-h"]) {
      const { dependencies, io } = await createDependencies();
      expect(await runHpiCli([helpArgument], dependencies)).toBe(0);
      expect(io.stdout.join("\n")).toContain("--model exact-id");
      expect(io.stdout.join("\n")).toContain("--permission safe|balanced|full-access");
      expect(io.stdout.join("\n")).toContain("hpi pilot preflight --plan <file> --json");
    }
  });

  it("runs only the safe pilot preflight and never echoes an invalid plan", async () => {
    const { dependencies, io, root } = await createDependencies();
    const planPath = join(root, "pilot-plan.json");
    await writeFile(
      planPath,
      JSON.stringify({
        credential: "token=do-not-echo",
        privatePath: root,
      }),
      "utf8",
    );

    expect(
      await runHpiCli(["pilot", "preflight", "--plan", planPath, "--json"], dependencies),
    ).toBe(2);
    const output = `${io.stdout.join("")} ${io.stderr.join("")}`;
    expect(output).toContain('"status":"BLOCKED"');
    expect(output).not.toContain(root);
    expect(output).not.toContain("do-not-echo");
  });

  it("returns redacted actionable preflight reason codes for file and JSON failures", async () => {
    const unreadable = await createDependencies({
      readTextFile: () => Promise.reject(new Error("C:\\private\\pilot-plan.json")),
    });
    expect(
      await runHpiCli(
        ["pilot", "preflight", "--plan", "C:\\private\\pilot-plan.json", "--json"],
        unreadable.dependencies,
      ),
    ).toBe(2);
    expect(unreadable.io.stdout.join("\n")).toContain("PILOT_PLAN_FILE_UNREADABLE");
    expect(unreadable.io.stdout.join("\n")).not.toContain("C:\\private");

    const invalidJson = await createDependencies({
      readTextFile: () => Promise.resolve("{not-json"),
    });
    expect(
      await runHpiCli(
        ["pilot", "preflight", "--plan", "pilot-plan.json", "--json"],
        invalidJson.dependencies,
      ),
    ).toBe(2);
    expect(invalidJson.io.stdout.join("\n")).toContain("PILOT_PLAN_JSON_INVALID");
  });

  it("rejects unknown commands and malformed options before confirmation or launch", async () => {
    for (const arguments_ of [
      ["quik"],
      ["setup", "--permisson", "safe"],
      ["setup", "--permission", "safe", "--permission", "balanced"],
      ["setup", "--provider"],
      ["doctor", "--jsno"],
      ["login", "unexpected"],
      ["--safe-mode", "unexpected"],
    ]) {
      let launched = false;
      const { dependencies, io } = await createDependencies({
        confirmed: true,
        launch: () => {
          launched = true;
          return Promise.resolve(0);
        },
      });

      expect(await runHpiCli(arguments_, dependencies), arguments_.join(" ")).toBe(2);
      expect(launched).toBe(false);
      expect(io.stderr.join("\n")).toContain("InvalidArguments=BLOCKED");
      expect(io.stdout.join("\n")).toContain("Usage: hpi");
      const paths = resolveHpiPaths({
        env: dependencies.environment,
        homeDirectory: dependencies.homeDirectory,
      });
      await expect(access(paths.configurationFile)).rejects.toThrow();
    }
  });

  it("keeps help and version available while invalid isolated-home input fails without a stack", async () => {
    const { dependencies, io } = await createDependencies();
    const invalidHomeDependencies: HpiCliDependencies = {
      ...dependencies,
      environment: { HUNTER_PI_HOME: "relative-profile" },
    };

    expect(await runHpiCli(["--help"], invalidHomeDependencies)).toBe(0);
    expect(await runHpiCli(["version", "--json"], invalidHomeDependencies)).toBe(0);
    expect(await runHpiCli(["doctor"], invalidHomeDependencies)).toBe(1);
    expect(io.stderr.join("\n")).toContain("CommandStatus=INCOMPATIBLE");
    expect(io.stderr.join("\n")).not.toContain("at ");
  });

  it("identifies the product, fixed Engine Release, source stamp state, and update channel", async () => {
    const { dependencies, io } = await createDependencies();

    expect(await runHpiCli(["version", "--json"], dependencies)).toBe(0);
    const version = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
    expect(version).toMatchObject({
      product: "Hunter Pi",
      productVersion: "0.1.0-dev.0",
      engine: {
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.83.0",
      },
      updateChannel: "developer-preview",
    });
    expect(version).toHaveProperty("sourceCommit");
    expect(version).toHaveProperty("sourceState");
    expect(version).toHaveProperty("coreExtensionIntegrity");
    expect(version).toHaveProperty("productShellIntegrity");
  });

  it("cancels first-run disclosure as BLOCKED without persisting configuration", async () => {
    const { dependencies, io, root } = await createDependencies({ confirmed: false });

    expect(await runHpiCli(["setup"], dependencies)).toBe(2);
    expect(io.stdout.join("\n")).toContain("Provider data disclosure");
    expect(io.stdout.join("\n")).toContain("PROMPTS");
    expect(io.stdout.join("\n")).toContain(
      "Hunter Pi cannot enforce the Provider's external policy",
    );
    expect(io.stderr.join("\n")).toContain("SetupStatus=BLOCKED");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    await expect(access(paths.configurationFile)).rejects.toThrow();
    expect(`${io.stdout.join("")} ${io.stderr.join("")}`).not.toContain(root);
  });

  it("orchestrates the bounded first-run environment, setup, login, defaults, plugins, and verification steps", async () => {
    let capturedPlan: PiLaunchPlan | undefined;
    const { dependencies, io } = await createDependencies({
      confirmed: true,
      authConfigured: true,
      launch: (plan) => {
        capturedPlan = plan;
        return Promise.resolve(0);
      },
    });

    expect(await runHpiCli([], dependencies)).toBe(0);
    const output = io.stdout.join("\n");
    for (const step of ["1/7", "2/7", "3/7", "4/7", "5/7", "6/7", "7/7"]) {
      expect(output).toContain(`Step ${step}`);
    }
    expect(output).toContain("FirstRunStatus=CONFIGURED");
    expect(output).toContain("InteractiveTui=NOT_PROVEN");
    expect(capturedPlan?.environment["HUNTER_PI_MODE"]).toBe("LOGIN");
    expect(capturedPlan?.environment["HUNTER_PI_BLOCK_PROMPT_INPUT"]).toBe("1");
  });

  it("rejects invalid setup values before printing or persisting them", async () => {
    const { dependencies, io } = await createDependencies({ confirmed: false });

    expect(
      await runHpiCli(
        [
          "setup",
          "--provider",
          "openai-codex\nforged",
          "--policy-reference",
          "https://example.invalid/provider-policy",
        ],
        dependencies,
      ),
    ).toBe(1);
    expect(io.stdout.join("")).toBe("");
    expect(io.stderr.join("\n")).toContain("CommandStatus=INCOMPATIBLE");
    expect(`${io.stdout.join("")} ${io.stderr.join("")}`).not.toContain("forged");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    await expect(access(paths.configurationFile)).rejects.toThrow();

    const credentialUrl = await createDependencies({ confirmed: true });
    expect(
      await runHpiCli(
        ["setup", "--policy-reference", "https://user:secret@example.invalid/policy?token=secret"],
        credentialUrl.dependencies,
      ),
    ).toBe(1);
    expect(credentialUrl.io.stdout.join("")).toBe("");
    expect(`${credentialUrl.io.stdout.join("")} ${credentialUrl.io.stderr.join("")}`).not.toContain(
      "secret",
    );
  });

  it("persists only versioned consent and then reports missing login honestly", async () => {
    const { dependencies, io } = await createDependencies({ confirmed: true });

    expect(await runHpiCli(["setup"], dependencies)).toBe(0);
    expect(io.stdout.join("\n")).toContain("Destination=https://provider-managed.example");
    expect(io.stdout.join("\n")).toContain("ExternalRetention=NOT_PROVEN");
    expect(io.stdout.join("\n")).toContain("TrainingUse=NOT_PROVEN");
    expect(io.stdout.join("\n")).toContain("AccountControls=PROVIDER_OWNED");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const configuration = await loadHpiConfiguration(paths);
    expect(configuration?.disclosure.acknowledgement).toMatchObject({
      providerId: "openai-codex",
      acceptedAt: "2026-08-03T13:00:00.000Z",
    });
    const persisted = await readFile(paths.configurationFile, "utf8");
    expect(persisted).not.toMatch(/api[_-]?key|cookie|authorization|bearer/iu);

    io.stdout.splice(0);
    expect(await runHpiCli(["doctor", "--json"], dependencies)).toBe(2);
    const report = JSON.parse(io.stdout.join("")) as {
      overallStatus: string;
      checks: { id: string; status: string }[];
    };
    expect(report.overallStatus).toBe("BLOCKED");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "provider_auth", status: "BLOCKED" }),
    );
  });

  it("launches a normal Quick Session and reports process exit without a verified Change", async () => {
    let capturedPlan: PiLaunchPlan | undefined;
    const { dependencies, io } = await createDependencies({
      authConfigured: true,
      launch: (plan) => {
        capturedPlan = plan;
        return Promise.resolve(0);
      },
    });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["--continue"], dependencies)).toBe(0);
    expect(capturedPlan?.arguments).toContain("--continue");
    expect(capturedPlan?.environment["HUNTER_PI_HEADER"]).toContain(
      "Repository=repository@main CLEAN",
    );
    expect(io.stdout.join("\n")).toContain("Repository=repository@main CLEAN");
    expect(io.stdout.join("\n")).toContain("VerifiedChange=NOT_CLAIMED");
    expect(io.stdout.join("\n")).toContain('"observation":"PROCESS_EXIT"');
  });

  it("starts Safe Mode without auth and omits a throwing configured plugin", async () => {
    let capturedPlan: PiLaunchPlan | undefined;
    const { dependencies } = await createDependencies({
      authConfigured: false,
      launch: (plan) => {
        capturedPlan = plan;
        return Promise.resolve(0);
      },
    });
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const ready = acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
      acceptedAt: "2026-08-03T12:59:00.000Z",
      resolvedDestinationOrigin: "https://provider-managed.example",
    });
    await saveHpiConfiguration(paths, {
      ...ready,
      setupCompletedAt: "2026-08-03T12:59:30.000Z",
      plugins: [
        {
          id: "broken/plugin",
          entrypoint: join(createdRoots[0] ?? tmpdir(), "throwing.js"),
          enabled: true,
          compatibility: "UNVERIFIED",
          trust: "USER_APPROVED",
          isolation: "PROCESS_AUTHORITY",
        },
      ],
    });

    expect(await runHpiCli(["--safe-mode"], dependencies)).toBe(0);
    expect(capturedPlan?.arguments).toContain("--no-skills");
    expect(capturedPlan?.arguments).not.toContain("throwing.js");
    expect(capturedPlan?.environment["HUNTER_PI_PERMISSION_PROFILE"]).toBe("SAFE");
  });

  it("fails closed when an isolated runtime directory is a symlink or junction", async () => {
    let launched = false;
    let authInspected = false;
    const { dependencies, io, root } = await createDependencies({
      launch: () => {
        launched = true;
        return Promise.resolve(0);
      },
      readProviderAuthStatus: () => {
        authInspected = true;
        return Promise.resolve({ configured: false });
      },
    });
    await writeReadyConfiguration(dependencies);
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const outside = join(root, "outside-session-target");
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(outside);
    await symlink(
      outside,
      paths.sessionDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await runHpiCli(["--safe-mode"], dependencies)).toBe(1);
    expect(launched).toBe(false);
    expect(authInspected).toBe(false);
    expect(io.stderr.join("\n")).toContain("CommandStatus=INCOMPATIBLE");
  });

  it("rejects linked session entries before every Quick Session inspects auth or launches Pi", async () => {
    let launched = false;
    let authInspected = false;
    const { dependencies, io, root } = await createDependencies({
      launch: () => {
        launched = true;
        return Promise.resolve(0);
      },
      readProviderAuthStatus: () => {
        authInspected = true;
        return Promise.resolve({ configured: true });
      },
    });
    await writeReadyConfiguration(dependencies);
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    await prepareHpiRuntimeDirectories(paths);
    const outside = join(root, "outside-session-tree");
    const linked = join(paths.sessionDirectory, "linked-session");
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(outside);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

    expect(await runHpiCli([], dependencies)).toBe(1);
    expect(authInspected).toBe(false);
    expect(launched).toBe(false);
    expect(io.stderr.join("\n")).toContain("CommandStatus=INCOMPATIBLE");
  });

  it("rejects linked session entries before the Provider login TUI launches", async () => {
    let launched = false;
    const { dependencies, root } = await createDependencies({
      launch: () => {
        launched = true;
        return Promise.resolve(0);
      },
    });
    await writeReadyConfiguration(dependencies);
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    await prepareHpiRuntimeDirectories(paths);
    const outside = join(root, "outside-login-session-tree");
    const linked = join(paths.sessionDirectory, "linked-login-session");
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(outside);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");

    expect(await runHpiCli(["login"], dependencies)).toBe(1);
    expect(launched).toBe(false);
  });

  it("delegates login to Pi and records only readiness metadata after return", async () => {
    let capturedPlan: PiLaunchPlan | undefined;
    const { dependencies, io } = await createDependencies({
      authConfigured: true,
      launch: (plan) => {
        capturedPlan = plan;
        return Promise.resolve(0);
      },
    });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["login"], dependencies)).toBe(0);
    expect(capturedPlan?.environment["HUNTER_PI_MODE"]).toBe("LOGIN");
    expect(capturedPlan?.environment["HUNTER_PI_BLOCK_PROMPT_INPUT"]).toBe("1");
    expect(capturedPlan?.arguments).toContain("--no-extensions");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    expect((await loadHpiConfiguration(paths))?.providerReadiness).toEqual({
      providerId: "openai-codex",
      status: "DETECTED",
      checkedAt: "2026-08-03T13:00:00.000Z",
    });
    expect(io.stdout.join("\n")).toContain("Hunter host received metadata only");
    expect(JSON.stringify(await loadHpiConfiguration(paths))).not.toMatch(
      /api[_-]?key|cookie|authorization|bearer/iu,
    );
  });

  it("records a cancelled login attempt as BLOCKED even when prior auth metadata exists", async () => {
    const { dependencies, io } = await createDependencies({
      confirmed: false,
      authConfigured: true,
      launch: () => Promise.resolve(0),
    });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["login"], dependencies)).toBe(2);
    expect(io.stderr.join("\n")).toContain("LoginStatus=BLOCKED Receipt=DECLINED");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    expect((await loadHpiConfiguration(paths))?.providerReadiness.status).toBe("NOT_CHECKED");
  });

  it("blocks the disposable Managed Change before creating a fixture when Provider auth is absent", async () => {
    const { dependencies, io, root } = await createDependencies({ authConfigured: false });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["managed", "fixture", "--json"], dependencies)).toBe(2);
    expect(io.stderr.join("\n")).toContain(
      "ManagedChangeStatus=BLOCKED Reason=PROVIDER_AUTH_REQUIRED",
    );
    expect(io.stderr.join("\n")).not.toContain("InvalidArguments=BLOCKED");
    expect(`${io.stdout.join("")} ${io.stderr.join("")}`).not.toContain(root);
  });

  it("runs the exact disposable Managed Change through a bounded Pi JSON process and emits portable Evidence", async () => {
    const sourceCommit = "d".repeat(40);
    const { dependencies, io, root } = await createDependencies({
      authConfigured: true,
      getVersionInfo: () =>
        Promise.resolve({
          product: "Hunter Pi",
          productVersion: "0.1.0-dev.0",
          engine: {
            packageName: "@earendil-works/pi-coding-agent",
            version: "0.83.0",
          },
          sourceCommit,
          sourceState: "CLEAN",
          coreExtensionIntegrity: coreFixtureIntegrity,
          productShellIntegrity: productShellFixtureIntegrity,
          updateChannel: "developer-preview",
        }),
    });
    await writeReadyConfiguration(dependencies);
    let processRequests = 0;
    const runTask6Process = async (
      request: Task6PiProcessRequest,
    ): Promise<Task6PiProcessResult> => {
      processRequests += 1;
      expect(request.plan.cwd).not.toBe(dependencies.cwd);
      expect(request.maximumOutputBytes).toBe(229_376);
      expect(request.plan.environment).toMatchObject({
        HUNTER_PI_MODE: "QUICK",
        HUNTER_PI_PERMISSION_PROFILE: "FULL_ACCESS",
        HUNTER_PI_SAFE_MODE: "0",
      });
      expect(request.plan.arguments).toContain("--no-approve");
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: `sha256:${"a".repeat(64)}`,
        stderrDigest: `sha256:${"b".repeat(64)}`,
        capturedBytes: 128,
        outputTruncated: false,
      };
    };
    const managedDependencies: HpiCliDependencies = {
      ...dependencies,
      runTask6Process,
    };

    expect(await runHpiCli(["managed", "fixture", "--json"], managedDependencies)).toBe(0);
    expect(processRequests).toBe(1);
    const artifact = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-task6-managed-change.v1",
      taskResult: "GO",
      productSource: { commit: sourceCommit, state: "CLEAN" },
      provider: { id: "openai-codex", authStatus: "DETECTED", requestStatus: "DETECTED" },
      lifecycleAfterAgentReturn: "VERIFYING",
      cleanup: { status: "PASS" },
      remoteCi: "PENDING",
    });
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(
      (await readdir(root)).some((entry) => entry.startsWith("hunter-pi-managed-change-")),
    ).toBe(false);
  });

  it("refuses a Managed Change from an unstamped or dirty product artifact", async () => {
    let processRan = false;
    const { dependencies, io } = await createDependencies({ authConfigured: true });
    await writeReadyConfiguration(dependencies);
    const managedDependencies: HpiCliDependencies = {
      ...dependencies,
      runTask6Process: () => {
        processRan = true;
        throw new Error("an untrusted product artifact must not reach Pi");
      },
    };

    expect(await runHpiCli(["managed", "fixture", "--json"], managedDependencies)).toBe(2);
    expect(processRan).toBe(false);
    expect(io.stderr.join("\n")).toContain(
      "ManagedChangeStatus=BLOCKED Reason=UNSTAMPED_OR_DIRTY_PRODUCT",
    );
  });

  it("doctors and disables plugins as metadata without deleting their entrypoint", async () => {
    const { dependencies, io, root } = await createDependencies();
    const pluginPath = join(root, "plugin.js");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(pluginPath, 'throw new Error("do not execute me");\n', "utf8"),
    );
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const ready = acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
      acceptedAt: "2026-08-03T12:59:00.000Z",
      resolvedDestinationOrigin: "https://provider-managed.example",
    });
    await saveHpiConfiguration(paths, {
      ...ready,
      setupCompletedAt: "2026-08-03T12:59:30.000Z",
      plugins: [
        {
          id: "local/throwing",
          entrypoint: pluginPath,
          enabled: true,
          compatibility: "UNVERIFIED",
          trust: "USER_APPROVED",
          isolation: "PROCESS_AUTHORITY",
        },
      ],
    });

    expect(await runHpiCli(["plugin", "doctor"], dependencies)).toBe(0);
    expect(io.stdout.join("\n")).toContain('"entrypointStatus":"DETECTED"');
    expect(await runHpiCli(["plugin", "disable", "local/throwing"], dependencies)).toBe(0);
    expect((await loadHpiConfiguration(paths))?.plugins[0]?.enabled).toBe(false);
    expect(await readFile(pluginPath, "utf8")).toContain("do not execute me");
  });

  it("records a TUI smoke only after explicit human confirmation, never from exit alone", async () => {
    let capturedPlan: PiLaunchPlan | undefined;
    const { dependencies, io } = await createDependencies({
      confirmed: true,
      authConfigured: false,
      launch: (plan) => {
        capturedPlan = plan;
        return Promise.resolve(0);
      },
    });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["smoke", "tui"], dependencies)).toBe(0);
    expect(io.stdout.join("\n")).toContain("HunterStatus=DETECTED Command=/hunter-status");
    expect(capturedPlan?.environment["HUNTER_PI_SAFE_MODE"]).toBe("1");
    expect(capturedPlan?.environment["HUNTER_PI_BLOCK_PROMPT_INPUT"]).toBe("1");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const readiness = (await loadHpiConfiguration(paths))?.interactiveTuiReadiness;
    expect(readiness).toMatchObject({
      status: "DETECTED",
      checkedAt: "2026-08-03T13:00:00.000Z",
      engineVersion: "0.83.0",
      productVersion: "0.1.0-dev.0",
      sourceCommit: "NOT_STAMPED",
      sourceState: "NOT_STAMPED",
      platform: process.platform,
      terminalKind: "TTY",
      coreExtensionIntegrity: coreFixtureIntegrity,
      productShellIntegrity: productShellFixtureIntegrity,
      receiptKind: "MANUAL_ACKNOWLEDGEMENT",
    });
    expect(readiness?.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(io.stdout.join("\n")).toContain("TuiSmoke=DETECTED Acknowledgement=MANUAL");

    const rejected = await createDependencies({
      confirmed: false,
      launch: () => Promise.resolve(0),
    });
    await writeReadyConfiguration(rejected.dependencies);
    expect(await runHpiCli(["smoke", "tui"], rejected.dependencies)).toBe(2);
    const rejectedPaths = resolveHpiPaths({
      env: rejected.dependencies.environment,
      homeDirectory: rejected.dependencies.homeDirectory,
    });
    expect((await loadHpiConfiguration(rejectedPaths))?.interactiveTuiReadiness.status).toBe(
      "NOT_PROVEN",
    );
  });

  it("refuses to record a TUI smoke from an unstamped workspace artifact", async () => {
    let launched = false;
    const { dependencies, io } = await createDependencies({
      confirmed: true,
      launch: () => {
        launched = true;
        return Promise.resolve(0);
      },
      getVersionInfo: () =>
        Promise.resolve({
          product: "Hunter Pi",
          productVersion: "0.1.0-dev.0",
          engine: {
            packageName: "@earendil-works/pi-coding-agent",
            version: "0.83.0",
          },
          sourceCommit: "NOT_STAMPED",
          sourceState: "NOT_STAMPED",
          coreExtensionIntegrity: null,
          productShellIntegrity: null,
          updateChannel: "developer-preview",
        }),
    });
    await writeReadyConfiguration(dependencies);

    expect(await runHpiCli(["smoke", "tui"], dependencies)).toBe(2);
    expect(launched).toBe(false);
    expect(io.stderr.join("\n")).toContain("CORE_EXTENSION_INCOMPATIBLE");
  });
});
