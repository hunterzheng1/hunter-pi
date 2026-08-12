import { z } from "zod";

import {
  capabilityReceiptSchema,
  engineCapabilitySchema,
  type CapabilityProbeResult,
} from "@hunter-pi/engine-contracts";

export const PI_CANDIDATE = {
  packageName: "@earendil-works/pi-coding-agent",
  version: "0.84.1",
  registryGitHead: "53fa77ccd8a279eb87e92294ef3687b03ff80112",
  integrity:
    "sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==",
  installedPackageFingerprint:
    "sha256:54bc309babee1b4175d66ea54f63d72ca89bd30be77e5c4dabcdd64e1edfcdcd",
  installedFileCount: 968,
  installedBytes: 13_649_587,
} as const;

const PI_CANDIDATE_V1 = {
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
  "packages/pi-host/src/provider-usage.ts",
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
  "packages/pi-host/src/provider-usage.ts",
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
  "packages/pi-host/dist/provider-usage.js",
  "packages/pi-host/dist/schemas.js",
  "packages/pi-host/dist/sdk-probe-child.js",
  "test/fixtures/pi/core-extension-probe.ts",
  "dist/tools/pi-public-interface-probe.js",
] as const;

const PI_PROBE_SOURCE_FILES_V1 = [
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

const PI_PROBE_SOURCE_EXECUTION_FILES_V1 = [
  "packages/pi-host/src/fixture.ts",
  "packages/pi-host/src/index.ts",
  "packages/pi-host/src/ndjson.ts",
  "packages/pi-host/src/probe.ts",
  "packages/pi-host/src/schemas.ts",
  "packages/pi-host/src/sdk-probe-child.ts",
  "test/fixtures/pi/core-extension-probe.ts",
  "tools/pi-public-interface-probe.ts",
] as const;

const PI_PROBE_BUILT_EXECUTION_FILES_V1 = [
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

const piCandidateReceiptV1Schema = z.strictObject({
  packageName: z.literal(PI_CANDIDATE_V1.packageName),
  version: z.literal(PI_CANDIDATE_V1.version),
  registryGitHead: z.literal(PI_CANDIDATE_V1.registryGitHead),
  integrity: z.literal(PI_CANDIDATE_V1.integrity),
  cliFingerprint: fingerprintSchema,
  installedPackageFingerprint: z.literal(PI_CANDIDATE_V1.installedPackageFingerprint),
  installedFileCount: z.literal(PI_CANDIDATE_V1.installedFileCount),
  installedBytes: z.literal(PI_CANDIDATE_V1.installedBytes),
});

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

const piProbeSourceFilesV1Schema = z
  .array(z.string().min(1).max(256))
  .length(PI_PROBE_SOURCE_FILES_V1.length)
  .refine(
    (files) => JSON.stringify(files) === JSON.stringify(PI_PROBE_SOURCE_FILES_V1),
    "Pi v1 probe source pathspec must be exact and ordered",
  );

const piProbeExecutionReceiptV1Schema = z
  .strictObject({
    mode: z.enum(["SOURCE_TYPESCRIPT", "BUILT_JAVASCRIPT"]),
    digest: fingerprintSchema,
    files: z.array(z.string().min(1).max(256)).min(1),
  })
  .superRefine((receipt, context) => {
    const expected =
      receipt.mode === "SOURCE_TYPESCRIPT"
        ? PI_PROBE_SOURCE_EXECUTION_FILES_V1
        : PI_PROBE_BUILT_EXECUTION_FILES_V1;
    if (JSON.stringify(receipt.files) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Pi v1 probe execution pathspec must match its execution mode",
      });
    }
  });

const piProbeImplementationReceiptV1Schema = z.strictObject({
  sourceDigest: fingerprintSchema,
  sourceFiles: piProbeSourceFilesV1Schema,
  execution: piProbeExecutionReceiptV1Schema,
});

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

const deltaOnlyMessageUpdateContractSchema = z.strictObject({
  mode: z.literal("DELTA_ONLY"),
  assistantMessageEventObserved: z.literal(true),
  typedAssistantDeltaObserved: z.literal(true),
  cumulativeMessageAbsent: z.literal(true),
  assistantPartialAbsent: z.literal(true),
  authoritativeMessageEndObserved: z.literal(true),
  productionCompletionAccepted: z.literal(true),
  productionUsageAccounting: z.literal("PASS"),
});

const jsonSurfaceSchema = z
  .strictObject({
    status: piProbeStatusSchema,
    framing: z.enum(["NDJSON", "NOT_PROVEN"]),
    eventTypes: z.array(z.string().min(1).max(128)),
    parsedLineCount: z.number().int().nonnegative(),
    messageUpdateContract: deltaOnlyMessageUpdateContractSchema,
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
  "prompt-stream-proof",
  "prompt-cancel",
  "abort-active",
  "state-after",
] as const;

const requiredRpcResponseIdsV1 = [
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
    messageUpdateContract: deltaOnlyMessageUpdateContractSchema,
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

const jsonSurfaceV1Schema = z
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
        message: "SUPPORTED v1 JSON mode requires parseable NDJSON and required lifecycle events",
      });
    }
  });

