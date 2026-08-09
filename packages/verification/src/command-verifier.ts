import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  planRevisionSchema,
  verificationReceiptSchema,
  type AttemptId,
  type CheckId,
  type EvidenceId,
  type Fingerprint,
  type PlanRevision,
  type RunId,
  type VerificationReceipt,
  type VerificationReceiptId,
} from "@hunter-pi/domain";

export interface RunDeclaredCommandVerificationRequest {
  readonly planRevision: PlanRevision;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly checkId: CheckId;
  readonly verificationReceiptId: VerificationReceiptId;
  readonly evidenceId: EvidenceId;
  readonly repository: string;
  readonly environmentFingerprint: Fingerprint;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly now?: () => string;
}

export interface DeclaredCommandVerificationResult {
  readonly receipt: VerificationReceipt;
}

interface CapturedProcessResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly blocked: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

function sha256(value: string | Buffer): Fingerprint {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
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
  executableInput: string,
  arguments_: readonly string[],
): { readonly executable: string; readonly arguments: readonly string[] } {
  if (executableInput === "node") {
    return { executable: process.execPath, arguments: arguments_ };
  }
  const npmCli = resolveWindowsNpmCli(executableInput);
  return npmCli === undefined
    ? { executable: executableInput, arguments: arguments_ }
    : { executable: process.execPath, arguments: [npmCli, ...arguments_] };
}

function runGit(repository: string, arguments_: readonly string[]): Buffer {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    env: minimalEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("unable to fingerprint the declared verification workspace");
  }
  return Buffer.from(result.stdout);
}

function assertContained(parent: string, child: string): void {
  const childRelative = relative(parent, child);
  if (
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error("verification workspace content escaped the repository");
  }
}

async function fingerprintGitWorkspace(repository: string): Promise<Fingerprint> {
  const canonicalRepository = await realpath(resolve(repository));
  const repositoryStatus = await lstat(canonicalRepository);
  if (!repositoryStatus.isDirectory() || repositoryStatus.isSymbolicLink()) {
    throw new Error("declared verification workspace is not a physical directory");
  }
  const topLevel = resolve(
    runGit(canonicalRepository, ["rev-parse", "--show-toplevel"]).toString("utf8").trim(),
  );
  if (topLevel !== canonicalRepository) {
    throw new Error("declared verification workspace is not the Git repository root");
  }
  const baseCommit = runGit(canonicalRepository, ["rev-parse", "HEAD"]);
  const trackedDiff = runGit(canonicalRepository, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-renames",
    "HEAD",
    "--",
  ]);
  const untrackedOutput = runGit(canonicalRepository, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]).toString("utf8");
  const untrackedPaths = untrackedOutput
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  hash.update("hunter-pi-git-input.v1\0");
  hash.update(baseCommit);
  hash.update("\0tracked-diff\0");
  hash.update(trackedDiff);
  for (const path of untrackedPaths) {
    const candidate = resolve(canonicalRepository, ...path.split("/"));
    assertContained(canonicalRepository, candidate);
    const status = await lstat(candidate);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink > 1) {
      throw new Error("verification workspace contains an unsafe untracked entry");
    }
    hash.update("\0untracked-path\0");
    hash.update(path);
    hash.update("\0untracked-content\0");
    hash.update(await readFile(candidate));
  }
  return `sha256:${hash.digest("hex")}`;
}

function runBoundedProcess(options: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}): Promise<CapturedProcessResult> {
  return new Promise((resolvePromise) => {
    const invocation = resolveProcessInvocation(options.executable, options.arguments);
    let child;
    try {
      child = spawn(invocation.executable, [...invocation.arguments], {
        cwd: options.cwd,
        env: minimalEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolvePromise({
        exitCode: 127,
        timedOut: false,
        blocked: true,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let blocked = false;
    let settled = false;

    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, options.maximumOutputBytes - capturedBytes);
      const retained = chunk.subarray(0, remaining);
      if (retained.length > 0) {
        (stream === "stdout" ? stdoutChunks : stderrChunks).push(retained);
        capturedBytes += retained.length;
      }
      if (retained.length < chunk.length) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture("stderr", chunk);
    });
    child.once("error", () => {
      blocked = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: timedOut ? 124 : signal === null ? (code ?? 1) : 1,
        timedOut,
        blocked,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export async function runDeclaredCommandVerification(
  request: RunDeclaredCommandVerificationRequest,
): Promise<DeclaredCommandVerificationResult> {
  const planRevision = planRevisionSchema.parse(request.planRevision);
  const check = planRevision.checks.find((candidate) => candidate.checkId === request.checkId);
  if (check === undefined) {
    throw new Error(`check ${request.checkId} is not declared by the Plan Revision`);
  }
  if (
    check.definition.workingDirectoryReference !== "fixture-repository" &&
    check.definition.workingDirectoryReference !== "workspace-root"
  ) {
    throw new Error(
      `verification working directory reference ${check.definition.workingDirectoryReference} is not supported`,
    );
  }
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    !Number.isSafeInteger(request.maximumOutputBytes) ||
    request.maximumOutputBytes <= 0
  ) {
    throw new Error("verification limits must be positive finite integers");
  }

  const canonicalRepository = await realpath(resolve(request.repository));
  const inputFingerprint = await fingerprintGitWorkspace(canonicalRepository);
  const now = request.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const processResult = await runBoundedProcess({
    executable: check.definition.executable,
    arguments: check.definition.argv,
    cwd: canonicalRepository,
    timeoutMs: request.timeoutMs,
    maximumOutputBytes: request.maximumOutputBytes,
  });
  const endedAt = now();
  const stdoutDigest = sha256(processResult.stdout);
  const stderrDigest = sha256(processResult.stderr);
  const resultStatus = {
    kind: "EXIT_CODE" as const,
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
  };
  const outcome = processResult.blocked
    ? "BLOCKED"
    : !processResult.timedOut && processResult.exitCode === 0
      ? "PASS"
      : "FAIL";
  const resultFingerprint = sha256(
    JSON.stringify({
      inputFingerprint,
      resultStatus,
      stdoutDigest,
      stderrDigest,
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
    }),
  );
  const receipt = verificationReceiptSchema.parse({
    schemaVersion: "1.0.0",
    verificationReceiptId: request.verificationReceiptId,
    runId: request.runId,
    attemptId: request.attemptId,
    checkId: check.checkId,
    checkVersion: check.version,
    checkDefinitionFingerprint: check.definitionFingerprint,
    resultFingerprint,
    outcome,
    startedAt,
    endedAt,
    observedAt: endedAt,
    inputFingerprint,
    configFingerprint: check.configurationFingerprint,
    workspaceFingerprint: planRevision.workspaceFingerprint,
    sourceFingerprint: planRevision.sourceFingerprint,
    environmentFingerprint: request.environmentFingerprint,
    resultStatus,
    output: {
      stdoutDigest,
      stderrDigest,
      artifactDigests: [],
      capturedBytes: processResult.stdout.length + processResult.stderr.length,
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
      redaction: {
        applied: true,
        fieldsRemoved: 2,
      },
    },
    evidenceIds: [request.evidenceId],
  });
  return { receipt };
}
