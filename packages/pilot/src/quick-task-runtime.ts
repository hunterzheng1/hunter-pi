import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve, sep } from "node:path";

import {
  fingerprintSchema,
  operationIdSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import {
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  type LeaseManager,
} from "@hunter-pi/execution";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  realManagedChangeRequestSchema,
  type RealManagedChangeRequest,
} from "@hunter-pi/managed-change";
import type { PiLaunchPlan, Task6PiProcessRunner } from "@hunter-pi/pi-host";
import { observeControlledCommand, type ProcessRunner } from "@hunter-pi/verification";

import {
  pilotQuickTaskReceiptSchema,
  type PilotQuickTaskReceipt,
  type PilotTaskOracle,
} from "./contracts.js";
import { canonicalJson, pilotFingerprint } from "./serialization.js";
import { createPilotRepositoryTargetReceipt } from "./target.js";
import {
  capturedPilotWorkflowFactIds,
  pilotApplicableWorkflowFactCount,
  quickPilotWorkflowFactSignals,
} from "./workflow-facts.js";

export class PilotQuickTaskRuntimeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PilotQuickTaskRuntimeError";
  }
}

export interface RunPilotQuickTaskOptions {
  readonly taskId: string;
  readonly repository: string;
  readonly request: RealManagedChangeRequest;
  readonly oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }>;
  readonly launchPlan: PiLaunchPlan;
  readonly runProcess: Task6PiProcessRunner;
  readonly commandRunner: ProcessRunner;
  readonly writerLeaseManager: LeaseManager;
  readonly writerLeaseOwnerFingerprint: Fingerprint;
  readonly environmentFingerprint: Fingerprint;
  readonly runtimeConfigurationFingerprint: Fingerprint;
  readonly beforeProviderSend: () => Promise<void>;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

interface RepositorySnapshot {
  readonly repository: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly status: string;
  readonly workingTreeStateFingerprint: Fingerprint;
}

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function shortId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function minimalGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOGLOBAL: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
}

function git(repository: string, argv: readonly string[], allowedStatuses = [0]): string {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", repository, ...argv],
    {
      env: minimalGitEnvironment(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.status === null ||
    !allowedStatuses.includes(result.status)
  ) {
    throw new PilotQuickTaskRuntimeError(
      "the selected Git repository could not be inspected safely",
    );
  }
  return result.stdout;
}

async function inspectRepository(repositoryInput: string): Promise<RepositorySnapshot> {
  const requested = resolve(repositoryInput);
  const stats = await lstat(requested).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PilotQuickTaskRuntimeError("the selected repository is not one physical directory");
  }
  const repository = await realpath(requested);
  if (
    repository !== requested ||
    resolve(git(repository, ["rev-parse", "--show-toplevel"]).trim()) !== repository
  ) {
    throw new PilotQuickTaskRuntimeError("the selected repository is not its canonical Git root");
  }
  const filterNames = git(
    repository,
    ["config", "--local", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|smudge)$"],
    [0, 1],
  );
  if (filterNames.trim().length > 0) {
    throw new PilotQuickTaskRuntimeError("external Git content filters are not allowed");
  }
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  return {
    repository,
    branch: git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(),
    baseCommit: git(repository, ["rev-parse", "HEAD"]).trim(),
    baseTree: git(repository, ["rev-parse", "HEAD^{tree}"]).trim(),
    status,
    workingTreeStateFingerprint: await fingerprintWorkingTreeState(repository, status),
  };
}

