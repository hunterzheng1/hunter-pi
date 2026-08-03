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
 * @param {readonly string[]} metadata allowlisted non-content metadata.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
const createProcessFailureSummary = (label, failure, metadata) => {
  const output = `${failure.stdout}\n${failure.stderr}`;
  const outputDigest = createHash("sha256").update(output).digest("hex");
  const outputBytes = Buffer.byteLength(output, "utf8");
  const details = [
    `status ${String(failure.status)}`,
    ...metadata,
    `outputBytes ${String(outputBytes)}`,
    `outputSha256 ${outputDigest}`,
  ];

  return `${label} failed (${details.join(", ")}).`;
};

/**
 * @param {string} label stable process label.
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure process failure details.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
export const summarizeProcessFailure = (label, failure) =>
  createProcessFailureSummary(label, failure, []);

/**
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure npm failure details.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
export const summarizeNpmFailure = (failure) => {
  const output = `${failure.stdout}\n${failure.stderr}`;
  const npmCode = /^npm (?:error|ERR!) code ([A-Z0-9_-]{1,32})\s*$/imu.exec(output)?.[1];
  const syscall = /^npm (?:error|ERR!) syscall ([A-Za-z0-9_.-]{1,32})\s*$/imu.exec(output)?.[1];
  const errno = /^npm (?:error|ERR!) errno (-?\d{1,12})\s*$/imu.exec(output)?.[1];
  const metadata = [
    npmCode === undefined ? undefined : `npmCode ${npmCode}`,
    syscall === undefined ? undefined : `syscall ${syscall}`,
    errno === undefined ? undefined : `errno ${errno}`,
  ].filter((value) => value !== undefined);

  return createProcessFailureSummary("npm CLI", failure, metadata);
};

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
