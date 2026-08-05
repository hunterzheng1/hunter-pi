import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

import { z } from "zod";

import { runNpm, subprocessOutputLimitBytes, summarizeProcessFailure } from "./npm-process.mjs";
import { createRelativeFileSpecifier } from "./package-specifier.mjs";
import { createCanonicalTemporaryDirectory } from "./temporary-directory.mjs";
import { packCliArtifact } from "./cli-package.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageNames = [
  "@hunter-pi/domain",
  "@hunter-pi/evidence",
  "@hunter-pi/engine-contracts",
  "@hunter-pi/pi-host",
  "@hunter-pi/pilot",
  "@hunter-pi/plugin-manager",
  "@hunter-pi/updater",
  "@hunter-pi/workflow-kernel",
  "@hunter-pi/testkit",
];
const packageDirectories = [
  "domain",
  "evidence",
  "engine-contracts",
  "pi-host",
  "pilot",
  "plugin-manager",
  "updater",
  "workflow-kernel",
  "testkit",
];

/** @type {(text: string) => unknown} */
const parseJson = JSON.parse;
const packOutputSchema = z.array(z.looseObject({ filename: z.string() })).length(1);
const cliVersionSchema = z.strictObject({
  product: z.literal("Hunter Pi"),
  productVersion: z.literal("0.1.0-dev.0"),
  engine: z.strictObject({
    packageName: z.literal("@earendil-works/pi-coding-agent"),
    version: z.literal("0.83.0"),
  }),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceState: z.enum(["CLEAN", "DIRTY"]),
  coreExtensionIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  productShellIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  updateChannel: z.literal("developer-preview"),
});
const installedPackageIdentitySchema = z.looseObject({ name: z.string(), version: z.string() });

/**
 * @param {string} output npm pack JSON output.
 * @returns {string} generated archive filename.
 */
const readArchiveFilename = (output) => {
  const record = packOutputSchema.parse(parseJson(output))[0];
  if (record === undefined) {
    throw new Error("npm pack did not return one archive record.");
  }

  return record.filename;
};

/**
 * @param {{ readonly executable: string; readonly arguments: readonly string[]; readonly cwd: string; readonly environment: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>}
 */
function runCapturedProcess(options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.executable, [...options.arguments], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (/** @type {Buffer | string} */ chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (/** @type {Buffer | string} */ chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolvePromise({ exitCode: signal === null ? (code ?? 1) : 1, stdout, stderr });
    });
  });
}

/**
 * @param {{ readonly installedPiRoot: string; readonly installedCoreExtension: string; readonly root: string; readonly safeEnvironment: NodeJS.ProcessEnv }} options
 */
async function proveInstalledCoreInputGate(options) {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.end(
      'data: {"id":"unexpected","object":"chat.completion.chunk","created":0,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await /** @type {Promise<void>} */ (
    new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolvePromise();
      });
    })
  );
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Unable to bind the packaged Core input-gate fixture.");
    }
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const agentDirectory = join(options.root, "packaged-core-agent");
    const sessionDirectory = join(options.root, "packaged-core-sessions");
    await Promise.all([mkdir(agentDirectory), mkdir(sessionDirectory)]);
    const credentialSentinel = "packaged-core-credential-must-not-be-recorded";
    await writeFile(
      join(agentDirectory, "models.json"),
      `${JSON.stringify({
        providers: {
          "hunter-fixture": {
            baseUrl: `${origin}/v1`,
            api: "openai-completions",
            apiKey: credentialSentinel,
            authHeader: true,
            models: [{ id: "fixture-model", reasoning: false, maxTokens: 64 }],
          },
        },
      })}\n`,
      "utf8",
    );
    const environment = {
      ...options.safeEnvironment,
      HOME: options.root,
      HUNTER_PI_BLOCK_PROMPT_INPUT: "1",
      HUNTER_PI_MODE: "QUICK",
      HUNTER_PI_PINNED_MODEL: "fixture-model",
      HUNTER_PI_PINNED_ORIGIN: origin,
      HUNTER_PI_PINNED_PROVIDER: "hunter-fixture",
      HUNTER_PI_PERMISSION_PROFILE: "SAFE",
      HUNTER_PI_SAFE_MODE: "1",
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TEMP: options.root,
      TMP: options.root,
      TMPDIR: options.root,
      USERPROFILE: options.root,
    };
    const execution = await runCapturedProcess({
      executable: process.execPath,
      arguments: [
        join(options.installedPiRoot, "dist", "cli.js"),
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--session-dir",
        sessionDirectory,
        "--provider",
        "hunter-fixture",
        "--model",
        "hunter-fixture/fixture-model",
        "--models",
        "hunter-fixture/fixture-model",
        "--extension",
        options.installedCoreExtension,
        "--mode",
        "json",
        "--no-session",
        "--no-tools",
        "packaged Core no-send prompt",
      ],
      cwd: options.root,
      environment,
    });
    if (execution.exitCode !== 0 || requestCount !== 0) {
      throw new Error("The installed bundled Core did not intercept Provider-bound prompt input.");
    }
    if (`${execution.stdout}\n${execution.stderr}`.includes(credentialSentinel)) {
      throw new Error("The installed bundled Core smoke output contained a fixture credential.");
    }
  } finally {
    await /** @type {Promise<void>} */ (
      new Promise((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
      })
    );
  }
}

