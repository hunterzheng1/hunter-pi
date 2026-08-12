import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("Windows release installer contract", () => {
  it("ships one maintained installer source for local and exact-version GitHub installs", async () => {
    const [installer, assetBuilder, cliPackage] = await Promise.all([
      readFile(resolve(repositoryRoot, "scripts", "install.ps1"), "utf8"),
      readFile(resolve(repositoryRoot, "scripts", "create-windows-release-assets.mjs"), "utf8"),
      readFile(resolve(repositoryRoot, "apps", "cli", "package.json"), "utf8"),
    ]);

    expect(JSON.parse(cliPackage)).toMatchObject({ version: "0.1.0-dev.1" });
    expect(installer).toContain('DefaultReleaseTag = "v0.1.0-dev.1"');
    expect(installer).toContain("releases/download/$ReleaseTag/hpi-windows-x64.zip");
    expect(installer).toContain("releases/download/$ReleaseTag/hpi-windows-x64.zip.sha256");
    expect(installer).toContain('ValidateSet("Auto", "Remote", "LocalDirectory", "LocalArchive")');
    expect(assetBuilder).toContain('join(repositoryRoot, "scripts", "install.ps1")');
    expect(assetBuilder).toContain('"hpi-windows-x64.zip"');
    expect(assetBuilder).toContain('"hpi-windows-x64.zip.sha256"');
  });

  it("publishes and exercises the release assets in hosted Windows CI", async () => {
    const workflow = await readFile(
      resolve(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/Build Windows release ZIP and checksum/u);
    expect(workflow).toMatch(/Run isolated Windows installer end-to-end/u);
    expect(workflow).toMatch(
      /name: hpi-windows-x64-release[\s\S]*?hpi-windows-x64\.zip[\s\S]*?hpi-windows-x64\.zip\.sha256[\s\S]*?install\.ps1/u,
    );
  });
});
