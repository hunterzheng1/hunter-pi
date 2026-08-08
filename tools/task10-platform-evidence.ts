import { createHash } from "node:crypto";

import { z } from "zod";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

export const TASK10_CONTRACT_TEST_FILES = [
  "test/task10-plugin-manager.test.ts",
  "test/task10-pi-package-adapter.test.ts",
  "test/task10-plugin-activation.test.ts",
] as const;
export const TASK10_CONTRACT_TEST_COUNT = 18;

export const TASK10_SOURCE_PATHSPEC = [
  ".github/workflows/ci.yml",
  "apps/cli/package.json",
  "apps/cli/src/bin.ts",
  "apps/cli/src/cli.ts",
  "apps/cli/src/index.ts",
  "apps/cli/src/version.ts",
  "apps/cli/tsconfig.json",
  "docs/03-system-architecture.md",
  "docs/11-decision-summary.md",
  "docs/README.md",
  "docs/ci-operations.md",
  "docs/plans/2026-08-03-foundation-to-daily-use.md",
  "docs/plans/2026-08-05-task10-plugin-manager.md",
  "docs/validation/2026-08-08-daily-use-completion-audit.md",
  "package-lock.json",
  "package.json",
  "packages/pi-host/package.json",
  "packages/pi-host/src/configuration.ts",
  "packages/pi-host/src/index.ts",
  "packages/pi-host/src/pi-package-install-contract.ts",
  "packages/pi-host/src/pi-package-resolver.ts",
  "packages/pi-host/src/pi-package-install-worker.ts",
  "packages/pi-host/src/plugin-activation.ts",
  "packages/pi-host/src/plugin-errors.ts",
  "packages/pi-host/src/plugin-qualification.ts",
  "packages/pi-host/src/product-launcher.ts",
  "packages/pi-host/tsconfig.json",
  "packages/plugin-manager/src/contracts.ts",
  "packages/plugin-manager/src/manager.ts",
  "scripts/bundle-cli.mjs",
  "scripts/cli-package.mjs",
  "test/hpi-cli.test.ts",
  ...TASK10_CONTRACT_TEST_FILES,
] as const;

export const TASK10_VERIFIER_PATHSPEC = [
  "packages/evidence/src/atomic-write.ts",
  "packages/evidence/src/index.ts",
  "packages/evidence/src/serialization.ts",
  "scripts/npm-process.mjs",
  "scripts/package-specifier.mjs",
  "scripts/package-smoke.mjs",
  "scripts/temporary-directory.mjs",
  "test/support/temporary-test-directory.ts",
  "test/support/vitest-resource-runtime.ts",
  "test/support/workflow-domain-fixture.ts",
  "test/ci-efficiency-policy.test.ts",
  "tools/task10-platform-evidence.ts",
  "tools/task10-platform-probe.ts",
  "tools/task10-source-identity.ts",
  "tools/compare-task10-platform-evidence.ts",
  "test/task10-platform-evidence.test.ts",
  "test/vitest.global-setup.ts",
  "vitest.config.ts",
] as const;

export const TASK10_PLATFORM_CHECKS = [
  { id: "CONTRACT_MATRIX" },
  { id: "PUBLIC_PI_PACKAGE_RESOLUTION" },
  { id: "OBSERVED_SOURCE_BINDING" },
  { id: "INSTALL_RESOURCE_BUDGET" },
  { id: "PREACTIVATION_NON_EXECUTION" },
  { id: "MALICIOUS_FIXTURE_SAFE_MODE" },
  { id: "QUALIFIED_RESOURCE_ACTIVATION" },
  { id: "APPEND_ONLY_LIFECYCLE" },
  { id: "PRIVACY" },
] as const;
export type Task10PlatformCheckId = (typeof TASK10_PLATFORM_CHECKS)[number]["id"];

const contractMatrixSchema = z.strictObject({
  status: z.literal("PASS"),
  testFileCount: z.literal(TASK10_CONTRACT_TEST_FILES.length),
  testCount: z.literal(TASK10_CONTRACT_TEST_COUNT),
  passedCount: z.literal(TASK10_CONTRACT_TEST_COUNT),
  definitionFingerprint: fingerprintSchema,
});

