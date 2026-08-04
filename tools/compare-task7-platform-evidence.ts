import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  TASK7_PLATFORM_CHECKS,
  assertTask7EvidencePrivacy,
  formatTask7Evidence,
  prepareTask7Output,
  readTask7EvidenceInput,
  resolveTask7OutputPath,
  task7PlatformReceiptSchema,
  type Task7PlatformReceipt,
} from "./task7-platform-evidence.js";

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const task7PlatformConsistencySchema = z.strictObject({
  schemaVersion: z.literal("hpi-task7-platform-consistency.v1"),
  kind: z.literal("hunter-pi/task7-platform-consistency"),
  observedAt: z.iso.datetime({ offset: true }),
  status: z.literal("PASS"),
  platforms: z.tuple([z.literal("win32"), z.literal("linux")]),
  sourceDigest: fingerprintSchema,
  commandFingerprint: fingerprintSchema,
  testFileFingerprint: fingerprintSchema,
  receiptDigests: z.strictObject({
    windows: fingerprintSchema,
    ubuntu: fingerprintSchema,
  }),
  checks: z.array(
    z.strictObject({
      id: z.enum(TASK7_PLATFORM_CHECKS.map((check) => check.id)),
      status: z.literal("PASS"),
    }),
  ),
  fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_ONLY"),
  providerRequests: z.literal("NOT_RUN"),
  realRepositories: z.literal("NOT_RUN"),
  remoteCi: z.literal("PENDING"),
});
export type Task7PlatformConsistency = z.infer<typeof task7PlatformConsistencySchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function requirePassingReceipt(input: unknown, platform: "win32" | "linux"): Task7PlatformReceipt {
  assertTask7EvidencePrivacy(input);
  const receipt = task7PlatformReceiptSchema.parse(input);
  if (receipt.environment.platform !== platform || receipt.status !== "PASS") {
    throw new Error(`Task 7 ${platform} receipt is not an exact PASS`);
  }
  return receipt;
}

export function compareTask7PlatformEvidence(
  windowsInput: unknown,
  ubuntuInput: unknown,
  observedAt = new Date().toISOString(),
): Task7PlatformConsistency {
  const windows = requirePassingReceipt(windowsInput, "win32");
  const ubuntu = requirePassingReceipt(ubuntuInput, "linux");
  if (windows.source.commit !== ubuntu.source.commit) {
    throw new Error("Task 7 platform receipts did not bind the same source commit");
  }
  if (windows.source.digest !== ubuntu.source.digest) {
    throw new Error("Task 7 platform receipts did not bind the same source digest");
  }
  if (JSON.stringify(windows.source.pathspec) !== JSON.stringify(ubuntu.source.pathspec)) {
    throw new Error("Task 7 platform receipts did not bind the same source pathspec");
  }
  if (windows.execution.commandFingerprint !== ubuntu.execution.commandFingerprint) {
    throw new Error("Task 7 platform receipts did not bind the same command fingerprint");
  }
  if (windows.execution.testFileFingerprint !== ubuntu.execution.testFileFingerprint) {
    throw new Error("Task 7 platform receipts did not bind the same test file");
  }
  if (JSON.stringify(windows.checks) !== JSON.stringify(ubuntu.checks)) {
    throw new Error("Task 7 platform receipts did not pass the same check matrix");
  }
  const result = task7PlatformConsistencySchema.parse({
    schemaVersion: "hpi-task7-platform-consistency.v1",
    kind: "hunter-pi/task7-platform-consistency",
    observedAt,
    status: "PASS",
    platforms: ["win32", "linux"],
    sourceDigest: windows.source.digest,
    commandFingerprint: windows.execution.commandFingerprint,
    testFileFingerprint: windows.execution.testFileFingerprint,
    receiptDigests: {
      windows: digest(windows),
      ubuntu: digest(ubuntu),
    },
    checks: windows.checks,
    fixturePolicy: "AUTOMATIC_TEMPORARY_ONLY",
    providerRequests: "NOT_RUN",
    realRepositories: "NOT_RUN",
    remoteCi: "PENDING",
  });
  assertTask7EvidencePrivacy(result);
  return result;
}

function parseArguments(arguments_: readonly string[]): {
  readonly windows: string;
  readonly ubuntu: string;
  readonly output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || values.has(name)) {
      throw new Error(
        "usage: compare-task7-platform-evidence --windows <file> --ubuntu <file> --output <file>",
      );
    }
    values.set(name, value);
  }
  const windows = values.get("--windows");
  const ubuntu = values.get("--ubuntu");
  const output = values.get("--output");
  if (values.size !== 3 || windows === undefined || ubuntu === undefined || output === undefined) {
    throw new Error(
      "usage: compare-task7-platform-evidence --windows <file> --ubuntu <file> --output <file>",
    );
  }
  return { windows, ubuntu, output };
}

async function runCli(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const arguments_ = parseArguments(process.argv.slice(2));
  const outputPath = resolveTask7OutputPath(repositoryRoot, arguments_.output);
  await prepareTask7Output(repositoryRoot, outputPath);
  const [windows, ubuntu] = await Promise.all([
    readTask7EvidenceInput(repositoryRoot, arguments_.windows),
    readTask7EvidenceInput(repositoryRoot, arguments_.ubuntu),
  ]);
  const receipt = compareTask7PlatformEvidence(windows, ubuntu);
  await writeFile(outputPath, await formatTask7Evidence(receipt), {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write("Task7PlatformConsistency=PASS; RemoteCI=PENDING\n");
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown consistency failure";
    process.stderr.write(`Task 7 Evidence consistency failed: ${message}\n`);
    process.exitCode = 1;
  });
}
