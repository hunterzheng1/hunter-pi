import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  TASK7_SOURCE_PATHSPEC,
  TASK7_VERIFIER_PATHSPEC,
  assertTask7EvidencePrivacy,
  formatTask7Evidence,
  parseTask7VitestReport,
  prepareTask7Output,
  resolveTask7OutputPath,
  task7PlatformFailureReceiptSchema,
  task7PlatformReceiptSchema,
  type Task7PlatformFailureReceipt,
  type Task7PlatformReceipt,
} from "./task7-platform-evidence.js";

export interface Task7ProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutDigest: `sha256:${string}`;
  readonly stderrDigest: `sha256:${string}`;
  readonly observedBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface SourceIdentity {
  readonly commit: string;
  readonly digest: `sha256:${string}`;
  readonly testFileFingerprint: `sha256:${string}`;
  readonly verifierFingerprint: `sha256:${string}`;
  readonly gitVersion: string;
}

type FailureStage = Task7PlatformFailureReceipt["stage"];

const MAX_TASK7_PROBE_CAPTURE_BYTES = 1_048_576;

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function runTask7ProbeCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<Task7ProbeCommandResult> {
  return new Promise<Task7ProbeCommandResult>((resolveResult, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let observedStdoutBytes = 0;
    let observedStderrBytes = 0;
    let retainedStdoutBytes = 0;
    let retainedStderrBytes = 0;
    let observedBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      observedBytes += chunk.length;
      observedStdoutBytes += chunk.length;
      stdoutHash.update(chunk);
      const remaining = MAX_TASK7_PROBE_CAPTURE_BYTES - retainedStdoutBytes;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        stdout.push(retained);
        retainedStdoutBytes += retained.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      observedBytes += chunk.length;
      observedStderrBytes += chunk.length;
      stderrHash.update(chunk);
      const remaining = MAX_TASK7_PROBE_CAPTURE_BYTES - retainedStderrBytes;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        stderr.push(retained);
        retainedStderrBytes += retained.length;
      }
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolveResult({
        exitCode,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        stdoutDigest: `sha256:${stdoutHash.digest("hex")}`,
        stderrDigest: `sha256:${stderrHash.digest("hex")}`,
        observedBytes,
        stdoutTruncated: observedStdoutBytes > retainedStdoutBytes,
        stderrTruncated: observedStderrBytes > retainedStderrBytes,
      });
    });
  });
}

async function requireSuccessfulTextCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await runTask7ProbeCommand(executable, arguments_, cwd);
  if (
    result.exitCode !== 0 ||
    result.stderr.length > 0 ||
    result.stdoutTruncated ||
    result.stderrTruncated
  ) {
    throw new Error("source identity command did not complete cleanly");
  }
  return result.stdout.toString("utf8").trim();
}

export async function assertTask7WorktreeClean(repositoryRoot: string): Promise<void> {
  const status = await requireSuccessfulTextCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot,
  );
  if (status.length > 0) throw new Error("Task 7 entire worktree is not clean");
}

function isContained(root: string, target: string): boolean {
  const targetRelative = relative(root, target);
  return (
    targetRelative.length > 0 &&
    targetRelative !== ".." &&
    !targetRelative.startsWith(`..${sep}`) &&
    !isAbsolute(targetRelative)
  );
}

