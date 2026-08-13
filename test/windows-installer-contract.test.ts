import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Windows release installer contract", () => {
  it("ships one maintained installer source for local and exact-version GitHub installs", async () => {
    const [installerBytes, assetBuilder, cliPackage, readme, userGuide] = await Promise.all([
      readFile(resolve(repositoryRoot, "scripts", "install.ps1")),
      readFile(resolve(repositoryRoot, "scripts", "create-windows-release-assets.mjs"), "utf8"),
      readFile(resolve(repositoryRoot, "apps", "cli", "package.json"), "utf8"),
      readFile(resolve(repositoryRoot, "README.md"), "utf8"),
      readFile(resolve(repositoryRoot, "docs", "user-guide.md"), "utf8"),
    ]);
    const installer = installerBytes.toString("utf8");
    const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");

    expect(JSON.parse(cliPackage)).toMatchObject({ version: "0.1.0-dev.2" });
    expect(installer).toMatch(/\[string\]\$ReleaseTag\s*=\s*"v0\.1\.0-dev\.2"/u);
    expect(installer).not.toContain("$DefaultReleaseTag");
    expect(installer).toContain("releases/download/$ReleaseTag/hpi-windows-x64.zip");
    expect(installer).toContain("releases/download/$ReleaseTag/hpi-windows-x64.zip.sha256");
    expect(installer).toContain("function Invoke-HpiDownload");
    expect(installer).toContain("InitialHost=$($parsedUri.Host) FailedHost=$failedHost");
    expect(installer).toContain(
      "TLS trust, HTTPS inspection proxy, and access to the reported hosts",
    );
    expect(installer).toContain("Do not disable certificate validation");
    expect(installer).toContain('ValidateSet("Auto", "Remote", "LocalDirectory", "LocalArchive")');
    expect(assetBuilder).toContain('join(repositoryRoot, "scripts", "install.ps1")');
    expect(assetBuilder).toContain('"hpi-windows-x64.zip"');
    expect(assetBuilder).toContain('"hpi-windows-x64.zip.sha256"');
    expect(assetBuilder).toContain('join(outputRoot, "portable-release-candidate.json")');
    expect(assetBuilder).toContain('join(outputRoot, "update.bundle.tgz")');
    expect(assetBuilder).toContain(
      'join(outputRoot, "windows-portable-qualification-evidence.json")',
    );
    expect(assetBuilder).toContain('candidate.qualification.status === "PASS"');
    expect(readme).toContain(installerSha256);
    expect(userGuide).toContain(installerSha256);
  });

  it("publishes and exercises the release assets in hosted Windows CI", async () => {
    const workflow = await readFile(
      resolve(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/Build Windows release ZIP and checksum/u);
    expect(workflow).toMatch(/Run isolated Windows installer end-to-end/u);
    expect(workflow).toMatch(
      /windows-portable:\s*\n\s*name: Windows x64 portable artifact[\s\S]*?timeout-minutes: 45/u,
    );
    expect(workflow).toContain("$output = @(& .artifacts/hpi-windows-x64-release/install.ps1");
    expect(workflow).toContain("-PathMode User");
    expect(workflow).toContain('[Environment]::GetEnvironmentVariable("Path", "User")');
    expect(workflow).toMatch(
      /name: hpi-windows-x64-release[\s\S]*?hpi-windows-x64\.zip[\s\S]*?hpi-windows-x64\.zip\.sha256[\s\S]*?install\.ps1/u,
    );
    expect(workflow).toContain("hunter-pi-cli-0.1.0-dev.2.tgz");
  });
});
