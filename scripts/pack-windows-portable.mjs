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
  await cp(join(consumerDirectory, "node_modules"), join(outputDirectory, "node_modules"), {
    recursive: true,
  });
  await cp(process.execPath, join(outputDirectory, "node.exe"));
  await cp(join(repositoryRoot, "LICENSE"), join(outputDirectory, "LICENSE"));
  await cp(join(repositoryRoot, "NOTICE.md"), join(outputDirectory, "NOTICE.md"));
  await writeFile(
    join(outputDirectory, "hpi.cmd"),
    '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\@hunter-pi\\cli\\dist\\hpi.js" %*\r\n',
    "utf8",
  );

  const cliPackagePath = join(outputDirectory, "node_modules", "@hunter-pi", "cli");
  const productShell = await readFile(join(cliPackagePath, "dist", "hpi.js"));
  const coreExtension = await readFile(join(cliPackagePath, "dist", "core-extension.js"));
  const runtime = await readFile(join(outputDirectory, "node.exe"));
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  const dirtyOutput = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).artifacts",
  ]);
  const manifest = {
    schemaVersion: "hpi-windows-portable.v1",
    product: "Hunter Pi",
    platform: "win32-x64",
    nodeVersion: process.versions.node,
    sourceCommit,
    sourceState: dirtyOutput.length === 0 ? "CLEAN" : "DIRTY",
    updateChannel: "developer-preview",
    installer: "PORTABLE_DIRECTORY",
    signed: false,
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

  const probe = spawnSync(
    join(outputDirectory, "node.exe"),
    [join(cliPackagePath, "dist", "hpi.js"), "version", "--json"],
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
      },
      shell: false,
      windowsHide: true,
    },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error("The assembled Windows portable package failed its version probe.");
  }
  process.stdout.write(`Hunter Pi Windows x64 portable package: ${outputDirectory}\n`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
