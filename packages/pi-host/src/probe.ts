import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { capabilityReceiptSchema } from "@hunter-pi/engine-contracts";

import type { PiProbeFixture } from "./fixture.js";
import { LfOnlyNdjsonDecoder } from "./ndjson.js";
import { accountPiProviderUsage, hasExactPiAgentCompletion } from "./provider-usage.js";
import {
  PI_CANDIDATE,
  PI_PROBE_BUILT_EXECUTION_FILES,
  PI_PROBE_SOURCE_FILES,
  PI_PROBE_SOURCE_EXECUTION_FILES,
  derivePiEngineCapabilityResults,
  piCandidateReceiptSchema,
  piProbeImplementationReceiptSchema,
  piPublicInterfaceProbeReportSchema,
  piPublicInterfaceSurfacesSchema,
  type PiCandidateReceipt,
  type PiProbeFailureStage,
  type PiProbeImplementationReceipt,
  type PiPublicInterfaceProbeReport,
  type PiPublicInterfaceSurfaces,
} from "./schemas.js";

export class PiProbeStageError extends Error {
  public readonly stage: PiProbeFailureStage;

  public constructor(stage: PiProbeFailureStage, cause: unknown) {
    super(`Pi probe stage ${stage} did not complete`, { cause });
    this.name = "PiProbeStageError";
    this.stage = stage;
  }
}

const runProbeStage = async <Result>(
  stage: PiProbeFailureStage,
  operation: () => Result | Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new PiProbeStageError(stage, error);
  }
};

const maximumOutputBytes = 8 * 1024 * 1024;
const processTimeoutMs = 30_000;

const jsonRecordSchema = z.record(z.string(), z.unknown());

const sourceInfoReceiptSchema = z.strictObject({
  name: z.string().min(1),
  source: z.string().min(1),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
});

const coreExtensionReceiptSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("factory_loaded"),
    coreExtensionId: z.literal("hunter-pi/core-probe"),
    coreExtensionVersion: z.literal("1.0.0"),
  }),
  z.strictObject({
    event: z.literal("session_start"),
    coreExtensionId: z.literal("hunter-pi/core-probe"),
    coreExtensionVersion: z.literal("1.0.0"),
    activeTools: z.array(z.string()),
    effectiveToolGraph: z.array(sourceInfoReceiptSchema),
  }),
  z.strictObject({ event: z.enum(["agent_start", "agent_end", "agent_settled"]) }),
  z.strictObject({
    event: z.enum(["tool_call", "tool_result"]),
    toolName: z.string().min(1),
    isError: z.boolean().optional(),
  }),
  z.strictObject({
    event: z.literal("probe_tool_execute"),
    value: z.string().min(1),
  }),
  z.strictObject({ event: z.enum(["probe_stream_waiting", "probe_stream_aborted"]) }),
  z.strictObject({ event: z.literal("session_shutdown") }),
]);
type CoreExtensionReceipt = z.infer<typeof coreExtensionReceiptSchema>;

const sdkCreateReceiptSchema = z.strictObject({
  phase: z.literal("create"),
  processId: z.number().int().positive(),
  sessionCreated: z.boolean(),
  eventTypes: z.array(z.string().min(1)),
  sessionContained: z.boolean(),
  sessionPersisted: z.boolean(),
  workspaceCwdBound: z.boolean(),
});

const sdkResumeReceiptSchema = z.strictObject({
  phase: z.literal("resume"),
  processId: z.number().int().positive(),
  sameSessionIdOnResume: z.boolean(),
  customEntryRecovered: z.boolean(),
  workspaceCwdBound: z.boolean(),
});

