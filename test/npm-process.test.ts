import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createNpmDiagnosticRoots,
  createIsolatedNpmEnvironment,
  runNpm,
  shouldRetryNpmFailure,
  summarizeNpmFailure,
  summarizeProcessFailure,
} from "../scripts/npm-process.mjs";

describe("isolated npm process support", () => {
  it("maps process-owned paths to stable diagnostic labels", () => {
    const roots = createNpmDiagnosticRoots(
      {
        APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
        TEMP: "C:\\Users\\fixture\\Temp",
        USERPROFILE: "C:\\Users\\fixture",
      },
      "C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js",
      "C:\\runtime\\node.exe",
    );

    expect(roots).toEqual({
      appdata: "C:\\Users\\fixture\\AppData\\Roaming",
      localappdata: "C:\\Users\\fixture\\AppData\\Local",
      "node-runtime": "C:\\runtime",
      "npm-runtime": "C:\\runtime\\node_modules\\npm",
      temp: "C:\\Users\\fixture\\Temp",
      userprofile: "C:\\Users\\fixture",
    });
  });

  it("removes inherited npm configuration and credential variables", () => {
    const sourceEnvironment: NodeJS.ProcessEnv = {
      PATH: "safe-path",
      npm_execpath: "npm-entry.js",
      NPM_CONFIG_REGISTRY: "https://user:password@private.example.test/",
      npm_config_cache: "C:\\Users\\private-user\\npm-cache",
      NODE_AUTH_TOKEN: "do-not-inherit",
      NPM_TOKEN: "do-not-inherit-either",
      TEMP: "C:\\Users\\PRIVATE~1\\Temp",
      tmpdir: "C:\\Users\\private-user\\Temp",
    };

    const isolated = createIsolatedNpmEnvironment(sourceEnvironment, "isolated-npm-root");

    expect(isolated).toMatchObject({
      PATH: "safe-path",
      npm_execpath: "npm-entry.js",
      NPM_CONFIG_CACHE: join("isolated-npm-root", "cache"),
      NPM_CONFIG_GLOBALCONFIG: join("isolated-npm-root", "global.npmrc"),
      NPM_CONFIG_USERCONFIG: join("isolated-npm-root", "user.npmrc"),
      TEMP: join("isolated-npm-root", "tmp"),
      TMP: join("isolated-npm-root", "tmp"),
      TMPDIR: join("isolated-npm-root", "tmp"),
    });
    expect(isolated).not.toHaveProperty("NPM_CONFIG_REGISTRY");
    expect(isolated).not.toHaveProperty("npm_config_cache");
    expect(isolated).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(isolated).not.toHaveProperty("NPM_TOKEN");
    expect(isolated).not.toHaveProperty("tmpdir");
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
    const summary = summarizeNpmFailure(
      {
        status: 4_294_963_238,
        stderr: [
          "npm error code ENOENT",
          "npm error syscall lstat",
          "npm error path C:\\Users\\private-user\\Temp\\npm-isolation\\cache\\missing",
          "npm error errno -4058",
        ].join("\n"),
        stdout: "",
      },
      {
        cwd: "C:\\work\\consumer",
        isolationRoot: "C:\\Users\\private-user\\Temp\\npm-isolation",
        knownRoots: {
          archives: "C:\\work\\archives",
          repository: "C:\\work\\repository",
        },
      },
    );

    expect(summary).toMatch(
      /^npm CLI failed \(status 4294963238, npmCode ENOENT, syscall lstat, errno -4058, pathScope npm-cache, outputBytes \d+, outputSha256 [a-f0-9]{64}\)\.$/u,
    );
    expect(summary).not.toContain("AppData");
    expect(summary).not.toContain("private-user");
  });

  it("retries one exact npm install transport interruption and nothing broader", () => {
    const transportFailure = {
      status: 4_294_963_219,
      stderr: "npm error code ECONNRESET\nnpm error syscall read\nnpm error errno -4077",
      stdout: "",
    };

    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        transportFailure,
        1,
      ),
    ).toBe(true);
    expect(shouldRetryNpmFailure(["install", "--ignore-scripts"], transportFailure, 2)).toBe(false);
    expect(shouldRetryNpmFailure(["install"], transportFailure, 1)).toBe(false);
    expect(shouldRetryNpmFailure(["pack", "."], transportFailure, 1)).toBe(false);
    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts"],
        { status: 1, stderr: "npm error code E429", stdout: "" },
        1,
      ),
    ).toBe(false);
    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts"],
        { status: 1, stderr: "npm error code EACCES", stdout: "" },
        1,
      ),
    ).toBe(false);
    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts"],
        {
          status: 1,
          stderr: "npm error code ECONNRESET\nnpm error code E429",
          stdout: "",
        },
        1,
      ),
    ).toBe(false);
    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts"],
        {
          status: 1,
          stderr: "npm error code EACCES",
          stdout: "npm error code ECONNRESET",
        },
        1,
      ),
    ).toBe(false);
    expect(
      shouldRetryNpmFailure(
        ["install", "--ignore-scripts"],
        {
          status: 1,
          stderr: "npm error code ECONNRESET",
          stdout: "npm error code E429",
        },
        1,
      ),
    ).toBe(false);
  });

  it("preserves a redacted first failure and returns the single retry result", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-pi-npm-retry-test-"));
    const fakeNpmEntryPoint = join(root, "fake-npm.mjs");
    const marker = join(root, "attempted");
    const originalNpmEntryPoint = process.env["npm_execpath"];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await writeFile(
        fakeNpmEntryPoint,
        [
          'import { existsSync, writeFileSync } from "node:fs";',
          `const marker = ${JSON.stringify(marker)};`,
          "if (!existsSync(marker)) {",
          '  writeFileSync(marker, "first", "utf8");',
          '  process.stderr.write("npm error code ECONNRESET\\nnpm error syscall read\\n");',
          "  process.exit(1);",
          "}",
          'process.stdout.write("retry-succeeded\\n");',
        ].join("\n"),
        "utf8",
      );
      process.env["npm_execpath"] = fakeNpmEntryPoint;

      expect(runNpm(["install", "--ignore-scripts"], root, join(root, "npm"))).toBe(
        "retry-succeeded\n",
      );
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(
        /^Preserved transient npm failure; retrying once\. npm CLI failed \(status 1, npmCode ECONNRESET, syscall read, outputBytes \d+, outputSha256 [a-f0-9]{64}\)\.\n$/u,
      );
    } finally {
      stderr.mockRestore();
      if (originalNpmEntryPoint === undefined) delete process.env["npm_execpath"];
      else process.env["npm_execpath"] = originalNpmEntryPoint;
      await rm(root, { force: true, recursive: true });
    }
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
