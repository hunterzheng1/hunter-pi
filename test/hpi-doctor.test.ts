import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  createInteractiveTuiConfigurationFingerprint,
  hpiDoctorReportSchema,
  inspectPiEngineRelease,
  resolveHpiPaths,
  runHpiDoctor,
  saveHpiConfiguration,
} from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const createdRoots: string[] = [];
const coreIntegrity = `sha256:${"a".repeat(64)}`;
const changedCoreIntegrity = `sha256:${"b".repeat(64)}`;
const productShellIntegrity = `sha256:${"c".repeat(64)}`;
const changedProductShellIntegrity = `sha256:${"d".repeat(64)}`;
const detectedCoreExtension = () =>
  Promise.resolve({
    detected: true,
    version: "0.1.0-dev.1",
    integrity: coreIntegrity,
  });
const testProductIdentity = {
  productVersion: "0.1.0-dev.1",
  sourceCommit: "NOT_STAMPED",
  sourceState: "NOT_STAMPED" as const,
  coreExtensionIntegrity: coreIntegrity,
  productShellIntegrity,
};
const detectedManagedDestination = () =>
  Promise.resolve({
    configuredOrigin: "https://provider-managed.example",
    pristineOrigin: "https://provider-managed.example",
  });

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

async function createConfiguredProfile(): Promise<{
  readonly profile: string;
  readonly paths: ReturnType<typeof resolveHpiPaths>;
}> {
  const profile = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-doctor-test-");
  createdRoots.push(profile);
  const paths = resolveHpiPaths({ homeDirectory: profile, env: {} });
  const configuration = acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
    acceptedAt: "2026-08-03T12:00:00.000Z",
    resolvedDestinationOrigin: "https://provider-managed.example",
  });
  await saveHpiConfiguration(paths, {
    ...configuration,
    setupCompletedAt: "2026-08-03T12:01:00.000Z",
  });
  return { profile, paths };
}

