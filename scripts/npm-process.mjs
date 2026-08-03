import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const credentialEnvironmentKeys = new Set(["node_auth_token", "npm_auth_token", "npm_token"]);
export const subprocessOutputLimitBytes = 1024 * 1024;

/**
 * @param {NodeJS.ProcessEnv} environment inherited process environment.
 * @param {string} isolationRoot npm-only configuration and cache root.
 * @returns {NodeJS.ProcessEnv} a copy with user npm state and credentials removed.
 */
export const createIsolatedNpmEnvironment = (environment, isolationRoot) => {
  /** @type {NodeJS.ProcessEnv} */
  const isolated = {};

  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("npm_config_") || credentialEnvironmentKeys.has(normalizedKey)) {
      continue;
    }

    isolated[key] = value;
  }

  return {
    ...isolated,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(isolationRoot, "cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: join(isolationRoot, "global.npmrc"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: join(isolationRoot, "user.npmrc"),
  };
};

/**
 * @param {string} label stable process label.
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure process failure details.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
export const summarizeProcessFailure = (label, failure) => {
  const output = `${failure.stdout}\n${failure.stderr}`;
  const outputDigest = createHash("sha256").update(output).digest("hex");
  const outputBytes = Buffer.byteLength(output, "utf8");

  return `${label} failed (status ${String(failure.status)}, outputBytes ${String(outputBytes)}, outputSha256 ${outputDigest}).`;
};

/**
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure npm failure details.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
export const summarizeNpmFailure = (failure) => summarizeProcessFailure("npm CLI", failure);

/**
 * Runs the npm CLI that launched the current repository script.
 *
 * @param {readonly string[]} arguments_ npm CLI arguments.
 * @param {string} cwd working directory.
 * @param {string} isolationRoot npm-only configuration and cache root.
 * @returns {string} captured standard output.
 */
export const runNpm = (arguments_, cwd, isolationRoot) => {
  const npmEntryPoint = process.env["npm_execpath"];
  if (npmEntryPoint === undefined || npmEntryPoint.length === 0) {
    throw new Error("npm_execpath is required to run this repository smoke test.");
  }

  mkdirSync(join(isolationRoot, "cache"), { recursive: true });
  writeFileSync(join(isolationRoot, "global.npmrc"), "", "utf8");
  writeFileSync(join(isolationRoot, "user.npmrc"), "", "utf8");

  const result = spawnSync(process.execPath, [npmEntryPoint, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: createIsolatedNpmEnvironment(process.env, isolationRoot),
    maxBuffer: subprocessOutputLimitBytes,
    shell: false,
    windowsHide: true,
  });

  if (result.error !== undefined) {
    throw new Error("Unable to start the npm CLI.");
  }

  if (result.status !== 0) {
    throw new Error(
      summarizeNpmFailure({
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      }),
    );
  }

  return result.stdout;
};
