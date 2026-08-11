import { performance } from "node:perf_hooks";

import { createLocalManagedProcessDriver } from "@hunter-pi/execution";

import type { GhCliCommandResult } from "./github-actions-qualification.js";

const maximumOutputBytes = 1_048_576;

interface QualificationCliProcessOptions {
  readonly createDriver?: typeof createLocalManagedProcessDriver;
  readonly monotonicNow?: () => number;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function failedResult(): GhCliCommandResult {
  return { exitCode: null, stdout: "", stderr: "" };
}

/** @internal This module is intentionally absent from the updater package barrel. */
export async function runQualificationCliProcess(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  options: QualificationCliProcessOptions = {},
): Promise<GhCliCommandResult> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const deadline = monotonicNow() + timeoutMs;
  const driver = (options.createDriver ?? createLocalManagedProcessDriver)();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const output = { observedBytes: 0, exceeded: false };
  let session: Awaited<ReturnType<typeof driver.start>> | undefined;
  const deadlineState = { exceeded: false };
  const requestCancellation = (reason: "POLICY" | "TIMEOUT"): void => {
    if (session === undefined) return;
    void session.cancel(session.identityFingerprint, reason).catch(() => undefined);
  };
  const deadlineTimer = setTimeout(() => {
    deadlineState.exceeded = true;
    requestCancellation("TIMEOUT");
  }, timeoutMs);
  deadlineTimer.unref();
  try {
    session = await driver.start({
      executable,
      argv: arguments_,
      cwd: process.cwd(),
      environment: inheritedEnvironment(),
      timeoutMs,
      onOutput: (stream, chunk) => {
        if (output.exceeded) return;
        output.observedBytes += chunk.byteLength;
        if (output.observedBytes > maximumOutputBytes) {
          output.exceeded = true;
          stdout.length = 0;
          stderr.length = 0;
          requestCancellation("POLICY");
          return;
        }
        (stream === "STDOUT" ? stdout : stderr).push(Buffer.from(chunk));
      },
    });
    if (deadlineState.exceeded || monotonicNow() >= deadline) {
      deadlineState.exceeded = true;
      await session.cancel(session.identityFingerprint, "TIMEOUT");
    } else if (output.exceeded) {
      await session.cancel(session.identityFingerprint, "POLICY");
    }
    const snapshot = await session.waitForSettlement();
    if (monotonicNow() >= deadline) deadlineState.exceeded = true;
    if (
      deadlineState.exceeded ||
      output.exceeded ||
      snapshot.phase !== "TERMINAL" ||
      snapshot.identityState !== "MATCH" ||
      snapshot.treeState !== "EMPTY" ||
      snapshot.stdoutState !== "CLOSED" ||
      snapshot.stderrState !== "CLOSED" ||
      snapshot.terminationCause !== "NONE" ||
      snapshot.exitCode === null
    ) {
      return failedResult();
    }
    return {
      exitCode: snapshot.exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  } catch {
    if (session !== undefined) {
      const reason = deadlineState.exceeded || monotonicNow() >= deadline ? "TIMEOUT" : "POLICY";
      await session.cancel(session.identityFingerprint, reason).catch(() => undefined);
      await session.waitForSettlement().catch(() => undefined);
    }
    return failedResult();
  } finally {
    clearTimeout(deadlineTimer);
  }
}
