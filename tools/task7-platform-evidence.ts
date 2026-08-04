import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { format } from "prettier";
import { z } from "zod";

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);

export const TASK7_SOURCE_PATHSPEC = [
  "package-lock.json",
  "package.json",
  "packages/domain/src",
  "packages/execution/src",
  "packages/workspace/src",
  "test/file-lease-manager.test.ts",
  "test/git-workspace-manager.test.ts",
  "test/managed-process-host.test.ts",
  "test/managed-process-platform.test.ts",
] as const;

export const TASK7_PLATFORM_CHECKS = [
  {
    id: "structured-argv",
    title: "preserves Unicode paths and structured argv without shell reconstruction",
  },
  {
    id: "nested-cancel",
    title: "cancels an owned nested child and grandchild as one contained tree",
  },
  {
    id: "nested-timeout",
    title: "times out and reconciles the exact nested process tree",
  },
  {
    id: "delayed-output-finality",
    title: "keeps finality pending while a descendant holds inherited output handles",
  },
  {
    id: "bounded-output",
    title: "bounds retained output while hashing every observed byte",
  },
  {
    id: "identity-mismatch",
    title: "does not signal a platform process tree when its identity fingerprint differs",
  },
] as const;

const sourcePathspecSchema = z.tuple(
  TASK7_SOURCE_PATHSPEC.map((path) => z.literal(path)) as [
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[0]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[1]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[2]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[3]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[4]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[5]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[6]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[7]>,
    z.ZodLiteral<(typeof TASK7_SOURCE_PATHSPEC)[8]>,
  ],
);

const task7CheckIdSchema = z.enum(TASK7_PLATFORM_CHECKS.map((check) => check.id));
const task7CheckResultSchema = z.strictObject({
  id: task7CheckIdSchema,
  status: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
});

export const task7PlatformReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-task7-platform-receipt.v1"),
    kind: z.literal("hunter-pi/task7-platform-receipt"),
    observedAt: z.iso.datetime({ offset: true }),
    status: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
    source: z.strictObject({
      repository: z.literal("hunter-pi"),
      commit: commitSchema,
      digest: fingerprintSchema,
      pathspec: sourcePathspecSchema,
    }),
    environment: z.strictObject({
      platform: z.enum(["win32", "linux"]),
      platformLabel: z.enum(["WINDOWS", "UBUNTU"]),
      architecture: z.string().regex(/^[a-z0-9_-]{2,32}$/u),
      nodeVersion: z.string().regex(/^v24\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u),
      gitVersion: z.string().regex(/^\d+\.\d+\.\d+(?:\.[A-Za-z0-9.-]+)?$/u),
    }),
    execution: z.strictObject({
      commandFingerprint: fingerprintSchema,
      testFileFingerprint: fingerprintSchema,
      startedAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }),
      durationMs: z.number().int().nonnegative(),
      exitCode: z.number().int().nullable(),
      reportStatus: z.enum(["COMPLETE", "NOT_PROVEN"]),
      stdoutDigest: fingerprintSchema,
      stderrDigest: fingerprintSchema,
      observedBytes: z.number().int().nonnegative(),
    }),
    containment: z.strictObject({
      expected: z.enum(["WINDOWS_JOB_OBJECT", "POSIX_PROCESS_GROUP"]),
      status: z.enum(["PASS", "NOT_PROVEN"]),
    }),
    checks: z.array(task7CheckResultSchema).length(TASK7_PLATFORM_CHECKS.length),
    boundaries: z.strictObject({
      fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_ONLY"),
      providerRequests: z.literal("NOT_RUN"),
      realRepositories: z.literal("NOT_RUN"),
      privateData: z.literal("EXCLUDED"),
      remoteCi: z.literal("PENDING"),
    }),
  })
  .superRefine((receipt, context) => {
    const expectedLabel = receipt.environment.platform === "win32" ? "WINDOWS" : "UBUNTU";
    const expectedContainment =
      receipt.environment.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "POSIX_PROCESS_GROUP";
    if (receipt.environment.platformLabel !== expectedLabel) {
      context.addIssue({ code: "custom", message: "platform label does not match platform" });
    }
    if (receipt.containment.expected !== expectedContainment) {
      context.addIssue({ code: "custom", message: "containment does not match platform" });
    }
    const ids = receipt.checks.map((check) => check.id);
    if (JSON.stringify(ids) !== JSON.stringify(TASK7_PLATFORM_CHECKS.map((check) => check.id))) {
      context.addIssue({
        code: "custom",
        message: "Task 7 checks must use the exact ordered matrix",
      });
    }
    if (
      receipt.status === "PASS" &&
      (receipt.execution.exitCode !== 0 ||
        receipt.execution.reportStatus !== "COMPLETE" ||
        receipt.containment.status !== "PASS" ||
        receipt.checks.some((check) => check.status !== "PASS"))
    ) {
      context.addIssue({ code: "custom", message: "PASS receipt contains an unproven result" });
    }
  });
