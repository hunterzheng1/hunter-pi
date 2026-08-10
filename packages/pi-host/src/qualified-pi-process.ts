import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { URL } from "node:url";

import {
  createFileLeaseManager,
  createLocalManagedProcessHost,
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  managedProcessCancelRequestSchema,
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
  type Task6PiProcessRunner,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "./task6-engine-host.js";
import { LfOnlyNdjsonDecoder } from "./ndjson.js";
import { accountPiProviderUsage, unavailablePiProviderUsage } from "./provider-usage.js";

export interface QualifiedPiJsonProcessOptions {
  readonly leaseRoot: string;
  readonly now?: () => string;
}

export class QualifiedPiProcessBlockedError extends Error {
  public readonly reason:
    | "LEASE_CONFLICT"
    | "PROCESS_FINALITY_NOT_PROVEN"
    | "FORCED_INTERRUPTION_NOT_PROVEN"
    | "RUNTIME_CONFIGURATION_NOT_PROVEN"
    | "RUNTIME_SNAPSHOT_CLEANUP_FAILED"
    | "LEASE_RELEASE_NOT_PROVEN";

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
  const inherited: Record<string, string> = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

function removeCredentialedProxyEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name === "HTTP_PROXY" || name === "HTTPS_PROXY") {
      try {
        const parsed = new URL(value);
        if (
          (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          parsed.username !== "" ||
          parsed.password !== ""
        ) {
          continue;
        }
      } catch {
        continue;
      }
    }
    sanitized[name] = value;
  }
  return sanitized;
}

interface QualifiedPiRuntimeSnapshot {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
}

const maximumRuntimeConfigurationBytes = 4 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readExactOptionalFile(path: string): Promise<Buffer | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new QualifiedPiProcessBlockedError(
      "RUNTIME_CONFIGURATION_NOT_PROVEN",
      "the Pi runtime snapshot source contains an aliased or non-regular file",
    );
  }
  if (!Number.isSafeInteger(stats.size) || stats.size > maximumRuntimeConfigurationBytes) {
    throw new QualifiedPiProcessBlockedError(
      "RUNTIME_CONFIGURATION_NOT_PROVEN",
      "the Pi runtime snapshot source exceeds its finite configuration limit",
    );
  }
  return readFile(path);
}