async function computeTrackedDigest(
  repositoryRoot: string,
  pathspec: readonly string[],
): Promise<`sha256:${string}`> {
  const fileList = await requireSuccessfulTextCommand(
    "git",
    ["ls-files", "-z", "--", ...pathspec],
    repositoryRoot,
  );
  const files = fileList
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error("Task 7 pathspec selected no files");
  for (const expected of pathspec) {
    if (!files.some((path) => path === expected || path.startsWith(`${expected}/`))) {
      throw new Error("Task 7 pathspec entry selected no tracked file");
    }
  }
  const canonicalRoot = await realpath(repositoryRoot);
  const hash = createHash("sha256");
  for (const path of files) {
    const target = resolve(repositoryRoot, path);
    if (!isContained(repositoryRoot, target)) throw new Error("source file escaped repository");
    const [entry, canonicalTarget, content] = await Promise.all([
      lstat(target),
      realpath(target),
      readFile(target),
    ]);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      !isContained(canonicalRoot, canonicalTarget)
    ) {
      throw new Error("Task 7 pathspec contains an unsafe file");
    }
    hash.update(`${path}\0${String(content.length)}\0`, "utf8");
    hash.update(content);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function computeSourceIdentity(repositoryRoot: string): Promise<SourceIdentity> {
  await assertTask7WorktreeClean(repositoryRoot);
  const [commit, gitVersionOutput, sourceDigest, verifierFingerprint, testContent] =
    await Promise.all([
      requireSuccessfulTextCommand("git", ["rev-parse", "HEAD"], repositoryRoot),
      requireSuccessfulTextCommand("git", ["--version"], repositoryRoot),
      computeTrackedDigest(repositoryRoot, TASK7_SOURCE_PATHSPEC),
      computeTrackedDigest(repositoryRoot, TASK7_VERIFIER_PATHSPEC),
      readFile(resolve(repositoryRoot, "test/managed-process-platform.test.ts")),
    ]);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Git commit identity is invalid");
  const gitVersion = gitVersionOutput.replace(/^git version\s+/u, "");
  return {
    commit,
    digest: sourceDigest,
    testFileFingerprint: digest(testContent),
    verifierFingerprint,
    gitVersion,
  };
}

function platformIdentity(): {
  readonly platform: "win32" | "linux";
  readonly platformLabel: "WINDOWS" | "UBUNTU";
  readonly containment: "WINDOWS_JOB_OBJECT" | "LINUX_SUBREAPER_PROCESS_TREE";
} {
  if (process.platform === "win32") {
    return {
      platform: "win32",
      platformLabel: "WINDOWS",
      containment: "WINDOWS_JOB_OBJECT",
    };
  }
  if (process.platform === "linux") {
    return {
      platform: "linux",
      platformLabel: "UBUNTU",
      containment: "LINUX_SUBREAPER_PROCESS_TREE",
    };
  }
  throw new Error("Task 7 platform probe supports only Windows and Linux");
}

function createFailureReceipt(
  stage: FailureStage,
  status: "FAIL" | "NOT_PROVEN",
  result?: Task7ProbeCommandResult,
): Task7PlatformFailureReceipt {
  const platform =
    process.platform === "win32" || process.platform === "linux" ? process.platform : "UNSUPPORTED";
  return task7PlatformFailureReceiptSchema.parse({
    schemaVersion: "hpi-task7-platform-failure.v2",
    kind: "hunter-pi/task7-platform-failure",
    observedAt: new Date().toISOString(),
    status,
    platform,
    stage,
    code: "TASK7_PLATFORM_PROBE_DID_NOT_COMPLETE",
    exitCode: result?.exitCode ?? null,
    stdoutDigest: result?.stdoutDigest ?? digest(""),
    stderrDigest: result?.stderrDigest ?? digest(""),
    observedBytes: result?.observedBytes ?? 0,
    verifierVersion: "task7-verifier.v2",
    fixturePolicy: "AUTOMATIC_TEMPORARY_ONLY",
    providerRequests: "NOT_RUN",
    realRepositories: "NOT_RUN",
    remoteCi: "PENDING",
  });
}

export async function runTask7PlatformProbe(
  repositoryRoot: string,
): Promise<Task7PlatformReceipt | Task7PlatformFailureReceipt> {
  let stage: FailureStage = "SOURCE_IDENTITY";
  let result: Task7ProbeCommandResult | undefined;
  let reportRoot: string | undefined;
  try {
    const platform = platformIdentity();
    const source = await computeSourceIdentity(repositoryRoot);
    stage = "TEST_EXECUTION";
    reportRoot = await mkdtemp(join(tmpdir(), "hpi-task7-platform-probe-"));
    const reportPath = join(reportRoot, "vitest-report.json");
    const vitestEntry = resolve(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
    const vitestEntryState = await lstat(vitestEntry);
    if (!vitestEntryState.isFile() || vitestEntryState.isSymbolicLink()) {
      throw new Error("Vitest entrypoint is unavailable");
    }
    const portableCommand = [
      "node@24",
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/managed-process-platform.test.ts",
      "--reporter=json",
      "--outputFile=<TEMP_REPORT>",
    ];
    const startedAt = new Date();
    result = await runTask7ProbeCommand(
      process.execPath,
      [
        vitestEntry,
        "run",
        "test/managed-process-platform.test.ts",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      repositoryRoot,
    );
    const endedAt = new Date();
    if (result.exitCode !== 0) return createFailureReceipt(stage, "FAIL", result);
    stage = "REPORT_PARSE";
    const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    const checks = parseTask7VitestReport(report, platform.platform);
    const receipt = task7PlatformReceiptSchema.parse({
      schemaVersion: "hpi-task7-platform-receipt.v2",
      kind: "hunter-pi/task7-platform-receipt",
      observedAt: endedAt.toISOString(),
      status: "PASS",
      source: {
        repository: "hunter-pi",
        commit: source.commit,
        digest: source.digest,
        pathspec: TASK7_SOURCE_PATHSPEC,
        verifierPathspec: TASK7_VERIFIER_PATHSPEC,
        verifierFingerprint: source.verifierFingerprint,
      },
      environment: {
        platform: platform.platform,
        platformLabel: platform.platformLabel,
        architecture: process.arch,
        nodeVersion: process.version,
        gitVersion: source.gitVersion,
      },
      execution: {
        commandFingerprint: digest(JSON.stringify(portableCommand)),
        testFileFingerprint: source.testFileFingerprint,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        exitCode: result.exitCode,
        reportStatus: "COMPLETE",
        stdoutDigest: result.stdoutDigest,
        stderrDigest: result.stderrDigest,
        observedBytes: result.observedBytes,
      },
      containment: { expected: platform.containment, status: "PASS" },
      checks,
      boundaries: {
        fixturePolicy: "AUTOMATIC_TEMPORARY_ONLY",
        providerRequests: "NOT_RUN",
        realRepositories: "NOT_RUN",
        privateData: "EXCLUDED",
        remoteCi: "PENDING",
      },
    });
    assertTask7EvidencePrivacy(receipt);
    return receipt;
  } catch {
    return createFailureReceipt(stage, "NOT_PROVEN", result);
  } finally {
    if (reportRoot !== undefined) {
      await rm(reportRoot, { force: true, recursive: true });
    }
  }
}

function parseOutputArgument(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return `.artifacts/task7-platform/${process.platform}-node24-${String(process.pid)}.json`;
  }
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output" ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0
  ) {
    throw new Error("usage: task7-platform-probe [--output <approved-path.json>]");
  }
  return arguments_[1];
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
  const outputPath = resolveTask7OutputPath(
    repositoryRoot,
    parseOutputArgument(process.argv.slice(2)),
  );
  await prepareTask7Output(repositoryRoot, outputPath);
  const receipt = await runTask7PlatformProbe(repositoryRoot);
  await writeFile(outputPath, await formatTask7Evidence(receipt), {
    encoding: "utf8",
    flag: "wx",
  });
  if (receipt.status === "PASS") {
    process.stdout.write(
      `Task7Platform=PASS; Platform=${receipt.environment.platformLabel}; RemoteCI=PENDING\n`,
    );
    return;
  }
  process.stderr.write(
    `Task 7 platform probe ${receipt.status}; structured failure Evidence was written\n`,
  );
  process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown Task 7 probe failure";
    process.stderr.write(`Task 7 platform probe failed before Evidence publication: ${message}\n`);
    process.exitCode = 1;
  });
}
