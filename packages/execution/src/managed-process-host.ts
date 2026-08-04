import { createHash, type Hash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";

import type { LeaseManager } from "./contracts.js";
import { ManagedProcessError } from "./process-errors.js";
import {
  managedProcessCancelReceiptSchema,
  managedProcessCancelRequestSchema,
  managedProcessFinalReceiptSchema,
  managedProcessHeartbeatReceiptSchema,
  managedProcessLogReadRequestSchema,
  managedProcessLogReceiptSchema,
  managedProcessSessionIdSchema,
  managedProcessStartReceiptSchema,
  managedProcessStartRequestSchema,
  type ManagedProcessCancelReceipt,
  type ManagedProcessFinalReason,
  type ManagedProcessFinalReceipt,
  type ManagedProcessHeartbeatReceipt,
  type ManagedProcessHost,
  type ManagedProcessLeaseBinding,
  type ManagedProcessLogChunk,
  type ManagedProcessSessionId,
  type ManagedProcessStartReceipt,
  type ManagedProcessStartRequest,
} from "./process-contracts.js";
import {
  driverCancelResultSchema,
  driverSnapshotSchema,
  parseDriverIdentity,
  parseProcessContainment,
  type DriverSnapshot,
  type ManagedProcessDriver,
  type ManagedProcessDriverSession,
} from "./process-platform.js";

interface ManagedProcessHostOptions {
  readonly driver: ManagedProcessDriver;
  readonly leaseManager: LeaseManager;
  readonly now?: () => string;
}

interface OutputFrame {
  readonly stream: "STDOUT" | "STDERR";
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly data: Buffer;
}

interface OutputLedger {
  readonly hash: Hash;
  readonly frames: OutputFrame[];
  observedBytes: number;
  retainedBytes: number;
  readonly maxOutputBytes: number;
}

interface SessionRecord {
  readonly request: ManagedProcessStartRequest;
  readonly requestFingerprint: Fingerprint;
  readonly receipt: ManagedProcessStartReceipt;
  readonly driver: ManagedProcessDriverSession;
  readonly output: OutputLedger;
  readonly leases: readonly ManagedProcessLeaseBinding[];
  readonly leaseBindingFingerprint: Fingerprint | null;
  readonly cancelOperations: Map<
    string,
    {
      readonly operationFingerprint: Fingerprint;
      readonly requestFingerprint: Fingerprint;
      readonly receipt: ManagedProcessCancelReceipt;
    }
  >;
  finalPromise?: Promise<{ readonly receipt: ManagedProcessFinalReceipt }>;
  finalReceipt?: ManagedProcessFinalReceipt;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: string | Buffer): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function outputDigest(output: OutputLedger): Fingerprint {
  return fingerprintSchema.parse(`sha256:${output.hash.copy().digest("hex")}`);
}

async function requirePhysicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ManagedProcessError("PROCESS_CWD_INVALID", "process cwd must be absolute");
  }
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ManagedProcessError("PROCESS_CWD_INVALID", "process cwd must be physical");
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw new ManagedProcessError("PROCESS_CWD_INVALID", "process cwd must not use an alias");
  }
  return canonical;
}

function captureOutput(output: OutputLedger, stream: "STDOUT" | "STDERR", chunk: Buffer): void {
  if (chunk.length === 0) return;
  output.hash.update(`${stream}\0${String(chunk.length)}\0`, "utf8");
  output.hash.update(chunk);
  output.observedBytes += chunk.length;
  const available = Math.max(0, output.maxOutputBytes - output.retainedBytes);
  if (available === 0) return;
  const retained = Buffer.from(chunk.subarray(0, available));
  const cursorStart = output.retainedBytes;
  output.retainedBytes += retained.length;
  output.frames.push({
    stream,
    cursorStart,
    cursorEnd: output.retainedBytes,
    data: retained,
  });
}

function outputState(snapshot: DriverSnapshot): "OPEN" | "CLOSED" | "NOT_PROVEN" {
  if (snapshot.stdoutState === "NOT_PROVEN" || snapshot.stderrState === "NOT_PROVEN") {
    return "NOT_PROVEN";
  }
  return snapshot.stdoutState === "CLOSED" && snapshot.stderrState === "CLOSED" ? "CLOSED" : "OPEN";
}

