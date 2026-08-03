import { z } from "zod";

import {
  capabilityReceiptSchema,
  engineCapabilitySchema,
  type CapabilityProbeResult,
} from "@hunter-pi/engine-contracts";

export const PI_CANDIDATE = {
  packageName: "@earendil-works/pi-coding-agent",
  version: "0.83.0",
  registryGitHead: "845d6ff1f6643aba440341cce877ce1c43ebbc39",
  integrity:
    "sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==",
  installedPackageFingerprint:
    "sha256:42b89fef9bf22021cb3d2ec4d187ad3a6a9444b90d8191e749b63cd5ea2cabdd",
  installedFileCount: 884,
  installedBytes: 13_104_822,
} as const;

export const PI_PROBE_SOURCE_FILES = [
  ".github/workflows/ci.yml",
  "package.json",
  "package-lock.json",
  "packages/pi-host/package.json",
  "packages/pi-host/tsconfig.json",
  "packages/pi-host/src/index.ts",
  "packages/pi-host/src/fixture.ts",
  "packages/pi-host/src/ndjson.ts",
  "packages/pi-host/src/probe.ts",
  "packages/pi-host/src/schemas.ts",
  "packages/pi-host/src/sdk-probe-child.ts",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "test/fixtures/pi/core-extension-probe.ts",
  "test/pi-fixture-and-output-safety.test.ts",
  "test/pi-ndjson.test.ts",
  "test/pi-probe-cli.test.ts",
  "test/pi-public-interface-probe.test.ts",
  "tools/compare-pi-probe-evidence.ts",
  "tools/pi-public-interface-probe.ts",
  "tools/tsconfig.json",
] as const;

export const PI_PROBE_SOURCE_EXECUTION_FILES = [
  "packages/pi-host/src/fixture.ts",
  "packages/pi-host/src/index.ts",
  "packages/pi-host/src/ndjson.ts",
  "packages/pi-host/src/probe.ts",
  "packages/pi-host/src/schemas.ts",
  "packages/pi-host/src/sdk-probe-child.ts",
  "test/fixtures/pi/core-extension-probe.ts",
  "tools/pi-public-interface-probe.ts",
] as const;

export const PI_PROBE_BUILT_EXECUTION_FILES = [
  "packages/pi-host/dist/fixture.js",
  "packages/pi-host/dist/index.js",
  "packages/pi-host/dist/ndjson.js",
  "packages/pi-host/dist/probe.js",
  "packages/pi-host/dist/schemas.js",
  "packages/pi-host/dist/sdk-probe-child.js",
  "test/fixtures/pi/core-extension-probe.ts",
  "dist/tools/pi-public-interface-probe.js",
] as const;

export const piProbeStatusSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "BLOCKED", "NOT_PROVEN"]);
export type PiProbeStatus = z.infer<typeof piProbeStatusSchema>;

export const piProbeFailureStageSchema = z.enum([
  "FIXTURE_SETUP",
  "CANDIDATE_IDENTITY",
  "IMPLEMENTATION_IDENTITY",
  "EXTENSION_AND_JSON",
  "RPC",
  "SDK",
  "REPORT_ASSEMBLY",
  "FIXTURE_CLEANUP",
  "EVIDENCE_WRITE",
]);
export type PiProbeFailureStage = z.infer<typeof piProbeFailureStageSchema>;

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const piCandidateReceiptSchema = z.strictObject({
  packageName: z.literal(PI_CANDIDATE.packageName),
  version: z.literal(PI_CANDIDATE.version),
  registryGitHead: z.literal(PI_CANDIDATE.registryGitHead),
  integrity: z.literal(PI_CANDIDATE.integrity),
  cliFingerprint: fingerprintSchema,
  installedPackageFingerprint: z.literal(PI_CANDIDATE.installedPackageFingerprint),
  installedFileCount: z.literal(PI_CANDIDATE.installedFileCount),
  installedBytes: z.literal(PI_CANDIDATE.installedBytes),
});
export type PiCandidateReceipt = z.infer<typeof piCandidateReceiptSchema>;