export interface RunPiPublicInterfaceProbeOptions {
  readonly fixture: PiProbeFixture;
  readonly coreExtensionPath: string;
  readonly observedAt?: string;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireProbeFact(condition: boolean, message: string): true {
  if (!condition) throw new Error(message);
  return true;
}

function completedAgentSegments(
  records: readonly Record<string, unknown>[],
): readonly (readonly Record<string, unknown>[])[] {
  const segments: Record<string, unknown>[][] = [];
  let precedingTerminalIndex = -1;
  for (const [index, record] of records.entries()) {
    if (record["type"] !== "agent_settled") continue;
    let start = -1;
    for (let candidate = index - 1; candidate > precedingTerminalIndex; candidate -= 1) {
      if (records[candidate]?.["type"] === "agent_start") {
        start = candidate;
        break;
      }
    }
    if (start >= 0) segments.push(records.slice(start, index + 1));
    precedingTerminalIndex = index;
  }
  return segments;
}

export function inspectPiMessageUpdateContract(records: readonly Record<string, unknown>[]) {
  const updates = records.filter((record) => record["type"] === "message_update");
  const assistantEvents = updates.map((record) => record["assistantMessageEvent"]);
  const typedAssistantEvents = assistantEvents.filter(
    (event): event is Record<string, unknown> =>
      typeof event === "object" && event !== null && !Array.isArray(event),
  );
  const completedSegment = completedAgentSegments(records).find((segment) => {
    const eventTypes = segment.map((record) =>
      typeof record["type"] === "string" ? record["type"] : "",
    );
    return (
      hasExactPiAgentCompletion(eventTypes) &&
      accountPiProviderUsage(segment, "TRANSPORT_RETRIES_DISABLED").status === "PASS"
    );
  });
  const productionCompletionAccepted = requireProbeFact(
    completedSegment !== undefined &&
      hasExactPiAgentCompletion(
        completedSegment.map((record) =>
          typeof record["type"] === "string" ? record["type"] : "",
        ),
      ),
    "Pi event stream was not accepted by the production completion predicate",
  );
  requireProbeFact(
    completedSegment !== undefined &&
      accountPiProviderUsage(completedSegment, "TRANSPORT_RETRIES_DISABLED").status === "PASS",
    "Pi event stream was not accepted by production Provider usage accounting",
  );
  return {
    mode: "DELTA_ONLY" as const,
    assistantMessageEventObserved: requireProbeFact(
      assistantEvents.length > 0 && typedAssistantEvents.length === assistantEvents.length,
      "Pi message_update did not expose assistantMessageEvent deltas",
    ),
    typedAssistantDeltaObserved: requireProbeFact(
      typedAssistantEvents.every(
        (event) => typeof event["type"] === "string" && event["type"].trim().length > 0,
      ) &&
        typedAssistantEvents.some(
          (event) =>
            typeof event["type"] === "string" &&
            event["type"].endsWith("_delta") &&
            typeof event["delta"] === "string" &&
            event["delta"].length > 0,
        ),
      "Pi message_update did not expose a typed assistantMessageEvent delta",
    ),
    cumulativeMessageAbsent: requireProbeFact(
      updates.every((record) => !Object.prototype.hasOwnProperty.call(record, "message")),
      "Pi message_update unexpectedly exposed a cumulative message",
    ),
    assistantPartialAbsent: requireProbeFact(
      assistantEvents.every(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          !Object.prototype.hasOwnProperty.call(event, "partial"),
      ),
      "Pi message_update unexpectedly exposed assistantMessageEvent.partial",
    ),
    authoritativeMessageEndObserved: requireProbeFact(
      completedSegment?.some(
        (record) =>
          record["type"] === "message_end" &&
          typeof record["message"] === "object" &&
          record["message"] !== null &&
          Reflect.get(record["message"], "role") === "assistant",
      ) === true,
      "Pi did not expose an authoritative assistant message_end",
    ),
    productionCompletionAccepted,
    productionUsageAccounting: "PASS" as const,
  };
}

function sha256(content: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

interface FileSetFingerprint {
  readonly digest: `sha256:${string}`;
  readonly fileCount: number;
  readonly bytes: number;
}

async function fingerprintFiles(
  root: string,
  files: readonly string[],
): Promise<FileSetFingerprint> {
  const digest = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(join(root, ...file.split("/")));
    digest.update(file, "utf8");
    digest.update("\0", "utf8");
    digest.update(content);
    digest.update("\0", "utf8");
    bytes += content.byteLength;
  }
  return {
    digest: `sha256:${digest.digest("hex")}`,
    fileCount: files.length,
    bytes,
  };
}

async function listInstalledPackageFiles(
  packageRoot: string,
  relativeDirectory = "",
): Promise<string[]> {
  const directory = join(packageRoot, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    if (relativeDirectory.length === 0 && entry.name === "node_modules") {
      continue;
    }
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error("the installed Pi package contains an unexpected symbolic link");
    }
    if (entry.isDirectory()) {
      files.push(...(await listInstalledPackageFiles(packageRoot, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("the installed Pi package contains an unsupported filesystem entry");
    }
    files.push(relativePath);
  }
  return files;
}

function workspaceRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

function piPackageRoot(): string {
  const entryPoint = fileURLToPath(import.meta.resolve(PI_CANDIDATE.packageName));
  return resolve(dirname(entryPoint), "..");
}

function piCliPath(): string {
  return join(piPackageRoot(), "dist", "cli.js");
}

function sdkProbeChildPath(): string {
  const sourcePath = fileURLToPath(import.meta.url);
  return join(dirname(sourcePath), `sdk-probe-child.${sourcePath.endsWith(".ts") ? "ts" : "js"}`);
}

async function inspectPiCandidate(): Promise<PiCandidateReceipt> {
  const packageRoot = piPackageRoot();
  const installedFiles = await listInstalledPackageFiles(packageRoot);
  installedFiles.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const [packageText, lockText, cliContent, installedPackage] = await Promise.all([
    readFile(join(packageRoot, "package.json"), "utf8"),
    readFile(join(workspaceRoot(), "package-lock.json"), "utf8"),
    readFile(piCliPath()),
    fingerprintFiles(packageRoot, installedFiles),
  ]);
  const packageManifest = z
    .looseObject({
      name: z.literal(PI_CANDIDATE.packageName),
      version: z.literal(PI_CANDIDATE.version),
    })
    .parse(JSON.parse(packageText) as unknown);
  const lock = z
    .looseObject({
      packages: z.record(
        z.string(),
        z.looseObject({
          version: z.string().optional(),
          integrity: z.string().optional(),
        }),
      ),
    })
    .parse(JSON.parse(lockText) as unknown);
  const lockEntry = lock.packages[`node_modules/${PI_CANDIDATE.packageName}`];
  if (
    lockEntry?.version !== PI_CANDIDATE.version ||
    lockEntry.integrity !== PI_CANDIDATE.integrity
  ) {
    throw new Error("the installed Pi package does not match the frozen lockfile artifact");
  }

  return piCandidateReceiptSchema.parse({
    packageName: packageManifest.name,
    version: packageManifest.version,
    registryGitHead: PI_CANDIDATE.registryGitHead,
    integrity: lockEntry.integrity,
    cliFingerprint: sha256(cliContent),
    installedPackageFingerprint: installedPackage.digest,
    installedFileCount: installedPackage.fileCount,
    installedBytes: installedPackage.bytes,
  });
}

async function inspectProbeImplementation(): Promise<PiProbeImplementationReceipt> {
  const root = workspaceRoot();
  const sourcePath = fileURLToPath(import.meta.url);
  const executionMode = sourcePath.endsWith(".ts") ? "SOURCE_TYPESCRIPT" : "BUILT_JAVASCRIPT";
  const executionFiles =
    executionMode === "SOURCE_TYPESCRIPT"
      ? PI_PROBE_SOURCE_EXECUTION_FILES
      : PI_PROBE_BUILT_EXECUTION_FILES;
  const [source, execution] = await Promise.all([
    fingerprintFiles(root, PI_PROBE_SOURCE_FILES),
    fingerprintFiles(root, executionFiles),
  ]);
  return piProbeImplementationReceiptSchema.parse({
    sourceDigest: source.digest,
    sourceFiles: PI_PROBE_SOURCE_FILES,
    execution: {
      mode: executionMode,
      digest: execution.digest,
      files: executionFiles,
    },
  });
}

function createProbeEnvironment(
  fixture: PiProbeFixture,
  extensionReceiptPath: string,
  responseMode: "tool" | "wait-for-abort",
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    APPDATA: fixture.homeDirectory,
    CI: "1",
    FORCE_COLOR: "0",
    HOME: fixture.homeDirectory,
    HUNTER_PI_PROBE_EXTENSION_RECEIPT: extensionReceiptPath,
    HUNTER_PI_PROBE_RESPONSE_MODE: responseMode,
    LANG: "C.UTF-8",
    LOCALAPPDATA: fixture.homeDirectory,
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: fixture.agentDirectory,
    PI_CODING_AGENT_SESSION_DIR: fixture.sessionDirectory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    TEMP: fixture.temporaryDirectory,
    TERM: "dumb",
    TMP: fixture.temporaryDirectory,
    TZ: "UTC",
    USERPROFILE: fixture.homeDirectory,
  };
}

function commonPiArguments(coreExtensionPath: string): string[] {
  return [
    "--no-session",
    "--no-extensions",
    "--extension",
    coreExtensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    "hunter_pi_probe_tool",
    "--provider",
    "hunter-pi-probe",
    "--model",
    "probe-model",
    "--no-approve",
    "--offline",
  ];
}

function runNodeSynchronously(
  arguments_: readonly string[],
  fixture: PiProbeFixture,
  environment: NodeJS.ProcessEnv,
): Buffer {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: fixture.repository,
    env: environment,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: processTimeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("a fixed Pi public-interface child probe failed");
  }
  return Buffer.from(result.stdout);
}

function parseNdjson(content: string | Buffer): Record<string, unknown>[] {
  const decoder = new LfOnlyNdjsonDecoder(maximumOutputBytes);
  return [
    ...decoder.push(typeof content === "string" ? Buffer.from(content, "utf8") : content),
    ...decoder.finish(),
  ].map((record) => jsonRecordSchema.parse(record));
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function waitUpTo(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function readCoreExtensionReceipts(path: string): Promise<CoreExtensionReceipt[]> {
  return parseNdjson(await readFile(path, "utf8")).map((receipt) =>
    coreExtensionReceiptSchema.parse(receipt),
  );
}

async function runJsonAndExtensionProbe(
  fixture: PiProbeFixture,
  coreExtensionPath: string,
): Promise<{
  readonly extension: PiPublicInterfaceSurfaces["extension"];
  readonly json: PiPublicInterfaceSurfaces["json"];
}> {
  const receiptPath = join(fixture.receiptDirectory, "json-extension.ndjson");
  const output = runNodeSynchronously(
    [
      piCliPath(),
      "--mode",
      "json",
      ...commonPiArguments(coreExtensionPath),
      "Run the provider-independent JSON and Extension probe.",
    ],
    fixture,
    createProbeEnvironment(fixture, receiptPath, "tool"),
  );
  const records = parseNdjson(output);
  const receipts = await readCoreExtensionReceipts(receiptPath);
  const sessionStart = receipts.find((receipt) => receipt.event === "session_start");
  const factory = receipts.find((receipt) => receipt.event === "factory_loaded");
  if (sessionStart?.event !== "session_start" || factory?.event !== "factory_loaded") {
    throw new Error("the Core Extension did not emit its identity and tool graph receipts");
  }
  const lifecycleEvents = receipts.map((receipt) => receipt.event);
  const eventTypes = uniqueStrings(
    records.flatMap((record) => (typeof record["type"] === "string" ? [record["type"]] : [])),
  );

  return {
    extension: {
      status: "SUPPORTED",
      coreExtensionId: factory.coreExtensionId,
      coreExtensionVersion: factory.coreExtensionVersion,
      sourceFingerprint: sha256(await readFile(coreExtensionPath)),
      lifecycleEvents,
      activeTools: sessionStart.activeTools,
      effectiveToolGraph: sessionStart.effectiveToolGraph,
      interceptedToolCall: receipts.some(
        (receipt) => receipt.event === "tool_call" && receipt.toolName === "hunter_pi_probe_tool",
      ),
      interceptedToolResult: receipts.some(
        (receipt) =>
          receipt.event === "tool_result" &&
          receipt.toolName === "hunter_pi_probe_tool" &&
          receipt.isError === false,
      ),
    },
    json: {
      status: "SUPPORTED",
      framing: "NDJSON",
      eventTypes,
      parsedLineCount: records.length,
      messageUpdateContract: inspectPiMessageUpdateContract(records),
    },
  };
}

interface RpcProcessResult {
  readonly records: readonly Record<string, unknown>[];
  readonly exitCode: number | null;
}

async function runRpcProcess(
  fixture: PiProbeFixture,
  coreExtensionPath: string,
  receiptPath: string,
): Promise<RpcProcessResult> {
  const child = spawn(
    process.execPath,
    [piCliPath(), "--mode", "rpc", ...commonPiArguments(coreExtensionPath)],
    {
      cwd: fixture.repository,
      env: createProbeEnvironment(fixture, receiptPath, "wait-for-abort"),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const records: Record<string, unknown>[] = [];
  const changes = new EventEmitter();
  let capturedBytes = 0;
  let failure: Error | undefined;

  const fail = (message: string): void => {
    failure ??= new Error(message);
    changes.emit("change");
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };

  const decoder = new LfOnlyNdjsonDecoder(maximumOutputBytes);
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const record of decoder.push(chunk)) {
        records.push(jsonRecordSchema.parse(record));
        changes.emit("change");
      }
    } catch {
      fail("RPC stdout was not a valid NDJSON stream");
    }
  });
  child.stdout.on("end", () => {
    try {
      for (const record of decoder.finish()) {
        records.push(jsonRecordSchema.parse(record));
      }
      changes.emit("change");
    } catch {
      fail("RPC stdout ended with an invalid NDJSON record");
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    capturedBytes += Buffer.byteLength(chunk);
    if (capturedBytes > maximumOutputBytes) {
      fail("RPC diagnostic output exceeded its bounded capture limit");
    }
  });
  child.on("error", () => {
    fail("unable to start the Pi RPC child");
  });
  const closePromise = new Promise<number | null>((resolveClose) => {
    child.on("close", (code) => {
      changes.emit("change");
      resolveClose(code);
    });
  });

  const waitFor = async (
    predicate: (record: Record<string, unknown>, index: number) => boolean,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolveRecord, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        fail("Pi RPC response timed out");
        reject(new Error("Pi RPC response timed out"));
      }, processTimeoutMs);
      const check = (): void => {
        if (failure !== undefined) {
          cleanup();
          reject(failure);
          return;
        }
        const found = records.find(predicate);
        if (found !== undefined) {
          cleanup();
          resolveRecord(found);
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          cleanup();
          reject(new Error("Pi RPC child exited before the expected receipt"));
        }
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        changes.off("change", check);
      };
      changes.on("change", check);
      check();
    });

  const send = (record: Record<string, unknown>): void => {
    if (!child.stdin.write(`${JSON.stringify(record)}\n`, "utf8")) {
      throw new Error("Pi RPC stdin rejected a bounded command");
    }
  };
  const responseWithId =
    (id: string) =>
    (record: Record<string, unknown>): boolean =>
      record["type"] === "response" && record["id"] === id;
  const eventWithType =
    (type: string, minimumIndex = 0) =>
    (record: Record<string, unknown>, index: number): boolean =>
      index >= minimumIndex && record["type"] === type;

  try {
    send({ id: "state-before-a", type: "get_state" });
    send({ id: "state-before-b", type: "get_state" });
    await Promise.all([
      waitFor(responseWithId("state-before-a")),
      waitFor(responseWithId("state-before-b")),
    ]);

    const streamProofStart = records.length;
    send({ id: "prompt-stream-proof", type: "prompt", message: "Emit a bounded stream." });
    await waitFor(responseWithId("prompt-stream-proof"));
    await waitFor(eventWithType("agent_settled", streamProofStart));

    const cancellationStart = records.length;
    send({ id: "prompt-cancel", type: "prompt", message: "Wait for cancellation." });
    await waitFor(responseWithId("prompt-cancel"));
    await waitFor(eventWithType("agent_start", cancellationStart));

    send({ id: "abort-active", type: "abort" });
    await waitFor(responseWithId("abort-active"));
    await waitFor(eventWithType("agent_end", cancellationStart));

    send({ id: "state-after", type: "get_state" });
    await waitFor(responseWithId("state-after"));
    child.stdin.end();
    const code = await awaitWithTimeout(
      closePromise,
      processTimeoutMs,
      "Pi RPC child did not close after stdin EOF",
    );
    if (failure !== undefined) {
      throw failure;
    }
    return { records, exitCode: code };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill();
      await waitUpTo(closePromise, 1_000);
    }
  }
}

