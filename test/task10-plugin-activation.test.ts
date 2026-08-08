import { chmod, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FilePiPackageBindingStore,
  PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
  PiPackageManifestResolver,
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  createLocalPiPluginSource,
  createPiLaunchPlan,
  prepareQualifiedPiPluginActivation,
  qualifyPiPackageInspection,
  resolveHpiPaths,
} from "@hunter-pi/pi-host";
import { FilePluginManager } from "@hunter-pi/plugin-manager";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

describe("Task 10 qualified Plugin activation", () => {
  it("loads an exact qualified resource only after registry and runtime binding verification", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-activation-");
    const packageRoot = join(root, "package");
    const marker = join(root, "plugin-evaluated.txt");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-qualified-fixture",
        version: "1.0.0",
        license: "MIT",
        pi: { skills: ["./SKILL.md"] },
      }),
      "utf8",
    );
    await writeFile(
      join(packageRoot, "SKILL.md"),
      `# Qualified fixture\n\nThe marker path is ${JSON.stringify(marker)}, but this metadata must not execute.\n`,
      "utf8",
    );
    const source = await createLocalPiPluginSource({ label: "qualified", packageRoot });
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "resolver"),
      localPackages: new Map([["qualified", packageRoot]]),
    });
    const inspection = await resolver.inspect(source);
    const qualificationStateRoot = join(root, "qualification");
    const qualification = await qualifyPiPackageInspection({
      inspection,
      stateRoot: qualificationStateRoot,
      observedAt: fixtureTimestamp,
    });
    const compatibilityContext = {
      qualificationStateRoot,
      distributionReleaseId: "release_hunter-pi-task10-test",
      engineReleaseId: "engine-release_pi-0.83.0",
      engineReleaseFingerprint: fixtureFingerprint,
      platformFingerprint: fixtureFingerprint,
      compatibilityVerifierFingerprint: PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
    } as const;
    const bindingRoot = join(root, "bindings");
    const bindingStore = new FilePiPackageBindingStore({
      stateRoot: bindingRoot,
      managedPackageRoot: join(root, "resolver"),
    });
    await expect(
      bindingStore.put({ ...inspection.runtimeBinding, packageRoot }, fixtureTimestamp),
    ).rejects.toThrow(/BINDING_TAMPERED/u);
    await bindingStore.put(inspection.runtimeBinding, fixtureTimestamp);
    const bindingFilename = (await readdir(bindingRoot)).find((entry) => entry.endsWith(".json"));
    if (bindingFilename === undefined) throw new Error("fixture runtime binding is missing");
    const extraLink = join(root, "binding-extra-link.json");
    await link(join(bindingRoot, bindingFilename), extraLink);
    await expect(
      bindingStore.get(inspection.manifest.pluginId, inspection.manifest.packageFingerprint),
    ).rejects.toThrow(/BINDING_TAMPERED/u);
    await rm(extraLink);
    const mismatchedBindingPath = join(
      bindingRoot,
      `${inspection.manifest.pluginId}-${"0".repeat(64)}.json`,
    );
    await writeFile(
      mismatchedBindingPath,
      await readFile(join(bindingRoot, bindingFilename), "utf8"),
      "utf8",
    );
    await expect(bindingStore.removeManagedSnapshots(inspection.manifest.pluginId)).rejects.toThrow(
      /BINDING_TAMPERED/u,
    );
    await expect(readdir(inspection.runtimeBinding.packageRoot)).resolves.toContain("SKILL.md");
    await rm(mismatchedBindingPath);
    const manager = new FilePluginManager({
      stateRoot: join(root, "registry"),
      resolve: (candidate) => resolver.resolve(candidate),
      distributionReleaseId: compatibilityContext.distributionReleaseId,
      engineReleaseId: compatibilityContext.engineReleaseId,
      engineReleaseFingerprint: compatibilityContext.engineReleaseFingerprint,
      platformFingerprint: compatibilityContext.platformFingerprint,
      compatibilityVerifierFingerprint: compatibilityContext.compatibilityVerifierFingerprint,
      verifyCompatibility: () => ({
        outcome: "VERIFIED",
        verifierFingerprint: qualification.verifierFingerprint,
        evidenceIds: [qualification.evidenceId],
      }),
    });
    await manager.install({
      schemaVersion: "hpi-plugin-install.v1",
      operationId: "op_plugin-qualified-fixture",
      operationFingerprint: fixtureFingerprint,
      source,
      trust: "USER_APPROVED",
      provenanceAcknowledged: true,
      requestedIsolation: "PROCESS_AUTHORITY",
      compatibility: "VERIFIED",
      evidenceIds: [qualification.evidenceId],
      observedAt: fixtureTimestamp,
    });

    const records = await manager.list();
    const inventory = await manager.inventory();
    const activation = await prepareQualifiedPiPluginActivation({
      records,
      inventory,
      bindingStore,
      compatibilityContext,
    });
    const alternateFingerprint = `sha256:${"b".repeat(64)}` as const;
    const incompatibleContexts = [
      [
        "distributionReleaseId",
        { ...compatibilityContext, distributionReleaseId: "release_hunter-pi-other" },
      ],
      ["engineReleaseId", { ...compatibilityContext, engineReleaseId: "engine-release_pi-other" }],
      [
        "engineReleaseFingerprint",
        { ...compatibilityContext, engineReleaseFingerprint: alternateFingerprint },
      ],
      [
        "platformFingerprint",
        { ...compatibilityContext, platformFingerprint: alternateFingerprint },
      ],
      [
        "compatibilityVerifierFingerprint",
        { ...compatibilityContext, compatibilityVerifierFingerprint: alternateFingerprint },
      ],
    ] as const;
    for (const [field, incompatibleContext] of incompatibleContexts) {
      await expect(
        prepareQualifiedPiPluginActivation({
          records,
          inventory,
          bindingStore,
          compatibilityContext: incompatibleContext,
        }),
        field,
      ).rejects.toThrow(/compatibility|qualification|current/iu);
    }
    const snapshotRoot = inspection.runtimeBinding.packageRoot;
    const snapshotSkill = join(snapshotRoot, "SKILL.md");
    if (inventory.schemaVersion !== "hpi-plugin-inventory.v2") {
      throw new Error("fixture requires a v2 Plugin inventory");
    }
    await expect(
      prepareQualifiedPiPluginActivation({
        records,
        inventory: { ...inventory, effectiveSkills: [] },
        bindingStore,
        compatibilityContext,
      }),
    ).rejects.toThrow(/records.*inventory|inventory.*inconsistent/iu);
    const paths = resolveHpiPaths({ env: { HUNTER_PI_HOME: join(root, "profile") } });
    const configuration = {
      ...acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
        acceptedAt: fixtureTimestamp,
        resolvedDestinationOrigin: "https://provider-managed.example",
      }),
      setupCompletedAt: fixtureTimestamp,
    };
    const plan = createPiLaunchPlan({
      paths,
      configuration,
      cwd: root,
      purpose: "QUICK",
      safeMode: false,
      providerAuthConfigured: true,
      sessionTreeInspected: true,
      coreExtensionPath: join(root, "core-extension.js"),
      piCliPath: join(root, "pi-cli.js"),
      resolvedProviderDestination: {
        configuredOrigin: "https://provider-managed.example",
        pristineOrigin: "https://provider-managed.example",
      },
      pluginActivation: activation,
    });

    expect(plan.arguments).toEqual(expect.arrayContaining(["--skill", snapshotSkill]));
    expect(plan.arguments).not.toContain(join(packageRoot, "SKILL.md"));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(
      join(packageRoot, "SKILL.md"),
      "# Source changed after qualification\n",
      "utf8",
    );
    await expect(
      prepareQualifiedPiPluginActivation({
        records: await manager.list(),
        inventory: await manager.inventory(),
        bindingStore,
        compatibilityContext,
      }),
    ).resolves.toMatchObject({ skills: [snapshotSkill] });
    await expect(readFile(snapshotSkill, "utf8")).resolves.toContain("Qualified fixture");

    const qualificationPath = join(qualificationStateRoot, `${qualification.evidenceId}.json`);
    await rm(qualificationPath);
    await expect(
      prepareQualifiedPiPluginActivation({
        records: await manager.list(),
        inventory: await manager.inventory(),
        bindingStore,
        compatibilityContext,
      }),
    ).rejects.toThrow();
    await qualifyPiPackageInspection({
      inspection,
      stateRoot: qualificationStateRoot,
      observedAt: fixtureTimestamp,
    });
    await writeFile(qualificationPath, "{}\n", "utf8");
    await expect(
      prepareQualifiedPiPluginActivation({
        records: await manager.list(),
        inventory: await manager.inventory(),
        bindingStore,
        compatibilityContext,
      }),
    ).rejects.toThrow();
    await rm(qualificationPath);
    await qualifyPiPackageInspection({
      inspection,
      stateRoot: qualificationStateRoot,
      observedAt: fixtureTimestamp,
    });

    await expect(writeFile(snapshotSkill, "# direct mutation\n", "utf8")).rejects.toThrow();
    await chmod(snapshotSkill, 0o600);
    await writeFile(snapshotSkill, "# malicious snapshot after permission override\n", "utf8");
    await expect(
      prepareQualifiedPiPluginActivation({
        records: await manager.list(),
        inventory: await manager.inventory(),
        bindingStore,
        compatibilityContext,
      }),
    ).rejects.toThrow(/BINDING_TAMPERED/u);
    await expect(bindingStore.removeManagedSnapshots(inspection.manifest.pluginId)).rejects.toThrow(
      /BINDING_TAMPERED/u,
    );
    await expect(readdir(snapshotRoot)).resolves.toContain("SKILL.md");
  });
});
