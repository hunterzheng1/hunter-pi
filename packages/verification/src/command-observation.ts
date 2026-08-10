import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { z } from "zod";

const MAXIMUM_TIMEOUT_MS = 86_400_000;
const MAXIMUM_OUTPUT_BYTES = 268_435_456;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || (codeUnit >= 127 && codeUnit <= 159)) return true;
  }
  return false;
}

const osStringSchema = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) => !containsControlCharacter(value),
      "controlled command values must not contain a control character",
    );

const controlledCommandRequestSchema = z.strictObject({
  workingDirectory: osStringSchema(32_768),
  executable: osStringSchema(32_768),
  argv: z.array(osStringSchema(32_768)).max(512),
  definitionFingerprint: fingerprintSchema,
  configurationFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  workspaceFingerprint: fingerprintSchema,
  environmentFingerprint: fingerprintSchema,
  timeoutMs: z.number().int().positive().max(MAXIMUM_TIMEOUT_MS),
  maximumOutputBytes: z.number().int().positive().max(MAXIMUM_OUTPUT_BYTES),
});

export interface ControlledCommandObservationRequest {
  readonly workingDirectory: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly definitionFingerprint: Fingerprint;
  readonly configurationFingerprint: Fingerprint;
  readonly sourceFingerprint: Fingerprint;
  readonly workspaceFingerprint: Fingerprint;
  readonly environmentFingerprint: Fingerprint;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface ControlledCommandProcessRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface ControlledCommandProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly processError: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly observedOutputBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly terminalFinality: "FINAL" | "NOT_PROVEN";
  readonly processTreeState: "EMPTY" | "ACTIVE" | "NOT_PROVEN";
  readonly outputState: "CLOSED" | "OPEN" | "NOT_PROVEN";
}

export interface ProcessRunner {
  run(request: ControlledCommandProcessRequest): Promise<ControlledCommandProcessResult>;
}

export const commandObservationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-command-observation.v1"),
    definitionFingerprint: fingerprintSchema,
    configurationFingerprint: fingerprintSchema,
    sourceFingerprint: fingerprintSchema,
    workspaceFingerprint: fingerprintSchema,
    environmentFingerprint: fingerprintSchema,
    workingDirectoryFingerprint: fingerprintSchema,
    commandFingerprint: fingerprintSchema,
    outcome: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    resultStatus: z.strictObject({
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      terminalFinality: z.enum(["FINAL", "NOT_PROVEN"]),
      processTreeState: z.enum(["EMPTY", "ACTIVE", "NOT_PROVEN"]),
      outputState: z.enum(["CLOSED", "OPEN", "NOT_PROVEN"]),
    }),
    output: z.strictObject({
      stdoutDigest: fingerprintSchema,
      stderrDigest: fingerprintSchema,
      capturedBytes: z.number().int().nonnegative().max(MAXIMUM_OUTPUT_BYTES),
      observedBytes: z.number().int().nonnegative(),
      stdoutTruncated: z.boolean(),
      stderrTruncated: z.boolean(),
    }),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({ code: "custom", message: "command observation time moved backwards" });
    }
  });
export type CommandObservationReceipt = z.infer<typeof commandObservationReceiptSchema>;

export interface ControlledCommandObservationResult {
  readonly receipt: CommandObservationReceipt;
}

function sha256(value: Uint8Array): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function minimalEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    FORCE_COLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
}

function resolveWindowsNpmCli(executable: string): string | undefined {
  if (process.platform !== "win32" || !["npm", "npm.cmd"].includes(executable.toLowerCase())) {
    return undefined;
  }
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env["PATH"] ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .flatMap((entry) => [join(entry, executable), join(entry, `${executable}.cmd`)])
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const npmCli = join(dirname(candidate), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(npmCli)) return npmCli;
  }
  return undefined;
}

function resolveProcessInvocation(
  executable: string,
  argv: readonly string[],
): { readonly executable: string; readonly argv: readonly string[] } {
  if (executable === "node") return { executable: process.execPath, argv };
  const npmCli = resolveWindowsNpmCli(executable);
  return npmCli === undefined
    ? { executable, argv }
    : { executable: process.execPath, argv: [npmCli, ...argv] };
}

function unavailableProcessResult(): ControlledCommandProcessResult {
  return {
    exitCode: null,
    timedOut: false,
    processError: true,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    observedOutputBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    terminalFinality: "NOT_PROVEN",
    processTreeState: "NOT_PROVEN",
    outputState: "NOT_PROVEN",
  };
}