function isSuccessfulRpcResponse(record: Record<string, unknown>, command: string): boolean {
  return (
    record["type"] === "response" && record["command"] === command && record["success"] === true
  );
}

async function runRpcCancellationProbe(
  fixture: PiProbeFixture,
  coreExtensionPath: string,
): Promise<PiPublicInterfaceSurfaces["rpc"]> {
  const receiptPath = join(fixture.receiptDirectory, "rpc-extension.ndjson");
  const result = await runRpcProcess(fixture, coreExtensionPath, receiptPath);
  const receipts = await readCoreExtensionReceipts(receiptPath);
  const responseIds = result.records.flatMap((record) =>
    record["type"] === "response" && typeof record["id"] === "string" ? [record["id"]] : [],
  );
  const streamPrompt = result.records.find((record) => record["id"] === "prompt-stream-proof");
  const prompt = result.records.find((record) => record["id"] === "prompt-cancel");
  const abort = result.records.find((record) => record["id"] === "abort-active");
  const stateAfter = result.records.find((record) => record["id"] === "state-after");
  const stateData = jsonRecordSchema.safeParse(stateAfter?.["data"]);
  const streamStoppedAfterAbort =
    stateData.success &&
    stateData.data["isStreaming"] === false &&
    receipts.some((receipt) => receipt.event === "probe_stream_aborted") &&
    result.records.some((record) => record["type"] === "agent_end");

  return {
    status: "SUPPORTED",
    framing: "NDJSON",
    cancellationScope: "SINGLE_IN_FLIGHT_AGENT_OPERATION",
    correlationById: true,
    concurrentRequestIds: ["state-before-a", "state-before-b"],
    requestScopedCancellation: false,
    correlatedResponseIds: responseIds,
    messageUpdateContract: inspectPiMessageUpdateContract(result.records),
    promptAccepted:
      streamPrompt !== undefined &&
      isSuccessfulRpcResponse(streamPrompt, "prompt") &&
      prompt !== undefined &&
      isSuccessfulRpcResponse(prompt, "prompt"),
    abortAccepted: abort !== undefined && isSuccessfulRpcResponse(abort, "abort"),
    streamStoppedAfterAbort,
    childExited: result.exitCode !== null,
    exitCode: result.exitCode,
    cleanupScope: "ROOT_PROCESS_WITHOUT_TOOL_CHILDREN",
    descendantProcessCleanup: "NOT_PROVEN",
  };
}

