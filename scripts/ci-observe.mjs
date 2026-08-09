#!/usr/bin/env node

/* eslint-disable
  @typescript-eslint/no-confusing-void-expression,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/restrict-plus-operands
*/

import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_INTERVAL_SECONDS = 120;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 3_600;
const DEFAULT_MAX_POLLS = 60;
const COMMAND_TIMEOUT_MS = 30_000;
const LOCK_PREFIX = "hunter-pi-ci-observer";
const MIN_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_RATE_LIMIT_WAIT_MS = 900_000;

/** @typedef {{help: true} | {help: false, runId: string, intervalSeconds: number, maxPolls: number, once: boolean, expectedHeadSha: string | undefined}} ObserverOptions */
/** @typedef {{code: number | null, stdout: string, stderr: string, timedOut: boolean}} GhResult */
/** @typedef {{status: string, conclusion: string | null, headSha: string, jobs: Array<{name: string, status: string, conclusion: string | null}>}} RunSnapshot */

const RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);
const JOB_STATUSES = new Set(["queued", "in_progress", "completed"]);
const CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

/** @param {unknown} value @returns {string | null} */
function normalizeConclusion(value) {
  if (value === null || value === "") return null;
  if (typeof value === "string" && CONCLUSIONS.has(value)) return value;
  throw new ObserverBlockedError("CI_RUN_RESPONSE_INVALID");
}

class ObserverBlockedError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "ObserverBlockedError";
    this.reason = reason;
  }
}

function usage() {
  return [
    "Usage: npm run ci:observe -- <run-id> [--head <sha>] [--interval <seconds>] [--max-polls <count>] [--once]",
    "",
    `default interval: ${String(DEFAULT_INTERVAL_SECONDS)} seconds`,
    `minimum interval: ${String(MIN_INTERVAL_SECONDS)} seconds`,
    `maximum interval: ${String(MAX_INTERVAL_SECONDS)} seconds`,
    "--head binds a successful result to one exact 40-character commit SHA.",
    "--once performs one quota check and one status query; it returns 2 while the run is pending.",
    "The observer never downloads logs and permits only one observer per run ID.",
  ].join("\n");
}