export type Task7PlatformReceipt = z.infer<typeof task7PlatformReceiptSchema>;

export const task7PlatformFailureReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-task7-platform-failure.v1"),
  kind: z.literal("hunter-pi/task7-platform-failure"),
  observedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["FAIL", "NOT_PROVEN"]),
  platform: z.enum(["win32", "linux", "UNSUPPORTED"]),
  stage: z.enum(["SOURCE_IDENTITY", "TEST_EXECUTION", "REPORT_PARSE", "EVIDENCE_WRITE"]),
  code: z.literal("TASK7_PLATFORM_PROBE_DID_NOT_COMPLETE"),
  exitCode: z.number().int().nullable(),
  stdoutDigest: fingerprintSchema,
  stderrDigest: fingerprintSchema,
  observedBytes: z.number().int().nonnegative(),
  fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_ONLY"),
  providerRequests: z.literal("NOT_RUN"),
  realRepositories: z.literal("NOT_RUN"),
  remoteCi: z.literal("PENDING"),
});
export type Task7PlatformFailureReceipt = z.infer<typeof task7PlatformFailureReceiptSchema>;

const vitestAssertionSchema = z.looseObject({
  ancestorTitles: z.array(z.string()),
  title: z.string(),
  status: z.string(),
});
const vitestReportSchema = z.looseObject({
  numTotalTestSuites: z.number().int(),
  numPassedTestSuites: z.number().int(),
  numFailedTestSuites: z.number().int(),
  numPendingTestSuites: z.number().int(),
  numTotalTests: z.number().int(),
  numPassedTests: z.number().int(),
  numFailedTests: z.number().int(),
  numPendingTests: z.number().int(),
  testResults: z.array(z.looseObject({ assertionResults: z.array(vitestAssertionSchema) })),
});

export function parseTask7VitestReport(
  input: unknown,
): { readonly id: (typeof TASK7_PLATFORM_CHECKS)[number]["id"]; readonly status: "PASS" }[] {
  const report = vitestReportSchema.parse(input);
  const assertions = report.testResults.flatMap((result) => result.assertionResults);
  if (
    report.numTotalTestSuites !== 1 ||
    report.numPassedTestSuites !== 1 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.numTotalTests !== TASK7_PLATFORM_CHECKS.length ||
    assertions.length !== TASK7_PLATFORM_CHECKS.length
  ) {
    throw new Error("Vitest report did not contain the exact Task 7 platform matrix");
  }
  return TASK7_PLATFORM_CHECKS.map((check) => {
    const matches = assertions.filter(
      (assertion) =>
        assertion.title === check.title &&
        JSON.stringify(assertion.ancestorTitles) ===
          JSON.stringify(["local managed process platform"]),
    );
    if (matches.length !== 1) {
      throw new Error("Vitest report did not contain the exact Task 7 platform matrix");
    }
    if (matches[0]?.status !== "passed") {
      throw new Error(`Task 7 platform check ${check.id} did not pass`);
    }
    return { id: check.id, status: "PASS" as const };
  });
}

const privacyPatterns = [
  /[A-Za-z]:[\\/]/u,
  /\\\\[^\\\s]+\\/u,
  /\/(?:home|Users|tmp|var\/tmp)\//u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
  /\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{8,}\b/iu,
  /\bAKIA[A-Z0-9]{12,}\b/u,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/u,
] as const;