async function runSdkProbe(
  fixture: PiProbeFixture,
  coreExtensionPath: string,
): Promise<PiPublicInterfaceSurfaces["sdk"]> {
  const statePath = join(fixture.receiptDirectory, "sdk-resume-state.json");
  const createOutput = runNodeSynchronously(
    [
      sdkProbeChildPath(),
      "create",
      fixture.repository,
      fixture.agentDirectory,
      fixture.sessionDirectory,
      coreExtensionPath,
      statePath,
    ],
    fixture,
    createProbeEnvironment(
      fixture,
      join(fixture.receiptDirectory, "sdk-create-extension.ndjson"),
      "tool",
    ),
  );
  const createRecords = parseNdjson(createOutput);
  if (createRecords.length !== 1) {
    throw new Error("SDK create child emitted an ambiguous receipt stream");
  }
  const created = sdkCreateReceiptSchema.parse(createRecords[0]);

  const resumeReceiptPath = join(fixture.receiptDirectory, "sdk-resume-extension.ndjson");
  const resumeOutput = runNodeSynchronously(
    [
      sdkProbeChildPath(),
      "resume",
      fixture.repository,
      fixture.agentDirectory,
      fixture.sessionDirectory,
      coreExtensionPath,
      statePath,
    ],
    fixture,
    createProbeEnvironment(fixture, resumeReceiptPath, "tool"),
  );
  const resumeRecords = parseNdjson(resumeOutput);
  if (resumeRecords.length !== 1) {
    throw new Error("SDK resume child emitted an ambiguous receipt stream");
  }
  const resumed = sdkResumeReceiptSchema.parse(resumeRecords[0]);
  const resumeExtensionReceipts = await readCoreExtensionReceipts(resumeReceiptPath);
  const resumeFactory = resumeExtensionReceipts.find(
    (receipt) => receipt.event === "factory_loaded",
  );
  const resumeSessionStart = resumeExtensionReceipts.find(
    (receipt) => receipt.event === "session_start",
  );
  const coreExtensionReloaded =
    resumeFactory?.event === "factory_loaded" &&
    resumeSessionStart?.event === "session_start" &&
    resumeSessionStart.activeTools.includes("hunter_pi_probe_tool") &&
    resumeSessionStart.effectiveToolGraph.some(
      (tool) =>
        tool.name === "hunter_pi_probe_tool" &&
        tool.source === "cli" &&
        tool.scope === "temporary" &&
        tool.origin === "top-level",
    );
  return {
    status: "SUPPORTED",
    coreExtensionReloaded,
    sessionCreated: created.sessionCreated,
    eventTypes: created.eventTypes,
    sessionContained: created.sessionContained,
    sessionPersisted: created.sessionPersisted,
    freshProcessResume: created.processId !== resumed.processId,
    sameSessionIdOnResume: resumed.sameSessionIdOnResume,
    customEntryRecovered: resumed.customEntryRecovered,
    workspaceCwdBound: created.workspaceCwdBound && resumed.workspaceCwdBound,
    persistenceRole: "ENGINE_EXTERNAL_REFERENCE",
    canonicalCheckpoint: "NOT_PROVEN_BY_PI",
  };
}