const rpcSurfaceV1Schema = z
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
        surface.correlatedResponseIds.length !== requiredRpcResponseIdsV1.length ||
        new Set(surface.correlatedResponseIds).size !== requiredRpcResponseIdsV1.length ||
        requiredRpcResponseIdsV1.some((id) => !surface.correlatedResponseIds.includes(id)) ||
        !surface.promptAccepted ||
        !surface.abortAccepted ||
        !surface.streamStoppedAfterAbort ||
        !surface.childExited ||
        surface.exitCode !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "SUPPORTED v1 RPC requires correlation, active cancellation, and exact child exit proof",
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

const piPublicInterfaceSurfacesV1Schema = z.strictObject({
  extension: extensionSurfaceSchema,
  json: jsonSurfaceV1Schema,
  rpc: rpcSurfaceV1Schema,
  sdk: sdkSurfaceSchema,
  tui: explicitNonProofSurfaceSchema,
  realProvider: explicitNonProofSurfaceSchema,
});

const supportedWhen = (condition: boolean, blocked: boolean): PiProbeStatus => {
  if (condition) {
    return "SUPPORTED";
  }
  return blocked ? "BLOCKED" : "NOT_PROVEN";
};

interface PiCapabilitySurfaceFacts {
  readonly extension: { readonly status: PiProbeStatus };
  readonly json: {
    readonly status: PiProbeStatus;
    readonly eventTypes: readonly string[];
  };
  readonly rpc: {
    readonly status: PiProbeStatus;
    readonly promptAccepted: boolean;
    readonly abortAccepted: boolean;
    readonly streamStoppedAfterAbort: boolean;
  };
  readonly sdk: {
    readonly status: PiProbeStatus;
    readonly eventTypes: readonly string[];
    readonly coreExtensionReloaded: boolean;
    readonly sessionCreated: boolean;
    readonly sessionContained: boolean;
    readonly workspaceCwdBound: boolean;
    readonly sameSessionIdOnResume: boolean;
    readonly customEntryRecovered: boolean;
  };
}

function derivePiEngineCapabilityResultsFromFacts(
  parsed: PiCapabilitySurfaceFacts,
): CapabilityProbeResult[] {
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

export function derivePiEngineCapabilityResults(
  surfaces: PiPublicInterfaceSurfaces,
): CapabilityProbeResult[] {
  const parsed = piPublicInterfaceSurfacesSchema.parse(surfaces);
  return derivePiEngineCapabilityResultsFromFacts(parsed);
}

const piProbeEnvironmentSchema = z.strictObject({
  platform: z.string().min(1).max(32),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+/u),
  configurationIsolation: z.literal("ISOLATED"),
  sessionIsolation: z.literal("ISOLATED"),
  providerMode: z.literal("DETERMINISTIC_FAUX"),
  piNetworkMode: z.literal("OFFLINE"),
  networkIsolation: z.literal("NOT_PROVEN"),
  fixtureKind: z.literal("TEMPORARY_GIT"),
});

export const piPublicInterfaceProbeReportV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("hunter-pi/pi-public-interface-probe"),
    observedAt: z.iso.datetime({ offset: true }),
    candidate: piCandidateReceiptV1Schema,
    implementation: piProbeImplementationReceiptV1Schema,
    environment: piProbeEnvironmentSchema,
    surfaces: piPublicInterfaceSurfacesV1Schema,
    capabilities: capabilityReceiptSchema,
  })
  .superRefine((report, context) => {
    const expected = derivePiEngineCapabilityResultsFromFacts(report.surfaces);
    if (report.capabilities.observedAt !== report.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "observedAt"],
        message: "v1 Capability Receipt must bind the probe observation time",
      });
    }
    if (JSON.stringify(report.capabilities.results) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "results"],
        message: "v1 capability levels must be derived from the matching behavior receipts",
      });
    }
  });
export type PiPublicInterfaceProbeReportV1 = z.infer<typeof piPublicInterfaceProbeReportV1Schema>;

export const piPublicInterfaceProbeReportSchema = z
  .strictObject({
    schemaVersion: z.literal("2.0.0"),
    kind: z.literal("hunter-pi/pi-public-interface-probe"),
    observedAt: z.iso.datetime({ offset: true }),
    candidate: piCandidateReceiptSchema,
    implementation: piProbeImplementationReceiptSchema,
    environment: piProbeEnvironmentSchema,
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

export const piPublicInterfaceProbeReportReaderSchema = z.union([
  piPublicInterfaceProbeReportV1Schema,
  piPublicInterfaceProbeReportSchema,
]);
export type PiPublicInterfaceProbeReportReader = z.infer<
  typeof piPublicInterfaceProbeReportReaderSchema
>;

export const piPublicInterfaceProbeFailureReportSchema = z.strictObject({
  schemaVersion: z.literal("2.0.0"),
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
