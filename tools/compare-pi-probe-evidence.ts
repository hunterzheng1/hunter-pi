import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  piPublicInterfaceProbeReportSchema,
  type PiPublicInterfaceProbeReport,
} from "@hunter-pi/pi-host";

import {
  formatPiProbeEvidence,
  preparePiProbeOutput,
  resolvePiProbeOutputPath,
} from "./pi-public-interface-probe.js";

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const piProbeEvidenceConsistencySchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("hunter-pi/pi-evidence-consistency"),
  status: z.literal("SUPPORTED"),
  platforms: z.tuple([z.literal("win32"), z.literal("linux")]),
  observations: z.strictObject({
    windows: z.iso.datetime({ offset: true }),
    ubuntu: z.iso.datetime({ offset: true }),
  }),
  installedPackageFingerprint: fingerprintSchema,
  cliFingerprint: fingerprintSchema,
  sourceDigest: fingerprintSchema,
  executionDigest: fingerprintSchema,
  coreExtensionFingerprint: fingerprintSchema,
});
export type PiProbeEvidenceConsistency = z.infer<typeof piProbeEvidenceConsistencySchema>;

const requireProviderIndependentSupport = (
  report: PiPublicInterfaceProbeReport,
  label: string,
): void => {
  for (const surface of ["extension", "json", "rpc", "sdk"] as const) {
    if (report.surfaces[surface].status !== "SUPPORTED") {
      throw new Error(`${label} did not support required provider-independent surface ${surface}`);
    }
  }
  const expectedCapabilities = new Map([
    ["START_ATTEMPT", "SUPPORTED"],
    ["SEND_INPUT", "SUPPORTED"],
    ["OBSERVE", "SUPPORTED"],
    ["INTERRUPT", "SUPPORTED"],
    ["CHECKPOINT", "NOT_PROVEN"],
    ["RECONCILE", "NOT_PROVEN"],
    ["RESUME", "SUPPORTED"],
    ["CLOSE", "NOT_PROVEN"],
  ] as const);
  for (const result of report.capabilities.results) {
    if (expectedCapabilities.get(result.capability) !== result.status) {
      throw new Error(`${label} capability result did not match the Task 4 bounded outcome`);
    }
  }
};

export function comparePiProbeEvidence(
  windowsInput: unknown,
  ubuntuInput: unknown,
): PiProbeEvidenceConsistency {
  const windows = piPublicInterfaceProbeReportSchema.parse(windowsInput);
  const ubuntu = piPublicInterfaceProbeReportSchema.parse(ubuntuInput);
  if (windows.environment.platform !== "win32" || ubuntu.environment.platform !== "linux") {
    throw new Error("Pi Evidence platforms must be win32 and linux");
  }
  if (
    !windows.environment.nodeVersion.startsWith("v24.") ||
    !ubuntu.environment.nodeVersion.startsWith("v24.")
  ) {
    throw new Error("Pi Evidence must come from Node.js 24");
  }
  if (
    windows.implementation.execution.mode !== "BUILT_JAVASCRIPT" ||
    ubuntu.implementation.execution.mode !== "BUILT_JAVASCRIPT"
  ) {
    throw new Error("Pi CI Evidence must execute the built JavaScript adapter");
  }
  requireProviderIndependentSupport(windows, "Windows");
  requireProviderIndependentSupport(ubuntu, "Ubuntu");

  if (JSON.stringify(windows.candidate) !== JSON.stringify(ubuntu.candidate)) {
    throw new Error("Windows and Ubuntu Pi Evidence did not bind the same candidate artifact");
  }
  if (windows.implementation.sourceDigest !== ubuntu.implementation.sourceDigest) {
    throw new Error("Windows and Ubuntu Pi Evidence did not bind the same source digest");
  }
  if (
    windows.implementation.execution.digest !== ubuntu.implementation.execution.digest ||
    JSON.stringify(windows.implementation.execution.files) !==
      JSON.stringify(ubuntu.implementation.execution.files)
  ) {
    throw new Error("Windows and Ubuntu Pi Evidence did not bind the same adapter execution");
  }
  if (
    windows.surfaces.extension.sourceFingerprint !== ubuntu.surfaces.extension.sourceFingerprint
  ) {
    throw new Error("Windows and Ubuntu Pi Evidence did not bind the same Core Extension");
  }

  return piProbeEvidenceConsistencySchema.parse({
    schemaVersion: "1.0.0",
    kind: "hunter-pi/pi-evidence-consistency",
    status: "SUPPORTED",
    platforms: ["win32", "linux"],
    observations: {
      windows: windows.observedAt,
      ubuntu: ubuntu.observedAt,
    },
    installedPackageFingerprint: windows.candidate.installedPackageFingerprint,
    cliFingerprint: windows.candidate.cliFingerprint,
    sourceDigest: windows.implementation.sourceDigest,
    executionDigest: windows.implementation.execution.digest,
    coreExtensionFingerprint: windows.surfaces.extension.sourceFingerprint,
  });
}

const parseArguments = (
  arguments_: readonly string[],
): { readonly windows: string; readonly ubuntu: string; readonly output: string } => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || values.has(name)) {
      throw new Error(
        "usage: compare-pi-probe-evidence --windows <file> --ubuntu <file> --output <file>",
      );
    }
    values.set(name, value);
  }
  const windows = values.get("--windows");
  const ubuntu = values.get("--ubuntu");
  const output = values.get("--output");
  if (values.size !== 3 || windows === undefined || ubuntu === undefined || output === undefined) {
    throw new Error(
      "usage: compare-pi-probe-evidence --windows <file> --ubuntu <file> --output <file>",
    );
  }
  return { windows, ubuntu, output };
};

const runCli = async (): Promise<void> => {
  const repositoryRoot = resolve(process.cwd());
  const arguments_ = parseArguments(process.argv.slice(2));
  const outputPath = resolvePiProbeOutputPath(repositoryRoot, arguments_.output);
  await preparePiProbeOutput(repositoryRoot, outputPath);
  const [windows, ubuntu] = await Promise.all([
    readFile(resolve(repositoryRoot, arguments_.windows), "utf8").then(
      (content) => JSON.parse(content) as unknown,
    ),
    readFile(resolve(repositoryRoot, arguments_.ubuntu), "utf8").then(
      (content) => JSON.parse(content) as unknown,
    ),
  ]);
  const receipt = comparePiProbeEvidence(windows, ubuntu);
  await writeFile(outputPath, await formatPiProbeEvidence(receipt), {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write("PiEvidenceConsistency=SUPPORTED\n");
};

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown consistency failure";
    process.stderr.write(`Pi Evidence consistency failed: ${message}\n`);
    process.exitCode = 1;
  });
}
