import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { pluginManifestSchema } from "@hunter-pi/plugin-manager";
import { FilePluginManager, type PluginSource } from "@hunter-pi/plugin-manager";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

function manifestFor(source: PluginSource, suffix: string, toolName = `tool-${suffix}`) {
  return pluginManifestSchema.parse({
    schemaVersion: "hpi-plugin-manifest.v1",
    pluginId: `plugin_${suffix}`,
    version: "1.2.3",
    source,
    packageFingerprint: fixtureFingerprint,
    license: "MIT",
    provenance: {
      upstreamName: `fixture-${suffix}`,
      sourceReference: `https://example.invalid/${suffix}`,
      sourceFingerprint: fixtureFingerprint,
      licenseReference: "LICENSE",
    },
    resources: {
      tools: [{ name: toolName, description: "A fixture tool" }],
      hooks: [{ name: `hook-${suffix}`, description: "A fixture hook" }],
    },
  });
}

function installRequest(source: PluginSource, suffix: string) {
  return {
    schemaVersion: "hpi-plugin-install.v1" as const,
    operationId: `op_plugin-install-${suffix}`,
    operationFingerprint: fixtureFingerprint,
    source,
    trust: "USER_APPROVED" as const,
    provenanceAcknowledged: true,
    requestedIsolation: "PROCESS_AUTHORITY" as const,
    compatibility: "VERIFIED" as const,
    evidenceIds: [],
    observedAt: fixtureTimestamp,
  };
}

function verifiedCompatibility() {
  return {
    outcome: "VERIFIED" as const,
    verifierFingerprint: fixtureFingerprint,
    evidenceIds: ["evidence_plugin-compatibility"],
  };
}