const piProbeSourceFilesSchema = z
  .array(z.enum(PI_PROBE_SOURCE_FILES))
  .length(PI_PROBE_SOURCE_FILES.length)
  .refine(
    (files) => JSON.stringify(files) === JSON.stringify(PI_PROBE_SOURCE_FILES),
    "Pi probe source pathspec must be exact and ordered",
  );

const piProbeExecutionReceiptSchema = z
  .strictObject({
    mode: z.enum(["SOURCE_TYPESCRIPT", "BUILT_JAVASCRIPT"]),
    digest: fingerprintSchema,
    files: z.array(z.string().min(1).max(256)).min(1),
  })
  .superRefine((receipt, context) => {
    const expected =
      receipt.mode === "SOURCE_TYPESCRIPT"
        ? PI_PROBE_SOURCE_EXECUTION_FILES
        : PI_PROBE_BUILT_EXECUTION_FILES;
    if (JSON.stringify(receipt.files) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Pi probe execution pathspec must match its execution mode",
      });
    }
  });

export const piProbeImplementationReceiptSchema = z.strictObject({
  sourceDigest: fingerprintSchema,
  sourceFiles: piProbeSourceFilesSchema,
  execution: piProbeExecutionReceiptSchema,
});
export type PiProbeImplementationReceipt = z.infer<typeof piProbeImplementationReceiptSchema>;

const toolGraphEntrySchema = z.strictObject({
  name: z.string().min(1).max(128),
  source: z.string().min(1).max(128),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
});

const extensionSurfaceSchema = z
  .strictObject({
    status: piProbeStatusSchema,
    coreExtensionId: z.literal("hunter-pi/core-probe"),
    coreExtensionVersion: z.literal("1.0.0"),
    sourceFingerprint: fingerprintSchema,
    lifecycleEvents: z.array(z.string().min(1).max(128)),
    activeTools: z.array(z.string().min(1).max(128)),
    effectiveToolGraph: z.array(toolGraphEntrySchema),
    interceptedToolCall: z.boolean(),
    interceptedToolResult: z.boolean(),
  })
  .superRefine((surface, context) => {
    if (
      surface.status === "SUPPORTED" &&
      (!surface.lifecycleEvents.includes("session_start") ||
        !surface.lifecycleEvents.includes("session_shutdown") ||
        surface.activeTools.length !== 1 ||
        surface.activeTools[0] !== "hunter_pi_probe_tool" ||
        !surface.effectiveToolGraph.some((tool) => tool.name === "hunter_pi_probe_tool") ||
        !surface.interceptedToolCall ||
        !surface.interceptedToolResult)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "SUPPORTED Extension requires exact identity, lifecycle, tool graph, and interception proof",
      });
    }
  });

const jsonSurfaceSchema = z
  .strictObject({
    status: piProbeStatusSchema,
    framing: z.enum(["NDJSON", "NOT_PROVEN"]),
    eventTypes: z.array(z.string().min(1).max(128)),
    parsedLineCount: z.number().int().nonnegative(),
  })
  .superRefine((surface, context) => {
    const requiredEvents = [
      "agent_start",
      "agent_end",
      "tool_execution_start",
      "tool_execution_end",
    ];
    if (
      surface.status === "SUPPORTED" &&
      (surface.framing !== "NDJSON" ||
        surface.parsedLineCount === 0 ||
        requiredEvents.some((event) => !surface.eventTypes.includes(event)))
    ) {
      context.addIssue({
        code: "custom",
        message: "SUPPORTED JSON mode requires parseable NDJSON and required lifecycle events",
      });
    }
  });

const requiredRpcResponseIds = [
  "state-before-a",
  "state-before-b",
  "prompt-cancel",
  "abort-active",
  "state-after",
] as const;

