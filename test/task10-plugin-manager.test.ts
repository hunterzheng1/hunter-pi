import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createPluginRegistryPresentation } from "@hunter-pi/cli";
import { pluginManifestSchema, pluginManifestV2Schema } from "@hunter-pi/plugin-manager";
import {
  FilePluginManager,
  FilePluginJournal,
  PluginJournalCorruptError,
  withPluginLifecycleTransaction,
  type PluginSource,
} from "@hunter-pi/plugin-manager";
import { canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

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

function manifestV2For(source: PluginSource, suffix: string) {
  return pluginManifestV2Schema.parse({
    schemaVersion: "hpi-plugin-manifest.v2",
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
      tools: [{ name: `tool-${suffix}`, description: "A fixture tool" }],
      hooks: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
    executableSurface: "NONE",
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
  it("rejects private paths and credential-bearing package or provenance references", () => {
    const localSource: PluginSource = {
      kind: "LOCAL",
      label: "privacy-fixture",
      pathFingerprint: fixtureFingerprint,
      contentFingerprint: fixtureFingerprint,
    };
    expect(() =>
      pluginManifestV2Schema.parse({
        ...manifestV2For(localSource, "privacy"),
        provenance: {
          ...manifestV2For(localSource, "privacy").provenance,
          sourceReference: "C:\\fixture-private\\plugin",
        },
      }),
    ).toThrow();
    expect(() =>
      pluginManifestV2Schema.parse({
        ...manifestV2For(
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
          ...manifestV2For(localSource, "privacy").provenance,
          sourceReference: "https://fixture-user@example.invalid/plugin",
        },
      }),
    ).toThrow();
    for (const sourceReference of [
      "file:///C:/Users/private/plugin",
      "https://example.invalid/plugin?token=REDACTED",
      "https://example.invalid/plugin#access_token=REDACTED",
    ]) {
      expect(() =>
        pluginManifestV2Schema.parse({
          ...manifestV2For(localSource, "privacy-reference"),
          provenance: {
            ...manifestV2For(localSource, "privacy-reference").provenance,
            sourceReference,
          },
        }),
      ).toThrow();
    }
    for (const source of [
      {
        kind: "NPM",
        registry: "https://registry.npmjs.org?token=REDACTED",
        packageName: "privacy-fixture",
        version: "1.2.3",
        integrity: fixtureFingerprint,
      },
      {
        kind: "GIT",
        remote: "https://github.com/example/fixture-plugin.git#access_token=REDACTED",
        commit: "0123456789abcdef0123456789abcdef01234567",
        treeFingerprint: fixtureFingerprint,
      },
    ]) {
      expect(() =>
        pluginManifestV2Schema.parse({
          ...manifestV2For(localSource, "privacy-source"),
          source,
        }),
      ).toThrow();
    }
    const portableV2 = manifestV2For(localSource, "privacy-v2");
    expect(() =>
      pluginManifestV2Schema.parse({
        ...portableV2,
        resources: {
          ...portableV2.resources,
          tools: [{ name: "privacy-tool", description: "password=REDACTED" }],
        },
      }),
    ).toThrow();
    expect(() =>
      pluginManifestV2Schema.parse({
        ...portableV2,
        license: "C:\\Users\\private\\LICENSE",
      }),
    ).toThrow();
  });

  it("keeps historical v1 Manifest references replay-compatible while v2 stays portable", async () => {
    const historicalSource = {
      kind: "NPM" as const,
      registry: "https://registry.npmjs.org?token=legacy-registry-secret#historical",
      packageName: "legacy-plugin",
      version: "1.2.3",
      integrity: fixtureFingerprint,
    };
    const historical = {
      ...manifestFor(historicalSource, "legacy-history"),
      provenance: {
        ...manifestFor(historicalSource, "legacy-history").provenance,
        sourceReference: "file:///legacy/plugin/source",
      },
      license: "C:\\Users\\legacy-private\\LICENSE",
      resources: {
        tools: [
          {
            name: "tool-legacy-history",
            description: "https://example.invalid/tool?token=legacy-resource-secret",
          },
        ],
        hooks: [],
      },
    };

    expect(pluginManifestSchema.parse(historical)).toMatchObject({
      schemaVersion: "hpi-plugin-manifest.v1",
      source: historicalSource,
      provenance: { sourceReference: "file:///legacy/plugin/source" },
    });
    expect(() =>
      pluginManifestV2Schema.parse({
        ...manifestV2For(
          {
            kind: "LOCAL",
            label: "legacy-history-v2",
            pathFingerprint: fixtureFingerprint,
            contentFingerprint: fixtureFingerprint,
          },
          "legacy-history-v2",
        ),
        source: historicalSource,
      }),
    ).toThrow();

    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-v1-replay-");
    const stateRoot = join(root, "state");
    const currentSource = { ...historicalSource, registry: "https://registry.npmjs.org" };
    const manager = new FilePluginManager({
      stateRoot,
      resolve: (source) => Promise.resolve(manifestFor(source, "legacy-history")),
      compatibilityVerifierFingerprint: fixtureFingerprint,
      verifyCompatibility: verifiedCompatibility,
    });
    await manager.install(installRequest(currentSource, "legacy-history"));
    const journalRoot = join(stateRoot, "journal");
    const filename = (await readdir(journalRoot)).find((entry) => entry.endsWith(".json"));
    if (filename === undefined) throw new Error("legacy journal fixture is missing");
    const entry = JSON.parse(await readFile(join(journalRoot, filename), "utf8")) as Record<
      string,
      unknown
    >;
    const record = entry["record"] as {
      manifest: {
        source: unknown;
        provenance: { sourceReference: string };
      };
    };
    record.manifest.source = historicalSource;
    record.manifest.provenance.sourceReference = "file:///legacy/plugin/source";
    Object.assign(record.manifest, {
      license: historical.license,
      resources: historical.resources,
    });
    const payload = { ...entry };
    delete payload["entryFingerprint"];
    const entryFingerprint = sha256Fingerprint(canonicalJson(payload));
    entry["entryFingerprint"] = entryFingerprint;
    const replacementFilename = `${String(entry["sequence"]).padStart(12, "0")}-${entryFingerprint.slice(
      "sha256:".length,
    )}.json`;
    await writeFile(join(journalRoot, filename), `${canonicalJson(entry)}\n`, "utf8");
    await rename(join(journalRoot, filename), join(journalRoot, replacementFilename));

    const reopened = new FilePluginManager({
      stateRoot,
      resolve: () => Promise.reject(new Error("historical replay must not resolve a source")),
    });
    await expect(reopened.list()).resolves.toMatchObject([
      {
        manifest: {
          source: historicalSource,
          provenance: { sourceReference: "file:///legacy/plugin/source" },
        },
      },
    ]);
    const presentation = createPluginRegistryPresentation(
      await reopened.list(),
      await reopened.inventory(),
    );
    const serializedPresentation = JSON.stringify(presentation);
    expect(serializedPresentation).not.toContain("file:///");
    expect(serializedPresentation).not.toContain("legacy-registry-secret");
    expect(serializedPresentation).not.toContain("legacy-resource-secret");
    expect(serializedPresentation).not.toContain("C:\\\\Users");
    expect(serializedPresentation).not.toContain("#historical");
    expect(presentation.records).toMatchObject([
      {
        manifest: { legacyMetadata: "REDACTED", sourceKind: "NPM" },
      },
    ]);
    expect(presentation.inventory?.declaredTools).toMatchObject([
      { description: "REDACTED_LEGACY_METADATA" },
    ]);
    await expect(
      reopened.disable({
        schemaVersion: "hpi-plugin-disable.v1",
        operationId: "op_plugin-disable-legacy-history",
        operationFingerprint: `sha256:${"d".repeat(64)}`,
        pluginId: "plugin_legacy-history",
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED" });
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

  it("treats every Pi built-in tool override as reserved before activation", async () => {
    for (const [index, builtIn] of [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ].entries()) {
      const root = await createTemporaryTestDirectory(
        tmpdir(),
        `hunter-pi-task10-built-in-${builtIn}-`,
      );
      const source: PluginSource = {
        kind: "LOCAL",
        label: `built-in-${builtIn}-fixture`,
        pathFingerprint: fixtureFingerprint,
        contentFingerprint: fixtureFingerprint,
      };
      const suffix = `built-in-${String(index)}`;
      const manager = new FilePluginManager({
        stateRoot: join(root, "state"),
        resolve: (candidate) => Promise.resolve(manifestFor(candidate, suffix, builtIn)),
        compatibilityVerifierFingerprint: fixtureFingerprint,
        verifyCompatibility: verifiedCompatibility,
      });

      await manager.install(installRequest(source, suffix));

      const startup = await manager.startup();
      expect(startup.mode).toBe("SAFE_MODE");
      expect(startup.reasons).toEqual(["PLUGIN_QUARANTINED", "RESERVED_RESOURCE_COLLISION"]);
      const inventory = await manager.inventory();
      expect(inventory.effectiveTools).toEqual([]);
      expect(inventory.conflicts.some((conflict) => conflict.resourceName === builtIn)).toBe(true);
    }
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
    const missingCommittedEntry = Object.assign(new Error("committed entry disappeared"), {
      code: "ENOENT",
    });
    await expect(
      new FilePluginJournal({
        stateRoot: join(root, "state", "journal"),
        readEntry: () => Promise.reject(missingCommittedEntry),
      }).read(),
    ).rejects.toBeInstanceOf(PluginJournalCorruptError);
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

  it("serializes complete Plugin lifecycle transactions", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-lifecycle-lock-");
    const stateRoot = join(root, "state");
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        withPluginLifecycleTransaction(stateRoot, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
          } finally {
            active -= 1;
          }
        }),
      ),
    );

    expect(maximumActive).toBe(1);
  });
});
