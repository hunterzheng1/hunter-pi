import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PI_CANDIDATE,
  PI_PROBE_BUILT_EXECUTION_FILES,
  PI_PROBE_SOURCE_FILES,
  createPiProbeFixture,
  derivePiEngineCapabilityResults,
  piPublicInterfaceSurfacesSchema,
  piPublicInterfaceProbeReportSchema,
  runPiPublicInterfaceProbe,
  type PiProbeFixture,
  type PiPublicInterfaceProbeReport,
} from "@hunter-pi/pi-host";
import { comparePiProbeEvidence } from "../tools/compare-pi-probe-evidence.js";

const coreExtensionPath = fileURLToPath(
  new URL("./fixtures/pi/core-extension-probe.ts", import.meta.url),
);

describe("fixed Pi public-interface probe", () => {
  let fixture: PiProbeFixture | undefined;
  let report: PiPublicInterfaceProbeReport | undefined;

  beforeAll(async () => {
    fixture = await createPiProbeFixture(tmpdir());
    report = await runPiPublicInterfaceProbe({
      coreExtensionPath,
      fixture,
      observedAt: "2026-08-03T00:00:00.000Z",
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) {
      const { removePiProbeFixture } = await import("@hunter-pi/pi-host");
      await removePiProbeFixture(fixture.root);
    }
  });

  it("proves the provider-independent Extension, JSON, RPC, and SDK behavior in an isolated Git fixture", async () => {
    if (fixture === undefined || report === undefined) {
      throw new Error("Pi public-interface probe setup did not complete");
    }
    const completedReport = report;

    expect(piPublicInterfaceProbeReportSchema.parse(completedReport)).toEqual(completedReport);
    expect(completedReport.candidate).toMatchObject({
      packageName: "@earendil-works/pi-coding-agent",
      version: "0.83.0",
      registryGitHead: "845d6ff1f6643aba440341cce877ce1c43ebbc39",
      installedFileCount: 884,
      installedBytes: 13_104_822,
      installedPackageFingerprint:
        "sha256:42b89fef9bf22021cb3d2ec4d187ad3a6a9444b90d8191e749b63cd5ea2cabdd",
    });
    expect(completedReport.candidate.integrity).toBe(PI_CANDIDATE.integrity);
    expect(completedReport.implementation.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(completedReport.implementation.sourceFiles).toEqual(PI_PROBE_SOURCE_FILES);
    expect(completedReport.implementation.execution.mode).toBe("SOURCE_TYPESCRIPT");
    expect(completedReport.implementation.execution.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    for (const sourceFile of [
      "tsconfig.base.json",
      "tsconfig.build.json",
      "tools/tsconfig.json",
    ] as const) {
      expect(completedReport.implementation.sourceFiles).toContain(sourceFile);
    }
    expect(completedReport.environment).toMatchObject({
      configurationIsolation: "ISOLATED",
      fixtureKind: "TEMPORARY_GIT",
      networkIsolation: "NOT_PROVEN",
      piNetworkMode: "OFFLINE",
      providerMode: "DETERMINISTIC_FAUX",
      sessionIsolation: "ISOLATED",
    });

    expect(completedReport.surfaces.extension).toMatchObject({
      status: "SUPPORTED",
      coreExtensionId: "hunter-pi/core-probe",
      coreExtensionVersion: "1.0.0",
      activeTools: ["hunter_pi_probe_tool"],
      interceptedToolCall: true,
      interceptedToolResult: true,
    });
    expect(completedReport.surfaces.extension.lifecycleEvents).toEqual(
      expect.arrayContaining(["session_start", "agent_start", "agent_end", "session_shutdown"]),
    );
    expect(completedReport.surfaces.extension.effectiveToolGraph).toContainEqual({
      name: "hunter_pi_probe_tool",
      origin: "top-level",
      scope: "temporary",
      source: "cli",
    });

    expect(completedReport.surfaces.json).toMatchObject({
      status: "SUPPORTED",
      framing: "NDJSON",
    });
    expect(completedReport.surfaces.json.eventTypes).toEqual(
      expect.arrayContaining([
        "agent_start",
        "agent_end",
        "tool_execution_start",
        "tool_execution_end",
      ]),
    );

    expect(completedReport.surfaces.rpc).toMatchObject({
      status: "SUPPORTED",
      framing: "NDJSON",
      cancellationScope: "SINGLE_IN_FLIGHT_AGENT_OPERATION",
      correlationById: true,
      concurrentRequestIds: ["state-before-a", "state-before-b"],
      requestScopedCancellation: false,
      promptAccepted: true,
      abortAccepted: true,
      streamStoppedAfterAbort: true,
      childExited: true,
      exitCode: 0,
      cleanupScope: "ROOT_PROCESS_WITHOUT_TOOL_CHILDREN",
      descendantProcessCleanup: "NOT_PROVEN",
    });
    expect([...completedReport.surfaces.rpc.correlatedResponseIds].sort()).toEqual(
      ["abort-active", "prompt-cancel", "state-after", "state-before-a", "state-before-b"].sort(),
    );

    expect(completedReport.surfaces.sdk).toMatchObject({
      status: "SUPPORTED",
      coreExtensionReloaded: true,
      sessionCreated: true,
      sessionContained: true,
      sessionPersisted: true,
      freshProcessResume: true,
      sameSessionIdOnResume: true,
      customEntryRecovered: true,
      workspaceCwdBound: true,
      persistenceRole: "ENGINE_EXTERNAL_REFERENCE",
      canonicalCheckpoint: "NOT_PROVEN_BY_PI",
    });
    expect(completedReport.surfaces.sdk.eventTypes).toEqual(
      expect.arrayContaining([
        "agent_start",
        "agent_end",
        "tool_execution_start",
        "tool_execution_end",
      ]),
    );

    expect(completedReport.surfaces.tui.status).toBe("NOT_PROVEN");
    expect(completedReport.surfaces.realProvider.status).toBe("NOT_PROVEN");
    expect(completedReport.capabilities.results).toEqual([
      { capability: "START_ATTEMPT", status: "SUPPORTED" },
      { capability: "SEND_INPUT", status: "SUPPORTED" },
      { capability: "OBSERVE", status: "SUPPORTED" },
      { capability: "INTERRUPT", status: "SUPPORTED" },
      { capability: "CHECKPOINT", status: "NOT_PROVEN" },
      { capability: "RECONCILE", status: "NOT_PROVEN" },
      { capability: "RESUME", status: "SUPPORTED" },
      { capability: "CLOSE", status: "NOT_PROVEN" },
    ]);

    const serialized = JSON.stringify(completedReport);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(process.env["USERPROFILE"] ?? "\u0000");
    expect(serialized).not.toMatch(/api[_-]?key|token|cookie|authorization/iu);

    const status = await readFile(`${fixture.repository}/.git/HEAD`, "utf8");
    expect(status).toContain("refs/heads/");
  });

  it("rejects a capability claim that is not derived from the matching surface receipt", () => {
    if (report === undefined) {
      throw new Error("Pi public-interface probe setup did not complete");
    }
    const completedReport = report;

    expect(() =>
      piPublicInterfaceProbeReportSchema.parse({
        ...completedReport,
        capabilities: {
          ...completedReport.capabilities,
          results: completedReport.capabilities.results.map((result) =>
            result.capability === "RECONCILE" ? { ...result, status: "SUPPORTED" } : result,
          ),
        },
      }),
    ).toThrow();
  }, 60_000);

  it("validates RPC responses by unique id rather than response order", () => {
    if (report === undefined) {
      throw new Error("Pi public-interface probe setup did not complete");
    }
    const reversedResponseIds = [...report.surfaces.rpc.correlatedResponseIds].reverse();
    expect(
      piPublicInterfaceProbeReportSchema.parse({
        ...report,
        surfaces: {
          ...report.surfaces,
          rpc: { ...report.surfaces.rpc, correlatedResponseIds: reversedResponseIds },
        },
      }).surfaces.rpc.correlatedResponseIds,
    ).toEqual(reversedResponseIds);
  }, 60_000);

  it("never derives support from a surface whose own status is not SUPPORTED", () => {
    if (report === undefined) {
      throw new Error("Pi public-interface probe setup did not complete");
    }
    const capabilityStatus = (
      surfaces: PiPublicInterfaceProbeReport["surfaces"],
      capability: PiPublicInterfaceProbeReport["capabilities"]["results"][number]["capability"],
    ): string =>
      derivePiEngineCapabilityResults(surfaces).find((result) => result.capability === capability)
        ?.status ?? "MISSING";

    const extensionNotProven = piPublicInterfaceSurfacesSchema.parse({
      ...report.surfaces,
      extension: { ...report.surfaces.extension, status: "NOT_PROVEN" },
    });
    expect(capabilityStatus(extensionNotProven, "START_ATTEMPT")).toBe("NOT_PROVEN");

    const jsonNotProven = piPublicInterfaceSurfacesSchema.parse({
      ...report.surfaces,
      json: { ...report.surfaces.json, status: "NOT_PROVEN" },
    });
    expect(capabilityStatus(jsonNotProven, "SEND_INPUT")).toBe("NOT_PROVEN");
    expect(capabilityStatus(jsonNotProven, "OBSERVE")).toBe("NOT_PROVEN");

    const rpcNotProven = piPublicInterfaceSurfacesSchema.parse({
      ...report.surfaces,
      rpc: { ...report.surfaces.rpc, status: "NOT_PROVEN" },
    });
    expect(capabilityStatus(rpcNotProven, "START_ATTEMPT")).toBe("NOT_PROVEN");
    expect(capabilityStatus(rpcNotProven, "INTERRUPT")).toBe("NOT_PROVEN");

    const sdkNotProven = piPublicInterfaceSurfacesSchema.parse({
      ...report.surfaces,
      sdk: { ...report.surfaces.sdk, status: "NOT_PROVEN" },
    });
    for (const capability of ["START_ATTEMPT", "SEND_INPUT", "OBSERVE", "RESUME"] as const) {
      expect(capabilityStatus(sdkNotProven, capability)).toBe("NOT_PROVEN");
    }
  }, 60_000);

  it("requires Windows and Ubuntu CI receipts to bind the same artifact and execution", () => {
    if (report === undefined) {
      throw new Error("Pi public-interface probe setup did not complete");
    }
    const execution = {
      mode: "BUILT_JAVASCRIPT" as const,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      files: PI_PROBE_BUILT_EXECUTION_FILES,
    };
    const windows = piPublicInterfaceProbeReportSchema.parse({
      ...report,
      implementation: { ...report.implementation, execution },
      environment: { ...report.environment, platform: "win32" },
    });
    const ubuntuObservedAt = "2026-08-03T00:00:01.000Z";
    const ubuntu = piPublicInterfaceProbeReportSchema.parse({
      ...report,
      observedAt: ubuntuObservedAt,
      implementation: { ...report.implementation, execution },
      environment: { ...report.environment, platform: "linux" },
      capabilities: { ...report.capabilities, observedAt: ubuntuObservedAt },
    });

    expect(comparePiProbeEvidence(windows, ubuntu)).toMatchObject({
      status: "SUPPORTED",
      platforms: ["win32", "linux"],
      sourceDigest: report.implementation.sourceDigest,
      executionDigest: execution.digest,
    });

    expect(() =>
      comparePiProbeEvidence(windows, {
        ...ubuntu,
        implementation: {
          ...ubuntu.implementation,
          sourceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      }),
    ).toThrow(/source digest/u);
  }, 60_000);
});
