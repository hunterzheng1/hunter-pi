import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const portablePackerSource = await readFile(
  resolve(import.meta.dirname, "..", "scripts", "pack-windows-portable.mjs"),
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
    expect(hostedVersionFiles).toEqual(Array.from({ length: 4 }, () => ".node-version"));
    expect(ciWorkflowSource).not.toMatch(/^\s*node-version:\s*/gmu);
  });

  it("uploads the complete portable installation including hidden update state", () => {
    expect(ciWorkflowSource).toMatch(
      /- name: Upload Windows x64 portable update artifact[\s\S]*?name: hpi-windows-x64-portable[\s\S]*?include-hidden-files: true/u,
    );
  });
});
