import { createHash, randomUUID } from "node:crypto";

import {
  createFileLeaseManager,
  createLocalManagedProcessHost,
  managedProcessSessionIdSchema,
  managedProcessStartRequestSchema,
  type ManagedProcessHost,
} from "@hunter-pi/execution";
import { fingerprintSchema, operationIdSchema, type Fingerprint } from "@hunter-pi/domain";

import type {
  ControlledCommandProcessRequest,
  ControlledCommandProcessResult,
  ProcessRunner,
} from "./command-observation.js";

const MAXIMUM_LOG_READ_BYTES = 16_777_216;

export interface QualifiedControlledCommandRunnerOptions {
  readonly leaseRoot: string;
  readonly now?: () => string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

async function readManagedOutput(
  host: ManagedProcessHost,
  sessionId: ReturnType<typeof managedProcessSessionIdSchema.parse>,
  retainedBytes: number,
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let cursor = 0;
  while (cursor < retainedBytes) {
    const result = await host.read({
      schemaVersion: "hpi-process-log-read.v1",
      sessionId,
      cursor,
      maxBytes: Math.min(MAXIMUM_LOG_READ_BYTES, retainedBytes - cursor),
    });
    if (result.receipt.nextCursor <= cursor) {
      throw new Error("managed command output cursor did not advance");
    }
    for (const chunk of result.chunks) {
      const data = Buffer.from(chunk.dataBase64, "base64");
      if (chunk.stream === "STDOUT") stdout.push(data);
      else stderr.push(data);
    }
    cursor = result.receipt.nextCursor;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function hasDisabledShell(value: unknown): value is { readonly shell: false } {
  return typeof value === "object" && value !== null && "shell" in value && value.shell === false;
}

export async function createQualifiedControlledCommandRunner(
  options: QualifiedControlledCommandRunnerOptions,
): Promise<ProcessRunner> {
  const leaseManager = await createFileLeaseManager({
    leaseRoot: options.leaseRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    async run(request: ControlledCommandProcessRequest): Promise<ControlledCommandProcessResult> {
      if (!hasDisabledShell(request)) {
        throw new Error("qualified controlled commands never use a shell");
      }
      const nonce = randomUUID().replaceAll("-", "");
      const sessionId = managedProcessSessionIdSchema.parse(`process_verify-${nonce}`);
      const operationId = operationIdSchema.parse(`op_verify-start-${nonce}`);
      const host = createLocalManagedProcessHost({
        leaseManager,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const operationFingerprint = sha256(
        canonicalJson({
          schemaVersion: "hpi-qualified-command.v1",
          sessionId,
          executable: request.executable,
          argv: request.argv,
          cwd: request.cwd,
          environment: request.environment,
          timeoutMs: request.timeoutMs,
          maximumOutputBytes: request.maximumOutputBytes,
        }),
      );
      const started = await host.start(
        managedProcessStartRequestSchema.parse({
          schemaVersion: "hpi-process-start.v1",
          operationId,
          operationFingerprint,
          sessionId,
          executable: request.executable,
          argv: [...request.argv],
          cwd: request.cwd,
          environment: { ...request.environment },
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maximumOutputBytes,
          leases: [],
        }),
      );
      const final = await host.awaitFinal(started.receipt.sessionId);
      const output = await readManagedOutput(
        host,
        started.receipt.sessionId,
        final.receipt.retainedBytes,
      );
      return {
        exitCode: final.receipt.exitCode,
        timedOut: final.receipt.executionObservation === "TIMED_OUT",
        processError: false,
        stdout: output.stdout,
        stderr: output.stderr,
        observedOutputBytes: final.receipt.observedBytes,
        // The process ledger intentionally retains one combined byte budget. If
        // either stream crossed it, conservatively mark both streams truncated.
        stdoutTruncated: final.receipt.truncated,
        stderrTruncated: final.receipt.truncated,
        terminalFinality: final.receipt.terminalFinality,
        processTreeState: final.receipt.processTreeState,
        outputState: final.receipt.outputState,
      };
    },
  };
}