function normalizeProcessResult(
  value: ControlledCommandProcessResult,
): ControlledCommandProcessResult {
  if (
    (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) ||
    !Number.isSafeInteger(value.observedOutputBytes) ||
    value.observedOutputBytes < 0 ||
    typeof value.timedOut !== "boolean" ||
    typeof value.processError !== "boolean" ||
    !(value.stdout instanceof Uint8Array) ||
    !(value.stderr instanceof Uint8Array) ||
    typeof value.stdoutTruncated !== "boolean" ||
    typeof value.stderrTruncated !== "boolean" ||
    !["FINAL", "NOT_PROVEN"].includes(value.terminalFinality) ||
    !["EMPTY", "ACTIVE", "NOT_PROVEN"].includes(value.processTreeState) ||
    !["CLOSED", "OPEN", "NOT_PROVEN"].includes(value.outputState)
  ) {
    throw new Error("the controlled process runner returned an invalid observation");
  }
  return value;
}

function boundOutput(
  processResult: ControlledCommandProcessResult,
  maximumOutputBytes: number,
): {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly observedBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
} {
  const stdoutInput = Buffer.from(processResult.stdout);
  const stderrInput = Buffer.from(processResult.stderr);
  const stdout = stdoutInput.subarray(0, maximumOutputBytes);
  const remaining = maximumOutputBytes - stdout.length;
  const stderr = stderrInput.subarray(0, remaining);
  return {
    stdout,
    stderr,
    observedBytes: Math.max(
      processResult.observedOutputBytes,
      stdoutInput.length + stderrInput.length,
    ),
    stdoutTruncated: processResult.stdoutTruncated || stdout.length < stdoutInput.length,
    stderrTruncated: processResult.stderrTruncated || stderr.length < stderrInput.length,
  };
}

export async function observeControlledCommand(
  request: ControlledCommandObservationRequest,
  processRunner: ProcessRunner,
  now: () => string = () => new Date().toISOString(),
): Promise<ControlledCommandObservationResult> {
  let parsedRequest: z.infer<typeof controlledCommandRequestSchema>;
  try {
    parsedRequest = controlledCommandRequestSchema.parse(request);
  } catch (error) {
    if (
      error instanceof z.ZodError &&
      error.issues.some(
        (issue) => issue.path.includes("timeoutMs") || issue.path.includes("maximumOutputBytes"),
      )
    ) {
      throw new Error("controlled command limits are invalid", { cause: error });
    }
    throw error;
  }

  const unresolvedWorkingDirectory = resolve(parsedRequest.workingDirectory);
  const unresolvedStatus = await lstat(unresolvedWorkingDirectory);
  if (!unresolvedStatus.isDirectory() || unresolvedStatus.isSymbolicLink()) {
    throw new Error("controlled command working directory must be a physical directory");
  }
  const workingDirectory = await realpath(unresolvedWorkingDirectory);
  const invocation = resolveProcessInvocation(parsedRequest.executable, parsedRequest.argv);
  const startedAt = timestampSchema.parse(now());
  let processResult: ControlledCommandProcessResult;
  try {
    processResult = normalizeProcessResult(
      await processRunner.run({
        executable: invocation.executable,
        argv: invocation.argv,
        cwd: workingDirectory,
        environment: minimalEnvironment(),
        shell: false,
        timeoutMs: parsedRequest.timeoutMs,
        maximumOutputBytes: parsedRequest.maximumOutputBytes,
      }),
    );
  } catch {
    processResult = unavailableProcessResult();
  }
  const endedAt = timestampSchema.parse(now());
  const output = boundOutput(processResult, parsedRequest.maximumOutputBytes);
  const finalityProven =
    processResult.terminalFinality === "FINAL" &&
    processResult.processTreeState === "EMPTY" &&
    processResult.outputState === "CLOSED";
  const truncated = output.stdoutTruncated || output.stderrTruncated;
  const outcome =
    processResult.processError ||
    processResult.timedOut ||
    processResult.exitCode === null ||
    truncated ||
    !finalityProven
      ? "NOT_PROVEN"
      : processResult.exitCode === 0
        ? "PASS"
        : "FAIL";

  return {
    receipt: commandObservationReceiptSchema.parse({
      schemaVersion: "hpi-command-observation.v1",
      definitionFingerprint: parsedRequest.definitionFingerprint,
      configurationFingerprint: parsedRequest.configurationFingerprint,
      sourceFingerprint: parsedRequest.sourceFingerprint,
      workspaceFingerprint: parsedRequest.workspaceFingerprint,
      environmentFingerprint: parsedRequest.environmentFingerprint,
      workingDirectoryFingerprint: sha256(Buffer.from(workingDirectory, "utf8")),
      commandFingerprint: sha256(
        Buffer.from(
          JSON.stringify({
            executable: invocation.executable,
            argv: invocation.argv,
            shell: false,
          }),
          "utf8",
        ),
      ),
      outcome,
      startedAt,
      endedAt,
      resultStatus: {
        exitCode: processResult.exitCode,
        timedOut: processResult.timedOut,
        terminalFinality: processResult.terminalFinality,
        processTreeState: processResult.processTreeState,
        outputState: processResult.outputState,
      },
      output: {
        stdoutDigest: sha256(output.stdout),
        stderrDigest: sha256(output.stderr),
        capturedBytes: output.stdout.length + output.stderr.length,
        observedBytes: output.observedBytes,
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
      },
    }),
  };
}