const temporaryRoot = await createCanonicalTemporaryDirectory("hunter-pi-package-smoke-");
const archiveDirectory = join(temporaryRoot, "archives");
const consumerDirectory = join(temporaryRoot, "consumer");
const cliConsumerDirectory = join(temporaryRoot, "cli-consumer");
const npmIsolationRoot = join(temporaryRoot, "npm");
const npmDiagnosticRoots = {
  archives: archiveDirectory,
  repository: repositoryRoot,
};

try {
  await mkdir(archiveDirectory);
  await mkdir(consumerDirectory);
  await mkdir(cliConsumerDirectory);

  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const [index, packageDirectory] of packageDirectories.entries()) {
    const packageName = packageNames[index];
    if (packageName === undefined) {
      throw new Error("Package smoke configuration is inconsistent.");
    }

    const packOutput = runNpm(
      [
        "pack",
        resolve(repositoryRoot, "packages", packageDirectory),
        "--json",
        "--pack-destination",
        archiveDirectory,
      ],
      repositoryRoot,
      npmIsolationRoot,
      npmDiagnosticRoots,
    );
    const archivePath = join(archiveDirectory, readArchiveFilename(packOutput));
    dependencies[packageName] = createRelativeFileSpecifier(consumerDirectory, archivePath);
  }

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "hunter-pi-package-smoke-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies,
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );

  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerDirectory,
    npmIsolationRoot,
    npmDiagnosticRoots,
  );

  const importProbe = `await Promise.all(${JSON.stringify(
    packageNames,
  )}.map((specifier) => import(specifier)));`;
  const importResult = spawnSync(process.execPath, ["--input-type=module", "--eval", importProbe], {
    cwd: consumerDirectory,
    encoding: "utf8",
    maxBuffer: subprocessOutputLimitBytes,
    shell: false,
    windowsHide: true,
  });

  if (importResult.error !== undefined) {
    throw new Error("Unable to start the package import probe.");
  }

  if (importResult.status !== 0) {
    throw new Error(
      summarizeProcessFailure("Package import probe", {
        status: importResult.status,
        stderr: importResult.stderr,
        stdout: importResult.stdout,
      }),
    );
  }

  process.stdout.write(`External package smoke passed (${packageNames.join(", ")}).\n`);

  const cliPackOutput = await packCliArtifact({
    destination: archiveDirectory,
    npmIsolationRoot: join(npmIsolationRoot, "cli-pack"),
    diagnosticRoots: npmDiagnosticRoots,
  });
  const cliArchivePath = join(archiveDirectory, readArchiveFilename(cliPackOutput));
  await writeFile(
    join(cliConsumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "hunter-pi-cli-smoke-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@hunter-pi/cli": createRelativeFileSpecifier(cliConsumerDirectory, cliArchivePath),
        },
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    cliConsumerDirectory,
    join(npmIsolationRoot, "cli-install"),
    npmDiagnosticRoots,
  );
  runNpm(
    ["ls", "@hunter-pi/cli", "@earendil-works/pi-coding-agent", "--all"],
    cliConsumerDirectory,
    join(npmIsolationRoot, "cli-tree"),
    npmDiagnosticRoots,
  );

  const installedCliRoot = join(cliConsumerDirectory, "node_modules", "@hunter-pi", "cli");
  const installedPiRoot = join(
    cliConsumerDirectory,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const installedProductShell = join(installedCliRoot, "dist", "hpi.js");
  const installedCoreExtension = join(installedCliRoot, "dist", "core-extension.js");
  await Promise.all([
    access(installedProductShell),
    access(installedCoreExtension),
    access(join(installedCliRoot, "LICENSE")),
    access(join(installedPiRoot, "dist", "cli.js")),
    access(join(installedPiRoot, "npm-shrinkwrap.json")),
  ]);
  z.looseObject({
    engines: z.strictObject({
      node: z.literal(">=24.0.0 <25"),
      npm: z.literal(">=11.0.0 <12"),
    }),
  }).parse(parseJson(await readFile(join(installedCliRoot, "package.json"), "utf8")));

  const piShrinkwrap = z
    .looseObject({
      lockfileVersion: z.literal(3),
      packages: z.record(
        z.string(),
        z.looseObject({
          version: z.string().optional(),
          resolved: z.string().optional(),
        }),
      ),
    })
    .parse(parseJson(await readFile(join(installedPiRoot, "npm-shrinkwrap.json"), "utf8")));
  for (const packageName of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ]) {
    const shrinkwrapKey = `node_modules/${packageName}`;
    const packageBasename = packageName.slice(packageName.indexOf("/") + 1);
    const locked = piShrinkwrap.packages[shrinkwrapKey];
    if (
      locked?.version !== "0.83.0" ||
      locked.resolved !==
        `https://registry.npmjs.org/${packageName}/-/${packageBasename}-0.83.0.tgz`
    ) {
      throw new Error(`Published Pi shrinkwrap does not freeze ${packageName} 0.83.0.`);
    }
    let installedRecord;
    for (const packagePath of [
      join(installedPiRoot, "node_modules", packageName, "package.json"),
      join(cliConsumerDirectory, "node_modules", packageName, "package.json"),
    ]) {
      try {
        installedRecord = installedPackageIdentitySchema.parse(
          parseJson(await readFile(packagePath, "utf8")),
        );
        break;
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
    }
    if (installedRecord?.name !== packageName || installedRecord.version !== "0.83.0") {
      throw new Error(`Installed Pi runtime component ${packageName} drifted from 0.83.0.`);
    }
  }

  /** @type {NodeJS.ProcessEnv} */
  const safeCliEnvironment = {};
  for (const key of ["ComSpec", "LANG", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) safeCliEnvironment[key] = value;
  }
  const cliProfile = join(temporaryRoot, "cli-profile");
  const cliTemporaryDirectory = join(temporaryRoot, "cli-temporary");
  await Promise.all([mkdir(cliProfile), mkdir(cliTemporaryDirectory)]);
  Object.assign(safeCliEnvironment, {
    HOME: cliProfile,
    HUNTER_PI_HOME: join(cliProfile, ".hunter-pi"),
    TEMP: cliTemporaryDirectory,
    TMP: cliTemporaryDirectory,
    TMPDIR: cliTemporaryDirectory,
    USERPROFILE: cliProfile,
  });

  const versionResult = spawnSync(process.execPath, [installedProductShell, "version", "--json"], {
    cwd: cliConsumerDirectory,
    encoding: "utf8",
    env: safeCliEnvironment,
    maxBuffer: subprocessOutputLimitBytes,
    shell: false,
    windowsHide: true,
  });
  if (versionResult.error !== undefined || versionResult.status !== 0) {
    throw new Error(
      summarizeProcessFailure("Installed hpi version probe", {
        status: versionResult.status,
        stderr: versionResult.stderr,
        stdout: versionResult.stdout,
      }),
    );
  }
  const version = cliVersionSchema.parse(parseJson(versionResult.stdout));
  const npmExecVersionOutput = runNpm(
    ["exec", "--offline", "--", "hpi", "version", "--json"],
    cliConsumerDirectory,
    join(npmIsolationRoot, "cli-npm-exec"),
    npmDiagnosticRoots,
  );
  cliVersionSchema.parse(parseJson(npmExecVersionOutput));

  const buildInfoPath = join(installedCliRoot, "dist", "build-info.json");
  const validBuildInfo = await readFile(buildInfoPath, "utf8");
  try {
    await writeFile(
      buildInfoPath,
      `${JSON.stringify({
        sourceCommit: version.sourceCommit,
        sourceState: version.sourceState,
        unexpected: true,
      })}\n`,
      "utf8",
    );
    const corruptIdentityResult = spawnSync(
      process.execPath,
      [installedProductShell, "version", "--json"],
      {
        cwd: cliConsumerDirectory,
        encoding: "utf8",
        env: safeCliEnvironment,
        maxBuffer: subprocessOutputLimitBytes,
        shell: false,
        windowsHide: true,
      },
    );
    if (corruptIdentityResult.status !== 1 || corruptIdentityResult.stdout.length !== 0) {
      throw new Error("Packaged hpi did not fail closed on an incompatible build identity.");
    }
    await rm(buildInfoPath);
    const missingIdentityResult = spawnSync(
      process.execPath,
      [installedProductShell, "version", "--json"],
      {
        cwd: cliConsumerDirectory,
        encoding: "utf8",
        env: safeCliEnvironment,
        maxBuffer: subprocessOutputLimitBytes,
        shell: false,
        windowsHide: true,
      },
    );
    if (missingIdentityResult.status !== 1 || missingIdentityResult.stdout.length !== 0) {
      throw new Error("Packaged hpi did not fail closed on a missing build identity.");
    }
  } finally {
    await writeFile(buildInfoPath, validBuildInfo, "utf8");
  }

  const validProductShell = await readFile(installedProductShell, "utf8");
  try {
    await writeFile(
      installedProductShell,
      `${validProductShell}\n// tampered shell fixture\n`,
      "utf8",
    );
    const tamperedProductShellResult = spawnSync(
      process.execPath,
      [installedProductShell, "version", "--json"],
      {
        cwd: cliConsumerDirectory,
        encoding: "utf8",
        env: safeCliEnvironment,
        maxBuffer: subprocessOutputLimitBytes,
        shell: false,
        windowsHide: true,
      },
    );
    if (tamperedProductShellResult.status !== 1 || tamperedProductShellResult.stdout.length !== 0) {
      throw new Error("Packaged hpi did not fail closed on product-shell tampering.");
    }
  } finally {
    await writeFile(installedProductShell, validProductShell, "utf8");
  }

  const piVersionResult = spawnSync(
    process.execPath,
    [join(installedPiRoot, "dist", "cli.js"), "--version"],
    {
      cwd: cliConsumerDirectory,
      encoding: "utf8",
      env: safeCliEnvironment,
      maxBuffer: subprocessOutputLimitBytes,
      shell: false,
      windowsHide: true,
    },
  );
  if (
    piVersionResult.error !== undefined ||
    piVersionResult.status !== 0 ||
    piVersionResult.stdout.trim() !== version.engine.version
  ) {
    throw new Error(
      summarizeProcessFailure("Installed Pi Engine Release probe", {
        status: piVersionResult.status,
        stderr: piVersionResult.stderr,
        stdout: piVersionResult.stdout,
      }),
    );
  }

  const doctorResult = spawnSync(
    process.execPath,
    [join(installedCliRoot, "dist", "hpi.js"), "doctor", "--json"],
    {
      cwd: cliConsumerDirectory,
      encoding: "utf8",
      env: safeCliEnvironment,
      maxBuffer: subprocessOutputLimitBytes,
      shell: false,
      windowsHide: true,
    },
  );
  if (doctorResult.error !== undefined || doctorResult.status !== 2) {
    throw new Error(
      summarizeProcessFailure("Installed hpi Doctor blocked-state probe", {
        status: doctorResult.status,
        stderr: doctorResult.stderr,
        stdout: doctorResult.stdout,
      }),
    );
  }
  const doctor = z
    .looseObject({
      overallStatus: z.literal("BLOCKED"),
      checks: z.array(z.looseObject({ id: z.string(), status: z.string() })),
    })
    .parse(parseJson(doctorResult.stdout));
  const engineCheck = doctor.checks.find((check) => check.id === "engine_release");
  if (engineCheck?.status !== "DETECTED") {
    throw new Error("Installed hpi Doctor did not detect the exact Pi Engine Release.");
  }
  const coreIntegrityCheck = doctor.checks.find((check) => check.id === "core_extension");
  if (coreIntegrityCheck?.status !== "DETECTED") {
    throw new Error("Installed hpi Doctor did not verify bundled Core Extension integrity.");
  }
  const validCoreExtension = await readFile(installedCoreExtension, "utf8");
  try {
    await writeFile(installedCoreExtension, `${validCoreExtension}\n// tampered fixture\n`, "utf8");
    const tamperedCoreDoctor = spawnSync(
      process.execPath,
      [join(installedCliRoot, "dist", "hpi.js"), "doctor", "--json"],
      {
        cwd: cliConsumerDirectory,
        encoding: "utf8",
        env: safeCliEnvironment,
        maxBuffer: subprocessOutputLimitBytes,
        shell: false,
        windowsHide: true,
      },
    );
    const tamperedReport = z
      .looseObject({
        checks: z.array(z.looseObject({ id: z.string(), status: z.string() })),
      })
      .parse(parseJson(tamperedCoreDoctor.stdout));
    if (
      tamperedCoreDoctor.status !== 2 ||
      tamperedReport.checks.find((check) => check.id === "core_extension")?.status !==
        "INCOMPATIBLE"
    ) {
      throw new Error("Installed hpi Doctor did not fail closed on Core Extension tampering.");
    }
  } finally {
    await writeFile(installedCoreExtension, validCoreExtension, "utf8");
  }
  const policyReference =
    "https://learn.chatgpt.com/docs/enterprise/work-admin-faq#how-does-chatgpt-work-support-enterprise-privacy-and-data-commitments";
  const configuredAt = "2026-08-03T00:00:00.000Z";
  const hpiConfigurationRoot = join(cliProfile, ".hunter-pi");
  await mkdir(hpiConfigurationRoot, { recursive: true });
  await writeFile(
    join(hpiConfigurationRoot, "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updateChannel: "developer-preview",
        setupCompletedAt: configuredAt,
        provider: {
          id: "openai-codex",
          selectedModel: "gpt-5.6-sol",
          endpointCategory: "PROVIDER_MANAGED",
          destinationOrigin: null,
          policyReference,
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
          version: "2026-08-03.2",
          categories: [
            "PROMPTS",
            "CONVERSATION_CONTEXT",
            "REPOSITORY_CONTENT",
            "TOOL_RESULTS",
            "REQUEST_METADATA",
          ],
          completeFilesMayEnterContext: true,
          hunterTelemetry: "DISABLED",
          piStartupNetwork: "OFFLINE",
          externalRetention: "NOT_PROVEN",
          trainingUse: "NOT_PROVEN",
          accountControls: "PROVIDER_OWNED",
          acknowledgement: {
            version: "2026-08-03.2",
            providerId: "openai-codex",
            endpointCategory: "PROVIDER_MANAGED",
            destinationOrigin: null,
            resolvedDestinationOrigin: "https://chatgpt.com",
            policyReference,
            externalRetention: "NOT_PROVEN",
            trainingUse: "NOT_PROVEN",
            accountControls: "PROVIDER_OWNED",
            acceptedAt: configuredAt,
          },
        },
        plugins: [],
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
  const configuredDoctorResult = spawnSync(
    process.execPath,
    [join(installedCliRoot, "dist", "hpi.js"), "doctor", "--json"],
    {
      cwd: cliConsumerDirectory,
      encoding: "utf8",
      env: safeCliEnvironment,
      maxBuffer: subprocessOutputLimitBytes,
      shell: false,
      windowsHide: true,
    },
  );
  if (configuredDoctorResult.error !== undefined || configuredDoctorResult.status !== 2) {
    throw new Error(
      summarizeProcessFailure("Configured installed hpi Doctor probe", {
        status: configuredDoctorResult.status,
        stderr: configuredDoctorResult.stderr,
        stdout: configuredDoctorResult.stdout,
      }),
    );
  }
  const configuredDoctor = z
    .looseObject({
      checks: z.array(
        z.looseObject({
          id: z.string(),
          status: z.string(),
          summary: z.string(),
        }),
      ),
    })
    .parse(parseJson(configuredDoctorResult.stdout));
  const authCheck = configuredDoctor.checks.find((check) => check.id === "provider_auth");
  if (
    authCheck?.status !== "BLOCKED" ||
    authCheck.summary !== "Selected Provider authentication is not configured."
  ) {
    throw new Error("Packaged Hunter Pi did not execute the real metadata-only Pi auth reader.");
  }
  const coreCheck = configuredDoctor.checks.find((check) => check.id === "core_extension");
  if (coreCheck?.status !== "DETECTED") {
    throw new Error("Packaged Hunter Pi did not detect its physical Core Extension entrypoint.");
  }
  await proveInstalledCoreInputGate({
    installedPiRoot,
    installedCoreExtension,
    root: cliTemporaryDirectory,
    safeEnvironment: safeCliEnvironment,
  });
  const portableOutput = `${versionResult.stdout}\n${doctorResult.stdout}\n${configuredDoctorResult.stdout}`;
  if (
    portableOutput.includes(temporaryRoot) ||
    /api[_-]?key|cookie|authorization|bearer/iu.test(portableOutput)
  ) {
    throw new Error(
      "Installed hpi smoke output contained a private path or credential-shaped field.",
    );
  }

  const globalPrefix = join(temporaryRoot, "isolated-global");
  const globalBinDirectory =
    process.platform === "win32" ? globalPrefix : join(globalPrefix, "bin");
  await mkdir(globalBinDirectory, { recursive: true });
  const rawPiSentinelPath = join(
    globalBinDirectory,
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  const rawPiSentinel =
    process.platform === "win32"
      ? "@echo raw-pi-sentinel\r\n"
      : "#!/bin/sh\necho raw-pi-sentinel\n";
  await writeFile(rawPiSentinelPath, rawPiSentinel, "utf8");
  if (process.platform !== "win32") await chmod(rawPiSentinelPath, 0o755);
  runNpm(
    ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", cliArchivePath],
    cliConsumerDirectory,
    join(npmIsolationRoot, "cli-install"),
    npmDiagnosticRoots,
  );
  if ((await readFile(rawPiSentinelPath, "utf8")) !== rawPiSentinel) {
    throw new Error("Isolated global hpi install changed the existing raw Pi command.");
  }
  const globalCliRoot =
    process.platform === "win32"
      ? join(globalPrefix, "node_modules", "@hunter-pi", "cli")
      : join(globalPrefix, "lib", "node_modules", "@hunter-pi", "cli");
  await Promise.all([
    access(join(globalCliRoot, "dist", "hpi.js")),
    access(join(globalBinDirectory, process.platform === "win32" ? "hpi.cmd" : "hpi")),
  ]);
  const globalHpiCommand = join(
    globalBinDirectory,
    process.platform === "win32" ? "hpi.cmd" : "hpi",
  );
  const globalVersionResult =
    process.platform === "win32"
      ? spawnSync(
          safeCliEnvironment["ComSpec"] ?? "cmd.exe",
          ["/d", "/v:off", "/s", "/c", '""%HPI_GLOBAL_COMMAND%" version --json"'],
          {
            cwd: cliConsumerDirectory,
            encoding: "utf8",
            env: { ...safeCliEnvironment, HPI_GLOBAL_COMMAND: globalHpiCommand },
            maxBuffer: subprocessOutputLimitBytes,
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        )
      : spawnSync(globalHpiCommand, ["version", "--json"], {
          cwd: cliConsumerDirectory,
          encoding: "utf8",
          env: safeCliEnvironment,
          maxBuffer: subprocessOutputLimitBytes,
          shell: false,
          windowsHide: true,
        });
  if (globalVersionResult.error !== undefined || globalVersionResult.status !== 0) {
    throw new Error(
      summarizeProcessFailure("Globally installed hpi version probe", {
        status: globalVersionResult.status,
        stderr: globalVersionResult.stderr,
        stdout: globalVersionResult.stdout,
      }),
    );
  }
  cliVersionSchema.parse(parseJson(globalVersionResult.stdout));
  process.stdout.write(
    `Single-artifact hpi smoke passed (${version.productVersion}, Pi ${version.engine.version}, Doctor ${doctor.overallStatus}, raw Pi unchanged).\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