export const task10PlatformFactsSchema = z.strictObject({
  contractMatrix: contractMatrixSchema,
  externalPackages: z.strictObject({
    count: z.literal(2),
    publicPackageManager: z.literal(true),
    metadataOnly: z.literal(true),
    executableCodeEvaluated: z.literal(false),
  }),
  exactSources: z.strictObject({
    local: z.literal("PUBLIC_MANAGER_PASS"),
    npm: z.literal("ADAPTER_CONTRACT_PASS"),
    git: z.literal("ADAPTER_CONTRACT_PASS"),
    piImport: z.literal("PUBLIC_MANAGER_PASS"),
    lifecycleScripts: z.literal("CONFIGURED_DISABLED"),
    publicNpmInstall: z.literal("NOT_RUN"),
    publicGitInstall: z.literal("NOT_RUN"),
    lifecycleAttackFixture: z.literal("NOT_RUN"),
  }),
  installationBudget: z.strictObject({
    elapsedLimit: z.literal("PASS"),
    entryLimit: z.literal("PASS"),
    byteLimit: z.literal("PASS"),
    freeSpaceFloor: z.literal("PASS"),
    failedGenerationRemoved: z.literal(true),
    singleArtifactWorkerRouting: z.literal("PASS"),
    productionWorkerPlatformExecution: z.literal("NOT_RUN"),
  }),
  maliciousFixtures: z.strictObject({
    fixtureCount: z.literal(5),
    safeModeCount: z.literal(5),
    evaluatedCount: z.literal(0),
    effectiveExtensionCount: z.literal(0),
  }),
  activation: z.strictObject({
    resourceOnlyCompatibility: z.literal("VERIFIED"),
    exactSkillActivated: z.literal(true),
    sourceMutationIsolated: z.literal(true),
    snapshotReadOnlyByDefault: z.literal(true),
    tamperRejected: z.literal(true),
  }),
  lifecycle: z.strictObject({
    install: z.literal("APPLIED"),
    disable: z.literal("APPLIED"),
    remove: z.literal("APPLIED"),
    durableReplay: z.literal(true),
    failedHistoryRewritten: z.literal(false),
  }),
  privacy: z.strictObject({
    scan: z.literal("PASS"),
    pathFree: z.literal(true),
    credentialFree: z.literal(true),
  }),
  boundaries: z.strictObject({
    providerRequests: z.literal("NOT_RUN"),
    realRepositories: z.literal("NOT_RUN"),
    osContainment: z.literal("NOT_CLAIMED"),
    arbitraryExtensionCompatibility: z.literal("NOT_CLAIMED"),
  }),
});
export type Task10PlatformFacts = z.infer<typeof task10PlatformFactsSchema>;

function exactPathspecSchema(expected: readonly string[]) {
  return z
    .array(z.string())
    .length(expected.length)
    .superRefine((paths, context) => {
      if (paths.some((path, index) => path !== expected[index])) {
        context.addIssue({ code: "custom", message: "Task 10 pathspec is not exact" });
      }
    });
}

const sourceIdentitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  state: z.literal("CLEAN"),
  pathspec: exactPathspecSchema(TASK10_SOURCE_PATHSPEC),
  fingerprint: fingerprintSchema,
});

const verifierIdentitySchema = z.strictObject({
  version: z.literal("task10-platform-verifier.v1"),
  pathspec: exactPathspecSchema(TASK10_VERIFIER_PATHSPEC),
  fingerprint: fingerprintSchema,
  commandFingerprint: fingerprintSchema,
});

const checkSchema = z.strictObject({
  id: z.enum(TASK10_PLATFORM_CHECKS.map(({ id }) => id)),
  status: z.literal("PASS"),
  fingerprint: fingerprintSchema,
});

