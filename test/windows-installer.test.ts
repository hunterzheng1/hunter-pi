import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  FileWindowsPortableReleaseAdapter,
  createPortableBundle,
  releaseCandidateSchema,
} from "@hunter-pi/updater";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerPath = join(repositoryRoot, "scripts", "install.ps1");
const cleanupRoots: string[] = [];

interface InstallerReceipt {
  readonly schemaVersion: "hunter-pi-install-receipt.v1";
  readonly status: "INSTALLED" | "ALREADY_INSTALLED" | "UPDATED";
  readonly releaseId: string;
  readonly productVersion: string;
  readonly source: "LOCAL_DIRECTORY" | "LOCAL_ARCHIVE" | "REMOTE";
  readonly checksum: "VERIFIED" | "LOCAL_MANIFEST_ONLY";
  readonly pathChanged: boolean;
  readonly stableCommandReady: boolean;
  readonly conflictDetected: boolean;
  readonly signed: false;
  readonly providerRequestPerformed: false;
  readonly existingHunterPiStateTouched: boolean;
}

function sortJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  throw new TypeError("fixture canonical JSON accepts JSON values");
}

async function makeQualifiedBootstrapFixture(root: string, runId: number): Promise<void> {
  const candidatePath = join(root, "portable-release-candidate.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
    releaseId: string;
    productVersion: string;
    artifact: { fingerprint: string; byteLength: number };
    qualification: {
      status: string;
      verifierFingerprint: string;
      checks: { name: string; outcome: string; evidenceIds: string[]; reason?: string }[];
      qualifiedAt: string;
    };
  };
  const evidenceId = `evidence_main-ci-${String(runId)}-portable`;
  candidate.qualification = {
    status: "PASS",
    verifierFingerprint: candidate.qualification.verifierFingerprint,
    checks: [{ name: "windows-portable-ci", outcome: "PASS", evidenceIds: [evidenceId] }],
    qualifiedAt: "2026-08-13T04:00:00.000Z",
  };
  await Promise.all([
    writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, "utf8"),
    writeFile(
      join(root, "versions", candidate.releaseId, ".hpi-candidate.json"),
      `${JSON.stringify(candidate)}\n`,
      "utf8",
    ),
    mkdir(join(root, ".hpi-update", "qualification-evidence"), { recursive: true }),
  ]);
  await writeFile(
    join(root, ".hpi-update", "qualification-evidence", `${String(runId)}.json`),
    `${JSON.stringify({ schemaVersion: "fixture-evidence.v1", evidenceId })}\n`,
    "utf8",
  );

  const sourceVersionRoot = join(root, "versions", candidate.releaseId);
  const cliPath = join(sourceVersionRoot, "node_modules", "@hunter-pi", "cli", "dist", "hpi.js");
  await Promise.all([
    rm(join(sourceVersionRoot, "node.exe"), { force: true }),
    mkdir(join(sourceVersionRoot, "node_modules", "@hunter-pi", "cli", "dist"), {
      recursive: true,
    }),
  ]);
  await link(process.execPath, join(sourceVersionRoot, "node.exe"));
  await writeFile(
    cliPath,
    `
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const candidatePath = value("--candidate");
const artifactPath = value("--artifact");
const evidencePath = value("--installer-bootstrap-evidence");
const root = process.env.HUNTER_PI_PORTABLE_ROOT;
if (args[0] === "update" && args[1] === "rollback" && args[2] && root) {
  const candidate = JSON.parse(readFileSync(join(root, "versions", args[2], ".hpi-candidate.json"), "utf8"));
  writeFileSync(join(root, ".hpi-update", "active.json"), JSON.stringify({
    schemaVersion: "hpi-portable-active.v1",
    releaseId: candidate.releaseId,
    productVersion: candidate.productVersion,
    artifactFingerprint: candidate.artifact.fingerprint,
    activatedAt: "2026-08-13T04:02:00.000Z",
  }) + "\\n");
  process.stdout.write(JSON.stringify({ schemaVersion: "hpi-update-receipt.v1", action: "ROLLBACK", outcome: "APPLIED", activeReleaseId: candidate.releaseId }) + "\\n");
  process.exit(0);
}
if (args[0] !== "update" || args[1] !== "apply" || !candidatePath || !artifactPath || !evidencePath || !root || !existsSync(evidencePath) || process.env.HUNTER_PI_INSTALLER_BOOTSTRAP !== "dev1-to-dev2") {
  process.stderr.write("bootstrap invocation is incomplete\\n");
  process.exit(2);
}
const source = dirname(candidatePath);
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const versionRoot = join(root, "versions", candidate.releaseId);
mkdirSync(versionRoot, { recursive: true });
copyFileSync(candidatePath, join(versionRoot, ".hpi-candidate.json"));
copyFileSync(artifactPath, join(versionRoot, ".hpi-artifact"));
copyFileSync(join(source, "hpi.cmd"), join(root, "hpi.cmd"));
writeFileSync(join(root, ".hpi-update", "active.json"), JSON.stringify({
  schemaVersion: "hpi-portable-active.v1",
  releaseId: candidate.releaseId,
  productVersion: candidate.productVersion,
  artifactFingerprint: candidate.artifact.fingerprint,
  activatedAt: "2026-08-13T04:01:00.000Z",
}) + "\\n");
writeFileSync(join(root, "bootstrap-invocation.json"), JSON.stringify({ candidatePath, artifactPath, evidencePath }) + "\\n");
process.stdout.write(JSON.stringify({ schemaVersion: "hpi-update-receipt.v1", action: "APPLY", outcome: "APPLIED", activeReleaseId: candidate.releaseId }) + "\\n");
`,
    "utf8",
  );
  await writeReleaseFileManifest(root);
}