describe("Hunter Pi Doctor", () => {
  it("detects the actually installed fixed Pi Engine Release through its ESM export", async () => {
    await expect(inspectPiEngineRelease()).resolves.toEqual({
      detected: true,
      version: "0.84.1",
    });
  });

  it("reports an unconfigured Provider as BLOCKED without leaking paths or credential-shaped data", async () => {
    const { paths, profile } = await createConfiguredProfile();

    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: false }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: detectedCoreExtension,
    });

    expect(hpiDoctorReportSchema.parse(report)).toEqual(report);
    expect(report.overallStatus).toBe("BLOCKED");
    expect(report.checks).toContainEqual({
      id: "provider_auth",
      status: "BLOCKED",
      summary: "Selected Provider authentication is not configured.",
      nextAction: "Run `hpi login` and complete the Provider-owned login flow.",
    });
    expect(report.checks).toContainEqual({
      id: "git_fixture",
      status: "DETECTED",
      summary: "Git initialized and inspected an automatically created temporary fixture.",
      nextAction: null,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(profile);
    expect(serialized).not.toContain(paths.root);
    expect(serialized).not.toMatch(/api[_-]?key|cookie|authorization|bearer/iu);
  });

  it("distinguishes readiness metadata from an unproven interactive TUI", async () => {
    const { paths, profile } = await createConfiguredProfile();

    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () =>
        Promise.resolve({ configured: true, source: "stored", label: "must-not-be-copied" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: detectedCoreExtension,
    });

    expect(report.overallStatus).toBe("NOT_PROVEN");
    expect(report.checks).toContainEqual({
      id: "provider_auth",
      status: "DETECTED",
      summary: "Selected Provider authentication metadata is configured (stored).",
      nextAction: null,
    });
    expect(report.checks).toContainEqual({
      id: "interactive_tui",
      status: "NOT_PROVEN",
      summary: "Interactive Pi TUI usability requires a separate real-terminal smoke.",
      nextAction: "Run `hpi smoke tui` in a real Windows terminal without sending a model request.",
    });
    expect(JSON.stringify(report)).not.toContain("must-not-be-copied");
  });

  it("accepts an exact human TUI receipt as DETECTED without turning it into Provider proof", async () => {
    const { paths, profile } = await createConfiguredProfile();
    const configuration = await import("@hunter-pi/pi-host").then(({ loadHpiConfiguration }) =>
      loadHpiConfiguration(paths),
    );
    if (configuration === null) throw new Error("test configuration is missing");
    await saveHpiConfiguration(paths, {
      ...configuration,
      interactiveTuiReadiness: {
        status: "DETECTED",
        checkedAt: "2026-08-03T12:01:30.000Z",
        engineVersion: "0.84.1",
        productVersion: testProductIdentity.productVersion,
        sourceCommit: testProductIdentity.sourceCommit,
        sourceState: testProductIdentity.sourceState,
        platform: process.platform,
        terminalKind: "TTY",
        coreExtensionIntegrity: coreIntegrity,
        productShellIntegrity,
        configurationFingerprint: createInteractiveTuiConfigurationFingerprint(configuration),
        receiptKind: "MANUAL_ACKNOWLEDGEMENT",
      },
    });

    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: detectedCoreExtension,
      productIdentity: testProductIdentity,
      platform: process.platform,
    });
    expect(report.overallStatus).toBe("DETECTED");
    expect(report.checks).toContainEqual({
      id: "interactive_tui",
      status: "DETECTED",
      summary: "Interactive Pi TUI has an exact explicit manual smoke acknowledgement.",
      nextAction: null,
    });
    expect(report.checks.map((check) => check.id)).not.toContain("real_provider");

    const changedArtifactReport = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:03:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: () =>
        Promise.resolve({
          detected: true,
          version: "0.1.0-dev.1",
          integrity: changedCoreIntegrity,
        }),
      productIdentity: { ...testProductIdentity, coreExtensionIntegrity: changedCoreIntegrity },
      platform: process.platform,
    });
    expect(
      changedArtifactReport.checks.find((check) => check.id === "interactive_tui")?.status,
    ).toBe("NOT_PROVEN");
  });

  it("does not reuse a human TUI receipt when the product shell changes but Core stays exact", async () => {
    const { paths, profile } = await createConfiguredProfile();
    const configuration = await import("@hunter-pi/pi-host").then(({ loadHpiConfiguration }) =>
      loadHpiConfiguration(paths),
    );
    if (configuration === null) throw new Error("test configuration is missing");
    await saveHpiConfiguration(paths, {
      ...configuration,
      interactiveTuiReadiness: {
        status: "DETECTED",
        checkedAt: "2026-08-03T12:01:30.000Z",
        engineVersion: "0.84.1",
        productVersion: testProductIdentity.productVersion,
        sourceCommit: testProductIdentity.sourceCommit,
        sourceState: testProductIdentity.sourceState,
        platform: process.platform,
        terminalKind: "TTY",
        coreExtensionIntegrity: coreIntegrity,
        productShellIntegrity,
        configurationFingerprint: createInteractiveTuiConfigurationFingerprint(configuration),
        receiptKind: "MANUAL_ACKNOWLEDGEMENT",
      },
    });

    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: detectedCoreExtension,
      productIdentity: {
        ...testProductIdentity,
        productShellIntegrity: changedProductShellIntegrity,
      },
      platform: process.platform,
    });

    expect(report.checks.find((check) => check.id === "core_extension")?.status).toBe("DETECTED");
    expect(report.checks.find((check) => check.id === "interactive_tui")?.status).toBe(
      "NOT_PROVEN",
    );
  });

  it("does not reuse a human TUI receipt across a different product artifact or platform", async () => {
    const { paths, profile } = await createConfiguredProfile();
    const configuration = await import("@hunter-pi/pi-host").then(({ loadHpiConfiguration }) =>
      loadHpiConfiguration(paths),
    );
    if (configuration === null) throw new Error("test configuration is missing");
    await saveHpiConfiguration(paths, {
      ...configuration,
      interactiveTuiReadiness: {
        status: "DETECTED",
        checkedAt: "2026-08-03T12:01:30.000Z",
        engineVersion: "0.84.1",
        productVersion: testProductIdentity.productVersion,
        sourceCommit: testProductIdentity.sourceCommit,
        sourceState: testProductIdentity.sourceState,
        platform: process.platform,
        terminalKind: "TTY",
        coreExtensionIntegrity: coreIntegrity,
        productShellIntegrity,
        configurationFingerprint: createInteractiveTuiConfigurationFingerprint(configuration),
        receiptKind: "MANUAL_ACKNOWLEDGEMENT",
      },
    });

    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      productIdentity: {
        productVersion: "0.1.0-dev.1",
        sourceCommit: "1".repeat(40),
        sourceState: "CLEAN",
        coreExtensionIntegrity: coreIntegrity,
        productShellIntegrity: changedProductShellIntegrity,
      },
      platform: "linux",
      inspectCoreExtension: detectedCoreExtension,
    });
    expect(report.checks.find((check) => check.id === "interactive_tui")?.status).toBe(
      "NOT_PROVEN",
    );
  });

  it("blocks when the bundled Core Extension entrypoint is absent", async () => {
    const { paths, profile } = await createConfiguredProfile();
    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      inspectCoreExtension: () => Promise.resolve({ detected: false }),
    });

    expect(report.checks).toContainEqual({
      id: "core_extension",
      status: "BLOCKED",
      summary: "The bundled Core Extension entrypoint is missing or invalid.",
      nextAction: "Reinstall the exact Hunter Pi developer-preview artifact.",
    });
  });

  it("marks incompatible Node and a missing Git executable precisely", async () => {
    const { paths, profile } = await createConfiguredProfile();

    const report = await runHpiDoctor({
      paths,
      nodeVersion: "v23.9.0",
      gitExecutable: join(profile, "missing-git"),
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "environment" }),
      resolveProviderDestination: detectedManagedDestination,
      temporaryParent: profile,
      observedAt: "2026-08-03T12:02:00.000Z",
      inspectCoreExtension: detectedCoreExtension,
    });

    expect(report.overallStatus).toBe("INCOMPATIBLE");
    expect(report.checks.find((check) => check.id === "node")?.status).toBe("INCOMPATIBLE");
    expect(report.checks.find((check) => check.id === "git_fixture")?.status).toBe("BLOCKED");
    expect(report.checks.find((check) => check.id === "git_fixture")?.nextAction).toBe(
      "Install Git, place it on PATH, and rerun `hpi doctor`.",
    );
  });

  it("blocks a disclosure whose currently resolved Provider origin has drifted", async () => {
    const { paths, profile } = await createConfiguredProfile();
    const report = await runHpiDoctor({
      paths,
      observedAt: "2026-08-03T12:02:00.000Z",
      readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
      resolveProviderDestination: () =>
        Promise.resolve({
          configuredOrigin: "https://changed-provider.example",
          pristineOrigin: "https://provider-managed.example",
        }),
      temporaryParent: profile,
      inspectCoreExtension: detectedCoreExtension,
      productIdentity: testProductIdentity,
    });

    expect(report.checks).toContainEqual({
      id: "provider_disclosure",
      status: "BLOCKED",
      summary: "The currently resolved Provider origin changed after acknowledgement.",
      nextAction: "Run `hpi setup` and review the current Provider data disclosure again.",
    });
  });
});
