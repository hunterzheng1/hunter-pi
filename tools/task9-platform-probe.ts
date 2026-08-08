import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  checkpointSchema,
  fingerprintSchema,
  operationIdSchema,
  workspaceIdSchema,
  writerLeaseIdSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import {
  createFileLeaseManager,
  createLocalManagedProcessHost,
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  managedProcessSessionIdSchema,
  managedProcessStartRequestSchema,
} from "@hunter-pi/execution";
import {
  assertSafeDirectoryPath,
  canonicalJson,
  sha256Fingerprint,
  writeImmutableAtomically,
} from "@hunter-pi/evidence";
import {
  createFinalReceiptPersistingManagedProcessHost,
  createReleaseReceiptPersistingLeaseManager,
  ExecutionAttemptFinalityAdapter,
  FileAttemptFinalityEvidenceCapture,
  FileManagedProcessFinalReceiptStore,
  FileWriterLeaseReleaseReceiptStore,
  MANAGED_PROCESS_SESSION_NAMESPACE,
} from "@hunter-pi/managed-change";

import {
  assertTask9EvidencePrivacy,
  TASK9_PLATFORM_CHECKS,
  TASK9_SOURCE_PATHSPEC,
  TASK9_VERIFIER_PATHSPEC,
  task9CheckFingerprint,
  task9PlatformFailureReceiptSchema,
  task9PlatformFactsSchema,
  task9PlatformReceiptSchema,
  type Task9PlatformEvidence,
  type Task9PlatformFailureReceipt,
  type Task9PlatformReceipt,
} from "./task9-platform-evidence.js";

const execFileAsync = promisify(execFile);
const outputRoot = ".artifacts/task9-platform";

interface SourceIdentity {
  readonly commit: string;
  readonly sourceFingerprint: Fingerprint;
  readonly verifierFingerprint: Fingerprint;
}

type FailureStage = Task9PlatformFailureReceipt["stage"];

function errorFingerprint(error: unknown): Fingerprint {
  const shape =
    error instanceof Error
      ? { name: error.name, code: "code" in error ? String(error.code) : "NONE" }
      : { name: "UnknownFailure", code: "NONE" };
  return sha256Fingerprint(canonicalJson(shape));
}

async function commandText(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(executable, [...arguments_], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stderr.length > 0) throw new Error("source identity command wrote stderr");
  return result.stdout;
}

async function assertCleanWorktree(repositoryRoot: string): Promise<void> {
  const status = await commandText(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot,
  );
  if (status.trim().length > 0) throw new Error("Task 9 entire worktree is not clean");
}

interface TrackedEntry {
  readonly mode: "100644" | "100755";
  readonly blob: string;
  readonly path: string;
}