interface PublishedDev1FixtureIdentity {
  readonly artifactFingerprint: string;
  readonly artifactByteLength: number;
  readonly candidateIdentityFingerprint: string;
  readonly qualificationJournalSha256: string;
}

async function markAsPublishedDev1Fixture(root: string): Promise<PublishedDev1FixtureIdentity> {
  const candidatePath = join(root, "portable-release-candidate.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
    qualification: {
      status: string;
      verifierFingerprint: string;
      checks: { name: string; outcome: string; evidenceIds: string[] }[];
      qualifiedAt: string;
    };
  };
  candidate.qualification = {
    status: "PASS",
    verifierFingerprint: candidate.qualification.verifierFingerprint,
    checks: [
      {
        name: "windows-portable-ci",
        outcome: "PASS",
        evidenceIds: ["evidence_main-ci-31643808274-portable"],
      },
    ],
    qualifiedAt: "2026-08-12T21:52:32Z",
  };
  await Promise.all([
    writeFile(candidatePath, `${JSON.stringify(candidate)}\n`, "utf8"),
    writeFile(
      join(root, "versions", "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc", ".hpi-candidate.json"),
      `${JSON.stringify(candidate)}\n`,
      "utf8",
    ),
  ]);
  const publishedCandidate = JSON.parse(await readFile(candidatePath, "utf8")) as {
    artifact: { fingerprint: string; byteLength: number };
    qualification?: unknown;
  };
  const { qualification: ignoredQualification, ...candidateIdentity } = publishedCandidate;
  void ignoredQualification;
  const qualificationRoot = join(root, ".hpi-update", "qualification-evidence");
  await mkdir(qualificationRoot, { recursive: true });
  const candidateIdentityFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(sortJsonValue(candidateIdentity)))
    .digest("hex")}`;
  await writeFile(
    join(qualificationRoot, "31643808274.json"),
    `${JSON.stringify({
      schemaVersion: "hpi-windows-portable-qualification-evidence.v2",
      evidenceId: "evidence_main-ci-31643808274-portable",
      repository: "hunterzheng1/hunter-pi",
      sourceCommit: "d9f2d931b9fc42d23ceae60fada2aee811caf2ec",
      candidateIdentityFingerprint,
      artifact: {
        name: "hpi-windows-x64-portable",
        fingerprint: publishedCandidate.artifact.fingerprint,
        byteLength: publishedCandidate.artifact.byteLength,
      },
      run: {
        id: 31643808274,
        attempt: 1,
        event: "push",
        headBranch: "main",
        headSha: "d9f2d931b9fc42d23ceae60fada2aee811caf2ec",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        updatedAt: "2026-08-12T21:52:32Z",
        url: "https://github.com/hunterzheng1/hunter-pi/actions/runs/31643808274",
        jobs: [
          "Tests / ubuntu-latest",
          "Tests / windows-latest",
          "Quality + platform Evidence / ubuntu-latest",
          "Quality + platform Evidence / windows-latest",
          "Windows x64 portable artifact",
          "Windows external package smoke",
          "Windows clean locked install",
          "Pi + Task 9 + Task 10 Evidence / Windows + Ubuntu identity",
          "Task 7 containment / ubuntu-latest",
          "Task 7 containment / windows-latest",
          "Task 7 Evidence / Windows + Ubuntu identity",
          "CI gate",
        ].map((name) => ({ name, status: "completed", conclusion: "success" })),
      },
      observedAt: "2026-08-12T21:52:32Z",
    })}\n`,
    "utf8",
  );
  const qualificationJournal = `${JSON.stringify({
    schemaVersion: "fixture-dev1-qualification-journal.v1",
    releaseId: "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
  })}\n`;
  const journalRoot = join(root, ".hpi-update", "manager", "journal");
  await mkdir(journalRoot, { recursive: true });
  await writeFile(
    join(
      journalRoot,
      "000000000001-96afeefd86dabe24bb3880ff3c3a7236bfe2efae2058576f22b312072409d5e0.json",
    ),
    qualificationJournal,
    "utf8",
  );
  await writeReleaseFileManifest(root);
  return {
    artifactFingerprint: publishedCandidate.artifact.fingerprint,
    artifactByteLength: publishedCandidate.artifact.byteLength,
    candidateIdentityFingerprint,
    qualificationJournalSha256: createHash("sha256").update(qualificationJournal).digest("hex"),
  };
}

async function createFixtureBoundInstaller(
  root: string,
  identity: PublishedDev1FixtureIdentity,
): Promise<string> {
  const path = join(root, "fixture-bound-install.ps1");
  const source = (await readFile(installerPath, "utf8"))
    .replaceAll(
      "sha256:5091110764aa5e7499f4b00e9e9b800cab6d739a17303d8b547dd8827186b983",
      identity.artifactFingerprint,
    )
    .replaceAll("64936745", String(identity.artifactByteLength))
    .replaceAll(
      "sha256:a4c95e75ac5396aa1e5f3ee453143defa45e38fc50e14833febf0f9d535bc52d",
      identity.candidateIdentityFingerprint,
    )
    .replaceAll(
      "f08a51c8b6cb2b5b8bfc9c95f23226c7bca66f71354e22588193a6c0508c5c18",
      identity.qualificationJournalSha256,
    );
  await writeFile(path, source, "utf8");
  return path;
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
  sourceCommit = "a".repeat(40),
): Promise<void> {
  const versionDirectory = join(root, "versions", releaseId);
  const engineFingerprint =
    "sha256:a41dddea11dee5fce40f7f100d99f76fcac88281efc8f067c0f6b57b86fdb27e";
  const productShellIntegrity = `sha256:${"d".repeat(64)}`;
  const coreExtensionIntegrity = `sha256:${"e".repeat(64)}`;
  await Promise.all([
    mkdir(versionDirectory, { recursive: true }),
    mkdir(join(root, ".hpi-update"), { recursive: true }),
  ]);
  const versionOutput = JSON.stringify({
    product: "Hunter Pi",
    productVersion,
    engine: { packageName: "@earendil-works/pi-coding-agent", version: "0.84.1" },
    sourceCommit,
    sourceState: "CLEAN",
    coreExtensionIntegrity,
    productShellIntegrity,
    updateChannel: "developer-preview",
  });
  const versionCommand = Buffer.from(`@echo off\r\necho ${versionOutput}\r\n`, "utf8");
  const versionRuntime = Buffer.from("fixture runtime\n", "utf8");
  const artifactBytes = createPortableBundle({
    releaseId,
    productVersion,
    engineReleaseId: "engine-release_pi-0.84.1",
    engineReleaseFingerprint: engineFingerprint,
    sourceCommit,
    files: [
      { path: "hpi.cmd", bytes: versionCommand },
      { path: "node.exe", bytes: versionRuntime },
    ],
  });
  const artifactFingerprint = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
  const candidate = {
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion,
    channel: "PREVIEW",
    artifact: {
      reference: "update.bundle.tgz",
      fingerprint: artifactFingerprint,
      byteLength: artifactBytes.byteLength,
    },
    engine: {
      releaseId: "engine-release_pi-0.84.1",
      fingerprint: engineFingerprint,
      piVersion: "0.84.1",
    },
    qualification: {
      status: "NOT_PROVEN",
      verifierFingerprint:
        "sha256:91015d5db9376b5e86a25538034c76609dcfddee1d7975faf64cca2bcbffe0c6",
      checks: [
        {
          name: "windows-portable-ci",
          outcome: "NOT_PROVEN",
          evidenceIds: [],
          reason: "fixture qualification is intentionally not proven",
        },
      ],
      qualifiedAt: "2026-08-13T00:00:00.000Z",
    },
    updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
    licenses: [
      {
        name: "Hunter Pi",
        version: productVersion,
        license: "MIT",
        sourceReference: "NOTICE.md",
      },
      {
        name: "@earendil-works/pi-coding-agent",
        version: "0.84.1",
        license: "SEE_PACKAGE_NOTICE",
        sourceReference: "NOTICE.md",
      },
    ],
  };
  await Promise.all([
    writeFile(join(root, "hpi.cmd"), versionCommand),
    writeFile(join(root, "hpi-launcher.mjs"), "// fixture launcher\n", "utf8"),
    writeFile(join(root, "node.exe"), versionRuntime),
    writeFile(join(root, "LICENSE"), "MIT fixture\n", "utf8"),
    writeFile(join(root, "NOTICE.md"), "fixture notice\n", "utf8"),
    writeFile(join(root, "portable-release-candidate.json"), `${JSON.stringify(candidate)}\n`),
    writeFile(join(versionDirectory, ".hpi-candidate.json"), `${JSON.stringify(candidate)}\n`),
    writeFile(join(root, "update.bundle.tgz"), artifactBytes),
    writeFile(join(versionDirectory, ".hpi-artifact"), artifactBytes),
    writeFile(join(versionDirectory, "hpi.cmd"), versionCommand),
    writeFile(join(versionDirectory, "node.exe"), versionRuntime),
    writeFile(
      join(root, ".hpi-update", "active.json"),
      `${JSON.stringify({
        schemaVersion: "hpi-portable-active.v1",
        releaseId,
        productVersion,
        artifactFingerprint,
        activatedAt: "2026-08-13T00:00:00.000Z",
      })}\n`,
    ),
    writeFile(
      join(root, "portable-manifest.json"),
      `${JSON.stringify({
        schemaVersion: "hpi-windows-portable.v3",
        product: "Hunter Pi",
        platform: "win32-x64",
        nodeVersion: "24.14.0",
        sourceCommit,
        sourceState: "CLEAN",
        updateChannel: "developer-preview",
        installer: "PORTABLE_ZIP",
        signed: false,
        releaseId,
        productVersion,
        engineVersion: "0.84.1",
        engineReleaseId: "engine-release_pi-0.84.1",
        engineReleaseFingerprint: engineFingerprint,
        artifactFingerprint,
        artifactByteLength: artifactBytes.byteLength,
        versionDirectory: `versions/${releaseId}`,
        cliPackageFingerprint: `sha256:${"c".repeat(64)}`,
        productShellIntegrity,
        coreExtensionIntegrity,
        nodeRuntimeIntegrity: `sha256:${"f".repeat(64)}`,
      })}\n`,
    ),
  ]);
  await cp(installerPath, join(root, "install.ps1"));
  await writeReleaseFileManifest(root);
}

function runInstallerWith(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  scriptPath = installerPath,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
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

function runInstaller(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  scriptPath = installerPath,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  return runInstallerWith("powershell.exe", arguments_, environment, scriptPath);
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
      engine: { version: "0.84.1" },
      sourceState: "CLEAN",
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

    const prefixConflictRoot = join(installRoot, "bin-old");
    await mkdir(prefixConflictRoot, { recursive: true });
    await writeFile(join(prefixConflictRoot, "hpi.cmd"), "@echo sibling conflict\r\n", "utf8");
    const siblingConflict = runInstaller([...commonArguments, "-LocalSource", sourceA], {
      ...baseEnvironment,
      PATH: `${prefixConflictRoot};${stableBin};${baseEnvironment.PATH}`,
    });
    expect(siblingConflict.status, siblingConflict.stderr).toBe(0);
    expect(receiptFrom(siblingConflict.stdout)).toMatchObject({ conflictDetected: true });

    const unsafeOverwrite = runInstaller([...commonArguments, "-LocalSource", sourceB], {
      ...baseEnvironment,
      PATH: `${stableBin};${baseEnvironment.PATH}`,
    });
    expect(unsafeOverwrite.status).not.toBe(0);
    expect(`${unsafeOverwrite.stdout}\n${unsafeOverwrite.stderr}`).toMatch(/hpi update/iu);
    await expect(
      readFile(join(installRoot, "versions", "release_fixture-a", ".hpi-candidate.json")),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(installRoot, "versions", "release_fixture-b", ".hpi-candidate.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const redirectedBinTarget = join(root, "redirected-bin-target");
    await Promise.all([
      rm(stableBin, { force: true, recursive: true }),
      mkdir(redirectedBinTarget, { recursive: true }),
    ]);
    const junction = spawnSync(
      "cmd.exe",
      ["/d", "/c", "mklink", "/J", stableBin, redirectedBinTarget],
      { encoding: "utf8", windowsHide: true },
    );
    expect(junction.status, junction.stderr).toBe(0);
    const redirected = runInstaller([...commonArguments, "-LocalSource", sourceA], baseEnvironment);
    expect(redirected.status).not.toBe(0);
    expect(`${redirected.stdout}\n${redirected.stderr}`).toMatch(/physical|redirect/iu);
    await expect(readFile(join(redirectedBinTarget, "hpi.cmd"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("routes installer replay through the update manager after activation and accepts it after restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-replay-"));
    cleanupRoots.push(root);
    const sourceInitial = join(root, "source-initial");
    const sourceUpdate = join(root, "source-update");
    const installRoot = join(root, "install");
    await Promise.all([
      createReleaseFixture(sourceInitial, "release_fixture-replay-initial", "0.1.0-dev.1"),
      createReleaseFixture(sourceUpdate, "release_fixture-replay-update", "0.1.0-dev.2"),
    ]);
    const commonArguments = [
      "-Source",
      "LocalDirectory",
      "-LocalSource",
      sourceInitial,
      "-InstallRoot",
      installRoot,
      "-PathMode",
      "Process",
      "-Json",
    ] as const;
    const environment = { ...process.env, LOCALAPPDATA: join(root, "local-app-data") };
    const initialInstall = runInstaller(commonArguments, environment);
    expect(initialInstall.status, initialInstall.stderr).toBe(0);

    const initialCandidate = releaseCandidateSchema.parse(
      JSON.parse(
        await readFile(join(sourceInitial, "portable-release-candidate.json"), "utf8"),
      ) as unknown,
    );
    const updateBase = releaseCandidateSchema.parse(
      JSON.parse(
        await readFile(join(sourceUpdate, "portable-release-candidate.json"), "utf8"),
      ) as unknown,
    );
    const futureEngineFingerprint = `sha256:${"b".repeat(64)}` as const;
    const updateArtifact = createPortableBundle({
      releaseId: updateBase.releaseId,
      productVersion: updateBase.productVersion,
      engineReleaseId: "engine-release_pi-0.85.0",
      engineReleaseFingerprint: futureEngineFingerprint,
      sourceCommit: "a".repeat(40),
      files: [
        { path: "hpi.cmd", bytes: Buffer.from("@echo off\r\necho future release\r\n", "utf8") },
        { path: "node.exe", bytes: Buffer.from("future runtime\n", "utf8") },
      ],
    });
    const updateCandidate = releaseCandidateSchema.parse({
      ...updateBase,
      channel: "STABLE",
      artifact: {
        ...updateBase.artifact,
        fingerprint: `sha256:${createHash("sha256").update(updateArtifact).digest("hex")}`,
        byteLength: updateArtifact.byteLength,
      },
      engine: {
        releaseId: "engine-release_pi-0.85.0",
        fingerprint: futureEngineFingerprint,
        piVersion: "0.85.0",
      },
      qualification: {
        ...updateBase.qualification,
        verifierFingerprint: `sha256:${"c".repeat(64)}`,
      },
      updatePolicy: { piSelfUpdate: "ENABLED", unsigned: false },
      licenses: updateBase.licenses.map((license) =>
        license.name === "@earendil-works/pi-coding-agent"
          ? { ...license, version: "0.85.0" }
          : license,
      ),
    });
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: installRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const stagedUpdate = await adapter.stage(updateCandidate, updateArtifact);
    await adapter.activate(stagedUpdate);

    const afterApply = runInstaller(commonArguments, environment);
    expect(afterApply.status).not.toBe(0);
    expect(`${afterApply.stdout}\n${afterApply.stderr}`).toMatch(/hpi update/iu);

    await adapter.restore({ releaseId: initialCandidate.releaseId });
    const afterRollback = runInstaller(commonArguments, environment);
    expect(afterRollback.status, afterRollback.stderr).toBe(0);
    expect(receiptFrom(afterRollback.stdout)).toMatchObject({
      status: "ALREADY_INSTALLED",
      releaseId: "release_fixture-replay-initial",
    });
  }, 120_000);

  it("bootstraps an installed dev.1 release to a qualified dev.2 through the update manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-bootstrap-"));
    cleanupRoots.push(root);
    const sourceInitial = join(root, "source-initial");
    const sourceUpdate = join(root, "source-update");
    const installRoot = join(root, "install");
    await Promise.all([
      createReleaseFixture(
        sourceInitial,
        "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
        "0.1.0-dev.1",
        "d9f2d931b9fc42d23ceae60fada2aee811caf2ec",
      ),
      createReleaseFixture(
        sourceUpdate,
        "release_fixture-bootstrap-dev2",
        "0.1.0-dev.2",
        "b".repeat(40),
      ),
    ]);
    const dev1Identity = await markAsPublishedDev1Fixture(sourceInitial);
    await makeQualifiedBootstrapFixture(sourceUpdate, 12345);
    const fixtureInstaller = await createFixtureBoundInstaller(root, dev1Identity);
    const environment = { ...process.env, LOCALAPPDATA: join(root, "local-app-data") };
    const commonArguments = [
      "-Source",
      "LocalDirectory",
      "-InstallRoot",
      installRoot,
      "-PathMode",
      "Process",
      "-Json",
    ] as const;

    const initial = runInstaller([...commonArguments, "-LocalSource", sourceInitial], environment);
    expect(initial.status, initial.stderr).toBe(0);

    const update = runInstaller(
      [...commonArguments, "-LocalSource", sourceUpdate],
      environment,
      fixtureInstaller,
    );
    expect(update.status, update.stderr).toBe(0);
    expect(receiptFrom(update.stdout)).toMatchObject({
      status: "UPDATED",
      releaseId: "release_fixture-bootstrap-dev2",
      productVersion: "0.1.0-dev.2",
      existingHunterPiStateTouched: true,
    });
    expect(
      JSON.parse(await readFile(join(installRoot, ".hpi-update", "active.json"), "utf8")),
    ).toMatchObject({
      releaseId: "release_fixture-bootstrap-dev2",
      productVersion: "0.1.0-dev.2",
    });
    await expect(
      readFile(
        join(
          installRoot,
          "versions",
          "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
          ".hpi-candidate.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("0.1.0-dev.1");
    const bootstrapInvocation = JSON.parse(
      await readFile(join(installRoot, "bootstrap-invocation.json"), "utf8"),
    ) as { evidencePath?: unknown };
    expect(bootstrapInvocation.evidencePath).toEqual(
      expect.stringMatching(/HunterPiBootstrap-.+12345\.json$/u),
    );

    const replay = runInstaller(
      [...commonArguments, "-LocalSource", sourceUpdate],
      environment,
      fixtureInstaller,
    );
    expect(replay.status, replay.stderr).toBe(0);
    expect(receiptFrom(replay.stdout)).toMatchObject({
      status: "ALREADY_INSTALLED",
      releaseId: "release_fixture-bootstrap-dev2",
    });
  }, 120_000);

  it("restores dev.1 when PATH persistence fails after a bootstrap update", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-bootstrap-path-failure-"));
    cleanupRoots.push(root);
    const sourceInitial = join(root, "source-initial");
    const sourceUpdate = join(root, "source-update");
    const installRoot = join(root, "install");
    await Promise.all([
      createReleaseFixture(
        sourceInitial,
        "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
        "0.1.0-dev.1",
        "d9f2d931b9fc42d23ceae60fada2aee811caf2ec",
      ),
      createReleaseFixture(
        sourceUpdate,
        "release_fixture-bootstrap-path-dev2",
        "0.1.0-dev.2",
        "b".repeat(40),
      ),
    ]);
    const dev1Identity = await markAsPublishedDev1Fixture(sourceInitial);
    await makeQualifiedBootstrapFixture(sourceUpdate, 23456);
    const fixtureInstaller = await createFixtureBoundInstaller(root, dev1Identity);
    const environment = { ...process.env, LOCALAPPDATA: join(root, "local-app-data") };
    const initial = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        sourceInitial,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      environment,
      fixtureInstaller,
    );
    expect(initial.status, initial.stderr).toBe(0);

    const update = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        sourceUpdate,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "User",
        "-Json",
      ],
      { ...environment, HUNTER_PI_INSTALL_TEST_FAIL_USER_PATH_WRITE: "1" },
      fixtureInstaller,
    );
    expect(update.status).not.toBe(0);
    expect(`${update.stdout}\n${update.stderr}`).toMatch(/PATH write failure/iu);
    expect(
      JSON.parse(await readFile(join(installRoot, ".hpi-update", "active.json"), "utf8")),
    ).toMatchObject({
      releaseId: "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
      productVersion: "0.1.0-dev.1",
    });
  }, 120_000);

  it("rejects bootstrap when published dev.1 qualification Evidence is missing", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "hunter-pi-installer-bootstrap-missing-dev1-evidence-"),
    );
    cleanupRoots.push(root);
    const sourceInitial = join(root, "source-initial");
    const sourceUpdate = join(root, "source-update");
    const installRoot = join(root, "install");
    await Promise.all([
      createReleaseFixture(
        sourceInitial,
        "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc",
        "0.1.0-dev.1",
        "d9f2d931b9fc42d23ceae60fada2aee811caf2ec",
      ),
      createReleaseFixture(
        sourceUpdate,
        "release_fixture-bootstrap-missing-dev1-evidence-dev2",
        "0.1.0-dev.2",
        "b".repeat(40),
      ),
    ]);
    const [dev1Identity] = await Promise.all([
      markAsPublishedDev1Fixture(sourceInitial),
      makeQualifiedBootstrapFixture(sourceUpdate, 34567),
    ]);
    const fixtureInstaller = await createFixtureBoundInstaller(root, dev1Identity);
    const environment = { ...process.env, LOCALAPPDATA: join(root, "local-app-data") };
    const initial = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        sourceInitial,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      environment,
      fixtureInstaller,
    );
    expect(initial.status, initial.stderr).toBe(0);
    await rm(join(installRoot, ".hpi-update", "qualification-evidence"), {
      recursive: true,
      force: true,
    });

    const update = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        sourceUpdate,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      environment,
      fixtureInstaller,
    );
    expect(update.status).not.toBe(0);
    expect(`${update.stdout}\n${update.stderr}`).toMatch(/qualification Evidence is missing/iu);
    expect(
      JSON.parse(await readFile(join(installRoot, ".hpi-update", "active.json"), "utf8")),
    ).toMatchObject({ releaseId: "release_hunter-pi-0.1.0-dev.1-d9f2d931b9fc" });
    await cp(
      join(sourceInitial, ".hpi-update", "qualification-evidence"),
      join(installRoot, ".hpi-update", "qualification-evidence"),
      { recursive: true },
    );
    await rm(join(installRoot, ".hpi-update", "manager", "journal"), {
      recursive: true,
      force: true,
    });
    const missingJournal = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        sourceUpdate,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "Process",
        "-Json",
      ],
      environment,
      fixtureInstaller,
    );
    expect(missingJournal.status).not.toBe(0);
    expect(`${missingJournal.stdout}\n${missingJournal.stderr}`).toMatch(
      /qualification journal receipt is\s+missing/iu,
    );
  }, 120_000);

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

  it("preserves ISO timestamp strings when invoked by PowerShell 7", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-pwsh7-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    await createReleaseFixture(source, "release_fixture-pwsh7", "0.1.0-dev.1");

    const result = runInstallerWith(
      "pwsh.exe",
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
    expect(result.status, result.stderr).toBe(0);
    expect(receiptFrom(result.stdout)).toMatchObject({
      status: "INSTALLED",
      releaseId: "release_fixture-pwsh7",
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

  it("rejects incomplete or wrong-Pi release identities before installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-identity-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    await createReleaseFixture(source, "release_fixture-identity", "0.1.0-dev.1");
    const rootCandidatePath = join(source, "portable-release-candidate.json");
    const versionCandidatePath = join(
      source,
      "versions",
      "release_fixture-identity",
      ".hpi-candidate.json",
    );
    const candidate = JSON.parse(await readFile(rootCandidatePath, "utf8")) as Record<
      string,
      unknown
    >;
    const invalidCandidate = { ...candidate, undeclaredField: true };
    await Promise.all([
      writeFile(rootCandidatePath, JSON.stringify(invalidCandidate), "utf8"),
      writeFile(versionCandidatePath, JSON.stringify(invalidCandidate), "utf8"),
    ]);
    await writeReleaseFileManifest(source);

    const incomplete = runInstaller(
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
    expect(incomplete.status).not.toBe(0);
    expect(`${incomplete.stdout}\n${incomplete.stderr}`).toMatch(/schema|properties|candidate/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await createReleaseFixture(source, "release_fixture-identity", "0.1.0-dev.1");
    const portablePath = join(source, "portable-manifest.json");
    const wrongPiPortable = JSON.parse(await readFile(portablePath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(portablePath, JSON.stringify({ ...wrongPiPortable, engineVersion: "0.83.0" }));
    await writeReleaseFileManifest(source);
    const wrongPi = runInstaller(
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
    expect(wrongPi.status).not.toBe(0);
    expect(`${wrongPi.stdout}\n${wrongPi.stderr}`).toMatch(/Pi|Engine|identity/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rejects candidate property casing and scalar values where JSON arrays are required", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-strict-json-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    const releaseId = "release_fixture-strict-json";
    const candidatePaths = [
      join(source, "portable-release-candidate.json"),
      join(source, "versions", releaseId, ".hpi-candidate.json"),
    ];
    await createReleaseFixture(source, releaseId, "0.1.0-dev.1");
    const candidate = JSON.parse(await readFile(candidatePaths[0] ?? "", "utf8")) as Record<
      string,
      unknown
    >;
    const { schemaVersion, ...candidateWithoutSchemaVersion } = candidate;
    const wrongCase = { ...candidateWithoutSchemaVersion, SchemaVersion: schemaVersion };
    await Promise.all(candidatePaths.map((path) => writeFile(path, JSON.stringify(wrongCase))));
    await writeReleaseFileManifest(source);
    const caseResult = runInstaller(
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
    expect(caseResult.status).not.toBe(0);
    expect(`${caseResult.stdout}\n${caseResult.stderr}`).toMatch(/schema|property/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await createReleaseFixture(source, releaseId, "0.1.0-dev.1");
    const scalarCandidate = JSON.parse(await readFile(candidatePaths[0] ?? "", "utf8")) as {
      qualification: { checks: unknown[] };
    };
    scalarCandidate.qualification.checks = scalarCandidate.qualification.checks[0] as never;
    await Promise.all(
      candidatePaths.map((path) => writeFile(path, JSON.stringify(scalarCandidate))),
    );
    await writeReleaseFileManifest(source);
    const scalarResult = runInstaller(
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
    expect(scalarResult.status).not.toBe(0);
    expect(`${scalarResult.stdout}\n${scalarResult.stderr}`).toMatch(/JSON array/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await createReleaseFixture(source, releaseId, "0.1.0-dev.1");
    const enumCandidate = JSON.parse(await readFile(candidatePaths[0] ?? "", "utf8")) as {
      qualification: {
        status: string;
        checks: { outcome: string; evidenceIds: string[] }[];
      };
    };
    enumCandidate.qualification.status = "pass";
    const firstCheck = enumCandidate.qualification.checks[0];
    if (firstCheck === undefined) throw new Error("strict candidate fixture lacks a check");
    enumCandidate.qualification.checks[0] = {
      ...firstCheck,
      outcome: "pass",
      evidenceIds: ["not-an-evidence-id"],
    };
    await Promise.all(candidatePaths.map((path) => writeFile(path, JSON.stringify(enumCandidate))));
    await writeReleaseFileManifest(source);
    const enumResult = runInstaller(
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
    expect(enumResult.status).not.toBe(0);
    expect(`${enumResult.stdout}\n${enumResult.stderr}`).toMatch(/status|outcome|Evidence/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const invalidLicenses = [
      { name: "Third Party", version: "garbage", license: "MIT", sourceReference: "NOTICE.md" },
      { name: " padded ", version: "1.0.0", license: "MIT", sourceReference: "NOTICE.md" },
      {
        name: "Third Party",
        version: "1.0.0",
        license: "x".repeat(4_097),
        sourceReference: "NOTICE.md",
      },
    ];
    for (const [index, invalidLicense] of invalidLicenses.entries()) {
      await createReleaseFixture(source, releaseId, "0.1.0-dev.1");
      const licenseCandidate = JSON.parse(await readFile(candidatePaths[0] ?? "", "utf8")) as {
        licenses: typeof invalidLicenses;
      };
      licenseCandidate.licenses.push(invalidLicense);
      await Promise.all(
        candidatePaths.map((path) => writeFile(path, JSON.stringify(licenseCandidate))),
      );
      await writeReleaseFileManifest(source);
      const licenseResult = runInstaller(
        [
          "-Source",
          "LocalDirectory",
          "-LocalSource",
          source,
          "-InstallRoot",
          `${installRoot}-${String(index)}`,
          "-PathMode",
          "Process",
          "-Json",
        ],
        { ...process.env, LOCALAPPDATA: join(root, "local-app-data") },
      );
      expect(licenseResult.status).not.toBe(0);
      expect(`${licenseResult.stdout}\n${licenseResult.stderr}`.replaceAll(/\s+/gu, "")).toMatch(
        /license|version/iu,
      );
    }
  }, 120_000);

  it("rolls back a newly published installation even when user PATH writes fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-path-failure-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    await createReleaseFixture(source, "release_fixture-path-failure", "0.1.0-dev.1");
    const result = runInstaller(
      [
        "-Source",
        "LocalDirectory",
        "-LocalSource",
        source,
        "-InstallRoot",
        installRoot,
        "-PathMode",
        "User",
        "-Json",
      ],
      {
        ...process.env,
        HUNTER_PI_INSTALL_TEST_FAIL_USER_PATH_WRITE: "1",
        LOCALAPPDATA: join(root, "local-app-data"),
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/PATH write failure/iu);
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("directs an existing legacy portable install to the update manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-legacy-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    await Promise.all([
      createReleaseFixture(source, "release_fixture-current", "0.1.0-dev.1"),
      createReleaseFixture(installRoot, "release_fixture-legacy", "0.1.0-dev.0"),
    ]);
    await writeFile(
      join(installRoot, "portable-manifest.json"),
      JSON.stringify({ schemaVersion: "hpi-windows-portable.v2" }),
      "utf8",
    );
    const result = runInstaller(
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
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/hpi update apply/iu);
  }, 60_000);

  it("does not publish an installation whose staged command fails its health probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-installer-health-"));
    cleanupRoots.push(root);
    const source = join(root, "source");
    const installRoot = join(root, "install");
    await createReleaseFixture(source, "release_fixture-health", "0.1.0-dev.1");
    await writeFile(join(source, "hpi.cmd"), "@echo off\r\nexit /b 9\r\n", "utf8");
    await writeReleaseFileManifest(source);

    const result = runInstaller(
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
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`.replaceAll(/\s+/gu, "")).toMatch(
      /versionprobe|health/iu,
    );
    await expect(readdir(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("builds a release manifest for a portable tree larger than the Windows handle limit", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const portableRoot = join(repositoryRoot, ".artifacts", `installer-large-${suffix}`);
    const outputRoot = join(repositoryRoot, ".artifacts", `installer-large-output-${suffix}`);
    cleanupRoots.push(portableRoot, outputRoot);
    await createReleaseFixture(portableRoot, "release_fixture-large", "0.1.0-dev.1");
    const bulkRoot = join(portableRoot, "bulk");
    await mkdir(bulkRoot, { recursive: true });
    for (let start = 0; start < 8_300; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 8_300 - start) }, (_, offset) =>
          writeFile(join(bulkRoot, `entry-${String(start + offset)}.txt`), "bounded\n", "utf8"),
        ),
      );
    }

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
  }, 120_000);

  it("rejects a case-aliased output without deleting the portable input", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const directoryName = `Installer-Case-${suffix}`;
    const portableRoot = join(repositoryRoot, ".artifacts", directoryName);
    const aliasedOutput = join(repositoryRoot, ".artifacts", directoryName.toLowerCase());
    cleanupRoots.push(portableRoot);
    await createReleaseFixture(portableRoot, "release_fixture-case", "0.1.0-dev.1");

    const build = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "create-windows-release-assets.mjs"),
        "--portable-root",
        portableRoot,
        "--output",
        aliasedOutput,
      ],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
    );
    expect(build.status).not.toBe(0);
    expect(build.stderr).toMatch(/output must differ/iu);
    await expect(readFile(join(portableRoot, "portable-manifest.json"), "utf8")).resolves.toContain(
      "hpi-windows-portable.v3",
    );

    const shortPathResult = spawnSync(
      "cmd.exe",
      ["/d", "/c", "for %I in (%HPI_TEST_LONG_PATH%) do @echo %~sI"],
      {
        encoding: "utf8",
        env: { ...process.env, HPI_TEST_LONG_PATH: portableRoot },
        windowsHide: true,
      },
    );
    expect(shortPathResult.status, shortPathResult.stderr).toBe(0);
    const shortPath = shortPathResult.stdout.trim();
    if (shortPath.length > 0 && shortPath.toLowerCase() !== portableRoot.toLowerCase()) {
      const shortAlias = join(repositoryRoot, ".artifacts", basename(shortPath));
      const shortAliasBuild = spawnSync(
        process.execPath,
        [
          join(repositoryRoot, "scripts", "create-windows-release-assets.mjs"),
          "--portable-root",
          portableRoot,
          "--output",
          shortAlias,
        ],
        { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
      );
      expect(shortAliasBuild.status).not.toBe(0);
      expect(shortAliasBuild.stderr).toMatch(/output must differ/iu);
      await expect(
        readFile(join(portableRoot, "portable-manifest.json"), "utf8"),
      ).resolves.toContain("hpi-windows-portable.v3");
    }
  });
});