export async function runPiPublicInterfaceProbe(
  options: RunPiPublicInterfaceProbeOptions,
): Promise<PiPublicInterfaceProbeReport> {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const [candidate, implementation, jsonAndExtension] = await Promise.all([
    runProbeStage("CANDIDATE_IDENTITY", inspectPiCandidate),
    runProbeStage("IMPLEMENTATION_IDENTITY", inspectProbeImplementation),
    runProbeStage("EXTENSION_AND_JSON", () =>
      runJsonAndExtensionProbe(options.fixture, options.coreExtensionPath),
    ),
  ]);
  const rpc = await runProbeStage("RPC", () =>
    runRpcCancellationProbe(options.fixture, options.coreExtensionPath),
  );
  const sdk = await runProbeStage("SDK", () =>
    runSdkProbe(options.fixture, options.coreExtensionPath),
  );

  return runProbeStage("REPORT_ASSEMBLY", () => {
    const surfaces = piPublicInterfaceSurfacesSchema.parse({
      ...jsonAndExtension,
      rpc,
      sdk,
      tui: {
        status: "NOT_PROVEN",
        reason: "Interactive TUI usability requires the Task 5 Windows acceptance smoke.",
      },
      realProvider: {
        status: "NOT_PROVEN",
        reason:
          "No login, credential access, network Provider call, or paid request ran in Task 4.",
      },
    });
    const capabilities = capabilityReceiptSchema.parse({
      schemaVersion: "1.0.0",
      observedAt,
      results: derivePiEngineCapabilityResults(surfaces),
    });

    return piPublicInterfaceProbeReportSchema.parse({
      schemaVersion: "2.0.0",
      kind: "hunter-pi/pi-public-interface-probe",
      observedAt,
      candidate,
      implementation,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        configurationIsolation: "ISOLATED",
        sessionIsolation: "ISOLATED",
        providerMode: "DETERMINISTIC_FAUX",
        piNetworkMode: "OFFLINE",
        networkIsolation: "NOT_PROVEN",
        fixtureKind: "TEMPORARY_GIT",
      },
      surfaces,
      capabilities,
    });
  });
}
