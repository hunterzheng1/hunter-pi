import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

const credentialEnvironmentKeys = new Set(["node_auth_token", "npm_auth_token", "npm_token"]);
const isolatedTemporaryEnvironmentKeys = new Set(["temp", "tmp", "tmpdir"]);
export const subprocessOutputLimitBytes = 1024 * 1024;

/**
 * @param {NodeJS.ProcessEnv} environment inherited process environment.
 * @param {string} npmEntryPoint npm CLI module path.
 * @param {string} nodeExecutable Node.js executable path.
 * @returns {Record<string, string>} stable labels for process-owned roots.
 */
export const createNpmDiagnosticRoots = (environment, npmEntryPoint, nodeExecutable) => {
  const pathApi = win32.isAbsolute(npmEntryPoint) ? win32 : posix;
  /** @type {Record<string, string>} */
  const roots = {
    "node-runtime": pathApi.dirname(nodeExecutable),
    "npm-runtime": pathApi.dirname(pathApi.dirname(npmEntryPoint)),
  };
  const environmentLabels = {
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    PROGRAMDATA: "programdata",
    PROGRAMFILES: "programfiles",
    SYSTEMROOT: "systemroot",
    TEMP: "temp",
    USERPROFILE: "userprofile",
  };

  for (const [environmentKey, label] of Object.entries(environmentLabels)) {
    const entry = Object.entries(environment).find(
      ([key, value]) =>
        key.toUpperCase() === environmentKey && value !== undefined && value.length > 0,
    );
    const value = entry?.[1];
    if (value !== undefined) {
      roots[label] = value;
    }
  }

  return roots;
};

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
    if (
      normalizedKey.startsWith("npm_config_") ||
      credentialEnvironmentKeys.has(normalizedKey) ||
      isolatedTemporaryEnvironmentKeys.has(normalizedKey)
    ) {
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
    TEMP: join(isolationRoot, "tmp"),
    TMP: join(isolationRoot, "tmp"),
    TMPDIR: join(isolationRoot, "tmp"),
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
 * @param {string} candidate raw npm error path.
 * @param {{ readonly cwd: string; readonly isolationRoot: string; readonly knownRoots?: Readonly<Record<string, string>> }} context path classification context.
 * @returns {string} stable path scope without path content.
 */
const classifyNpmFailurePath = (candidate, context) => {
  const unquotedCandidate = candidate.trim().replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
  const pathApi = win32.isAbsolute(unquotedCandidate) ? win32 : posix;
  const normalizedCandidate = pathApi.normalize(unquotedCandidate);

  /** @param {string} root */
  const isInside = (root) => {
    const relativePath = pathApi.relative(pathApi.normalize(root), normalizedCandidate);
    return (
      relativePath === "" ||
      (relativePath !== ".." &&
        !relativePath.startsWith(`..${pathApi.sep}`) &&
        !pathApi.isAbsolute(relativePath))
    );
  };

  if (isInside(pathApi.join(context.isolationRoot, "cache"))) {
    return "npm-cache";
  }
  if (isInside(context.isolationRoot)) {
    return "npm-isolation";
  }
  if (isInside(context.cwd)) {
    return "working-directory";
  }

  for (const [label, root] of Object.entries(context.knownRoots ?? {})) {
    if (/^[a-z][a-z0-9-]{0,31}$/u.test(label) && isInside(root)) {
      return label;
    }
  }

  return pathApi.isAbsolute(normalizedCandidate) ? "other-absolute" : "relative";
};

/**
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure npm failure details.
 * @param {{ readonly cwd: string; readonly isolationRoot: string; readonly knownRoots?: Readonly<Record<string, string>> }} [context] path classification context.
 * @returns {string} bounded, non-content-bearing diagnostic summary.
 */
export const summarizeNpmFailure = (failure, context) => {
  const output = `${failure.stdout}\n${failure.stderr}`;
  const npmCode = /^npm (?:error|ERR!) code ([A-Z0-9_-]{1,32})\s*$/imu.exec(output)?.[1];
  const syscall = /^npm (?:error|ERR!) syscall ([A-Za-z0-9_.-]{1,32})\s*$/imu.exec(output)?.[1];
  const errno = /^npm (?:error|ERR!) errno (-?\d{1,12})\s*$/imu.exec(output)?.[1];
  const failurePath = /^npm (?:error|ERR!) path (.+?)\s*$/imu.exec(output)?.[1];
  const metadata = [
    npmCode === undefined ? undefined : `npmCode ${npmCode}`,
    syscall === undefined ? undefined : `syscall ${syscall}`,
    errno === undefined ? undefined : `errno ${errno}`,
    failurePath === undefined || context === undefined
      ? undefined
      : `pathScope ${classifyNpmFailurePath(failurePath, context)}`,
  ].filter((value) => value !== undefined);

  return createProcessFailureSummary("npm CLI", failure, metadata);
};

/**
 * Allows one process-level retry only for the exact registry transport failure
 * observed during an npm install. npm's own retry policy remains responsible
 * for other transport conditions; rate-limit and package/assertion failures
 * must continue to fail without an outer retry.
 *
 * @param {readonly string[]} arguments_ npm CLI arguments.
 * @param {{ readonly status: number | null; readonly stderr: string; readonly stdout: string }} failure npm failure details.
 * @param {number} attemptNumber one-based process attempt number.
 * @returns {boolean} whether one final attempt is allowed.
 */
export const shouldRetryNpmFailure = (arguments_, failure, attemptNumber) => {
  if (
    attemptNumber !== 1 ||
    arguments_[0] !== "install" ||
    !arguments_.includes("--ignore-scripts")
  ) {
    return false;
  }
  const codes = [
    ...failure.stderr.matchAll(/^npm (?:error|ERR!) code ([A-Z0-9_-]{1,32})\s*$/gimu),
  ].map((match) => match[1]);
  return codes.length === 1 && codes[0] === "ECONNRESET";
};

/**
 * Runs the npm CLI that launched the current repository script.
 *
 * @param {readonly string[]} arguments_ npm CLI arguments.
 * @param {string} cwd working directory.
 * @param {string} isolationRoot npm-only configuration and cache root.
 * @param {Readonly<Record<string, string>>} [knownRoots] additional stable diagnostic path scopes.
 * @returns {string} captured standard output.
 */
export const runNpm = (arguments_, cwd, isolationRoot, knownRoots = {}) => {
  const npmEntryPoint = process.env["npm_execpath"];
  if (npmEntryPoint === undefined || npmEntryPoint.length === 0) {
    throw new Error("npm_execpath is required to run this repository smoke test.");
  }
  const diagnosticRoots = {
    ...knownRoots,
    ...createNpmDiagnosticRoots(process.env, npmEntryPoint, process.execPath),
  };

  mkdirSync(join(isolationRoot, "cache"), { recursive: true });
  mkdirSync(join(isolationRoot, "tmp"), { recursive: true });
  writeFileSync(join(isolationRoot, "global.npmrc"), "", "utf8");
  writeFileSync(join(isolationRoot, "user.npmrc"), "", "utf8");

  const environment = createIsolatedNpmEnvironment(process.env, isolationRoot);
  const failureContext = { cwd, isolationRoot, knownRoots: diagnosticRoots };
  for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
    const result = spawnSync(process.execPath, [npmEntryPoint, ...arguments_], {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: subprocessOutputLimitBytes,
      shell: false,
      windowsHide: true,
    });

    if (result.error !== undefined) {
      throw new Error("Unable to start the npm CLI.");
    }

    if (result.status === 0) return result.stdout;

    const failure = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
    const summary = summarizeNpmFailure(failure, failureContext);
    if (shouldRetryNpmFailure(arguments_, failure, attemptNumber)) {
      process.stderr.write(`Preserved transient npm failure; retrying once. ${summary}\n`);
      continue;
    }

    throw new Error(summary);
  }

  throw new Error("npm CLI exhausted its bounded retry unexpectedly.");
};
