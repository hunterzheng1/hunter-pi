import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { packCliArtifact } from "./cli-package.mjs";
import { createRelativeFileSpecifier } from "./package-specifier.mjs";
import { runNpm } from "./npm-process.mjs";
import { createCanonicalTemporaryDirectory } from "./temporary-directory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputArgumentIndex = process.argv.indexOf("--output");
if (outputArgumentIndex >= 0 && process.argv[outputArgumentIndex + 1] === undefined) {
  throw new Error("--output requires one directory name under .artifacts.");
}
const requestedOutput =
  outputArgumentIndex >= 0 ? process.argv[outputArgumentIndex + 1] : undefined;
const artifactRoot = resolve(join(repositoryRoot, ".artifacts"));
const outputDirectory = resolve(requestedOutput ?? join(artifactRoot, "hpi-windows-x64-portable"));
const outputRelative = relative(artifactRoot, outputDirectory);
if (
  outputRelative.length === 0 ||
  isAbsolute(outputRelative) ||
  outputRelative === ".." ||
  outputRelative.startsWith(`..${sep}`) ||
  outputRelative.includes(sep)
) {
  throw new Error("--output must be exactly one child directory under .artifacts.");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Hunter Pi portable package is currently qualified only for Windows x64.");
}
if (!process.versions.node.startsWith("24.")) {
  throw new Error(`The portable package requires Node 24; found ${process.versions.node}.`);
}

/** @param {Uint8Array} value */
function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** @param {readonly string[]} arguments_ */
function gitOutput(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Unable to stamp the portable package from Git identity.");
  }
  return result.stdout.trim();
}

const temporaryRoot = await createCanonicalTemporaryDirectory("hunter-pi-windows-portable-");
const archiveDirectory = join(temporaryRoot, "archives");
const consumerDirectory = join(temporaryRoot, "consumer");
const npmIsolationRoot = join(temporaryRoot, "npm");
const diagnosticRoots = { repository: repositoryRoot, fixture: temporaryRoot };