function executionObservation(
  snapshot: DriverSnapshot,
): "EXITED" | "CANCELLED" | "TIMED_OUT" | "UNRECONCILED" {
  if (snapshot.identityState !== "MATCH" || snapshot.phase === "UNRECONCILED") {
    return "UNRECONCILED";
  }
  if (snapshot.terminationCause === "CANCEL") return "CANCELLED";
  if (snapshot.terminationCause === "TIMEOUT") return "TIMED_OUT";
  return "EXITED";
}

class InMemoryManagedProcessHost implements ManagedProcessHost {
  readonly #driver: ManagedProcessDriver;
  readonly #leaseManager: LeaseManager;
  readonly #now: () => string;
  readonly #sessions = new Map<ManagedProcessSessionId, SessionRecord>();
  readonly #startOperations = new Map<
    string,
    {
      readonly operationFingerprint: Fingerprint;
      readonly requestFingerprint: Fingerprint;
      readonly sessionId: ManagedProcessSessionId;
      readonly receipt: ManagedProcessStartReceipt;
    }
  >();

  public constructor(options: ManagedProcessHostOptions) {
    this.#driver = options.driver;
    this.#leaseManager = options.leaseManager;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async start(
    request: ManagedProcessStartRequest,
  ): Promise<{ readonly receipt: ManagedProcessStartReceipt }> {
    const parsed = managedProcessStartRequestSchema.parse(request);
    const cwd = await requirePhysicalDirectory(parsed.cwd);
    const requestFingerprint = sha256(
      canonicalJson({
        ...parsed,
        cwd,
        environment: Object.fromEntries(Object.entries(parsed.environment).sort()),
      }),
    );
    const replay = this.#startOperations.get(parsed.operationId);
    if (replay !== undefined) {
      if (
        replay.operationFingerprint !== parsed.operationFingerprint ||
        replay.requestFingerprint !== requestFingerprint
      ) {
        throw new ManagedProcessError(
          "PROCESS_OPERATION_CONFLICT",
          "process start replay changed its fingerprint or canonical request",
        );
      }
      return { receipt: replay.receipt };
    }
    if (this.#sessions.has(parsed.sessionId)) {
      throw new ManagedProcessError("PROCESS_SESSION_CONFLICT", "process session already exists");
    }
    const observedAt = timestampSchema.parse(this.#now());
    const leaseBindingFingerprint =
      parsed.leases.length === 0
        ? null
        : sha256(
            canonicalJson({
              schemaVersion: "hpi-process-lease-binding.v1",
              sessionId: parsed.sessionId,
              operationId: parsed.operationId,
              operationFingerprint: parsed.operationFingerprint,
              requestFingerprint,
            }),
          );
    if (
      leaseBindingFingerprint !== null &&
      parsed.leaseBindOperationId !== null &&
      parsed.leaseBindOperationFingerprint !== null
    ) {
      try {
        await this.#leaseManager.bind({
          schemaVersion: "hpi-lease-bind.v1",
          operationId: parsed.leaseBindOperationId,
          operationFingerprint: parsed.leaseBindOperationFingerprint,
          bindingFingerprint: leaseBindingFingerprint,
          leases: parsed.leases.map((binding) => ({
            leaseId: binding.leaseId,
            ownerFingerprint: binding.ownerFingerprint,
          })),
        });
        for (const binding of parsed.leases) {
          const status = await this.#leaseManager.inspect(binding.leaseId);
          if (
            status.receipt.state !== "ACTIVE" ||
            status.receipt.ownerFingerprint !== binding.ownerFingerprint ||
            status.receipt.bindingFingerprint !== leaseBindingFingerprint
          ) {
            throw new Error("bound lease state did not match the process session");
          }
        }
      } catch (error) {
        throw new ManagedProcessError(
          "PROCESS_LEASE_INVALID",
          "process leases could not be atomically bound to the declared session",
          error,
        );
      }
    }

