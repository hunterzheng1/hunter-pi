import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";
import {
  assertSafeDirectoryPath,
  canonicalJson,
  sha256Fingerprint,
  writeImmutableAtomically,
} from "@hunter-pi/evidence";

import {
  assertTask9EvidencePrivacy,
  TASK9_PLATFORM_CHECKS,
  task9PlatformReceiptSchema,
  type Task9PlatformReceipt,
} from "./task9-platform-evidence.js";

export const task9PlatformConsistencySchema = z.strictObject({
  schemaVersion: z.literal("hpi-task9-platform-consistency.v1"),
  kind: z.literal("hunter-pi/task9-platform-consistency"),
  status: z.literal("PASS"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceFingerprint: fingerprintSchema,
  verifierFingerprint: fingerprintSchema,
  commandFingerprint: fingerprintSchema,
  windowsReceiptFingerprint: fingerprintSchema,
  ubuntuReceiptFingerprint: fingerprintSchema,
  checks: z
    .array(
      z.strictObject({
        id: z.enum(TASK9_PLATFORM_CHECKS.map(({ id }) => id)),
        status: z.literal("PASS"),
      }),
    )
    .length(TASK9_PLATFORM_CHECKS.length)
    .superRefine((checks, context) => {
      if (checks.some((check, index) => check.id !== TASK9_PLATFORM_CHECKS[index]?.id)) {
        context.addIssue({ code: "custom", message: "Task 9 consistency checks are not exact" });
      }
    }),
  observedAt: timestampSchema,
});
export type Task9PlatformConsistency = z.infer<typeof task9PlatformConsistencySchema>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function semanticFacts(receipt: Task9PlatformReceipt): unknown {
  return {
    process: {
      terminalFinality: receipt.facts.process.terminalFinality,
      processTreeState: receipt.facts.process.processTreeState,
      outputState: receipt.facts.process.outputState,
      leaseState: receipt.facts.process.leaseState,
    },
    writerLease: {
      state: receipt.facts.writerLease.state,
      workspaceMatches: receipt.facts.writerLease.workspaceMatches,
    },
    attemptFinality: {
      terminalFinality: receipt.facts.attemptFinality.terminalFinality,
      processCount: receipt.facts.attemptFinality.processCount,
      releasedWriterLeaseCount: receipt.facts.attemptFinality.releasedWriterLeaseCount,
      evidenceCount: receipt.facts.attemptFinality.evidenceCount,
    },
    durableReplay: receipt.facts.durableReplay,
    privacy: receipt.facts.privacy,
  };
}

export function compareTask9PlatformEvidence(
  leftInput: Task9PlatformReceipt,
  rightInput: Task9PlatformReceipt,
): Task9PlatformConsistency {
  const left = task9PlatformReceiptSchema.parse(leftInput);
  const right = task9PlatformReceiptSchema.parse(rightInput);
  const windows = left.platform.os === "WINDOWS" ? left : right;
  const ubuntu = left.platform.os === "UBUNTU" ? left : right;
  if (windows.platform.os !== "WINDOWS" || ubuntu.platform.os !== "UBUNTU") {
    throw new Error("Task 9 consistency requires one Windows and one Ubuntu receipt");
  }
  if (windows.source.commit !== ubuntu.source.commit) {
    throw new Error("Task 9 platform receipts did not bind the same source commit");
  }
  if (
    windows.source.fingerprint !== ubuntu.source.fingerprint ||
    !sameStrings(windows.source.pathspec, ubuntu.source.pathspec)
  ) {
    throw new Error("Task 9 platform receipts did not bind the same source identity");
  }
  if (
    windows.verifier.fingerprint !== ubuntu.verifier.fingerprint ||
    windows.verifier.commandFingerprint !== ubuntu.verifier.commandFingerprint ||
    !sameStrings(windows.verifier.pathspec, ubuntu.verifier.pathspec)
  ) {
    throw new Error("Task 9 platform receipts did not bind the same verifier identity");
  }
  if (canonicalJson(semanticFacts(windows)) !== canonicalJson(semanticFacts(ubuntu))) {
    throw new Error("Task 9 platform receipts did not prove the same semantic facts");
  }

  const observedAt = [windows.observedAt, ubuntu.observedAt].sort(
    (first, second) => Date.parse(first) - Date.parse(second),
  )[1];
  if (observedAt === undefined) throw new Error("Task 9 consistency has no observation time");
  const result = task9PlatformConsistencySchema.parse({
    schemaVersion: "hpi-task9-platform-consistency.v1",
    kind: "hunter-pi/task9-platform-consistency",
    status: "PASS",
    sourceCommit: windows.source.commit,
    sourceFingerprint: windows.source.fingerprint,
    verifierFingerprint: windows.verifier.fingerprint,
    commandFingerprint: windows.verifier.commandFingerprint,
    windowsReceiptFingerprint: sha256Fingerprint(canonicalJson(windows)),
    ubuntuReceiptFingerprint: sha256Fingerprint(canonicalJson(ubuntu)),
    checks: TASK9_PLATFORM_CHECKS.map(({ id }) => ({ id, status: "PASS" as const })),
    observedAt,
  });
  assertTask9EvidencePrivacy(result);
  return result;
}

function assertContained(root: string, target: string): void {
  const targetRelative = relative(root, target);
  if (
    targetRelative.length === 0 ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error("Task 9 consistency input escaped its approved Evidence root");
  }
}

async function readReceipt(path: string, approvedRoot: string): Promise<Task9PlatformReceipt> {
  assertContained(approvedRoot, path);
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("Task 9 consistency input is not a physical single-link file");
  }
  return task9PlatformReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function parseArguments(arguments_: readonly string[]): {
  readonly windows: string;
  readonly ubuntu: string;
  readonly output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "usage: compare-task9-platform-evidence --windows <path> --ubuntu <path> --output <path>",
      );
    }
    values.set(flag, value);
  }
  const windows = values.get("--windows");
  const ubuntu = values.get("--ubuntu");
  const output = values.get("--output");
  if (values.size !== 3 || windows === undefined || ubuntu === undefined || output === undefined) {
    throw new Error(
      "usage: compare-task9-platform-evidence --windows <path> --ubuntu <path> --output <path>",
    );
  }
  return { windows, ubuntu, output };
}

async function runCli(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const approvedRoot = resolve(repositoryRoot, ".artifacts/task9-platform-aggregate");
  const arguments_ = parseArguments(process.argv.slice(2));
  const windowsPath = resolve(repositoryRoot, arguments_.windows);
  const ubuntuPath = resolve(repositoryRoot, arguments_.ubuntu);
  const outputPath = resolve(repositoryRoot, arguments_.output);
  if (outputPath !== resolve(approvedRoot, "consistency.json")) {
    throw new Error("Task 9 consistency output is not the exact approved target");
  }
  const [windows, ubuntu] = await Promise.all([
    readReceipt(windowsPath, approvedRoot),
    readReceipt(ubuntuPath, approvedRoot),
  ]);
  const result = compareTask9PlatformEvidence(windows, ubuntu);
  const directory = dirname(outputPath);
  await assertSafeDirectoryPath(directory);
  await mkdir(directory, { recursive: true });
  await writeImmutableAtomically({
    directory,
    filename: "consistency.json",
    content: `${canonicalJson(result)}\n`,
  });
  process.stdout.write("Task9PlatformConsistency=PASS\n");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch(() => {
    process.stderr.write("Task 9 platform Evidence comparison failed\n");
    process.exitCode = 1;
  });
}