/** @param {string} value @param {string} option */
function parsePositiveInteger(value, option) {
  if (!/^\d+$/u.test(value)) throw new ObserverBlockedError(`${option}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ObserverBlockedError(`${option}_INVALID`);
  }
  return parsed;
}

/** @param {readonly string[]} arguments_ @returns {ObserverOptions} */
function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    if (arguments_.length !== 1) throw new ObserverBlockedError("ARGUMENTS_INVALID");
    return { help: true };
  }

  const runId = arguments_[0];
  if (runId === undefined || !/^\d+$/u.test(runId)) {
    throw new ObserverBlockedError("RUN_ID_INVALID");
  }
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let maxPolls = DEFAULT_MAX_POLLS;
  let once = false;
  let expectedHeadSha;
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--once") {
      if (once) throw new ObserverBlockedError("ARGUMENTS_INVALID");
      once = true;
      continue;
    }
    if (option === "--head" || option === "--interval" || option === "--max-polls") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new ObserverBlockedError("ARGUMENTS_INVALID");
      index += 1;
      if (option === "--head") {
        if (!/^[a-f0-9]{40}$/u.test(value)) throw new ObserverBlockedError("HEAD_INVALID");
        expectedHeadSha = value;
      } else if (option === "--interval") intervalSeconds = parsePositiveInteger(value, "INTERVAL");
      else maxPolls = parsePositiveInteger(value, "MAX_POLLS");
      continue;
    }
    throw new ObserverBlockedError("ARGUMENTS_INVALID");
  }
  if (intervalSeconds < MIN_INTERVAL_SECONDS) {
    throw new ObserverBlockedError("INTERVAL_TOO_SHORT");
  }
  if (intervalSeconds > MAX_INTERVAL_SECONDS) {
    throw new ObserverBlockedError("INTERVAL_TOO_LONG");
  }
  return { help: false, runId, intervalSeconds, maxPolls, once, expectedHeadSha };
}

/** @param {readonly string[]} arguments_ @returns {Promise<GhResult>} */
function runGh(arguments_) {
  return new Promise((resolvePromise) => {
    const child = spawn("gh", arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    /** @param {number | null} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

/** @param {string} output */
function isRateLimited(output) {
  return /rate limit|secondary rate|api rate/iu.test(output);
}

/** @param {readonly string[]} arguments_ @param {string} failureReason @returns {Promise<unknown>} */
async function ghJson(arguments_, failureReason) {
  const result = await runGh(arguments_);
  if (result.code !== 0 || result.timedOut) {
    if (isRateLimited(`${result.stdout}\n${result.stderr}`)) {
      throw new ObserverBlockedError("GITHUB_API_RATE_LIMITED");
    }
    throw new ObserverBlockedError(failureReason);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ObserverBlockedError(`${failureReason}_INVALID_JSON`);
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {RunSnapshot} */
function parseRunSnapshot(value) {
  if (!isRecord(value)) throw new ObserverBlockedError("CI_RUN_RESPONSE_INVALID");
  const status = value["status"];
  const conclusion = normalizeConclusion(value["conclusion"]);
  const headSha = value["headSha"];
  const jobs = value["jobs"];
  if (
    typeof status !== "string" ||
    !RUN_STATUSES.has(status) ||
    typeof headSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(headSha) ||
    !Array.isArray(jobs) ||
    jobs.length === 0
  ) {
    throw new ObserverBlockedError("CI_RUN_RESPONSE_INVALID");
  }
  const parsedJobs = [];
  for (const job of jobs) {
    if (!isRecord(job)) throw new ObserverBlockedError("CI_RUN_RESPONSE_INVALID");
    const name = job["name"];
    const jobStatus = job["status"];
    const jobConclusion = normalizeConclusion(job["conclusion"]);
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      typeof jobStatus !== "string" ||
      !JOB_STATUSES.has(jobStatus)
    ) {
      throw new ObserverBlockedError("CI_RUN_RESPONSE_INVALID");
    }
    parsedJobs.push({ name, status: jobStatus, conclusion: jobConclusion });
  }
  return { status, conclusion, headSha, jobs: parsedJobs };
}

/** @param {unknown} resetEpoch */
function resetTime(resetEpoch) {
  return typeof resetEpoch === "number" && Number.isSafeInteger(resetEpoch)
    ? new Date(resetEpoch * 1000).toISOString()
    : "UNKNOWN";
}

/** @param {unknown} resetEpoch @param {number} backoffMs */
function rateLimitWaitMs(resetEpoch, backoffMs) {
  const resetWaitMs =
    typeof resetEpoch === "number" && Number.isSafeInteger(resetEpoch)
      ? Math.max(0, resetEpoch * 1000 - Date.now() + 1000)
      : 0;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(MIN_RATE_LIMIT_WAIT_MS, resetWaitMs, backoffMs));
}

/** @param {number} milliseconds */
function rateLimitWaitSeconds(milliseconds) {
  return Math.ceil(milliseconds / 1000);
}

/** @returns {Promise<{remaining: number, reset: unknown}>} */
async function readCoreQuota() {
  const response = await ghJson(["api", "rate_limit"], "GITHUB_QUOTA_UNAVAILABLE");
  if (
    !isRecord(response) ||
    !isRecord(response["resources"]) ||
    !isRecord(response["resources"]["core"])
  ) {
    throw new ObserverBlockedError("GITHUB_QUOTA_INVALID");
  }
  const core = response["resources"]["core"];
  if (typeof core["remaining"] !== "number" || !Number.isSafeInteger(core["remaining"])) {
    throw new ObserverBlockedError("GITHUB_QUOTA_INVALID");
  }
  return { remaining: core["remaining"], reset: core["reset"] };
}

/** @param {RunSnapshot["jobs"]} jobs */
function jobSummary(jobs) {
  if (jobs.length === 0) return "NONE";
  return jobs
    .map((job) => {
      const name = job.name.replaceAll(/[\r\n]/gu, " ");
      const status = job.status;
      const conclusion = job.conclusion ?? "PENDING";
      return `${name}:${status}/${conclusion}`;
    })
    .join(",");
}

/** @param {string} runId @param {{remaining: number}} quota @param {RunSnapshot} snapshot */
function printSnapshot(runId, quota, snapshot) {
  const status = snapshot.status;
  const conclusion = snapshot.conclusion ?? "PENDING";
  const headSha = snapshot.headSha;
  console.log(
    `CIObserverStatus=${status.toUpperCase()} Run=${runId} Conclusion=${conclusion.toUpperCase()} Head=${headSha} CoreRemaining=${String(quota.remaining)} Jobs=${jobSummary(snapshot.jobs)}`,
  );
}

/** @param {RunSnapshot} snapshot */
function isTerminal(snapshot) {
  return snapshot.status === "completed" || snapshot.conclusion !== null;
}

/** @param {RunSnapshot} snapshot @param {string | undefined} expectedHeadSha */
function assertExpectedHead(snapshot, expectedHeadSha) {
  if (expectedHeadSha !== undefined && snapshot.headSha !== expectedHeadSha) {
    throw new ObserverBlockedError("CI_RUN_HEAD_MISMATCH");
  }
}

/** @param {RunSnapshot} snapshot */
function completedRunSucceeded(snapshot) {
  if (snapshot.status !== "completed" || snapshot.conclusion !== "success") return false;
  if (snapshot.jobs.length === 0) return false;
  return snapshot.jobs.every((job) => job.status === "completed" && job.conclusion === "success");
}

/** @param {number} pid */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** @param {unknown} error @returns {string | undefined} */
function errorCode(error) {
  if (typeof error !== "object" || error === null) return undefined;
  const code = /** @type {unknown} */ (Reflect.get(error, "code"));
  return typeof code === "string" ? code : undefined;
}

/** @param {string} runId @returns {Promise<() => Promise<void>>} */
async function acquireObserverLock(runId) {
  const path = join(tmpdir(), `${LOCK_PREFIX}-${runId}.lock`);
  const pendingPath = `${path}.${String(process.pid)}.${randomUUID()}.pending`;
  try {
    await writeFile(pendingPath, `${String(process.pid)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await link(pendingPath, path);
    await unlink(pendingPath);
  } catch (error) {
    await unlink(pendingPath).catch(() => undefined);
    if (errorCode(error) !== "EEXIST") throw new ObserverBlockedError("OBSERVER_LOCK_UNAVAILABLE");
    let ownerText;
    try {
      ownerText = (await readFile(path, "utf8")).trim();
    } catch {
      throw new ObserverBlockedError("OBSERVER_ALREADY_RUNNING");
    }
    const owner = Number(ownerText);
    if (ownerText.length === 0 || !Number.isSafeInteger(owner) || owner <= 0) {
      await unlink(path).catch(() => {
        throw new ObserverBlockedError("OBSERVER_LOCK_STALE");
      });
      return acquireObserverLock(runId);
    }
    if (processIsAlive(owner)) {
      throw new ObserverBlockedError("OBSERVER_ALREADY_RUNNING");
    }
    await unlink(path).catch(() => {
      throw new ObserverBlockedError("OBSERVER_LOCK_STALE");
    });
    return acquireObserverLock(runId);
  }
  return async () => {
    try {
      const owner = Number((await readFile(path, "utf8")).trim());
      if (owner === process.pid) await unlink(path);
    } catch {
      // The lock is only a local observer guard; no remote state is involved.
    }
  };
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** @param {readonly string[]} arguments_ @returns {Promise<number>} */
async function main(arguments_) {
  const options = parseArguments(arguments_);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const releaseLock = await acquireObserverLock(options.runId);
  let rateLimitBackoffMs = MIN_RATE_LIMIT_WAIT_MS;
  try {
    for (let poll = 0; poll < options.maxPolls; poll += 1) {
      let quota;
      try {
        quota = await readCoreQuota();
      } catch (error) {
        if (error instanceof ObserverBlockedError && error.reason === "GITHUB_API_RATE_LIMITED") {
          if (options.once) throw error;
          const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, rateLimitBackoffMs);
          console.error(
            `CIObserverStatus=WAITING Run=${options.runId} Reason=GITHUB_API_RATE_LIMITED RetryInSeconds=${String(rateLimitWaitSeconds(waitMs))}`,
          );
          await sleep(waitMs);
          rateLimitBackoffMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, rateLimitBackoffMs * 2);
          continue;
        }
        throw error;
      }
      if (quota.remaining < 2) {
        if (options.once) {
          throw new ObserverBlockedError(`GITHUB_API_QUOTA_LOW_RESET_${resetTime(quota.reset)}`);
        }
        const waitMs = rateLimitWaitMs(quota.reset, rateLimitBackoffMs);
        console.error(
          `CIObserverStatus=WAITING Run=${options.runId} Reason=GITHUB_API_QUOTA_LOW RetryInSeconds=${String(rateLimitWaitSeconds(waitMs))} Reset=${resetTime(quota.reset)}`,
        );
        await sleep(waitMs);
        rateLimitBackoffMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, rateLimitBackoffMs * 2);
        continue;
      }
      let snapshot;
      try {
        snapshot = parseRunSnapshot(
          await ghJson(
            ["run", "view", options.runId, "--json", "status,conclusion,headSha,jobs"],
            "CI_RUN_STATUS_UNAVAILABLE",
          ),
        );
      } catch (error) {
        if (error instanceof ObserverBlockedError && error.reason === "GITHUB_API_RATE_LIMITED") {
          if (options.once) throw error;
          const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, rateLimitBackoffMs);
          console.error(
            `CIObserverStatus=WAITING Run=${options.runId} Reason=GITHUB_API_RATE_LIMITED RetryInSeconds=${String(rateLimitWaitSeconds(waitMs))}`,
          );
          await sleep(waitMs);
          rateLimitBackoffMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, rateLimitBackoffMs * 2);
          continue;
        }
        throw error;
      }
      rateLimitBackoffMs = MIN_RATE_LIMIT_WAIT_MS;
      assertExpectedHead(snapshot, options.expectedHeadSha);
      printSnapshot(options.runId, quota, snapshot);
      if (isTerminal(snapshot)) {
        return completedRunSucceeded(snapshot) ? 0 : 1;
      }
      if (options.once) return 2;
      if (poll + 1 === options.maxPolls) break;
      await sleep(options.intervalSeconds * 1000);
    }
    console.error(`CIObserverStatus=TIMEOUT Run=${options.runId} Reason=MAX_POLLS_REACHED`);
    return 2;
  } finally {
    await releaseLock();
  }
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(resolve(scriptPath)).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ObserverBlockedError) {
      console.error(`CIObserverStatus=BLOCKED Reason=${error.reason}`);
    } else {
      console.error("CIObserverStatus=BLOCKED Reason=OBSERVER_FAILED");
    }
    process.exitCode = 2;
  }
}

export {
  acquireObserverLock,
  completedRunSucceeded,
  parseArguments,
  parseRunSnapshot,
  rateLimitWaitMs,
};
