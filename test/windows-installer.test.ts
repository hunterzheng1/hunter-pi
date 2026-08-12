import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerPath = join(repositoryRoot, "scripts", "install.ps1");
const cleanupRoots: string[] = [];

interface InstallerReceipt {
  readonly schemaVersion: "hunter-pi-install-receipt.v1";
  readonly status: "INSTALLED" | "ALREADY_INSTALLED";
  readonly releaseId: string;
  readonly productVersion: string;
  readonly source: "LOCAL_DIRECTORY" | "LOCAL_ARCHIVE" | "REMOTE";
  readonly checksum: "VERIFIED" | "LOCAL_MANIFEST_ONLY";
  readonly pathChanged: boolean;
  readonly stableCommandReady: boolean;
  readonly conflictDetected: boolean;
  readonly signed: false;
  readonly providerRequestPerformed: false;
  readonly existingHunterPiStateTouched: false;
}

async function regularFiles(root: string): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("release fixture must contain only regular files and directories");
    }
  }
  return files;
}

async function writeReleaseFileManifest(root: string): Promise<void> {
  const manifestPath = join(root, "release-files.json");
  const files = (await regularFiles(root))
    .filter((path) => path !== manifestPath)
    .map((path) => ({ path, relativePath: relative(root, path).replaceAll("\\", "/") }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const entries = await Promise.all(
    files.map(async ({ path, relativePath }) => {
      const content = await readFile(path);
      return {
        path: relativePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        byteLength: content.byteLength,
      };
    }),
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: "hpi-windows-release-files.v1", files: entries }, undefined, 2)}\n`,
    "utf8",
  );
}

async function createReleaseFixture(
  root: string,
  releaseId: string,
  productVersion: string,
): Promise<void> {
  const versionDirectory = join(root, "versions", releaseId);
  await Promise.all([
    mkdir(versionDirectory, { recursive: true }),
    mkdir(join(root, ".hpi-update"), { recursive: true }),
  ]);
  const candidate = {
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion,
    channel: "PREVIEW",
    engine: { piVersion: "0.84.1" },
    qualification: { status: "NOT_PROVEN" },
  };
  const versionOutput = JSON.stringify({
    product: "Hunter Pi",
    productVersion,
    releaseId,
    engine: { packageName: "@earendil-works/pi-coding-agent", version: "0.84.1" },
  });
  await Promise.all([
    writeFile(join(root, "hpi.cmd"), `@echo off\r\necho ${versionOutput}\r\n`, "utf8"),
    writeFile(join(root, "hpi-launcher.mjs"), "// fixture launcher\n", "utf8"),
    writeFile(join(root, "node.exe"), "fixture runtime\n", "utf8"),
    writeFile(join(root, "LICENSE"), "MIT fixture\n", "utf8"),
    writeFile(join(root, "NOTICE.md"), "fixture notice\n", "utf8"),
    writeFile(join(root, "portable-release-candidate.json"), `${JSON.stringify(candidate)}\n`),
    writeFile(join(versionDirectory, ".hpi-candidate.json"), `${JSON.stringify(candidate)}\n`),
    writeFile(join(versionDirectory, "hpi.cmd"), `@echo off\r\necho ${versionOutput}\r\n`),
    writeFile(
      join(root, ".hpi-update", "active.json"),
      `${JSON.stringify({
        schemaVersion: "hpi-portable-active.v1",
        releaseId,
        productVersion,
        artifactFingerprint: `sha256:${"a".repeat(64)}`,
        activatedAt: "2026-08-13T00:00:00.000Z",
      })}\n`,
    ),
    writeFile(
      join(root, "portable-manifest.json"),
      `${JSON.stringify({
        schemaVersion: "hpi-windows-portable.v3",
        product: "Hunter Pi",
        platform: "win32-x64",
        updateChannel: "developer-preview",
        installer: "PORTABLE_ZIP",
        signed: false,
        releaseId,
        productVersion,
        engineVersion: "0.84.1",
        versionDirectory: `versions/${releaseId}`,
      })}\n`,
    ),
  ]);
  await cp(installerPath, join(root, "install.ps1"));
  await writeReleaseFileManifest(root);
}

function runInstaller(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installerPath,
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function receiptFrom(stdout: string): InstallerReceipt {
  const line = stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.startsWith("{"));
  if (line === undefined) throw new Error("installer did not emit its JSON receipt");
  return JSON.parse(line) as InstallerReceipt;
}

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { force: true, recursive: true })));
});

describe.skipIf(process.platform !== "win32")("Windows install.ps1", () => {
  it("installs into the versioned layout, owns a stable PATH shim, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-"));
    cleanupRoots.push(root);
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const installRoot = join(root, "user", "HunterPi");
    const conflictRoot = join(root, "legacy-npm");
    const existingState = join(root, "existing-state");
    await Promise.all([
      createReleaseFixture(sourceA, "release_fixture-a", "0.1.0-dev.1"),
      createReleaseFixture(sourceB, "release_fixture-b", "0.1.0-dev.2"),
      mkdir(conflictRoot, { recursive: true }),
      mkdir(existingState, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(conflictRoot, "hpi.cmd"), "@echo legacy npm hpi\r\n", "utf8"),
      writeFile(join(existingState, "sentinel.txt"), "untouched\n", "utf8"),
    ]);
    const baseEnvironment = {
      ...process.env,
      HUNTER_PI_HOME: existingState,
      LOCALAPPDATA: join(root, "local-app-data"),
      PATH: `${conflictRoot};${process.env["PATH"] ?? ""}`,
    };
    const commonArguments = [
      "-Source",
      "LocalDirectory",
      "-InstallRoot",
      installRoot,
      "-PathMode",
      "Process",
      "-Json",
    ] as const;

    const first = runInstaller([...commonArguments, "-LocalSource", sourceA], baseEnvironment);
    expect(first.status, first.stderr).toBe(0);
    expect(receiptFrom(first.stdout)).toMatchObject({
      schemaVersion: "hunter-pi-install-receipt.v1",
      status: "INSTALLED",
      releaseId: "release_fixture-a",
      productVersion: "0.1.0-dev.1",
      source: "LOCAL_DIRECTORY",
      checksum: "LOCAL_MANIFEST_ONLY",
      pathChanged: true,
      stableCommandReady: true,
      conflictDetected: true,
      signed: false,
      providerRequestPerformed: false,
      existingHunterPiStateTouched: false,
    });
    await expect(readFile(join(existingState, "sentinel.txt"), "utf8")).resolves.toBe(
      "untouched\n",
    );
    await expect(readFile(join(conflictRoot, "hpi.cmd"), "utf8")).resolves.toContain("legacy");

    const stableBin = join(installRoot, "bin");
    const probe = spawnSync("cmd.exe", ["/d", "/s", "/c", "hpi version --json"], {
      encoding: "utf8",
      env: { ...baseEnvironment, PATH: `${stableBin};${baseEnvironment.PATH}` },
      shell: false,
      windowsHide: true,
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toMatchObject({
      product: "Hunter Pi",
      productVersion: "0.1.0-dev.1",
      releaseId: "release_fixture-a",
    });

    const second = runInstaller([...commonArguments, "-LocalSource", sourceA], {
      ...baseEnvironment,
      PATH: `${stableBin};${baseEnvironment.PATH}`,
    });
    expect(second.status, second.stderr).toBe(0);
    expect(receiptFrom(second.stdout)).toMatchObject({
      status: "ALREADY_INSTALLED",
      releaseId: "release_fixture-a",
      pathChanged: false,
    });

    const unsafeOverwrite = runInstaller([...commonArguments, "-LocalSource", sourceB], {
      ...baseEnvironment,
      PATH: `${stableBin};${baseEnvironment.PATH}`,
    });
    expect(unsafeOverwrite.status).not.toBe(0);
    expect(`${unsafeOverwrite.stdout}\n${unsafeOverwrite.stderr}`).toMatch(/hpi update apply/iu);
    await expect(
      readFile(join(installRoot, "versions", "release_fixture-a", ".hpi-candidate.json")),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(installRoot, "versions", "release_fixture-b", ".hpi-candidate.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("builds a ZIP whose embedded and standalone installers are identical and locally usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-release-assets-"));
    cleanupRoots.push(root);
    const suffix = randomUUID().replaceAll("-", "");
    const portableRoot = join(repositoryRoot, ".artifacts", `installer-source-${suffix}`);
    const outputRoot = join(repositoryRoot, ".artifacts", `installer-assets-${suffix}`);
    cleanupRoots.push(portableRoot, outputRoot);
    await createReleaseFixture(portableRoot, "release_fixture-zip", "0.1.0-dev.1");
    const build = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "create-windows-release-assets.mjs"),
        "--portable-root",
        portableRoot,
        "--output",
        outputRoot,
      ],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
    );
    expect(build.status, build.stderr).toBe(0);
    const archive = join(outputRoot, "hpi-windows-x64.zip");
    const checksum = join(outputRoot, "hpi-windows-x64.zip.sha256");
    const archiveBytes = await readFile(archive);
    expect(await readFile(checksum, "utf8")).toBe(
      `${createHash("sha256").update(archiveBytes).digest("hex")}  hpi-windows-x64.zip\n`,
    );
    const extracted = join(root, "extracted");
    const unzip = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:HPI_TEST_ZIP_PATH, $env:HPI_TEST_ZIP_DEST)",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HPI_TEST_ZIP_PATH: archive, HPI_TEST_ZIP_DEST: extracted },
        windowsHide: true,
      },
    );
    expect(unzip.status, unzip.stderr).toBe(0);
    const [sourceInstaller, standaloneInstaller, embeddedInstaller] = await Promise.all([
      readFile(installerPath),
      readFile(join(outputRoot, "install.ps1")),
      readFile(join(extracted, "install.ps1")),
    ]);
    expect(standaloneInstaller).toEqual(sourceInstaller);
    expect(embeddedInstaller).toEqual(sourceInstaller);

    const installRoot = join(root, "installed");
    const install = runInstaller(
      [
        "-Source",
        "LocalArchive",
        "-ArchivePath",
        archive,
        "-ChecksumPath",
        checksum,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      { ...process.env, LOCALAPPDATA: join(root, "local-app-data") },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(receiptFrom(install.stdout)).toMatchObject({
      status: "INSTALLED",
      source: "LOCAL_ARCHIVE",
      checksum: "VERIFIED",
      stableCommandReady: true,
    });
  }, 60_000);

  it("rejects a tampered local archive before creating the installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-tamper-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const archive = join(root, "hpi-windows-x64.zip");
    const checksum = `${archive}.sha256`;
    const installRoot = join(root, "install");
    await createReleaseFixture(source, "release_fixture-tamper", "0.1.0-dev.1");
    await writeFile(join(source, "hpi.cmd"), "@echo tampered payload\r\n", "utf8");
    const payloadTamper = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        source,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      { ...process.env, LOCALAPPDATA: join(root, "local-app-data") },
    );
    expect(payloadTamper.status).not.toBe(0);
    expect(`${payloadTamper.stdout}\n${payloadTamper.stderr}`).toMatch(/fingerprint/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await createReleaseFixture(source, "release_fixture-tamper", "0.1.0-dev.1");
    const zip = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:HPI_TEST_ZIP_SOURCE, $env:HPI_TEST_ZIP_PATH, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HPI_TEST_ZIP_SOURCE: source, HPI_TEST_ZIP_PATH: archive },
        windowsHide: true,
      },
    );
    expect(zip.status, zip.stderr).toBe(0);
    const archiveBytes = await readFile(archive);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    await Promise.all([
      writeFile(checksum, `${digest}  hpi-windows-x64.zip\n`, "utf8"),
      writeFile(archive, Buffer.concat([archiveBytes, Buffer.from("tampered")])),
    ]);

    const result = runInstaller(
      [
        "-Source",
        "LocalArchive",
        "-ArchivePath",
        archive,
        "-ChecksumPath",
        checksum,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      { ...process.env, LOCALAPPDATA: join(root, "local-app-data") },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/checksum|SHA-256/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