function changedPaths(status: string): readonly string[] {
  const records = status.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new PilotQuickTaskRuntimeError("Git returned an unsupported working-tree status");
    }
    const code = record.slice(0, 2);
    const path = record.slice(3).replaceAll("\\", "/");
    if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
      throw new PilotQuickTaskRuntimeError("Git returned an unsafe changed path");
    }
    paths.push(path);
    if (code.includes("R") || code.includes("C")) {
      const destination = records[index + 1];
      if (destination === undefined) {
        throw new PilotQuickTaskRuntimeError("Git returned an incomplete rename or copy");
      }
      paths.push(destination.replaceAll("\\", "/"));
      index += 1;
    }
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function fingerprintWorkingTreeState(
  repository: string,
  status: string,
): Promise<Fingerprint> {
  const entries: {
    readonly path: string;
    readonly state: "MISSING" | "REGULAR_FILE";
    readonly digest?: Fingerprint;
  }[] = [];
  for (const path of changedPaths(status)) {
    const absolutePath = resolve(repository, path);
    if (!absolutePath.startsWith(`${repository}${sep}`)) {
      throw new PilotQuickTaskRuntimeError("Git returned a changed path outside the repository");
    }
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new PilotQuickTaskRuntimeError("a changed path could not be inspected safely");
      }
    }
    if (stats === undefined) {
      entries.push({ path, state: "MISSING" });
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new PilotQuickTaskRuntimeError("changed paths must be regular files");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
    entries.push({
      path,
      state: "REGULAR_FILE",
      digest: fingerprintSchema.parse(`sha256:${hash.digest("hex")}`),
    });
  }
  return sha256(canonicalJson({ schemaVersion: "hpi-working-tree-state.v1", status, entries }));
}

function assertFrozenBinding(
  taskId: string,
  request: RealManagedChangeRequest,
  oracle: Extract<PilotTaskOracle, { readonly mode: "QUICK" }>,
  snapshot: RepositorySnapshot,
): void {
  const target = createPilotRepositoryTargetReceipt({
    targetId: request.target.targetId,
    canonicalRepositoryIdentity: snapshot.repository,
    branch: snapshot.branch,
    baseCommit: snapshot.baseCommit,
    baseTree: snapshot.baseTree,
    dirty: snapshot.status.length > 0,
  });
  if (
    taskId !== oracle.taskId ||
    request.target.targetId !== oracle.targetId ||
    target.status !== "READY" ||
    request.target.repositoryFingerprint !== oracle.repositoryFingerprint ||
    request.target.sourceFingerprint !== oracle.sourceFingerprint ||
    request.target.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
    target.repositoryFingerprint !== oracle.repositoryFingerprint ||
    target.sourceFingerprint !== oracle.sourceFingerprint ||
    target.targetReferenceFingerprint !== oracle.targetReferenceFingerprint ||
    fingerprintRealManagedChangeTaskDefinition(request) !== oracle.taskDefinitionFingerprint ||
    oracle.acceptanceCheckDefinitionFingerprints.length !== 1 ||
    fingerprintRealManagedChangeCheckDefinition(request) !==
      oracle.acceptanceCheckDefinitionFingerprints[0]
  ) {
    throw new PilotQuickTaskRuntimeError("the Quick task does not match its frozen pilot binding");
  }
}

async function acquireWriterLease(options: {
  readonly manager: LeaseManager;
  readonly repository: string;
  readonly ownerFingerprint: Fingerprint;
  readonly taskId: string;
}): Promise<() => Promise<void>> {
  const suffix = shortId(`${options.taskId}\0${options.repository}\0${randomUUID()}`);
  const leaseId = writerLeaseIdSchema.parse(`lease_quick-${suffix}`);
  const workspaceId = workspaceIdSchema.parse(`workspace_quick-${shortId(options.repository)}`);
  const operationFingerprint = sha256(
    canonicalJson({ schemaVersion: "hpi-quick-writer-lease.v1", leaseId, workspaceId }),
  );
  const acquire = await options.manager.acquire(
    leaseAcquireRequestSchema.parse({
      schemaVersion: "hpi-lease-acquire.v1",
      operationId: operationIdSchema.parse(`op_quick-acquire-${suffix}`),
      operationFingerprint,
      leaseId,
      workspaceId,
      ownerFingerprint: options.ownerFingerprint,
      resources: ["repository-writer"],
      ttlMs: 900_000,
    }),
  );
  if (acquire.receipt.outcome !== "ACQUIRED") {
    throw new PilotQuickTaskRuntimeError("the Quick task repository writer is busy");
  }
  let released = false;
  return async () => {
    if (released) return;
    const result = await options.manager.release(
      leaseReleaseRequestSchema.parse({
        schemaVersion: "hpi-lease-release.v1",
        operationId: operationIdSchema.parse(`op_quick-release-${suffix}`),
        operationFingerprint: sha256(`hpi-quick-writer-release\0${suffix}`),
        leaseId,
        ownerFingerprint: options.ownerFingerprint,
        bindingFingerprint: null,
      }),
    );
    if (result.receipt.outcome !== "RELEASED") {
      throw new PilotQuickTaskRuntimeError("the Quick task writer lease was not released");
    }
    released = true;
  };
}