    const output: OutputLedger = {
      hash: createHash("sha256"),
      frames: [],
      observedBytes: 0,
      retainedBytes: 0,
      maxOutputBytes: parsed.maxOutputBytes,
    };
    let driver: ManagedProcessDriverSession;
    try {
      driver = await this.#driver.start({
        executable: parsed.executable,
        argv: parsed.argv,
        cwd,
        environment: parsed.environment,
        timeoutMs: parsed.timeoutMs,
        onOutput: (stream, chunk) => {
          captureOutput(output, stream, chunk);
        },
      });
    } catch (error) {
      if (leaseBindingFingerprint !== null) {
        await Promise.all(
          parsed.leases.map((binding) =>
            this.#leaseManager.release({
              schemaVersion: "hpi-lease-release.v1",
              operationId: binding.releaseOperationId,
              operationFingerprint: binding.releaseOperationFingerprint,
              leaseId: binding.leaseId,
              ownerFingerprint: binding.ownerFingerprint,
              bindingFingerprint: leaseBindingFingerprint,
            }),
          ),
        ).catch(() => undefined);
      }
      throw error;
    }
    const identityFingerprint = parseDriverIdentity(driver.identityFingerprint);
    const containment = parseProcessContainment(driver.containment);
    const receipt = managedProcessStartReceiptSchema.parse({
      schemaVersion: "hpi-process-start-receipt.v1",
      action: "START",
      outcome: "STARTED",
      sessionId: parsed.sessionId,
      operationFingerprint: parsed.operationFingerprint,
      commandFingerprint: sha256(canonicalJson([parsed.executable, ...parsed.argv])),
      cwdFingerprint: sha256(cwd),
      environmentFingerprint: sha256(canonicalJson(parsed.environment)),
      processIdentityFingerprint: identityFingerprint,
      containment,
      leaseCount: parsed.leases.length,
      terminalFinality: "PENDING",
      observedAt,
    });
    const session: SessionRecord = {
      request: parsed,
      requestFingerprint,
      receipt,
      driver,
      output,
      leases: parsed.leases,
      leaseBindingFingerprint,
      cancelOperations: new Map(),
    };
    this.#sessions.set(parsed.sessionId, session);
    this.#startOperations.set(parsed.operationId, {
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint,
      sessionId: parsed.sessionId,
      receipt,
    });
    return { receipt };
  }

  public async read(request: unknown): Promise<{
    readonly chunks: readonly ManagedProcessLogChunk[];
    readonly receipt: ReturnType<typeof managedProcessLogReceiptSchema.parse>;
  }> {
    const parsed = managedProcessLogReadRequestSchema.parse(request);
    const session = this.#requireSession(parsed.sessionId);
    if (parsed.cursor > session.output.retainedBytes) {
      throw new ManagedProcessError("PROCESS_LOG_CURSOR_INVALID", "log cursor is unavailable");
    }
    const limit = Math.min(session.output.retainedBytes, parsed.cursor + parsed.maxBytes);
    const chunks: ManagedProcessLogChunk[] = [];
    for (const frame of session.output.frames) {
      const cursorStart = Math.max(frame.cursorStart, parsed.cursor);
      const cursorEnd = Math.min(frame.cursorEnd, limit);
      if (cursorEnd <= cursorStart) continue;
      const startOffset = cursorStart - frame.cursorStart;
      const endOffset = cursorEnd - frame.cursorStart;
      chunks.push({
        stream: frame.stream,
        cursorStart,
        cursorEnd,
        dataBase64: frame.data.subarray(startOffset, endOffset).toString("base64"),
      });
    }
    const returnedBytes = chunks.reduce(
      (total, chunk) => total + chunk.cursorEnd - chunk.cursorStart,
      0,
    );
    const nextCursor = parsed.cursor + returnedBytes;
    const snapshot = driverSnapshotSchema.parse(await session.driver.snapshot());
    return {
      chunks,
      receipt: managedProcessLogReceiptSchema.parse({
        schemaVersion: "hpi-process-log-receipt.v1",
        sessionId: parsed.sessionId,
        cursor: parsed.cursor,
        nextCursor,
        returnedBytes,
        retainedBytes: session.output.retainedBytes,
        observedBytes: session.output.observedBytes,
        outputDigest: outputDigest(session.output),
        truncated: session.output.observedBytes > session.output.retainedBytes,
        eof: outputState(snapshot) === "CLOSED" && nextCursor === session.output.retainedBytes,
        observedAt: timestampSchema.parse(this.#now()),
      }),
    };
  }

  public async heartbeat(
    sessionId: ManagedProcessSessionId,
  ): Promise<{ readonly receipt: ManagedProcessHeartbeatReceipt }> {
    const parsedSessionId = managedProcessSessionIdSchema.parse(sessionId);
    const session = this.#requireSession(parsedSessionId);
    if (session.finalReceipt !== undefined) {
      return {
        receipt: managedProcessHeartbeatReceiptSchema.parse({
          schemaVersion: "hpi-process-heartbeat.v1",
          sessionId: parsedSessionId,
          state: session.finalReceipt.terminalFinality === "FINAL" ? "FINAL" : "UNRECONCILED",
          exitCode: session.finalReceipt.exitCode,
          terminationCause:
            session.finalReceipt.executionObservation === "CANCELLED"
              ? "CANCEL"
              : session.finalReceipt.executionObservation === "TIMED_OUT"
                ? "TIMEOUT"
                : "NONE",
          identityState:
            session.finalReceipt.executionObservation === "UNRECONCILED" ? "NOT_PROVEN" : "MATCH",
          processTreeState: session.finalReceipt.processTreeState,
          outputState: session.finalReceipt.outputState,
          leaseState: session.finalReceipt.leaseState,
          terminalFinality: session.finalReceipt.terminalFinality,
          observedAt: timestampSchema.parse(this.#now()),
        }),
      };
    }
    const snapshot = driverSnapshotSchema.parse(await session.driver.snapshot());
    const leaseState = await this.#leaseState(session);
    let state: ManagedProcessHeartbeatReceipt["state"];
    if (snapshot.identityState !== "MATCH" || snapshot.phase === "UNRECONCILED") {
      state = "UNRECONCILED";
    } else if (snapshot.terminationCause === "TIMEOUT") {
      state = "TIMED_OUT";
    } else if (snapshot.terminationCause === "CANCEL") {
      state = "CANCELLED";
    } else if (snapshot.phase === "RUNNING") {
      state = "LIVE";
    } else {
      state = "EXITED";
    }
    return {
      receipt: managedProcessHeartbeatReceiptSchema.parse({
        schemaVersion: "hpi-process-heartbeat.v1",
        sessionId: parsedSessionId,
        state,
        exitCode: snapshot.exitCode,
        terminationCause: snapshot.terminationCause,
        identityState: snapshot.identityState,
        processTreeState: snapshot.treeState,
        outputState: outputState(snapshot),
        leaseState,
        terminalFinality: "PENDING",
        observedAt: timestampSchema.parse(this.#now()),
      }),
    };
  }

  public async cancel(
    request: unknown,
  ): Promise<{ readonly receipt: ManagedProcessCancelReceipt }> {
    const parsed = managedProcessCancelRequestSchema.parse(request);
    const session = this.#requireSession(parsed.sessionId);
    const requestFingerprint = sha256(
      canonicalJson({
        schemaVersion: parsed.schemaVersion,
        sessionId: parsed.sessionId,
        reason: parsed.reason,
      }),
    );
    const replay = session.cancelOperations.get(parsed.operationId);
    if (replay !== undefined) {
      if (
        replay.operationFingerprint !== parsed.operationFingerprint ||
        replay.requestFingerprint !== requestFingerprint
      ) {
        throw new ManagedProcessError(
          "PROCESS_OPERATION_CONFLICT",
          "process cancel replay changed its fingerprint or canonical request",
        );
      }
      return { receipt: replay.receipt };
    }
    const result = driverCancelResultSchema.parse(
      await session.driver.cancel(session.receipt.processIdentityFingerprint, parsed.reason),
    );
    const identityState =
      result.outcome === "ACKNOWLEDGED"
        ? "MATCH"
        : result.outcome === "IDENTITY_MISMATCH"
          ? "MISMATCH"
          : "NOT_PROVEN";
    const receipt = managedProcessCancelReceiptSchema.parse({
      schemaVersion: "hpi-process-cancel-receipt.v1",
      action: "CANCEL",
      outcome: result.outcome === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "NOT_PROVEN",
      sessionId: parsed.sessionId,
      identityState,
      terminationAcknowledged: result.outcome === "ACKNOWLEDGED",
      terminalFinality: "PENDING",
      observedAt: timestampSchema.parse(this.#now()),
    });
    session.cancelOperations.set(parsed.operationId, {
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint,
      receipt,
    });
    return { receipt };
  }

  public async awaitFinal(
    sessionId: ManagedProcessSessionId,
  ): Promise<{ readonly receipt: ManagedProcessFinalReceipt }> {
    const parsedSessionId = managedProcessSessionIdSchema.parse(sessionId);
    const session = this.#requireSession(parsedSessionId);
    session.finalPromise ??= this.#finalize(session);
    return session.finalPromise;
  }

  async #finalize(
    session: SessionRecord,
  ): Promise<{ readonly receipt: ManagedProcessFinalReceipt }> {
    const snapshot = driverSnapshotSchema.parse(await session.driver.waitForSettlement());
    const reasons: ManagedProcessFinalReason[] = [];
    if (snapshot.phase === "UNRECONCILED") reasons.push("DRIVER_UNRECONCILED");
    if (snapshot.identityState === "MISMATCH") reasons.push("IDENTITY_MISMATCH");
    if (snapshot.identityState === "NOT_PROVEN") reasons.push("DRIVER_UNRECONCILED");
    if (snapshot.treeState === "ACTIVE") reasons.push("PROCESS_TREE_NOT_EMPTY");
    if (snapshot.treeState === "NOT_PROVEN") reasons.push("PROCESS_TREE_NOT_PROVEN");
    if (outputState(snapshot) !== "CLOSED") reasons.push("OUTPUT_NOT_CLOSED");
    if (snapshot.phase !== "TERMINAL" && snapshot.phase !== "UNRECONCILED") {
      reasons.push("DRIVER_UNRECONCILED");
    }

    let leaseState: ManagedProcessFinalReceipt["leaseState"] =
      session.leases.length === 0 ? "NOT_REQUIRED" : "HELD";
    if (reasons.length === 0 && session.leases.length > 0) {
      try {
        for (const binding of session.leases) {
          await this.#leaseManager.release({
            schemaVersion: "hpi-lease-release.v1",
            operationId: binding.releaseOperationId,
            operationFingerprint: binding.releaseOperationFingerprint,
            leaseId: binding.leaseId,
            ownerFingerprint: binding.ownerFingerprint,
            bindingFingerprint: session.leaseBindingFingerprint,
          });
        }
        leaseState = "RELEASED";
      } catch {
        reasons.push("LEASE_RELEASE_FAILED");
        leaseState = "NOT_PROVEN";
      }
    }
    const uniqueReasons = [...new Set(reasons)];
    const receipt = managedProcessFinalReceiptSchema.parse({
      schemaVersion: "hpi-process-final-receipt.v1",
      sessionId: session.request.sessionId,
      executionObservation: executionObservation(snapshot),
      exitCode: snapshot.exitCode,
      processTreeState: snapshot.treeState,
      outputState: outputState(snapshot),
      leaseState,
      observedBytes: session.output.observedBytes,
      retainedBytes: session.output.retainedBytes,
      outputDigest: outputDigest(session.output),
      truncated: session.output.observedBytes > session.output.retainedBytes,
      terminalFinality: uniqueReasons.length === 0 ? "FINAL" : "NOT_PROVEN",
      reasonCodes: uniqueReasons,
      observedAt: timestampSchema.parse(this.#now()),
    });
    session.finalReceipt = receipt;
    return { receipt };
  }

  async #leaseState(
    session: SessionRecord,
  ): Promise<"HELD" | "RELEASED" | "NOT_REQUIRED" | "NOT_PROVEN"> {
    if (session.leases.length === 0) return "NOT_REQUIRED";
    try {
      const states = await Promise.all(
        session.leases.map(
          async (binding) => (await this.#leaseManager.inspect(binding.leaseId)).receipt,
        ),
      );
      if (
        states.every(
          (receipt) => receipt.state === "RELEASED" && receipt.bindingFingerprint === null,
        )
      ) {
        return "RELEASED";
      }
      if (
        session.leaseBindingFingerprint !== null &&
        states.every(
          (receipt) =>
            (receipt.state === "ACTIVE" || receipt.state === "EXPIRED") &&
            receipt.bindingFingerprint === session.leaseBindingFingerprint,
        )
      ) {
        return "HELD";
      }
      return "NOT_PROVEN";
    } catch {
      return "NOT_PROVEN";
    }
  }

  #requireSession(sessionId: ManagedProcessSessionId): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new ManagedProcessError("PROCESS_SESSION_NOT_FOUND", "process session is unknown");
    }
    return session;
  }
}

export function createManagedProcessHost(options: ManagedProcessHostOptions): ManagedProcessHost {
  return new InMemoryManagedProcessHost(options);
}