try {
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const packOutput = await packCliArtifact({
    destination: archiveDirectory,
    npmIsolationRoot: join(npmIsolationRoot, "pack"),
    diagnosticRoots,
  });
  const archiveRecord = z
    .array(z.looseObject({ filename: z.string() }))
    .length(1)
    .parse(JSON.parse(packOutput))[0];
  if (archiveRecord === undefined) throw new Error("npm pack did not report the CLI artifact.");
  const archivePath = join(archiveDirectory, archiveRecord.filename);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "hunter-pi-windows-portable-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@hunter-pi/cli": createRelativeFileSpecifier(consumerDirectory, archivePath),
        },
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerDirectory,
    join(npmIsolationRoot, "install"),
    diagnosticRoots,
  );

  try {
    const existingOutput = await lstat(outputDirectory);
    if (existingOutput.isSymbolicLink()) {
      throw new Error("portable package output cannot replace a symbolic link");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const payloadDirectory = join(temporaryRoot, "payload");
  await mkdir(payloadDirectory, { recursive: true });
  await cp(join(consumerDirectory, "node_modules"), join(payloadDirectory, "node_modules"), {
    recursive: true,
  });
  await cp(process.execPath, join(payloadDirectory, "node.exe"));
  await cp(join(repositoryRoot, "LICENSE"), join(payloadDirectory, "LICENSE"));
  await cp(join(repositoryRoot, "NOTICE.md"), join(payloadDirectory, "NOTICE.md"));
  await writeFile(
    join(payloadDirectory, "hpi.cmd"),
    '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\@hunter-pi\\cli\\dist\\hpi.js" %*\r\n',
    "utf8",
  );

  const cliPackagePath = join(payloadDirectory, "node_modules", "@hunter-pi", "cli");
  const productShell = await readFile(join(cliPackagePath, "dist", "hpi.js"));
  const coreExtension = await readFile(join(cliPackagePath, "dist", "core-extension.js"));
  const runtime = await readFile(join(payloadDirectory, "node.exe"));
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  const dirtyOutput = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).artifacts",
  ]);
  if (dirtyOutput.length > 0) {
    throw new Error("The Windows portable package requires a clean source tree.");
  }
  const cliPackage = z
    .looseObject({ version: z.string() })
    .parse(JSON.parse(await readFile(join(repositoryRoot, "apps", "cli", "package.json"), "utf8")));
  const productVersion = cliPackage.version;
  const enginePackageName = "@earendil-works/pi-coding-agent";
  const engineVersion = "0.83.0";
  const engineReleaseId = `engine-release_pi-${engineVersion}`;
  const engineReleaseFingerprint = sha256(
    Buffer.from(JSON.stringify({ packageName: enginePackageName, version: engineVersion }), "utf8"),
  );
  const releaseId = `release_hunter-pi-${productVersion}-${sourceCommit.slice(0, 12)}`;
  // The updater dist is produced by the preceding build step; the dynamic import keeps this packer executable as plain Node.js.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const updaterContracts =
    /** @type {{ readonly HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT: string; readonly releaseCandidateSchema: { parse(value: unknown): Record<string, unknown> } }} */ (
      await import(new URL("../packages/updater/dist/contracts.js", import.meta.url).href)
    );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const portableBundleModule =
    /** @type {{ readonly createPortableBundleFromDirectory: (options: { readonly directory: string; readonly releaseId: string; readonly productVersion: string; readonly engineReleaseId: string; readonly engineReleaseFingerprint: string; readonly sourceCommit: string }) => Promise<Uint8Array> }} */ (
      await import(new URL("../packages/updater/dist/portable-bundle.js", import.meta.url).href)
    );
  const bundle = await portableBundleModule.createPortableBundleFromDirectory({
    directory: payloadDirectory,
    releaseId,
    productVersion,
    engineReleaseId,
    engineReleaseFingerprint,
    sourceCommit,
  });
  const artifactFingerprint = sha256(bundle);
  const candidate = updaterContracts.releaseCandidateSchema.parse({
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion,
    channel: "PREVIEW",
    artifact: {
      reference: "update.bundle.tgz",
      fingerprint: artifactFingerprint,
      byteLength: bundle.byteLength,
    },
    engine: {
      releaseId: engineReleaseId,
      fingerprint: engineReleaseFingerprint,
      piVersion: engineVersion,
    },
    qualification: {
      status: "NOT_PROVEN",
      verifierFingerprint: updaterContracts.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      checks: [
        {
          name: "windows-portable-ci",
          outcome: "NOT_PROVEN",
          evidenceIds: [],
          reason: "remote Windows and Ubuntu qualification is required before promotion",
        },
      ],
      qualifiedAt: new Date().toISOString(),
    },
    updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
    licenses: [
      { name: "Hunter Pi", version: productVersion, license: "MIT", sourceReference: "NOTICE.md" },
      {
        name: enginePackageName,
        version: engineVersion,
        license: "SEE_PACKAGE_NOTICE",
        sourceReference: "NOTICE.md",
      },
    ],
  });
  const versionsDirectory = join(outputDirectory, "versions");
  const versionDirectory = join(versionsDirectory, releaseId);
  const stateDirectory = join(outputDirectory, ".hpi-update");
  await mkdir(versionsDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(join(stateDirectory, "migrations"), { recursive: true });
  await cp(payloadDirectory, versionDirectory, { recursive: true });
  await writeFile(
    join(versionDirectory, ".hpi-candidate.json"),
    `${JSON.stringify(candidate)}\n`,
    "utf8",
  );
  await writeFile(join(versionDirectory, ".hpi-artifact"), bundle);
  await writeFile(
    join(stateDirectory, "active.json"),
    `${JSON.stringify({
      schemaVersion: "hpi-portable-active.v1",
      releaseId,
      artifactFingerprint,
      productVersion,
      activatedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  await cp(process.execPath, join(outputDirectory, "node.exe"));
  await cp(join(repositoryRoot, "LICENSE"), join(outputDirectory, "LICENSE"));
  await cp(join(repositoryRoot, "NOTICE.md"), join(outputDirectory, "NOTICE.md"));
  const launcherSource = [
    'import { spawn } from "node:child_process";',
    'import { lstat, readFile, realpath } from "node:fs/promises";',
    'import { fileURLToPath } from "node:url";',
    'import { dirname, join, resolve } from "node:path";',
    "",
    "async function physicalDirectory(path) {",
    "  const stats = await lstat(path);",
    '  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("portable installation is not physical");',
    "  const canonical = await realpath(path);",
    '  if (resolve(canonical) !== resolve(path)) throw new Error("portable installation is redirected");',
    "  return canonical;",
    "}",
    "",
    "async function physicalFile(path) {",
    "  const stats = await lstat(path);",
    '  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("portable launch file is not physical");',
    "}",
    "",
    "const root = dirname(fileURLToPath(import.meta.url));",
    'const active = JSON.parse(await readFile(join(root, ".hpi-update", "active.json"), "utf8"));',
    'if (typeof active.releaseId !== "string" || !/^release_[A-Za-z0-9][A-Za-z0-9.-]*$/.test(active.releaseId)) throw new Error("portable active release is invalid");',
    'const versionDirectory = await physicalDirectory(join(root, "versions", active.releaseId));',
    'const nodePath = join(versionDirectory, "node.exe");',
    'const cliPath = join(versionDirectory, "node_modules", "@hunter-pi", "cli", "dist", "hpi.js");',
    "await physicalFile(nodePath);",
    "await physicalFile(cliPath);",
    "const child = spawn(nodePath, [cliPath, ...process.argv.slice(2)], {",
    "  cwd: process.cwd(),",
    "  env: { ...process.env, HUNTER_PI_PORTABLE_ROOT: root },",
    "  shell: false,",
    '  stdio: "inherit",',
    "  windowsHide: true,",
    "});",
    "const exitCode = await new Promise((resolveExit) => {",
    '  child.once("error", () => resolveExit(1));',
    '  child.once("exit", (code) => resolveExit(code ?? 1));',
    "});",
    "process.exitCode = exitCode;",
    "",
  ].join("\n");
  await writeFile(join(outputDirectory, "hpi-launcher.mjs"), launcherSource, "utf8");
  await writeFile(
    join(outputDirectory, "hpi.cmd"),
    '@echo off\r\nset "HUNTER_PI_PORTABLE_ROOT=%~dp0"\r\n"%~dp0node.exe" "%~dp0hpi-launcher.mjs" %*\r\nexit /b %errorlevel%\r\n',
    "utf8",
  );
  await writeFile(join(outputDirectory, "update.bundle.tgz"), bundle);
  const manifest = {
    schemaVersion: "hpi-windows-portable.v2",
    product: "Hunter Pi",
    platform: "win32-x64",
    nodeVersion: process.versions.node,
    sourceCommit,
    sourceState: "CLEAN",
    updateChannel: "developer-preview",
    installer: "PORTABLE_DIRECTORY",
    signed: false,
    releaseId,
    productVersion,
    engineReleaseId,
    engineReleaseFingerprint,
    artifactFingerprint,
    artifactByteLength: bundle.byteLength,
    versionDirectory: `versions/${releaseId}`,
    cliPackageFingerprint: sha256(await readFile(archivePath)),
    productShellIntegrity: sha256(productShell),
    coreExtensionIntegrity: sha256(coreExtension),
    nodeRuntimeIntegrity: sha256(runtime),
  };
  await writeFile(
    join(outputDirectory, "portable-manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outputDirectory, "portable-release-candidate.json"),
    `${JSON.stringify(candidate, undefined, 2)}\n`,
    "utf8",
  );

  const probe = spawnSync(
    join(outputDirectory, "node.exe"),
    [join(outputDirectory, "hpi-launcher.mjs"), "version", "--json"],
    {
      cwd: outputDirectory,
      encoding: "utf8",
      env: {
        ComSpec: process.env["ComSpec"],
        PATH: process.env["PATH"],
        SystemRoot: process.env["SystemRoot"],
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        USERPROFILE: temporaryRoot,
        HUNTER_PI_HOME: join(temporaryRoot, "home", ".hunter-pi"),
        HUNTER_PI_PORTABLE_ROOT: outputDirectory,
      },
      shell: false,
      windowsHide: true,
    },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error("The assembled Windows portable package failed its version probe.");
  }
  const updateProbe = spawnSync(
    join(outputDirectory, "node.exe"),
    [join(outputDirectory, "hpi-launcher.mjs"), "update", "status", "--json"],
    {
      cwd: outputDirectory,
      encoding: "utf8",
      env: {
        ComSpec: process.env["ComSpec"],
        PATH: process.env["PATH"],
        SystemRoot: process.env["SystemRoot"],
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        USERPROFILE: temporaryRoot,
        HUNTER_PI_HOME: join(temporaryRoot, "home", ".hunter-pi"),
        HUNTER_PI_PORTABLE_ROOT: outputDirectory,
      },
      shell: false,
      windowsHide: true,
    },
  );
  const updateProbeOutput = updateProbe.stdout.trim().split(/\r?\n/u).at(-1);
  /** @type {{ readonly status?: string | undefined; readonly currentReleaseId?: string | undefined } | undefined} */
  let updateStatus;
  try {
    updateStatus = z
      .looseObject({ status: z.string().optional(), currentReleaseId: z.string().optional() })
      .parse(JSON.parse(updateProbeOutput ?? ""));
  } catch {
    updateStatus = undefined;
  }
  if (
    updateProbe.error !== undefined ||
    updateProbe.status !== 0 ||
    updateStatus?.status !== "READY" ||
    updateStatus.currentReleaseId !== releaseId
  ) {
    throw new Error("The assembled Windows portable package failed its update status probe.");
  }
  process.stdout.write(`Hunter Pi Windows x64 portable package: ${outputDirectory}\n`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