const rpcSurfaceSchema = z
  .strictObject({
    status: piProbeStatusSchema,
    framing: z.enum(["NDJSON", "NOT_PROVEN"]),
    cancellationScope: z.literal("SINGLE_IN_FLIGHT_AGENT_OPERATION"),
    correlationById: z.literal(true),
    concurrentRequestIds: z.tuple([z.literal("state-before-a"), z.literal("state-before-b")]),
    requestScopedCancellation: z.literal(false),
    correlatedResponseIds: z.array(z.string().min(1).max(128)),
    promptAccepted: z.boolean(),
    abortAccepted: z.boolean(),
    streamStoppedAfterAbort: z.boolean(),
    childExited: z.boolean(),
    exitCode: z.number().int().nullable(),
    cleanupScope: z.literal("ROOT_PROCESS_WITHOUT_TOOL_CHILDREN"),
    descendantProcessCleanup: z.literal("NOT_PROVEN"),
  })
  .superRefine((surface, context) => {
    if (
      surface.status === "SUPPORTED" &&
      (surface.framing !== "NDJSON" ||
        surface.correlatedResponseIds.length !== requiredRpcResponseIds.length ||
        new Set(surface.correlatedResponseIds).size !== requiredRpcResponseIds.length ||
        requiredRpcResponseIds.some((id) => !surface.correlatedResponseIds.includes(id)) ||
        !surface.promptAccepted ||
        !surface.abortAccepted ||
        !surface.streamStoppedAfterAbort ||
        !surface.childExited ||
        surface.exitCode !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "SUPPORTED RPC requires correlation, active cancellation, and exact child exit proof",
      });
    }
  });

const sdkSurfaceSchema = z
  .strictObject({
    status: piProbeStatusSchema,
    coreExtensionReloaded: z.boolean(),
    sessionCreated: z.boolean(),
    eventTypes: z.array(z.string().min(1).max(128)),
    sessionContained: z.boolean(),
    sessionPersisted: z.boolean(),
    freshProcessResume: z.boolean(),
    sameSessionIdOnResume: z.boolean(),
    customEntryRecovered: z.boolean(),
    workspaceCwdBound: z.boolean(),
    persistenceRole: z.literal("ENGINE_EXTERNAL_REFERENCE"),
    canonicalCheckpoint: z.literal("NOT_PROVEN_BY_PI"),
  })
  .superRefine((surface, context) => {
    if (
      surface.status === "SUPPORTED" &&
      (!surface.coreExtensionReloaded ||
        !surface.sessionCreated ||
        !surface.eventTypes.includes("agent_start") ||
        !surface.eventTypes.includes("agent_end") ||
        !surface.sessionContained ||
        !surface.sessionPersisted ||
        !surface.freshProcessResume ||
        !surface.sameSessionIdOnResume ||
        !surface.customEntryRecovered ||
        !surface.workspaceCwdBound)
    ) {
      context.addIssue({
        code: "custom",
        message: "SUPPORTED SDK requires session, event, persistence, and resume proof",
      });
    }
  });

const explicitNonProofSurfaceSchema = z.strictObject({
  status: z.literal("NOT_PROVEN"),
  reason: z.string().min(1).max(512),
});

export const piPublicInterfaceSurfacesSchema = z.strictObject({
  extension: extensionSurfaceSchema,
  json: jsonSurfaceSchema,
  rpc: rpcSurfaceSchema,
  sdk: sdkSurfaceSchema,
  tui: explicitNonProofSurfaceSchema,
  realProvider: explicitNonProofSurfaceSchema,
});
export type PiPublicInterfaceSurfaces = z.infer<typeof piPublicInterfaceSurfacesSchema>;

const supportedWhen = (condition: boolean, blocked: boolean): PiProbeStatus => {
  if (condition) {
    return "SUPPORTED";
  }
  return blocked ? "BLOCKED" : "NOT_PROVEN";
};