async function trackedEntries(
  repositoryRoot: string,
  pathspec: readonly string[],
): Promise<readonly TrackedEntry[]> {
  const output = await commandText(
    "git",
    ["ls-files", "--stage", "-z", "--", ...pathspec],
    repositoryRoot,
  );
  const entries = output
    .split("\0")
    .filter(Boolean)
    .map((line): TrackedEntry => {
      const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new Error("Task 9 pathspec contains an unsafe or staged-conflict entry");
      }
      return { mode: match[1] as TrackedEntry["mode"], blob: match[2], path: match[3] };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new Error("Task 9 pathspec selected no tracked files");
  for (const expected of pathspec) {
    if (!entries.some(({ path }) => path === expected || path.startsWith(`${expected}/`))) {
      throw new Error("Task 9 pathspec entry selected no tracked file");
    }
  }
  for (const entry of entries) {
    const target = resolve(repositoryRoot, entry.path);
    const targetRelative = relative(repositoryRoot, target);
    if (
      targetRelative.length === 0 ||
      targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`) ||
      isAbsolute(targetRelative)
    ) {
      throw new Error("Task 9 source entry escaped the repository");
    }
    const status = await lstat(target);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("Task 9 source entry is not a physical file");
    }
  }
  return entries;
}

function entriesFingerprint(entries: readonly TrackedEntry[]): Fingerprint {
  return sha256Fingerprint(canonicalJson(entries));
}

async function sourceIdentity(repositoryRoot: string): Promise<SourceIdentity> {
  await assertCleanWorktree(repositoryRoot);
  const [commitOutput, sourceEntries, verifierEntries] = await Promise.all([
    commandText("git", ["rev-parse", "HEAD"], repositoryRoot),
    trackedEntries(repositoryRoot, TASK9_SOURCE_PATHSPEC),
    trackedEntries(repositoryRoot, TASK9_VERIFIER_PATHSPEC),
  ]);
  const commit = commitOutput.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Task 9 source commit is invalid");
  const commitAfter = (await commandText("git", ["rev-parse", "HEAD"], repositoryRoot)).trim();
  await assertCleanWorktree(repositoryRoot);
  if (commitAfter !== commit) throw new Error("Task 9 source changed while it was identified");
  return {
    commit,
    sourceFingerprint: entriesFingerprint(sourceEntries),
    verifierFingerprint: entriesFingerprint(verifierEntries),
  };
}

async function platformLabel(): Promise<"WINDOWS" | "UBUNTU"> {
  if (process.arch !== "x64") throw new Error("Task 9 platform Evidence requires x64");
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Task 9 platform Evidence requires Node 24");
  }
  if (process.platform === "win32") return "WINDOWS";
  if (process.platform === "linux") {
    const osRelease = await readFile("/etc/os-release", "utf8");
    const id = osRelease
      .split(/\r?\n/u)
      .find((line) => line.startsWith("ID="))
      ?.slice(3)
      .replace(/^['"]|['"]$/gu, "")
      .toLowerCase();
    if (id === "ubuntu") return "UBUNTU";
  }
  throw new Error("Task 9 platform Evidence supports only Windows and Ubuntu");
}

function fixtureFingerprint(value: unknown): Fingerprint {
  return fingerprintSchema.parse(sha256Fingerprint(canonicalJson(value)));
}

export async function runTask9FinalityFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "hpi-task9-platform-"));
  try {
    const cwd = join(fixtureRoot, "working-directory");
    const leaseRoot = join(fixtureRoot, "lease-state");
    const processFinalRoot = join(fixtureRoot, "process-final");
    const leaseReleaseRoot = join(fixtureRoot, "lease-release");
    const finalityEvidenceRoot = join(fixtureRoot, "finality-evidence");
    await Promise.all(
      [cwd, leaseRoot, processFinalRoot, leaseReleaseRoot, finalityEvidenceRoot].map((directory) =>
        mkdir(directory),
      ),
    );

    const now = () => new Date().toISOString();
    const leaseReleaseStore = new FileWriterLeaseReleaseReceiptStore({
      stateRoot: leaseReleaseRoot,
    });
    const leaseManager = createReleaseReceiptPersistingLeaseManager({
      leaseManager: await createFileLeaseManager({ leaseRoot, now }),
      releaseReceiptStore: leaseReleaseStore,
    });
    const workspaceId = workspaceIdSchema.parse("workspace_task9-platform");
    const leaseId = writerLeaseIdSchema.parse("lease_task9-platform");
    const ownerFingerprint = fixtureFingerprint({ owner: "task9-platform-probe" });
    const acquire = await leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: operationIdSchema.parse("op_task9-platform-acquire"),
        operationFingerprint: fixtureFingerprint({ operation: "acquire" }),
        leaseId,
        workspaceId,
        ownerFingerprint,
        resources: ["task9-platform-fixture"],
        ttlMs: 60_000,
      }),
    );
    if (acquire.receipt.outcome !== "ACQUIRED") {
      throw new Error("Task 9 fixture Writer Lease was not acquired");
    }

    const processFinalStore = new FileManagedProcessFinalReceiptStore({
      stateRoot: processFinalRoot,
    });
    const host = createFinalReceiptPersistingManagedProcessHost({
      host: createLocalManagedProcessHost({ leaseManager, now }),
      finalReceiptStore: processFinalStore,
    });
    const sessionId = managedProcessSessionIdSchema.parse("process_task9-platform");
    const systemRoot = process.platform === "win32" ? process.env["SystemRoot"] : undefined;
    const started = await host.start(
      managedProcessStartRequestSchema.parse({
        schemaVersion: "hpi-process-start.v1",
        operationId: operationIdSchema.parse("op_task9-platform-process"),
        operationFingerprint: fixtureFingerprint({ operation: "process" }),
        sessionId,
        executable: process.execPath,
        argv: ["-e", "process.stdout.write('task9-finality')"],
        cwd,
        environment: {
          HPI_TASK9_FIXTURE: "SAFE",
          ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
        },
        timeoutMs: 15_000,
        maxOutputBytes: 65_536,
        leases: [],
      }),
    );
    const final = await host.awaitFinal(started.receipt.sessionId);
    if (final.receipt.terminalFinality !== "FINAL") {
      throw new Error("Task 9 fixture process did not reach terminal finality");
    }

    const release = await leaseManager.release(
      leaseReleaseRequestSchema.parse({
        schemaVersion: "hpi-lease-release.v1",
        operationId: operationIdSchema.parse("op_task9-platform-release"),
        operationFingerprint: fixtureFingerprint({ operation: "release" }),
        leaseId,
        ownerFingerprint,
        bindingFingerprint: null,
      }),
    );
    if (release.receipt.outcome !== "RELEASED") {
      throw new Error("Task 9 fixture Writer Lease was not released");
    }

    const sourceFingerprint = fixtureFingerprint({ source: "task9-platform-fixture" });
    const checkpoint = checkpointSchema.parse({
      schemaVersion: "1.0.0",
      checkpointId: "checkpoint_task9-platform",
      runId: "run_task9-platform",
      attemptId: "att_task9-platform",
      planRevisionId: "plan_task9-platform",
      distributionReleaseId: "release_task9-platform",
      workspaceId,
      repositoryFingerprint: sourceFingerprint,
      workspaceFingerprint: sourceFingerprint,
      sourceFingerprint,
      eventCursor: 1,
      createdAt: acquire.receipt.observedAt,
      engine: {
        engineReleaseId: "engine-release_task9-platform",
        engineReleaseFingerprint: sourceFingerprint,
        resumeCapability: "UNSUPPORTED",
      },
      activeOperationReceiptIds: [],
      unknownOperationIds: [],
      heldWriterLeaseIds: [leaseId],
      processReferences: [{ namespace: MANAGED_PROCESS_SESSION_NAMESPACE, reference: sessionId }],
      remainingResourceBudgets: { maxCommands: 1 },
    });
    const evidenceCapture = new FileAttemptFinalityEvidenceCapture({
      stateRoot: finalityEvidenceRoot,
    });
    const first = await new ExecutionAttemptFinalityAdapter({
      processFinalReceipts: processFinalStore,
      writerLeaseReleaseReceipts: leaseReleaseStore,
      captureEvidence: evidenceCapture,
    }).reconcileAttemptFinality(checkpoint);

    const reopenedProcessStore = new FileManagedProcessFinalReceiptStore({
      stateRoot: processFinalRoot,
    });
    const reopenedLeaseReleaseStore = new FileWriterLeaseReleaseReceiptStore({
      stateRoot: leaseReleaseRoot,
    });
    const reopened = await new ExecutionAttemptFinalityAdapter({
      processFinalReceipts: reopenedProcessStore,
      writerLeaseReleaseReceipts: reopenedLeaseReleaseStore,
      captureEvidence: new FileAttemptFinalityEvidenceCapture({
        stateRoot: finalityEvidenceRoot,
      }),
    }).reconcileAttemptFinality(checkpoint);
    const [reopenedProcess, leaseRelease] = await Promise.all([
      reopenedProcessStore.read(sessionId),
      reopenedLeaseReleaseStore.read(leaseId),
    ]);
    const processReceiptMatches = canonicalJson(reopenedProcess) === canonicalJson(final.receipt);
    const attemptFinalityMatches = canonicalJson(reopened) === canonicalJson(first);
    if (!processReceiptMatches || !attemptFinalityMatches) {
      throw new Error("Task 9 durable finality replay changed immutable facts");
    }

    return task9PlatformFactsSchema.parse({
      process: {
        terminalFinality: final.receipt.terminalFinality,
        processTreeState: final.receipt.processTreeState,
        outputState: final.receipt.outputState,
        leaseState: final.receipt.leaseState,
        receiptFingerprint: fixtureFingerprint(final.receipt),
      },
      writerLease: {
        state: leaseRelease.state,
        workspaceMatches: leaseRelease.workspaceId === workspaceId,
        receiptFingerprint: fixtureFingerprint(leaseRelease),
      },
      attemptFinality: {
        terminalFinality: first.terminalFinality,
        processCount: first.processFinalities.length,
        releasedWriterLeaseCount: first.releasedWriterLeaseIds.length,
        evidenceCount: first.evidenceIds.length,
        receiptFingerprint: fixtureFingerprint(first),
      },
      durableReplay: {
        processReceiptMatches,
        evidenceReceiptMatches: first.evidenceIds[0] === reopened.evidenceIds[0],
        attemptFinalityMatches,
      },
      privacy: { scan: "PASS", pathFree: true, credentialFree: true },
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

function failureReceipt(
  stage: FailureStage,
  platform: "WINDOWS" | "UBUNTU" | "UNSUPPORTED",
  source: SourceIdentity | undefined,
  error: unknown,
): Task9PlatformFailureReceipt {
  return task9PlatformFailureReceiptSchema.parse({
    schemaVersion: "hpi-task9-platform-failure.v1",
    kind: "hunter-pi/task9-platform-failure",
    status: stage === "FINALITY_EXECUTION" ? "FAIL" : "NOT_PROVEN",
    stage,
    platform,
    source:
      source === undefined
        ? null
        : {
            commit: source.commit,
            fingerprint: source.sourceFingerprint,
            pathspec: TASK9_SOURCE_PATHSPEC,
            verifierFingerprint: source.verifierFingerprint,
            verifierPathspec: TASK9_VERIFIER_PATHSPEC,
          },
    code: "TASK9_PLATFORM_PROBE_DID_NOT_COMPLETE",
    errorFingerprint: errorFingerprint(error),
    boundaries: {
      fixturePolicy: "AUTOMATIC_TEMPORARY_ONLY",
      providerRequests: "NOT_RUN",
      realRepositories: "NOT_RUN",
      privateData: "EXCLUDED",
    },
    observedAt: new Date().toISOString(),
  });
}

export async function runTask9PlatformProbe(
  repositoryRoot: string,
): Promise<Task9PlatformEvidence> {
  let stage: FailureStage = "PLATFORM_IDENTITY";
  let platform: "WINDOWS" | "UBUNTU" | "UNSUPPORTED" = "UNSUPPORTED";
  let source: SourceIdentity | undefined;
  try {
    platform = await platformLabel();
    stage = "SOURCE_IDENTITY";
    source = await sourceIdentity(repositoryRoot);
    stage = "FINALITY_EXECUTION";
    const facts = await runTask9FinalityFixture();
    stage = "SOURCE_REVALIDATION";
    const sourceAfter = await sourceIdentity(repositoryRoot);
    if (canonicalJson(sourceAfter) !== canonicalJson(source)) {
      throw new Error("Task 9 source identity changed during platform execution");
    }
    const receipt: Task9PlatformReceipt = task9PlatformReceiptSchema.parse({
      schemaVersion: "hpi-task9-platform-receipt.v1",
      kind: "hunter-pi/task9-platform-receipt",
      status: "PASS",
      platform: { os: platform, architecture: "x64", nodeMajor: 24 },
      source: {
        commit: source.commit,
        state: "CLEAN",
        pathspec: TASK9_SOURCE_PATHSPEC,
        fingerprint: source.sourceFingerprint,
      },
      verifier: {
        version: "task9-platform-verifier.v1",
        pathspec: TASK9_VERIFIER_PATHSPEC,
        fingerprint: source.verifierFingerprint,
        commandFingerprint: sha256Fingerprint(
          canonicalJson([
            "node@24",
            "dist/tools/task9-platform-probe.js",
            "--output",
            "<APPROVED_TASK9_EVIDENCE_PATH>",
          ]),
        ),
      },
      facts,
      checks: TASK9_PLATFORM_CHECKS.map(({ id }) => ({
        id,
        status: "PASS",
        fingerprint: task9CheckFingerprint(id, facts),
      })),
      observedAt: new Date().toISOString(),
    });
    assertTask9EvidencePrivacy(receipt);
    return receipt;
  } catch (error) {
    return failureReceipt(stage, platform, source, error);
  }
}

function parseOutputArgument(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return `${outputRoot}/${process.platform}-node24-${String(process.pid)}.json`;
  }
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output" ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0
  ) {
    throw new Error("usage: task9-platform-probe [--output <approved-path.json>]");
  }
  return arguments_[1];
}

function resolveOutputPath(repositoryRoot: string, candidate: string): string {
  const root = resolve(repositoryRoot, outputRoot);
  const output = resolve(repositoryRoot, candidate);
  const outputRelative = relative(root, output);
  if (
    outputRelative.length === 0 ||
    outputRelative === ".." ||
    outputRelative.startsWith(`..${sep}`) ||
    isAbsolute(outputRelative) ||
    outputRelative.includes(sep) ||
    !outputRelative.endsWith(".json")
  ) {
    throw new Error("Task 9 output must be one JSON file in the approved Evidence root");
  }
  return output;
}

async function assertRepositoryRoot(repositoryRoot: string): Promise<void> {
  const manifest = z
    .looseObject({ name: z.literal("hunter-pi") })
    .parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown);
  void manifest;
}

async function runCli(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  await assertRepositoryRoot(repositoryRoot);
  const outputPath = resolveOutputPath(repositoryRoot, parseOutputArgument(process.argv.slice(2)));
  const directory = resolve(outputPath, "..");
  await assertSafeDirectoryPath(directory);
  await mkdir(directory, { recursive: true });
  const receipt = await runTask9PlatformProbe(repositoryRoot);
  await writeImmutableAtomically({
    directory,
    filename: outputPath.slice(directory.length + 1),
    content: `${canonicalJson(receipt)}\n`,
  });
  if (receipt.status === "PASS") {
    process.stdout.write(`Task9Platform=PASS; Platform=${receipt.platform.os}\n`);
    return;
  }
  process.stderr.write("Task 9 platform probe did not complete; failure Evidence was written\n");
  process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const digest = createHash("sha256")
      .update(error instanceof Error ? error.name : "UnknownFailure")
      .digest("hex");
    process.stderr.write(`Task 9 platform probe failed before publication (${digest})\n`);
    process.exitCode = 1;
  });
}