describe("Task 10 standard Pi Plugin manager", () => {
  it("rejects private paths and credential-bearing provenance references", () => {
    const localSource: PluginSource = {
      kind: "LOCAL",
      label: "privacy-fixture",
      pathFingerprint: fixtureFingerprint,
      contentFingerprint: fixtureFingerprint,
    };
    expect(() =>
      pluginManifestSchema.parse({
        ...manifestFor(localSource, "privacy"),
        provenance: {
          ...manifestFor(localSource, "privacy").provenance,
          sourceReference: "C:\\fixture-private\\plugin",
        },
      }),
    ).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...manifestFor(
          {
            kind: "NPM",
            registry: "https://registry.npmjs.org",
            packageName: "privacy-fixture",
            version: "1.2.3",
            integrity: fixtureFingerprint,
          },
          "privacy-url",
        ),
        provenance: {
          ...manifestFor(localSource, "privacy").provenance,
          sourceReference: "https://fixture-user@example.invalid/plugin",
        },
      }),
    ).toThrow();
  });

  it("installs exact local/npm/Git sources without loading plugin code", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-plugins-");
    const resolve = vi.fn((source: PluginSource) => {
      const suffix = source.kind.toLowerCase();
      return Promise.resolve(manifestFor(source, suffix));
    });
    const manager = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve,
      compatibilityVerifierFingerprint: fixtureFingerprint,
      verifyCompatibility: verifiedCompatibility,
    });
    const sources: PluginSource[] = [
      {
        kind: "LOCAL",
        label: "fixture-local",
        pathFingerprint: fixtureFingerprint,
        contentFingerprint: fixtureFingerprint,
      },
      {
        kind: "NPM",
        registry: "https://registry.npmjs.org",
        packageName: "fixture-plugin",
        version: "1.2.3",
        integrity: fixtureFingerprint,
      },
      {
        kind: "GIT",
        remote: "https://github.com/example/fixture-plugin.git",
        commit: "0123456789abcdef0123456789abcdef01234567",
        treeFingerprint: fixtureFingerprint,
      },
    ];

    for (const [index, source] of sources.entries()) {
      await expect(
        manager.install(installRequest(source, source.kind.toLowerCase() + "-" + String(index))),
      ).resolves.toMatchObject({
        outcome: "APPLIED",
        action: "INSTALL",
      });
    }
    const records = await manager.list();
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.state === "ENABLED")).toBe(true);
    expect(records.every((record) => record.assurance.compatibility === "VERIFIED")).toBe(true);
    expect(records.every((record) => record.assurance.trust === "USER_APPROVED")).toBe(true);
    expect(records.every((record) => record.assurance.isolation === "PROCESS_AUTHORITY")).toBe(
      true,
    );
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("does not treat caller-declared compatibility, trust, or containment as proof", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-untrusted-");
    const source: PluginSource = {
      kind: "LOCAL",
      label: "untrusted-fixture",
      pathFingerprint: fixtureFingerprint,
      contentFingerprint: fixtureFingerprint,
    };
    const manager = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve: (candidate) => Promise.resolve(manifestFor(candidate, "untrusted")),
      verifyCompatibility: () => "VERIFIED",
    });
    await manager.install({
      ...installRequest(source, "untrusted"),
      requestedIsolation: "CONTAINED",
      isolationEvidenceIds: ["evidence_caller-claim"],
    });
    const [record] = await manager.list();
    expect(record).toMatchObject({
      state: "QUARANTINED",
      assurance: {
        compatibility: "UNVERIFIED",
        trust: "USER_APPROVED",
        isolation: "NOT_PROVEN",
      },
    });
  });

  it("quarantines reserved collisions and missing provenance before any execution", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-safe-mode-");
    const resolve = vi.fn(() =>
      Promise.resolve(
        manifestFor(
          {
            kind: "LOCAL",
            label: "collision-fixture",
            pathFingerprint: fixtureFingerprint,
            contentFingerprint: fixtureFingerprint,
          },
          "collision",
          "hunter-status",
        ),
      ),
    );
    const manager = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve,
      compatibilityVerifierFingerprint: fixtureFingerprint,
      verifyCompatibility: verifiedCompatibility,
    });
    const request = installRequest(
      {
        kind: "LOCAL",
        label: "collision-fixture",
        pathFingerprint: fixtureFingerprint,
        contentFingerprint: fixtureFingerprint,
      },
      "collision",
    );
    await expect(
      manager.install({ ...request, provenanceAcknowledged: false }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
    });
    const [record] = await manager.list();
    expect(record).toMatchObject({
      state: "QUARANTINED",
      assurance: {
        compatibility: "INCOMPATIBLE",
        trust: "QUARANTINED",
      },
    });
    await expect(manager.startup()).resolves.toMatchObject({ mode: "SAFE_MODE" });
    const inventory = await manager.inventory();
    expect(inventory.safeMode).toBe(true);
    expect(inventory.conflicts.some((conflict) => conflict.resourceName === "hunter-status")).toBe(
      true,
    );
    await expect(
      manager.recoverSafeMode({
        schemaVersion: "hpi-plugin-safe-mode-recovery.v1",
        operations: [
          {
            schemaVersion: "hpi-plugin-disable.v1",
            operationId: "op_plugin-safe-disable-collision",
            operationFingerprint: fixtureFingerprint,
            pluginId: "plugin_collision",
            observedAt: fixtureTimestamp,
          },
        ],
      }),
    ).resolves.toMatchObject([{ outcome: "APPLIED", action: "DISABLE" }]);
    await expect(manager.startup()).resolves.toMatchObject({ mode: "NORMAL" });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("persists disable/remove and rejects operation identity reuse", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-lifecycle-");
    const source: PluginSource = {
      kind: "NPM",
      registry: "https://registry.npmjs.org",
      packageName: "lifecycle-fixture",
      version: "1.2.3",
      integrity: fixtureFingerprint,
    };
    const manager = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve: (candidate) => Promise.resolve(manifestFor(candidate, "lifecycle")),
      compatibilityVerifierFingerprint: fixtureFingerprint,
      verifyCompatibility: verifiedCompatibility,
    });
    const request = installRequest(source, "lifecycle");
    await manager.install(request);
    await expect(manager.install(request)).resolves.toMatchObject({ outcome: "APPLIED" });
    await expect(
      manager.install({
        ...request,
        source: { ...source, packageName: "lifecycle-other-fixture" },
      }),
    ).rejects.toThrow(/request|fingerprint|identity/u);
    await expect(
      manager.install({ ...request, operationFingerprint: `sha256:${"b".repeat(64)}` }),
    ).rejects.toThrow(/operation|fingerprint|identity/u);
    await expect(
      manager.disable({
        schemaVersion: "hpi-plugin-disable.v1",
        operationId: "op_plugin-disable-lifecycle",
        operationFingerprint: fixtureFingerprint,
        pluginId: "plugin_lifecycle",
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED" });
    const reopened = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve: (candidate) => Promise.resolve(manifestFor(candidate, "lifecycle")),
    });
    await expect(reopened.list()).resolves.toMatchObject([
      expect.objectContaining({ pluginId: "plugin_lifecycle", state: "DISABLED" }),
    ]);
    await expect(
      reopened.remove({
        schemaVersion: "hpi-plugin-remove.v1",
        operationId: "op_plugin-remove-lifecycle",
        operationFingerprint: `sha256:${"c".repeat(64)}`,
        pluginId: "plugin_lifecycle",
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED" });
    await expect(reopened.list()).resolves.toEqual([]);
  });

  it("imports Pi package metadata with a separate action while retaining all three receipts", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-import-");
    const source: PluginSource = {
      kind: "PI",
      packageName: "pi-fixture",
      version: "1.2.3",
      integrity: fixtureFingerprint,
    };
    const manager = new FilePluginManager({
      stateRoot: join(root, "state"),
      resolve: (candidate) => Promise.resolve(manifestFor(candidate, "pi")),
      compatibilityVerifierFingerprint: fixtureFingerprint,
      verifyCompatibility: verifiedCompatibility,
    });
    await expect(
      manager.importFromPi({
        schemaVersion: "hpi-plugin-import-pi.v1",
        operationId: "op_plugin-import-pi",
        operationFingerprint: fixtureFingerprint,
        source,
        trust: "USER_APPROVED",
        provenanceAcknowledged: true,
        requestedIsolation: "PROCESS_AUTHORITY",
        compatibility: "VERIFIED",
        evidenceIds: [],
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      action: "IMPORT_FROM_PI",
      outcome: "APPLIED",
      compatibility: "VERIFIED",
      trust: "USER_APPROVED",
      isolation: "PROCESS_AUTHORITY",
    });
  });
});