export function derivePiEngineCapabilityResults(
  surfaces: PiPublicInterfaceSurfaces,
): CapabilityProbeResult[] {
  const parsed = piPublicInterfaceSurfacesSchema.parse(surfaces);
  const anyBlocked = [parsed.extension, parsed.json, parsed.rpc, parsed.sdk].some(
    (surface) => surface.status === "BLOCKED",
  );
  const jsonEvents = new Set(parsed.json.eventTypes);
  const sdkEvents = new Set(parsed.sdk.eventTypes);

  const statuses: Record<z.infer<typeof engineCapabilitySchema>, PiProbeStatus> = {
    START_ATTEMPT: supportedWhen(
      parsed.extension.status === "SUPPORTED" &&
        parsed.rpc.status === "SUPPORTED" &&
        parsed.sdk.status === "SUPPORTED" &&
        parsed.sdk.sessionCreated &&
        parsed.sdk.sessionContained &&
        parsed.sdk.workspaceCwdBound,
      anyBlocked,
    ),
    SEND_INPUT: supportedWhen(
      parsed.json.status === "SUPPORTED" &&
        parsed.sdk.status === "SUPPORTED" &&
        sdkEvents.has("agent_start"),
      anyBlocked,
    ),
    OBSERVE: supportedWhen(
      parsed.json.status === "SUPPORTED" &&
        parsed.sdk.status === "SUPPORTED" &&
        jsonEvents.has("agent_end") &&
        sdkEvents.has("agent_end"),
      anyBlocked,
    ),
    INTERRUPT: supportedWhen(
      parsed.rpc.status === "SUPPORTED" &&
        parsed.rpc.promptAccepted &&
        parsed.rpc.abortAccepted &&
        parsed.rpc.streamStoppedAfterAbort,
      anyBlocked,
    ),
    CHECKPOINT: "NOT_PROVEN",
    RECONCILE: "NOT_PROVEN",
    RESUME: supportedWhen(
      parsed.sdk.status === "SUPPORTED" &&
        parsed.sdk.coreExtensionReloaded &&
        parsed.sdk.sessionContained &&
        parsed.sdk.workspaceCwdBound &&
        parsed.sdk.sameSessionIdOnResume &&
        parsed.sdk.customEntryRecovered,
      anyBlocked,
    ),
    CLOSE: "NOT_PROVEN",
  };

  return engineCapabilitySchema.options.map((capability) => ({
    capability,
    status: statuses[capability],
  }));
}

export const piPublicInterfaceProbeReportSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("hunter-pi/pi-public-interface-probe"),
    observedAt: z.iso.datetime({ offset: true }),
    candidate: piCandidateReceiptSchema,
    implementation: piProbeImplementationReceiptSchema,
    environment: z.strictObject({
      platform: z.string().min(1).max(32),
      nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+/u),
      configurationIsolation: z.literal("ISOLATED"),
      sessionIsolation: z.literal("ISOLATED"),
      providerMode: z.literal("DETERMINISTIC_FAUX"),
      piNetworkMode: z.literal("OFFLINE"),
      networkIsolation: z.literal("NOT_PROVEN"),
      fixtureKind: z.literal("TEMPORARY_GIT"),
    }),
    surfaces: piPublicInterfaceSurfacesSchema,
    capabilities: capabilityReceiptSchema,
  })
  .superRefine((report, context) => {
    const expected = derivePiEngineCapabilityResults(report.surfaces);
    if (report.capabilities.observedAt !== report.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "observedAt"],
        message: "Capability Receipt must bind the probe observation time",
      });
    }
    if (JSON.stringify(report.capabilities.results) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "results"],
        message: "Capability levels must be derived from the matching behavior receipts",
      });
    }
  });
export type PiPublicInterfaceProbeReport = z.infer<typeof piPublicInterfaceProbeReportSchema>;

export const piPublicInterfaceProbeFailureReportSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("hunter-pi/pi-public-interface-probe-failure"),
  observedAt: z.iso.datetime({ offset: true }),
  status: z.literal("NOT_PROVEN"),
  expectedCandidate: z.strictObject({
    packageName: z.literal(PI_CANDIDATE.packageName),
    version: z.literal(PI_CANDIDATE.version),
    registryGitHead: z.literal(PI_CANDIDATE.registryGitHead),
    integrity: z.literal(PI_CANDIDATE.integrity),
  }),
  failure: z.strictObject({
    code: z.literal("PROBE_DID_NOT_COMPLETE"),
    stage: piProbeFailureStageSchema,
    classification: z.literal("NOT_PROVEN"),
    reason: z.literal(
      "The provider-independent probe did not complete; no interface capability was established.",
    ),
  }),
});
export type PiPublicInterfaceProbeFailureReport = z.infer<
  typeof piPublicInterfaceProbeFailureReportSchema
>;
