import { spawnSync } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import {
  acquireObserverLock,
  completedRunSucceeded,
  parseArguments,
  parseRunSnapshot,
  rateLimitWaitMs,
} from "../scripts/ci-observe.mjs";

const observerScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "ci-observe.mjs",
);

function runObserver(...arguments_: readonly string[]) {
  return spawnSync(process.execPath, [observerScript, ...arguments_], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
}

describe("CI control-plane observer", () => {
  it("prints safe usage without invoking GitHub", () => {
    const result = runObserver("--help");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default interval: 120 seconds");
    expect(result.stdout).toContain("minimum interval: 60 seconds");
  });

  it("rejects a polling interval that would encourage high-frequency API calls", () => {
    const result = runObserver("31308598610", "--interval", "30", "--once");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CIObserverStatus=BLOCKED");
    expect(result.stderr).toContain("INTERVAL_TOO_SHORT");
  });

  it("validates an exact head binding before contacting GitHub", () => {
    const result = runObserver("31308598610", "--head", "not-a-commit", "--once");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CIObserverStatus=BLOCKED");
    expect(result.stderr).toContain("HEAD_INVALID");
  });

  it("rejects a timer interval that could overflow Node's timeout range", () => {
    const result = runObserver("31308598610", "--interval", "2147484", "--once");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CIObserverStatus=BLOCKED");
    expect(result.stderr).toContain("INTERVAL_TOO_LONG");
  });

  it("fails closed for malformed run state and requires every job to pass", () => {
    const valid = {
      status: "completed",
      conclusion: "success",
      headSha: "a".repeat(40),
      jobs: [{ name: "quality", status: "completed", conclusion: "success" }],
    };

    expect(parseRunSnapshot(valid)).toEqual(valid);
    expect(completedRunSucceeded(valid)).toBe(true);
    expect(
      completedRunSucceeded({
        ...valid,
        jobs: [{ name: "quality", status: "completed", conclusion: "skipped" }],
      }),
    ).toBe(false);
    expect(() => parseRunSnapshot({ ...valid, status: "unknown" })).toThrow(
      "CI_RUN_RESPONSE_INVALID",
    );
  });

  it("uses a bounded reset-aware wait and parses once mode without network access", () => {
    expect(rateLimitWaitMs(undefined, 1_000)).toBe(60_000);
    expect(rateLimitWaitMs(Math.floor(Date.now() / 1_000) + 3_600, 60_000)).toBe(900_000);
    expect(parseArguments(["123", "--once"])).toMatchObject({ once: true });
  });

  it("recovers an empty stale lock and rejects a live duplicate", async () => {
    const runId = `test-lock-${String(process.pid)}-${String(Date.now())}`;
    const lockPath = join(tmpdir(), `hunter-pi-ci-observer-${runId}.lock`);
    await rm(lockPath, { force: true });
    await writeFile(lockPath, "", "utf8");
    const release = await acquireObserverLock(runId);
    try {
      await expect(acquireObserverLock(runId)).rejects.toThrow("OBSERVER_ALREADY_RUNNING");
    } finally {
      await release();
      await expect(access(lockPath)).rejects.toThrow();
    }
  });
});
