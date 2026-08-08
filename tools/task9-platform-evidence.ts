import { z } from "zod";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

export const TASK9_SOURCE_PATHSPEC = [
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "packages/domain/src",
  "packages/execution/src",
  "packages/evidence/src",
  "packages/managed-change/src",
  "packages/workflow-kernel/src",
  "test",
  "tools/task9-platform-evidence.ts",
  "tools/task9-platform-probe.ts",
  "tools/compare-task9-platform-evidence.ts",
] as const;

export const TASK9_VERIFIER_PATHSPEC = [
  "package.json",
  "package-lock.json",
  "test/task9-platform-evidence.test.ts",
  "tools/task9-platform-evidence.ts",
  "tools/task9-platform-probe.ts",
  "tools/compare-task9-platform-evidence.ts",
] as const;

export const TASK9_PLATFORM_CHECKS = [
  { id: "PROCESS_FINAL_RECEIPT" },
  { id: "WRITER_LEASE_RELEASED" },
  { id: "ATTEMPT_FINALITY_BOUND" },
  { id: "DURABLE_REOPEN_REPLAY" },
  { id: "PORTABLE_EVIDENCE_PRIVACY" },
] as const;
export type Task9PlatformCheckId = (typeof TASK9_PLATFORM_CHECKS)[number]["id"];

const processFactsSchema = z.strictObject({
  terminalFinality: z.literal("FINAL"),
  processTreeState: z.literal("EMPTY"),
  outputState: z.literal("CLOSED"),
  leaseState: z.enum(["RELEASED", "NOT_REQUIRED"]),
  receiptFingerprint: fingerprintSchema,
});

const writerLeaseFactsSchema = z.strictObject({
  state: z.literal("RELEASED"),
  workspaceMatches: z.literal(true),
  receiptFingerprint: fingerprintSchema,
});

const attemptFinalityFactsSchema = z.strictObject({
  terminalFinality: z.literal("FINAL"),
  processCount: z.number().int().positive(),
  releasedWriterLeaseCount: z.number().int().positive(),
  evidenceCount: z.number().int().positive(),
  receiptFingerprint: fingerprintSchema,
});

const durableReplayFactsSchema = z.strictObject({
  processReceiptMatches: z.literal(true),
  evidenceReceiptMatches: z.literal(true),
  attemptFinalityMatches: z.literal(true),
});

const privacyFactsSchema = z.strictObject({
  scan: z.literal("PASS"),
  pathFree: z.literal(true),
  credentialFree: z.literal(true),
});

export const task9PlatformFactsSchema = z.strictObject({
  process: processFactsSchema,
  writerLease: writerLeaseFactsSchema,
  attemptFinality: attemptFinalityFactsSchema,
  durableReplay: durableReplayFactsSchema,
  privacy: privacyFactsSchema,
});
export type Task9PlatformFacts = z.infer<typeof task9PlatformFactsSchema>;

function checkPayload(id: Task9PlatformCheckId, facts: Task9PlatformFacts): unknown {
  switch (id) {
    case "PROCESS_FINAL_RECEIPT":
      return facts.process;
    case "WRITER_LEASE_RELEASED":
      return facts.writerLease;
    case "ATTEMPT_FINALITY_BOUND":
      return facts.attemptFinality;
    case "DURABLE_REOPEN_REPLAY":
      return facts.durableReplay;
    case "PORTABLE_EVIDENCE_PRIVACY":
      return facts.privacy;
  }
}

export function task9CheckFingerprint(
  id: Task9PlatformCheckId,
  factsInput: Task9PlatformFacts,
): Fingerprint {
  const facts = task9PlatformFactsSchema.parse(factsInput);
  return sha256Fingerprint(canonicalJson({ id, facts: checkPayload(id, facts) }));
}

const exactOrderedStrings = <Values extends readonly string[]>(values: Values, label: string) =>
  z
    .array(z.enum(values))
    .length(values.length)
    .superRefine((actual, context) => {
      if (actual.some((value, index) => value !== values[index])) {
        context.addIssue({ code: "custom", message: `${label} is not exact and ordered` });
      }
    });

const task9CheckIdSchema = z.enum(TASK9_PLATFORM_CHECKS.map(({ id }) => id));

