import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import {
  createFileLeaseManager,
  createLocalManagedProcessHost,
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  managedProcessSessionIdSchema,
  managedProcessStartRequestSchema,
  type ManagedProcessFinalReceipt,
} from "@hunter-pi/execution";
import {
  fingerprintSchema,
  operationIdSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type Fingerprint,
} from "@hunter-pi/domain";

import {
  task6PiProcessResultSchema,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "./task6-engine-host.js";
import { LfOnlyNdjsonDecoder } from "./ndjson.js";

export interface QualifiedPiJsonProcessOptions {
  readonly leaseRoot: string;
  readonly now?: () => string;
}

export class QualifiedPiProcessBlockedError extends Error {
  public readonly reason: "LEASE_CONFLICT" | "PROCESS_FINALITY_NOT_PROVEN";

  public constructor(reason: QualifiedPiProcessBlockedError["reason"], message: string) {
    super(message);
    this.name = "QualifiedPiProcessBlockedError";
    this.reason = reason;
  }
}

function sha256(value: string | Buffer): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function shortFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry[0]),
    ),
  );
}

function resultFromManagedProcess(
  finalReceipt: ManagedProcessFinalReceipt,
  stdout: Buffer,
  stderr: Buffer,
  maximumOutputBytes: number,
): Task6PiProcessResult {
  const outputTruncated = finalReceipt.truncated;
  let eventTypes: string[] = [];
  let recordCount = 0;
  let framingValid =
    finalReceipt.terminalFinality === "FINAL" &&
    !outputTruncated &&
    finalReceipt.executionObservation !== "UNRECONCILED";
  if (framingValid) {
    try {
      const decoder = new LfOnlyNdjsonDecoder(maximumOutputBytes);
      const records = [...decoder.push(stdout), ...decoder.finish()];
      recordCount = records.length;
      eventTypes = records.flatMap((record) => {
        const type = Reflect.get(record, "type");
        return typeof type === "string" ? [type] : [];
      });
    } catch {
      framingValid = false;
    }
  }
  return task6PiProcessResultSchema.parse({
    exitCode:
      finalReceipt.executionObservation === "TIMED_OUT" ? 124 : (finalReceipt.exitCode ?? 1),
    timedOut: finalReceipt.executionObservation === "TIMED_OUT",
    framingValid,
    eventTypes,
    recordCount,
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
    capturedBytes: finalReceipt.retainedBytes,
    outputTruncated,
    terminalFinality: finalReceipt.terminalFinality,
    processTreeState: finalReceipt.processTreeState,
    leaseState: finalReceipt.leaseState,
  });
}

function withContainment(result: Task6PiProcessResult, containment: string): Task6PiProcessResult {
  return task6PiProcessResultSchema.parse({
    ...result,
    containment,
  });
}

async function readManagedOutput(
  host: ReturnType<typeof createLocalManagedProcessHost>,
  sessionId: string,
  maximumOutputBytes: number,
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  const log = await host.read({
    schemaVersion: "hpi-process-log-read.v1",
    sessionId: managedProcessSessionIdSchema.parse(sessionId),
    cursor: 0,
    maxBytes: Math.max(1, maximumOutputBytes),
  });
  const collect = (stream: "STDOUT" | "STDERR"): Buffer =>
    Buffer.concat(
      log.chunks
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    );
  return { stdout: collect("STDOUT"), stderr: collect("STDERR") };
}