export function assertTask7EvidencePrivacy(input: unknown): void {
  const serialized = JSON.stringify(input);
  if (privacyPatterns.some((pattern) => pattern.test(serialized))) {
    throw new Error("Task 7 Evidence failed the privacy scan");
  }
}

const approvedOutputRoots = [
  ".artifacts/task7-platform",
  ".artifacts/task7-platform-aggregate",
  "docs/validation/evidence/task7",
] as const;
const outputFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;

function isContained(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative.length > 0 &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`) &&
    !isAbsolute(childRelative)
  );
}

export function resolveTask7OutputPath(repositoryRoot: string, requestedPath: string): string {
  const root = resolve(repositoryRoot);
  const target = resolve(root, requestedPath);
  const outputRoot = approvedOutputRoots
    .map((candidate) => resolve(root, candidate))
    .find((candidate) => isContained(candidate, target));
  if (outputRoot === undefined) {
    throw new Error("Task 7 output must stay in an approved Evidence root");
  }
  if (dirname(target) !== outputRoot || !outputFilenamePattern.test(basename(target))) {
    throw new Error("Task 7 Evidence output must be a flat JSON file");
  }
  return target;
}

export async function prepareTask7Output(
  repositoryRoot: string,
  outputPath: string,
): Promise<void> {
  const root = resolve(repositoryRoot);
  const outputRoot = dirname(outputPath);
  const normalizedRelativeRoot = relative(root, outputRoot).split(sep).join("/");
  if (!(approvedOutputRoots as readonly string[]).includes(normalizedRelativeRoot)) {
    throw new Error("Task 7 output root is not an approved Evidence directory");
  }
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("Task 7 repository root must be a physical directory");
  }
  let current = root;
  for (const segment of normalizedRelativeRoot.split("/")) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Task 7 Evidence directories must not contain links or reparse redirects");
    }
  }
  const [canonicalRoot, canonicalOutputRoot] = await Promise.all([
    realpath(root),
    realpath(outputRoot),
  ]);
  const expectedOutputRoot = resolve(canonicalRoot, ...normalizedRelativeRoot.split("/"));
  if (relative(expectedOutputRoot, canonicalOutputRoot).length !== 0) {
    throw new Error("Task 7 Evidence root resolves through an unexpected redirect");
  }
  try {
    const entry = await lstat(outputPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error("existing Task 7 Evidence must be a regular single-link file");
    }
    throw new Error("Task 7 Evidence output must not already exist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const approvedInputRoots = [
  ...approvedOutputRoots,
  ".artifacts/task7-platform-aggregate/windows",
  ".artifacts/task7-platform-aggregate/ubuntu",
] as const;

export async function readTask7EvidenceInput(
  repositoryRoot: string,
  requestedPath: string,
): Promise<unknown> {
  const root = resolve(repositoryRoot);
  const target = resolve(root, requestedPath);
  const inputRoot = approvedInputRoots
    .map((candidate) => resolve(root, candidate))
    .find((candidate) => dirname(target) === candidate);
  if (inputRoot === undefined || !outputFilenamePattern.test(basename(target))) {
    throw new Error("Task 7 input must stay in an approved Evidence root");
  }
  const normalizedRelativeRoot = relative(root, inputRoot).split(sep).join("/");
  let current = root;
  for (const segment of normalizedRelativeRoot.split("/")) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Task 7 Evidence input directories must be physical");
    }
  }
  const [canonicalRoot, canonicalInputRoot, canonicalTarget, entry] = await Promise.all([
    realpath(root),
    realpath(inputRoot),
    realpath(target),
    lstat(target),
  ]);
  const expectedInputRoot = resolve(canonicalRoot, ...normalizedRelativeRoot.split("/"));
  if (
    relative(expectedInputRoot, canonicalInputRoot).length !== 0 ||
    dirname(canonicalTarget) !== canonicalInputRoot ||
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1
  ) {
    throw new Error("Task 7 Evidence input must be a physical single-link file");
  }
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}

export async function formatTask7Evidence(value: unknown): Promise<string> {
  assertTask7EvidencePrivacy(value);
  return format(JSON.stringify(value), {
    endOfLine: "lf",
    parser: "json",
    printWidth: 100,
  });
}
