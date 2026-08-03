import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createIsolatedNpmEnvironment,
  summarizeNpmFailure,
  summarizeProcessFailure,
} from "../scripts/npm-process.mjs";

describe("isolated npm process support", () => {
  it("removes inherited npm configuration and credential variables", () => {
    const sourceEnvironment: NodeJS.ProcessEnv = {
      PATH: "safe-path",
      npm_execpath: "npm-entry.js",
      NPM_CONFIG_REGISTRY: "https://user:password@private.example.test/",
      npm_config_cache: "C:\\Users\\private-user\\npm-cache",
      NODE_AUTH_TOKEN: "do-not-inherit",
      NPM_TOKEN: "do-not-inherit-either",
    };

    const isolated = createIsolatedNpmEnvironment(sourceEnvironment, "isolated-npm-root");

    expect(isolated).toMatchObject({
      PATH: "safe-path",
      npm_execpath: "npm-entry.js",
      NPM_CONFIG_CACHE: join("isolated-npm-root", "cache"),
      NPM_CONFIG_GLOBALCONFIG: join("isolated-npm-root", "global.npmrc"),
      NPM_CONFIG_USERCONFIG: join("isolated-npm-root", "user.npmrc"),
    });
    expect(isolated).not.toHaveProperty("NPM_CONFIG_REGISTRY");
    expect(isolated).not.toHaveProperty("npm_config_cache");
    expect(isolated).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(isolated).not.toHaveProperty("NPM_TOKEN");
    expect(sourceEnvironment).toHaveProperty("NODE_AUTH_TOKEN", "do-not-inherit");
  });

  it("summarizes failed output without returning tokens or user paths", () => {
    const summary = summarizeNpmFailure({
      status: 1,
      stderr: "authorization: Bearer secret-value C:\\Users\\private-user\\.npmrc",
      stdout: "registry token=another-secret",
    });

    expect(summary).toMatch(
      /^npm CLI failed \(status 1, outputBytes \d+, outputSha256 [a-f0-9]{64}\)\.$/u,
    );
    expect(summary.length).toBeLessThan(160);
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("another-secret");
    expect(summary).not.toContain("private-user");
  });

  it("retains allowlisted npm failure metadata but drops its path", () => {
    const summary = summarizeNpmFailure({
      status: 4_294_963_238,
      stderr: [
        "npm error code ENOENT",
        "npm error syscall lstat",
        "npm error path C:\\Users\\private-user\\AppData\\Roaming\\npm",
        "npm error errno -4058",
      ].join("\n"),
      stdout: "",
    });

    expect(summary).toMatch(
      /^npm CLI failed \(status 4294963238, npmCode ENOENT, syscall lstat, errno -4058, outputBytes \d+, outputSha256 [a-f0-9]{64}\)\.$/u,
    );
    expect(summary).not.toContain("AppData");
    expect(summary).not.toContain("private-user");
  });

  it("summarizes a package import failure without returning captured output", () => {
    const summary = summarizeProcessFailure("Package import probe", {
      status: 1,
      stderr: "authorization: Bearer secret-value C:\\Users\\private-user\\Temp\\probe.mjs",
      stdout: "private prompt content",
    });

    expect(summary).toMatch(
      /^Package import probe failed \(status 1, outputBytes \d+, outputSha256 [a-f0-9]{64}\)\.$/u,
    );
    expect(summary.length).toBeLessThan(180);
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("private-user");
    expect(summary).not.toContain("private prompt");
  });
});