export async function createQualifiedPiJsonProcess(
  options: QualifiedPiJsonProcessOptions,
): Promise<(request: Task6PiProcessRequest) => Promise<Task6PiProcessResult>> {
  await mkdir(options.leaseRoot, { recursive: true });
  const now = options.now ?? (() => new Date().toISOString());
  const leaseManager = await createFileLeaseManager({
    leaseRoot: options.leaseRoot,
    now,
  });
  const ownerFingerprint = sha256(
    `hpi-qualified-pi-owner\0${String(process.pid)}\0${randomUUID()}`,
  );
  let invocation = 0;

  return async (request: Task6PiProcessRequest): Promise<Task6PiProcessResult> => {
    invocation += 1;
    const suffix = shortFingerprint(
      JSON.stringify({
        invocation,
        cwd: request.plan.cwd,
        executable: request.plan.executable,
        arguments: request.plan.arguments,
        prompt: request.prompt,
      }),
    );
    const processResource = `pi-process-${shortFingerprint(request.plan.cwd)}`;
    const processWorkspaceId = workspaceIdSchema.parse(
      `workspace_process-${shortFingerprint(request.plan.cwd)}`,
    );
    const leaseId = writerLeaseIdSchema.parse(`lease_pi-process-${suffix}`);
    const acquireOperationId = operationIdSchema.parse(`op_pi-acquire-${suffix}`);
    const releaseOperationId = operationIdSchema.parse(`op_pi-release-${suffix}`);
    const operationFingerprint = sha256(
      JSON.stringify({
        schemaVersion: "hpi-qualified-pi-process.v1",
        processWorkspaceId,
        processResource,
        leaseId,
        request: {
          cwd: request.plan.cwd,
          executable: request.plan.executable,
          arguments: request.plan.arguments,
          prompt: request.prompt,
        },
      }),
    );
    const acquire = await leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: acquireOperationId,
        operationFingerprint,
        leaseId,
        workspaceId: processWorkspaceId,
        ownerFingerprint,
        resources: [processResource],
        ttlMs: Math.min(86_400_000, Math.max(60_000, request.timeoutMs + 60_000)),
      }),
    );
    if (acquire.receipt.outcome !== "ACQUIRED") {
      throw new QualifiedPiProcessBlockedError(
        "LEASE_CONFLICT",
        "another qualified Pi process is already active for the selected workspace",
      );
    }

    const release = async (): Promise<void> => {
      await leaseManager.release(
        leaseReleaseRequestSchema.parse({
          schemaVersion: "hpi-lease-release.v1",
          operationId: releaseOperationId,
          operationFingerprint: sha256(`hpi-qualified-pi-release\0${suffix}`),
          leaseId,
          ownerFingerprint,
          bindingFingerprint: null,
        }),
      );
    };

    const host = createLocalManagedProcessHost({ leaseManager, now });
    const sessionId = managedProcessSessionIdSchema.parse(`process_pi-${suffix}`);
    const operationId = operationIdSchema.parse(`op_pi-start-${suffix}`);
    const processRequest = managedProcessStartRequestSchema.parse({
      schemaVersion: "hpi-process-start.v1",
      operationId,
      operationFingerprint: sha256(`hpi-qualified-pi-start\0${suffix}`),
      sessionId,
      executable: request.plan.executable,
      argv: [...request.plan.arguments, "--mode", "json", "--no-session", request.prompt],
      cwd: request.plan.cwd,
      environment: { ...inheritedEnvironment(), ...request.plan.environment },
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maximumOutputBytes,
      // The qualified-process lease is held by this adapter for the entire
      // process session. The managed process host still proves OS containment
      // and terminal finality; it does not own this outer workspace slot.
      leases: [],
    });

    let releaseNeeded = true;
    try {
      const started = await host.start(processRequest);
      const final = await host.awaitFinal(started.receipt.sessionId);
      const output = await readManagedOutput(host, sessionId, request.maximumOutputBytes);
      const result = resultFromManagedProcess(
        final.receipt,
        output.stdout,
        output.stderr,
        request.maximumOutputBytes,
      );
      if (final.receipt.terminalFinality !== "FINAL") {
        throw new QualifiedPiProcessBlockedError(
          "PROCESS_FINALITY_NOT_PROVEN",
          "the qualified Pi process did not reach reconciled terminal finality",
        );
      }
      await release();
      releaseNeeded = false;
      return withContainment({ ...result, leaseState: "RELEASED" }, started.receipt.containment);
    } finally {
      if (releaseNeeded) {
        await release().catch(() => undefined);
      }
    }
  };
}