async function prepareQualifiedPiRuntimeSnapshot(
  leaseRoot: string,
  environment: Readonly<Record<string, string>>,
  selectedProvider: string | undefined,
): Promise<QualifiedPiRuntimeSnapshot> {
  const snapshotsRoot = join(dirname(resolve(leaseRoot)), "pi-runtime-snapshots");
  let directory: string | undefined;
  try {
    await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
    const snapshotsRootStats = await lstat(snapshotsRoot);
    if (
      snapshotsRootStats.isSymbolicLink() ||
      !snapshotsRootStats.isDirectory() ||
      (await realpath(snapshotsRoot)) !== snapshotsRoot
    ) {
      throw new QualifiedPiProcessBlockedError(
        "RUNTIME_CONFIGURATION_NOT_PROVEN",
        "the Pi runtime snapshot root is not one exact physical directory",
      );
    }
    directory = await mkdtemp(join(snapshotsRoot, "pi-runtime-"));
    const configuredDirectory = environment["PI_CODING_AGENT_DIR"];
    let sourceDirectory: string | undefined;
    if (configuredDirectory !== undefined) {
      sourceDirectory = resolve(configuredDirectory);
      const stats = await lstat(sourceDirectory);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(sourceDirectory)) !== sourceDirectory
      ) {
        throw new QualifiedPiProcessBlockedError(
          "RUNTIME_CONFIGURATION_NOT_PROVEN",
          "the Pi runtime snapshot source is not one exact physical directory",
        );
      }
    }

    const boundedSettings = {
      retry: {
        enabled: false,
        maxRetries: 0,
        provider: { maxRetries: 0 },
      },
      compaction: { enabled: false },
    };
    await writeFile(join(directory, "settings.json"), `${JSON.stringify(boundedSettings)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    if (sourceDirectory !== undefined) {
      const auth = await readExactOptionalFile(join(sourceDirectory, "auth.json"));
      const models = await readExactOptionalFile(join(sourceDirectory, "models.json"));
      if ((auth !== undefined || models !== undefined) && selectedProvider === undefined) {
        throw new QualifiedPiProcessBlockedError(
          "RUNTIME_CONFIGURATION_NOT_PROVEN",
          "the selected Provider is unavailable for the bounded Pi runtime snapshot",
        );
      }
      if (auth !== undefined && selectedProvider !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(auth.toString("utf8"));
        } catch {
          parsed = undefined;
        }
        if (!isPlainObject(parsed)) {
          throw new QualifiedPiProcessBlockedError(
            "RUNTIME_CONFIGURATION_NOT_PROVEN",
            "the Pi authentication store cannot be snapshotted safely",
          );
        }
        const selectedCredential = parsed[selectedProvider];
        await writeFile(
          join(directory, "auth.json"),
          `${JSON.stringify(
            selectedCredential === undefined ? {} : { [selectedProvider]: selectedCredential },
          )}\n`,
          { flag: "wx", mode: 0o600 },
        );
      }
      if (models !== undefined && selectedProvider !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(models.toString("utf8"));
        } catch {
          parsed = undefined;
        }
        if (!isPlainObject(parsed) || !isPlainObject(parsed["providers"])) {
          throw new QualifiedPiProcessBlockedError(
            "RUNTIME_CONFIGURATION_NOT_PROVEN",
            "the Pi model store cannot be snapshotted safely",
          );
        }
        const selectedConfiguration = parsed["providers"][selectedProvider];
        await writeFile(
          join(directory, "models.json"),
          `${JSON.stringify({
            providers:
              selectedConfiguration === undefined
                ? {}
                : { [selectedProvider]: selectedConfiguration },
          })}\n`,
          { flag: "wx", mode: 0o600 },
        );
      }
    }
    return {
      directory,
      environment: { ...environment, PI_CODING_AGENT_DIR: directory },
    };
  } catch (error) {
    if (directory !== undefined) {
      try {
        await rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        throw new QualifiedPiProcessBlockedError(
          "RUNTIME_SNAPSHOT_CLEANUP_FAILED",
          "the temporary Pi runtime snapshot could not be removed",
        );
      }
    }
    if (error instanceof QualifiedPiProcessBlockedError) throw error;
    throw new QualifiedPiProcessBlockedError(
      "RUNTIME_CONFIGURATION_NOT_PROVEN",
      "the Pi runtime configuration cannot be snapshotted safely",
    );
  }
}

function selectedProviderFromPlan(request: Task6PiProcessRequest): string | undefined {
  const providers: string[] = [];
  for (let index = 0; index < request.plan.arguments.length; index += 1) {
    if (request.plan.arguments[index] !== "--provider") continue;
    const provider = request.plan.arguments[index + 1];
    if (provider !== undefined && provider.length > 0) providers.push(provider);
  }
  const pinnedProvider = request.plan.environment["HUNTER_PI_PINNED_PROVIDER"];
  if (pinnedProvider !== undefined) providers.push(pinnedProvider);
  const unique = [...new Set(providers)];
  if (unique.length > 1) {
    throw new QualifiedPiProcessBlockedError(
      "RUNTIME_CONFIGURATION_NOT_PROVEN",
      "the qualified Pi plan contains conflicting Provider selections",
    );
  }
  return unique[0];
}

async function removeQualifiedPiRuntimeSnapshot(
  snapshot: QualifiedPiRuntimeSnapshot,
): Promise<void> {
  try {
    await rm(snapshot.directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    throw new QualifiedPiProcessBlockedError(
      "RUNTIME_SNAPSHOT_CLEANUP_FAILED",
      "the temporary Pi runtime snapshot could not be removed",
    );
  }
}

function resultFromManagedProcess(
  finalReceipt: ManagedProcessFinalReceipt,
  stdout: Buffer,
  stderr: Buffer,
  maximumOutputBytes: number,
  forcedInterruption?: Task6PiProcessResult["interruption"],
): Task6PiProcessResult {
  const outputTruncated = finalReceipt.truncated;
  let eventTypes: string[] = [];
  let recordCount = 0;
  let providerUsage = unavailablePiProviderUsage();
  let framingValid =
    finalReceipt.terminalFinality === "FINAL" &&
    !outputTruncated &&
    finalReceipt.executionObservation !== "UNRECONCILED";
  if (framingValid) {
    try {
      const decoder = new LfOnlyNdjsonDecoder(maximumOutputBytes);
      const records = [...decoder.push(stdout), ...decoder.finish()];
      recordCount = records.length;
      providerUsage = accountPiProviderUsage(
        records,
        forcedInterruption !== undefined
          ? "TRANSPORT_RETRIES_DISABLED_AND_AGENT_END_MARKER"
          : "TRANSPORT_RETRIES_DISABLED",
      );
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
    providerUsage,
    ...(forcedInterruption === undefined ? {} : { interruption: forcedInterruption }),
    terminalFinality: finalReceipt.terminalFinality,
    processTreeState: finalReceipt.processTreeState,
    leaseState: finalReceipt.leaseState,
  });
}

async function waitForExactInterruptionMarker(
  host: ReturnType<typeof createLocalManagedProcessHost>,
  sessionId: string,
  nonce: string,
  maximumOutputBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expectedLine = `HPI_AGENT_END_MARKER:${nonce}`;
  while (!signal.aborted && Date.now() <= deadline) {
    const output = await readManagedOutput(host, sessionId, maximumOutputBytes);
    if (output.stderr.toString("utf8").split("\n").includes(expectedLine)) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  if (signal.aborted) return;
  throw new QualifiedPiProcessBlockedError(
    "FORCED_INTERRUPTION_NOT_PROVEN",
    "the qualified Pi interruption boundary was not observed before its deadline",
  );
}

function withContainment(result: Task6PiProcessResult, containment: string): Task6PiProcessResult {
  return task6PiProcessResultSchema.parse({
    ...result,
    containment,
  });
}

function hasExactManagedProcessFinality(receipt: ManagedProcessFinalReceipt): boolean {
  return (
    receipt.terminalFinality === "FINAL" &&
    receipt.processTreeState === "EMPTY" &&
    receipt.outputState === "CLOSED"
  );
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
): Promise<Task6PiProcessRunner> {
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

  return async (request, boundary): Promise<Task6PiProcessResult> => {
    invocation += 1;
    const suffix = shortFingerprint(
      JSON.stringify({
        ownerFingerprint,
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
      const released = await leaseManager.release(
        leaseReleaseRequestSchema.parse({
          schemaVersion: "hpi-lease-release.v1",
          operationId: releaseOperationId,
          operationFingerprint: sha256(`hpi-qualified-pi-release\0${suffix}`),
          leaseId,
          ownerFingerprint,
          bindingFingerprint: null,
        }),
      );
      if (released.receipt.outcome !== "RELEASED") {
        throw new QualifiedPiProcessBlockedError(
          "LEASE_RELEASE_NOT_PROVEN",
          "the qualified Pi process lease was not released exactly",
        );
      }
    };

    let runtimeSnapshot: QualifiedPiRuntimeSnapshot | undefined;
    const host = createLocalManagedProcessHost({ leaseManager, now });
    const sessionId = managedProcessSessionIdSchema.parse(`process_pi-${suffix}`);
    const operationId = operationIdSchema.parse(`op_pi-start-${suffix}`);
    let releaseNeeded = true;
    let managedProcessFinalityProven = false;
    let finalizeManagedProcessAfterFailure: (() => Promise<boolean>) | undefined;
    try {
      runtimeSnapshot = await prepareQualifiedPiRuntimeSnapshot(
        options.leaseRoot,
        request.plan.environment,
        selectedProviderFromPlan(request),
      );
      const forcedInterruptionNonce =
        request.forcedInterruption === undefined ? undefined : randomUUID();
      const interruptionResult =
        request.forcedInterruption === undefined
          ? undefined
          : request.forcedInterruption === "AFTER_AGENT_END_TERMINAL_CLOSE_SIMULATION"
            ? ("TERMINAL_CLOSE_SIMULATION_AFTER_AGENT_END" as const)
            : request.forcedInterruption === "AFTER_AGENT_END_POWER_LOSS_SIMULATION"
              ? ("POWER_LOSS_SIMULATION_AFTER_AGENT_END" as const)
              : ("FORCED_PROCESS_KILL_AFTER_AGENT_END" as const);
      const interruptionCancelReason =
        request.forcedInterruption === "AFTER_AGENT_END_POWER_LOSS_SIMULATION"
          ? ("TIMEOUT" as const)
          : request.forcedInterruption === "AFTER_AGENT_END_TERMINAL_CLOSE_SIMULATION"
            ? ("USER_REQUEST" as const)
            : ("POLICY" as const);
      const processRequest = managedProcessStartRequestSchema.parse({
        schemaVersion: "hpi-process-start.v1",
        operationId,
        operationFingerprint: sha256(`hpi-qualified-pi-start\0${suffix}`),
        sessionId,
        executable: request.plan.executable,
        argv: [...request.plan.arguments, "--mode", "json", "--no-session", request.prompt],
        cwd: request.plan.cwd,
        environment: removeCredentialedProxyEnvironment({
          ...inheritedEnvironment(),
          ...runtimeSnapshot.environment,
          ...(forcedInterruptionNonce === undefined
            ? {}
            : {
                HUNTER_PI_INTERRUPTION_NONCE: forcedInterruptionNonce,
              }),
        }),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maximumOutputBytes,
        // The qualified-process lease is held by this adapter for the entire
        // process session. The managed process host still proves OS containment
        // and terminal finality; it does not own this outer workspace slot.
        leases: [],
      });
      await boundary?.beforeExternalOperation();
      const started = await host.start(processRequest);
      let cancellationRequested = false;
      const finalPromise = host.awaitFinal(started.receipt.sessionId).then((final) => {
        managedProcessFinalityProven = hasExactManagedProcessFinality(final.receipt);
        return final;
      });
      const finalizeAfterFailure = async (): Promise<boolean> => {
        if (managedProcessFinalityProven) return true;
        try {
          if (!cancellationRequested) {
            await host.cancel(
              managedProcessCancelRequestSchema.parse({
                schemaVersion: "hpi-process-cancel.v1",
                operationId: operationIdSchema.parse(`op_pi-cleanup-${suffix}`),
                operationFingerprint: sha256(`hpi-qualified-pi-cleanup\0${suffix}`),
                sessionId,
                reason: "POLICY",
              }),
            );
          }
          const cleanupFinal = await host.awaitFinal(sessionId);
          managedProcessFinalityProven = hasExactManagedProcessFinality(cleanupFinal.receipt);
        } catch {
          managedProcessFinalityProven = false;
        }
        return managedProcessFinalityProven;
      };
      finalizeManagedProcessAfterFailure = finalizeAfterFailure;
      let result: Task6PiProcessResult;
      try {
        let forcedInterruptionProven = false;
        if (forcedInterruptionNonce !== undefined) {
          const boundaryAbort = new AbortController();
          const boundary = waitForExactInterruptionMarker(
            host,
            sessionId,
            forcedInterruptionNonce,
            request.maximumOutputBytes,
            request.timeoutMs,
            boundaryAbort.signal,
          );
          const winner = await Promise.race([
            boundary.then(() => "MARKER" as const),
            finalPromise.then(() => "FINAL" as const),
          ]);
          boundaryAbort.abort();
          if (winner !== "MARKER") {
            throw new QualifiedPiProcessBlockedError(
              "FORCED_INTERRUPTION_NOT_PROVEN",
              "the qualified Pi process ended before the forced interruption boundary",
            );
          }
          const cancelled = await host.cancel(
            managedProcessCancelRequestSchema.parse({
              schemaVersion: "hpi-process-cancel.v1",
              operationId: operationIdSchema.parse(`op_pi-cancel-${suffix}`),
              operationFingerprint: sha256(`hpi-qualified-pi-cancel\0${suffix}`),
              sessionId,
              reason: interruptionCancelReason,
            }),
          );
          if (cancelled.receipt.outcome !== "ACKNOWLEDGED") {
            throw new QualifiedPiProcessBlockedError(
              "FORCED_INTERRUPTION_NOT_PROVEN",
              "the qualified Pi process did not acknowledge the forced interruption",
            );
          }
          cancellationRequested = true;
          forcedInterruptionProven = true;
        }
        const final = await finalPromise;
        const output = await readManagedOutput(host, sessionId, request.maximumOutputBytes);
        result = resultFromManagedProcess(
          final.receipt,
          output.stdout,
          output.stderr,
          request.maximumOutputBytes,
          forcedInterruptionProven ? interruptionResult : undefined,
        );
        if (final.receipt.terminalFinality !== "FINAL") {
          throw new QualifiedPiProcessBlockedError(
            "PROCESS_FINALITY_NOT_PROVEN",
            "the qualified Pi process did not reach reconciled terminal finality",
          );
        }
      } catch (error) {
        if (!(await finalizeAfterFailure())) {
          throw new QualifiedPiProcessBlockedError(
            "PROCESS_FINALITY_NOT_PROVEN",
            "the qualified Pi process could not be finalized after an adapter failure",
          );
        }
        throw error;
      }
      await release();
      releaseNeeded = false;
      return withContainment({ ...result, leaseState: "RELEASED" }, started.receipt.containment);
    } finally {
      const processSafeToRelease =
        finalizeManagedProcessAfterFailure === undefined || managedProcessFinalityProven;
      if (releaseNeeded && processSafeToRelease) {
        await release().catch(() => undefined);
      }
      if (runtimeSnapshot !== undefined && processSafeToRelease) {
        await removeQualifiedPiRuntimeSnapshot(runtimeSnapshot);
      }
    }
  };
}
