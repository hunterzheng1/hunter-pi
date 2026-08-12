import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

import { createLocalManagedProcessDriver } from "@hunter-pi/execution";

import type { GhCliCommandResult } from "./github-actions-qualification.js";

const maximumOutputBytes = 1_048_576;

interface QualificationCliProcessOptions {
  readonly createDriver?: typeof createLocalManagedProcessDriver;
  readonly monotonicNow?: () => number;
}

interface QualificationCliExecutableResolutionOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly runProcess?: typeof runQualificationCliProcess;
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

function windowsEnvironmentValue(
  environment: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const expected = name.toUpperCase();
  return Object.entries(environment).find(([key]) => key.toUpperCase() === expected)?.[1];
}

/** @internal This module is intentionally absent from the updater package barrel. */
export async function resolveQualificationCliExecutable(
  executable: string,
  timeoutMs: number,
  options: QualificationCliExecutableResolutionOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return executable;
  if (
    executable.length === 0 ||
    executable.includes("\u0000") ||
    win32.basename(executable) !== executable ||
    ![".com", ".exe"].includes(win32.extname(executable).toLowerCase())
  ) {
    throw new Error("qualification executable is not one unqualified native filename");
  }
  const environment = options.environment ?? inheritedEnvironment();
  const systemRoot =
    windowsEnvironmentValue(environment, "SystemRoot") ??
    windowsEnvironmentValue(environment, "WINDIR");
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw new Error("qualification executable resolver is unavailable");
  }
  const result = await (options.runProcess ?? runQualificationCliProcess)(
    win32.join(systemRoot, "System32", "where.exe"),
    [`$PATH:${executable}`],
    timeoutMs,
  );
  if (result.exitCode !== 0 || result.stderr.trim().length > 0) {
    throw new Error("qualification executable is unavailable");
  }
  const candidates = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const selected = candidates[0];
  if (
    selected === undefined ||
    !win32.isAbsolute(selected) ||
    win32.basename(selected).toLowerCase() !== executable.toLowerCase()
  ) {
    throw new Error("qualification executable resolver returned an invalid target");
  }
  return win32.normalize(selected);
}

/** @internal This module is intentionally absent from the updater package barrel. */
export async function runQualificationCliProcess(
  executable: string,
  arguments_: readonly string[],
  timeoutMs: number,
  options: QualificationCliProcessOptions = {},
): Promise<GhCliCommandResult> {
  if (process.platform === "win32" && !win32.isAbsolute(executable)) {
    return failedResult();
  }
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