function promptFor(request: RealManagedChangeRequest): string {
  return [
    `Goal: ${request.goal}`,
    "Operate only in the explicitly selected repository workspace.",
    `Allowed paths: ${request.allowedPaths.join(", ")}`,
    ...request.constraints.map((constraint) => `Constraint: ${constraint}`),
    "Do not commit, push, publish, deploy, edit credentials, or modify any undeclared path.",
    "Make the smallest useful change, then return control. The product will run the independent check.",
  ].join("\n");
}

export async function runPilotQuickTask(
  options: RunPilotQuickTaskOptions,
): Promise<PilotQuickTaskReceipt> {
  const request = realManagedChangeRequestSchema.parse(options.request);
  const before = await inspectRepository(options.repository);
  assertFrozenBinding(options.taskId, request, options.oracle, before);
  if (resolve(options.launchPlan.cwd) !== before.repository) {
    throw new PilotQuickTaskRuntimeError(
      "the Quick launch plan does not target the frozen repository",
    );
  }
  const release = await acquireWriterLease({
    manager: options.writerLeaseManager,
    repository: before.repository,
    ownerFingerprint: options.writerLeaseOwnerFingerprint,
    taskId: options.taskId,
  });
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  let released = false;
  try {
    const locked = await inspectRepository(before.repository);
    assertFrozenBinding(options.taskId, request, options.oracle, locked);
    const providerStarted = monotonicNow();
    const providerSendBoundary = { authorized: false };
    const processResult = await options.runProcess(
      {
        plan: options.launchPlan,
        prompt: promptFor(request),
        timeoutMs: 300_000,
        maximumOutputBytes: 229_376,
      },
      {
        beforeExternalOperation: async () => {
          await options.beforeProviderSend();
          providerSendBoundary.authorized = true;
        },
      },
    );
    if (!providerSendBoundary.authorized) {
      throw new PilotQuickTaskRuntimeError(
        "the Quick process adapter did not honor the required pre-send authorization boundary",
      );
    }
    const providerRuntimeMs = Math.max(0, monotonicNow() - providerStarted);
    const processFinal =
      processResult.terminalFinality === "FINAL" &&
      processResult.processTreeState === "EMPTY" &&
      processResult.leaseState === "RELEASED";
    if (!processFinal) {
      throw new PilotQuickTaskRuntimeError("the Quick Pi process did not reach qualified finality");
    }
    const beforeAcceptance = await inspectRepository(before.repository);
    const acceptanceDefinitionFingerprint = options.oracle.acceptanceCheckDefinitionFingerprints[0];
    if (acceptanceDefinitionFingerprint === undefined) {
      throw new PilotQuickTaskRuntimeError("the Quick acceptance definition is missing");
    }
    const acceptance = await observeControlledCommand(
      {
        workingDirectory: before.repository,
        executable: request.check.executable,
        argv: request.check.argv,
        definitionFingerprint: acceptanceDefinitionFingerprint,
        configurationFingerprint: sha256(
          canonicalJson({
            schemaVersion: "hpi-quick-acceptance-configuration.v1",
            check: request.check,
          }),
        ),
        sourceFingerprint: options.oracle.sourceFingerprint,
        workspaceFingerprint: pilotFingerprint({
          schemaVersion: "hpi-quick-workspace.v1",
          repositoryFingerprint: options.oracle.repositoryFingerprint,
          sourceFingerprint: options.oracle.sourceFingerprint,
        }),
        environmentFingerprint: options.environmentFingerprint,
        timeoutMs: 120_000,
        maximumOutputBytes: 16_384,
      },
      options.commandRunner,
      options.now,
    );
    const afterAcceptance = await inspectRepository(before.repository);
    const paths = changedPaths(afterAcceptance.status);
    const sourcePreserved =
      afterAcceptance.baseCommit === before.baseCommit &&
      afterAcceptance.baseTree === before.baseTree;
    const pathsWithinScope =
      paths.length > 0 && paths.every((path) => request.allowedPaths.includes(path));
    const acceptancePreservedWorkspace =
      afterAcceptance.workingTreeStateFingerprint === beforeAcceptance.workingTreeStateFingerprint;
    await release();
    released = true;
    const executionObservation = processResult.timedOut
      ? "TIMED_OUT"
      : processResult.exitCode !== 0
        ? "PROCESS_ERROR"
        : processResult.framingValid &&
            processResult.eventTypes.at(-1) === "agent_end" &&
            processResult.providerUsage.status === "PASS"
          ? "RETURNED"
          : "NOT_PROVEN";
    const acceptanceObservation =
      !sourcePreserved || !pathsWithinScope || !acceptancePreservedWorkspace
        ? "FAIL"
        : acceptance.receipt.outcome;
    const usage = processResult.providerUsage;
    if (usage.status !== "PASS") {
      throw new PilotQuickTaskRuntimeError("the Quick Provider usage is not exactly accounted");
    }
    const capturedWorkflowFacts = capturedPilotWorkflowFactIds(
      quickPilotWorkflowFactSignals({
        taskIdentityObserved: options.oracle.taskId === options.taskId,
        repositoryIdentityObserved: options.oracle.repositoryFingerprint.length > 0,
        targetReferenceObserved: options.oracle.targetReferenceFingerprint.length > 0,
        sourceIdentityObserved: options.oracle.sourceFingerprint.length > 0,
        taskDefinitionObserved: options.oracle.taskDefinitionFingerprint.length > 0,
        acceptanceDefinitionObserved:
          options.oracle.acceptanceCheckDefinitionFingerprints.length === 1,
        executionObserved: typeof executionObservation === "string",
        processFinal: processResult.terminalFinality === "FINAL",
        processTreeFinal: processResult.processTreeState === "EMPTY",
        outputFinal: !processResult.outputTruncated,
        writerLeaseFinal: released,
        providerRequestUsageObserved: Number.isSafeInteger(usage.requestCount),
        providerTokenUsageObserved: Number.isSafeInteger(usage.tokenCount),
        providerCostUsageObserved: Number.isSafeInteger(usage.costMinorUnits),
        sourcePreservationObserved: typeof sourcePreserved === "boolean",
        changedPathScopeObserved: typeof pathsWithinScope === "boolean",
        independentAcceptanceObserved: acceptance.receipt.commandFingerprint.length > 0,
        acceptanceWorkspacePreservationObserved: typeof acceptancePreservedWorkspace === "boolean",
        secretLeakageObserved: !processResult.outputTruncated,
      }),
    );
    return pilotQuickTaskReceiptSchema.parse({
      receiptId: `quick-receipt-${shortId(`${options.taskId}\0${processResult.stdoutDigest}`)}`,
      taskId: options.oracle.taskId,
      targetId: options.oracle.targetId,
      repositoryFingerprint: options.oracle.repositoryFingerprint,
      targetReferenceFingerprint: options.oracle.targetReferenceFingerprint,
      sourceFingerprint: options.oracle.sourceFingerprint,
      taskDefinitionFingerprint: options.oracle.taskDefinitionFingerprint,
      acceptanceCheckIds: options.oracle.acceptanceCheckIds,
      acceptanceCheckDefinitionFingerprints: options.oracle.acceptanceCheckDefinitionFingerprints,
      providerSendAcknowledged: usage.requestCount > 0,
      providerRequestCount: usage.requestCount,
      providerTokenCount: usage.tokenCount,
      providerCostMinor: usage.costMinorUnits,
      sourcePreserved,
      rawSecretLeakage: false,
      applicableFactCount: pilotApplicableWorkflowFactCount,
      capturedFactCount: capturedWorkflowFacts.length,
      manualInterventions: 0,
      hunterOverheadMinutes: Math.max(0, monotonicNow() - started - providerRuntimeMs) / 60_000,
      mode: "QUICK",
      executionObservation,
      acceptanceObservation,
      verifiedChangeClaimed: false,
      processReceiptFingerprint: pilotFingerprint(processResult),
      acceptanceReceiptFingerprint: pilotFingerprint(acceptance.receipt),
      runtimeConfigurationFingerprint: options.runtimeConfigurationFingerprint,
      processFinality: "FINAL",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "RELEASED",
    });
  } finally {
    if (!released) await release().catch(() => undefined);
  }
}