export const task10PlatformReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-task10-platform-receipt.v1"),
    kind: z.literal("hunter-pi/task10-platform-receipt"),
    status: z.literal("PASS"),
    platform: z.strictObject({
      os: z.enum(["WINDOWS", "UBUNTU"]),
      architecture: z.literal("x64"),
      nodeMajor: z.literal(24),
    }),
    source: sourceIdentitySchema,
    verifier: verifierIdentitySchema,
    facts: task10PlatformFactsSchema,
    checks: z
      .array(checkSchema)
      .length(TASK10_PLATFORM_CHECKS.length)
      .superRefine((checks, context) => {
        if (checks.some((check, index) => check.id !== TASK10_PLATFORM_CHECKS[index]?.id)) {
          context.addIssue({ code: "custom", message: "Task 10 checks are not exact" });
        }
      }),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.facts.contractMatrix.definitionFingerprint !== task10DefinitionFingerprint()) {
      context.addIssue({ code: "custom", message: "Task 10 definition fingerprint is incorrect" });
    }
    if (receipt.verifier.commandFingerprint !== task10CommandFingerprint()) {
      context.addIssue({ code: "custom", message: "Task 10 command fingerprint is incorrect" });
    }
    for (const check of receipt.checks) {
      if (check.fingerprint !== task10CheckFingerprint(check.id, receipt.facts)) {
        context.addIssue({
          code: "custom",
          message: `Task 10 check fingerprint is incorrect: ${check.id}`,
        });
      }
    }
  });
export type Task10PlatformReceipt = z.infer<typeof task10PlatformReceiptSchema>;

export const task10PlatformFailureReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-task10-platform-failure.v1"),
  kind: z.literal("hunter-pi/task10-platform-failure"),
  status: z.enum(["FAIL", "NOT_PROVEN"]),
  stage: z.enum([
    "PLATFORM_IDENTITY",
    "SOURCE_IDENTITY",
    "CONTRACT_MATRIX",
    "PACKAGE_FIXTURES",
    "SOURCE_REVALIDATION",
  ]),
  platform: z.enum(["WINDOWS", "UBUNTU", "UNSUPPORTED"]),
  source: z
    .strictObject({
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      fingerprint: fingerprintSchema,
      verifierFingerprint: fingerprintSchema,
    })
    .nullable(),
  code: z.literal("TASK10_PLATFORM_PROBE_DID_NOT_COMPLETE"),
  errorFingerprint: fingerprintSchema,
  boundaries: task10PlatformFactsSchema.shape.boundaries,
  observedAt: timestampSchema,
});
export type Task10PlatformFailureReceipt = z.infer<typeof task10PlatformFailureReceiptSchema>;
export type Task10PlatformEvidence = Task10PlatformReceipt | Task10PlatformFailureReceipt;

export function task10CheckFingerprint(
  id: Task10PlatformCheckId,
  facts: Task10PlatformFacts,
): Fingerprint {
  return sha256Fingerprint(canonicalJson({ id, facts }));
}

export function task10DefinitionFingerprint(): Fingerprint {
  return sha256Fingerprint(
    canonicalJson({
      testFiles: TASK10_CONTRACT_TEST_FILES,
      testCount: TASK10_CONTRACT_TEST_COUNT,
      checks: TASK10_PLATFORM_CHECKS,
    }),
  );
}

export function task10CommandFingerprint(): Fingerprint {
  return sha256Fingerprint(
    canonicalJson({
      probe: [
        "node@24",
        "dist/tools/task10-platform-probe.js",
        "--output",
        "<APPROVED_TASK10_EVIDENCE_PATH>",
      ],
      contractTests: TASK10_CONTRACT_TEST_FILES,
      timeoutMs: 10 * 60_000,
    }),
  );
}

export function assertTask10EvidencePrivacy(value: unknown): void {
  const serialized = canonicalJson(value);
  const forbidden = [
    /[A-Za-z]:[\\/]/u,
    /(?:^|["'])\/(?:Users|home|private|tmp)\//u,
    /(?:api[_-]?key|access[_-]?token|password|secret|cookie)\s*[:=]/iu,
    /gh[opusr]_[A-Za-z0-9_]{20,}/u,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error("Task 10 Evidence contains a private path or credential-like value");
  }
}

export function task10ErrorFingerprint(error: unknown): Fingerprint {
  const shape =
    error instanceof Error
      ? {
          name: error.name,
          code: "code" in error ? String(error.code) : "NONE",
          messageFingerprint: createHash("sha256").update(error.message).digest("hex"),
        }
      : { name: "UnknownFailure", code: "NONE" };
  return sha256Fingerprint(canonicalJson(shape));
}
