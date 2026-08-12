import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createCanonicalTemporaryDirectory } from "./temporary-directory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(repositoryRoot, ".artifacts");

/** @param {string} argumentName @param {string} fallback */
function oneArtifactChild(argumentName, fallback) {
  const index = process.argv.indexOf(argumentName);
  if (index >= 0 && process.argv[index + 1] === undefined) {
    throw new Error(`${argumentName} requires one directory under .artifacts.`);
  }
  const rawValue = index >= 0 ? process.argv[index + 1] : fallback;
  if (rawValue === undefined) throw new Error(`${argumentName} is missing.`);
  const value = resolve(rawValue);
  const relativeValue = relative(artifactRoot, value);
  if (
    relativeValue.length === 0 ||
    isAbsolute(relativeValue) ||
    relativeValue === ".." ||
    relativeValue.startsWith(`..${sep}`) ||
    relativeValue.includes(sep)
  ) {
    throw new Error(`${argumentName} must be exactly one child directory under .artifacts.`);
  }
  return value;
}

const portableRoot = oneArtifactChild(
  "--portable-root",
  join(artifactRoot, "hpi-windows-x64-portable"),
);
const outputRoot = oneArtifactChild("--output", join(artifactRoot, "hpi-windows-x64-release"));
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows release assets can be assembled only on Windows x64");
}

/** @param {Uint8Array} content */
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** @param {string} root */
async function releaseFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error("release payload cannot contain links");
      if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile()) files.push(path);
      else throw new Error("release payload contains a non-file entry");
    }
  }
  return files
    .filter((path) => relative(root, path).replaceAll("\\", "/") !== "release-files.json")
    .map((path) => ({ path, relativePath: relative(root, path).replaceAll("\\", "/") }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const portable = await lstat(portableRoot);
if (!portable.isDirectory() || portable.isSymbolicLink()) {
  throw new Error("portable root must be one physical directory");
}
const canonicalArtifactRoot = await realpath(artifactRoot);
const canonicalPortableRoot = await realpath(portableRoot);
const outputParent = await realpath(resolve(outputRoot, ".."));
let canonicalOutputRoot = join(outputParent, basename(outputRoot));
try {
  const existingOutput = await lstat(outputRoot);
  if (existingOutput.isSymbolicLink()) {
    throw new Error("release output cannot replace a symbolic link");
  }
  canonicalOutputRoot = await realpath(outputRoot);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (
  canonicalPortableRoot.toLowerCase() === canonicalOutputRoot.toLowerCase() ||
  canonicalPortableRoot.toLowerCase() === outputRoot.toLowerCase() ||
  canonicalArtifactRoot.toLowerCase() !== outputParent.toLowerCase()
) {
  throw new Error("release output must differ from the portable root");
}
const temporaryRoot = await createCanonicalTemporaryDirectory("hunter-pi-release-assets-");
const stage = join(temporaryRoot, "payload");
const zipPath = join(outputRoot, "hpi-windows-x64.zip");
try {
  await rm(outputRoot, { force: true, recursive: true });
  await Promise.all([mkdir(outputRoot, { recursive: true }), mkdir(stage, { recursive: true })]);
  await cp(portableRoot, stage, { recursive: true });
  const installerSource = join(repositoryRoot, "scripts", "install.ps1");
  await cp(installerSource, join(stage, "install.ps1"));

  const entries = [];
  for (const { path, relativePath } of await releaseFiles(stage)) {
    const content = await readFile(path);
    entries.push({ path: relativePath, sha256: sha256(content), byteLength: content.byteLength });
  }
  await writeFile(
    join(stage, "release-files.json"),
    `${JSON.stringify(
      { schemaVersion: "hpi-windows-release-files.v1", files: entries },
      undefined,
      2,
    )}\n`,
    "utf8",
  );

  const zip = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:HPI_RELEASE_STAGE, $env:HPI_RELEASE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HPI_RELEASE_STAGE: stage, HPI_RELEASE_ZIP: zipPath },
      shell: false,
      windowsHide: true,
    },
  );
  if (zip.error !== undefined || zip.status !== 0) {
    throw new Error("unable to create the Windows release ZIP");
  }
  const zipBytes = await readFile(zipPath);
  if (zipBytes.byteLength === 0) throw new Error("Windows release ZIP is empty");
  await Promise.all([
    cp(installerSource, join(outputRoot, "install.ps1")),
    writeFile(
      join(outputRoot, "hpi-windows-x64.zip.sha256"),
      `${sha256(zipBytes)}  hpi-windows-x64.zip\n`,
      "utf8",
    ),
  ]);
  process.stdout.write(`Hunter Pi Windows release assets: ${outputRoot}\n`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
