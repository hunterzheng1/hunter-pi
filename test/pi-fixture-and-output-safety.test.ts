import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIsolatedFixtureGitEnvironment,
  createPiProbeFixtureWithGitRunner,
} from "../packages/pi-host/src/fixture.js";
import { preparePiProbeOutput } from "../tools/pi-public-interface-probe.js";

describe("Pi probe fixture and output safety", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("does not inherit Git redirectors, credential variables, or arbitrary environment", () => {
    const environment = createIsolatedFixtureGitEnvironment("C:/fixture", {
      GIT_DIR: "C:/outside",
      GIT_CONFIG_COUNT: "1",
      GITHUB_TOKEN: "fixture-secret",
      PATH: "C:/safe-bin",
      SystemRoot: "C:/Windows",
    });

    expect(environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "C:/fixture",
      PATH: "C:/safe-bin",
      USERPROFILE: "C:/fixture",
    });
    expect(environment).not.toHaveProperty("GIT_DIR");
    expect(environment).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("rejects an existing multi-link Evidence output target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-output-safety-"));
    temporaryRoots.push(root);
    const outputRoot = join(root, ".artifacts", "pi-probe");
    await mkdir(outputRoot, { recursive: true });
    const source = join(root, "outside.json");
    const target = join(outputRoot, "windows.json");
    await writeFile(source, "{}\n", "utf8");
    await link(source, target);

    await expect(preparePiProbeOutput(root, target)).rejects.toThrow(/single-link/u);
  });

  it("never replaces an existing regular Evidence file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-output-existing-"));
    temporaryRoots.push(root);
    const outputRoot = join(root, ".artifacts", "pi-probe");
    const target = join(outputRoot, "windows.json");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(target, "preserve-me\n", "utf8");

    await expect(preparePiProbeOutput(root, target)).rejects.toThrow(/must not already exist/u);
  });

  it("rejects an approved Evidence directory redirected by a junction or symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-output-redirect-"));
    temporaryRoots.push(root);
    const artifactRoot = join(root, ".artifacts");
    const redirectedRoot = join(root, "packages", "victim");
    await Promise.all([
      mkdir(artifactRoot, { recursive: true }),
      mkdir(redirectedRoot, { recursive: true }),
    ]);
    await symlink(
      redirectedRoot,
      join(artifactRoot, "pi-probe"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      preparePiProbeOutput(root, join(artifactRoot, "pi-probe", "package.json")),
    ).rejects.toThrow(/links or reparse redirects/u);
  });

  it("removes an owned fixture when Git initialization fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-pi-fixture-failure-parent-"));
    temporaryRoots.push(parent);

    await expect(
      createPiProbeFixtureWithGitRunner(parent, () => {
        throw new Error("injected Git failure");
      }),
    ).rejects.toThrow(/injected Git failure/u);
    await expect(readdir(parent)).resolves.toEqual([]);
  });
});
