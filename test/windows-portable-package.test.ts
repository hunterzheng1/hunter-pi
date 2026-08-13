import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const portablePackerSource = await readFile(
  resolve(import.meta.dirname, "..", "scripts", "pack-windows-portable.mjs"),
  "utf8",
);
const installerSource = await readFile(
  resolve(import.meta.dirname, "..", "scripts", "install.ps1"),
  "utf8",
);
const installerBytes = await readFile(resolve(import.meta.dirname, "..", "scripts", "install.ps1"));
const readmeSource = await readFile(resolve(import.meta.dirname, "..", "README.md"), "utf8");
const userGuideSource = await readFile(
  resolve(import.meta.dirname, "..", "docs", "user-guide.md"),
  "utf8",
);
const ciWorkflowSource = await readFile(
  resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);
const portableNodeVersion = (
  await readFile(resolve(import.meta.dirname, "..", ".node-version"), "utf8")
).trim();
const nvmNodeVersion = (
  await readFile(resolve(import.meta.dirname, "..", ".nvmrc"), "utf8")
).trim();

describe("Windows portable package launcher", () => {
  it("preserves the operator working directory when launching the packaged CLI", () => {
    expect(portablePackerSource).toContain('"  cwd: process.cwd(),",');
    expect(portablePackerSource).not.toContain('"  cwd: versionDirectory,",');
  });

  it("pins the exact Windows portable Node runtime in both the packer and hosted CI", () => {
    const hostedVersionFiles = [
      ...ciWorkflowSource.matchAll(/^\s*node-version-file:\s*(\S+)\s*$/gmu),
    ].map((match) => match[1]);

    expect(portableNodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(nvmNodeVersion).toBe(portableNodeVersion);
    expect(portablePackerSource).toContain(
      'await readFile(join(repositoryRoot, ".node-version"), "utf8")',
    );
    expect(portablePackerSource).toContain("process.versions.node !== windowsPortableNodeVersion");
    expect(hostedVersionFiles.length).toBeGreaterThanOrEqual(4);
    expect(hostedVersionFiles).toEqual(
      Array.from({ length: hostedVersionFiles.length }, () => ".node-version"),
    );
    expect(ciWorkflowSource).not.toMatch(/^\s*node-version:\s*/gmu);
  });

  it("uploads the complete portable installation including hidden update state", () => {
    expect(ciWorkflowSource).toMatch(
      /- name: Upload Windows x64 portable update artifact[\s\S]*?name: hpi-windows-x64-portable[\s\S]*?include-hidden-files: true/u,
    );
  });

  it("runs bootstrap updates through the incoming version CLI without the root launcher", () => {
    expect(installerSource).toContain('"node_modules\\@hunter-pi\\cli\\dist\\hpi.js"');
    expect(installerSource).not.toContain("& $nodePath $launcherPath @Arguments");
    expect(installerSource).toContain("$env:HUNTER_PI_PORTABLE_ROOT = $TargetRoot");
  });

  it("binds every recommended dev.2 installer command to the exact published script bytes", () => {
    const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
    expect(readmeSource).toContain(installerSha256);
    expect(userGuideSource).toContain(installerSha256);
  });
});