function containsPrivateOrCredentialText(value: unknown): boolean {
  const text = canonicalJson(value);
  return (
    /[A-Za-z]:\\\\(?:Users|Documents and Settings)\\\\/iu.test(text) ||
    /\/(?:home|Users)\//iu.test(text) ||
    /(?:authorization|password|private[_-]?key|access[_-]?token|refresh[_-]?token)/iu.test(text) ||
    /[?&](?:token|key|password|signature)=/iu.test(text)
  );
}

export const task9PlatformReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-task9-platform-receipt.v1"),
    kind: z.literal("hunter-pi/task9-platform-receipt"),
    status: z.literal("PASS"),
    platform: z.strictObject({
      os: z.enum(["WINDOWS", "UBUNTU"]),
      architecture: z.literal("x64"),
      nodeMajor: z.literal(24),
    }),
    source: z.strictObject({
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      state: z.literal("CLEAN"),
      pathspec: exactOrderedStrings(TASK9_SOURCE_PATHSPEC, "Task 9 source pathspec"),
      fingerprint: fingerprintSchema,
    }),
    verifier: z.strictObject({
      version: z.literal("task9-platform-verifier.v1"),
      pathspec: exactOrderedStrings(TASK9_VERIFIER_PATHSPEC, "Task 9 verifier pathspec"),
      fingerprint: fingerprintSchema,
      commandFingerprint: fingerprintSchema,
    }),
    facts: task9PlatformFactsSchema,
    checks: z
      .array(
        z.strictObject({
          id: task9CheckIdSchema,
          status: z.literal("PASS"),
          fingerprint: fingerprintSchema,
        }),
      )
      .length(TASK9_PLATFORM_CHECKS.length),
    observedAt: timestampSchema,
  })
  .superRefine((receipt, context) => {
    for (const [index, expected] of TASK9_PLATFORM_CHECKS.entries()) {
      const actual = receipt.checks[index];
      if (
        actual?.id !== expected.id ||
        actual.fingerprint !== task9CheckFingerprint(expected.id, receipt.facts)
      ) {
        context.addIssue({
          code: "custom",
          path: ["checks", index],
          message: "Task 9 checks are not exact, ordered, and fact-bound",
        });
      }
    }
    if (containsPrivateOrCredentialText(receipt)) {
      context.addIssue({ code: "custom", message: "Task 9 PASS Evidence failed privacy scan" });
    }
  });
export type Task9PlatformReceipt = z.infer<typeof task9PlatformReceiptSchema>;

export const task9PlatformFailureReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-task9-platform-failure.v1"),
  kind: z.literal("hunter-pi/task9-platform-failure"),
  status: z.enum(["FAIL", "NOT_PROVEN"]),
  stage: z.enum([
    "PLATFORM_IDENTITY",
    "SOURCE_IDENTITY",
    "FINALITY_EXECUTION",
    "SOURCE_REVALIDATION",
  ]),
  platform: z.enum(["WINDOWS", "UBUNTU", "UNSUPPORTED"]),
  source: z
    .strictObject({
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      fingerprint: fingerprintSchema,
      pathspec: exactOrderedStrings(TASK9_SOURCE_PATHSPEC, "Task 9 source pathspec"),
      verifierFingerprint: fingerprintSchema,
      verifierPathspec: exactOrderedStrings(TASK9_VERIFIER_PATHSPEC, "Task 9 verifier pathspec"),
    })
    .nullable(),
  code: z.literal("TASK9_PLATFORM_PROBE_DID_NOT_COMPLETE"),
  errorFingerprint: fingerprintSchema,
  boundaries: z.strictObject({
    fixturePolicy: z.literal("AUTOMATIC_TEMPORARY_ONLY"),
    providerRequests: z.literal("NOT_RUN"),
    realRepositories: z.literal("NOT_RUN"),
    privateData: z.literal("EXCLUDED"),
  }),
  observedAt: timestampSchema,
});
export type Task9PlatformFailureReceipt = z.infer<typeof task9PlatformFailureReceiptSchema>;
export type Task9PlatformEvidence = Task9PlatformReceipt | Task9PlatformFailureReceipt;

export function assertTask9EvidencePrivacy(value: unknown): void {
  if (containsPrivateOrCredentialText(value)) {
    throw new Error("Task 9 Evidence failed the portable privacy scan");
  }
}
