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
  assertTask10EvidencePrivacy,
  TASK10_PLATFORM_CHECKS,
  TASK10_SOURCE_PATHSPEC,
  TASK10_VERIFIER_PATHSPEC,
  task10PlatformReceiptSchema,
  type Task10PlatformReceipt,
} from "./task10-platform-evidence.js";
import { readTask10SourceIdentity } from "./task10-source-identity.js";

export const task10PlatformConsistencySchema = z.strictObject({
  schemaVersion: z.literal("hpi-task10-platform-consistency.v1"),
  kind: z.literal("hunter-pi/task10-platform-consistency"),
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
        id: z.enum(TASK10_PLATFORM_CHECKS.map(({ id }) => id)),
        status: z.literal("PASS"),
      }),
    )
    .length(TASK10_PLATFORM_CHECKS.length)
    .superRefine((checks, context) => {
      if (checks.some((check, index) => check.id !== TASK10_PLATFORM_CHECKS[index]?.id)) {
        context.addIssue({
          code: "custom",
          message: "Task 10 consistency checks are not exact",
        });
      }
    }),
  observedAt: timestampSchema,
});
export type Task10PlatformConsistency = z.infer<typeof task10PlatformConsistencySchema>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareTask10PlatformEvidence(
  leftInput: Task10PlatformReceipt,
  rightInput: Task10PlatformReceipt,
): Task10PlatformConsistency {
  const left = task10PlatformReceiptSchema.parse(leftInput);
  const right = task10PlatformReceiptSchema.parse(rightInput);
  const windows = left.platform.os === "WINDOWS" ? left : right;
  const ubuntu = left.platform.os === "UBUNTU" ? left : right;
  if (windows.platform.os !== "WINDOWS" || ubuntu.platform.os !== "UBUNTU") {
    throw new Error("Task 10 consistency requires one Windows and one Ubuntu receipt");
  }
  if (windows.source.commit !== ubuntu.source.commit) {
    throw new Error("Task 10 platform receipts did not bind the same source commit");
  }
  if (
    windows.source.fingerprint !== ubuntu.source.fingerprint ||
    !sameStrings(windows.source.pathspec, ubuntu.source.pathspec)
  ) {
    throw new Error("Task 10 platform receipts did not bind the same source identity");
  }
  if (
    windows.verifier.fingerprint !== ubuntu.verifier.fingerprint ||
    windows.verifier.commandFingerprint !== ubuntu.verifier.commandFingerprint ||
    !sameStrings(windows.verifier.pathspec, ubuntu.verifier.pathspec)
  ) {
    throw new Error("Task 10 platform receipts did not bind the same verifier identity");
  }
  if (canonicalJson(windows.facts) !== canonicalJson(ubuntu.facts)) {
    throw new Error("Task 10 platform receipts did not prove the same semantic facts");
  }

  const observedAt = [windows.observedAt, ubuntu.observedAt].sort(
    (first, second) => Date.parse(first) - Date.parse(second),
  )[1];
  if (observedAt === undefined) throw new Error("Task 10 consistency has no observation time");
  const result = task10PlatformConsistencySchema.parse({
    schemaVersion: "hpi-task10-platform-consistency.v1",
    kind: "hunter-pi/task10-platform-consistency",
    status: "PASS",
    sourceCommit: windows.source.commit,
    sourceFingerprint: windows.source.fingerprint,
    verifierFingerprint: windows.verifier.fingerprint,
    commandFingerprint: windows.verifier.commandFingerprint,
    windowsReceiptFingerprint: sha256Fingerprint(canonicalJson(windows)),
    ubuntuReceiptFingerprint: sha256Fingerprint(canonicalJson(ubuntu)),
    checks: TASK10_PLATFORM_CHECKS.map(({ id }) => ({ id, status: "PASS" as const })),
    observedAt,
  });
  assertTask10EvidencePrivacy(result);
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
    throw new Error("Task 10 consistency input escaped its approved Evidence root");
  }
}

async function readReceipt(path: string, approvedRoot: string): Promise<Task10PlatformReceipt> {
  assertContained(approvedRoot, path);
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("Task 10 consistency input is not a physical single-link file");
  }
  return task10PlatformReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
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
        "usage: compare-task10-platform-evidence --windows <path> --ubuntu <path> --output <path>",
      );
    }
    values.set(flag, value);
  }
  const windows = values.get("--windows");
  const ubuntu = values.get("--ubuntu");
  const output = values.get("--output");
  if (values.size !== 3 || windows === undefined || ubuntu === undefined || output === undefined) {
    throw new Error(
      "usage: compare-task10-platform-evidence --windows <path> --ubuntu <path> --output <path>",
    );
  }
  return { windows, ubuntu, output };
}

async function runCli(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const approvedRoot = resolve(repositoryRoot, ".artifacts/task10-platform-aggregate");
  const arguments_ = parseArguments(process.argv.slice(2));
  const windowsPath = resolve(repositoryRoot, arguments_.windows);
  const ubuntuPath = resolve(repositoryRoot, arguments_.ubuntu);
  const outputPath = resolve(repositoryRoot, arguments_.output);
  if (outputPath !== resolve(approvedRoot, "consistency.json")) {
    throw new Error("Task 10 consistency output is not the exact approved target");
  }
  const [windows, ubuntu] = await Promise.all([
    readReceipt(windowsPath, approvedRoot),
    readReceipt(ubuntuPath, approvedRoot),
  ]);
  const checkout = await readTask10SourceIdentity({
    repositoryRoot,
    sourcePathspec: TASK10_SOURCE_PATHSPEC,
    verifierPathspec: TASK10_VERIFIER_PATHSPEC,
  });
  for (const receipt of [windows, ubuntu]) {
    if (
      receipt.source.commit !== checkout.commit ||
      receipt.source.fingerprint !== checkout.sourceFingerprint ||
      receipt.verifier.fingerprint !== checkout.verifierFingerprint
    ) {
      throw new Error("Task 10 platform receipt does not match the aggregate checkout identity");
    }
  }
  const result = compareTask10PlatformEvidence(windows, ubuntu);
  const directory = dirname(outputPath);
  await assertSafeDirectoryPath(directory);
  await mkdir(directory, { recursive: true });
  await writeImmutableAtomically({
    directory,
    filename: "consistency.json",
    content: `${canonicalJson(result)}\n`,
  });
  process.stdout.write("Task10PlatformConsistency=PASS\n");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch(() => {
    process.stderr.write("Task 10 platform Evidence comparison failed\n");
    process.exitCode = 1;
  });
}
