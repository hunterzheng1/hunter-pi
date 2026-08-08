import { fileURLToPath, pathToFileURL } from "node:url";
import { cp, link, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PiPackageManifestResolver,
  PI_PACKAGE_INSTALL_WORKER_ARGUMENT,
  createLocalPiPluginSource,
  createPiPackageNpmCommand,
  fingerprintNpmRegistryIntegrity,
  fingerprintPiPackageDirectory,
  piPackageQualificationReceiptSchema,
  qualifyPiPackageInspection,
} from "@hunter-pi/pi-host";
import { pluginManifestV2Schema } from "@hunter-pi/plugin-manager";
import { FilePluginManager } from "@hunter-pi/plugin-manager";

import {
  assertInstallFilesystemBudget,
  assertPiPackageInstallDeadline,
  createPiPackageInstallWorkerArguments,
  createSanitizedPiPackageInstallEnvironment,
} from "../packages/pi-host/src/pi-package-resolver.js";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

function piPackageRoot(): string {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return dirname(dirname(entry));
}

describe("Task 10 public Pi Package adapter", () => {
  it("resolves two exact external Pi package fixtures through the public PackageManager", async () => {
    const stateRoot = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-adapter-");
    const examplesRoot = join(piPackageRoot(), "examples", "extensions");
    const fixtures = [
      { label: "pi-example-with-deps", root: join(examplesRoot, "with-deps") },
      { label: "pi-example-sandbox", root: join(examplesRoot, "sandbox") },
    ];
    const resolver = new PiPackageManifestResolver({
      stateRoot,
      localPackages: new Map(fixtures.map((fixture) => [fixture.label, fixture.root])),
      provenance: {
        upstreamName: "@earendil-works/pi-coding-agent examples",
        sourceReference: "npm @earendil-works/pi-coding-agent@0.83.0",
        license: "MIT",
        licenseReference: "upstream package.json license field",
      },
    });

    for (const fixture of fixtures) {
      const source = await createLocalPiPluginSource({
        label: fixture.label,
        packageRoot: fixture.root,
      });
      const inspection = await resolver.inspect(source);
      const manifest = pluginManifestV2Schema.parse(inspection.manifest);

      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/u);
      expect(manifest.source).toEqual(source);
      expect(manifest.resources.extensions).toMatchObject([
        { relativePath: "index.ts", enabled: true },
      ]);
      expect(manifest.resources.skills).toEqual([]);
      expect(manifest.resources.prompts).toEqual([]);
      expect(manifest.resources.themes).toEqual([]);
      expect(manifest.executableSurface).toBe("UNKNOWN_NOT_EXECUTED");
      expect(JSON.stringify(manifest)).not.toContain(examplesRoot);
      expect(inspection.runtimeBinding.packageRoot).not.toBe(fixture.root);
      expect(inspection.runtimeBinding.packageRoot.startsWith(stateRoot)).toBe(true);
      expect(inspection.runtimeBinding.extensions).toMatchObject([
        {
          absolutePath: join(inspection.runtimeBinding.packageRoot, "index.ts"),
          enabled: true,
        },
      ]);
    }
  });

  it("never evaluates package code while resolving metadata", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-no-eval-");
    const packageRoot = join(root, "fixture-package");
    const marker = join(root, "plugin-code-ran.txt");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-no-eval-fixture",
        version: "1.0.0",
        license: "MIT",
        type: "module",
        pi: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    await writeFile(
      join(packageRoot, "index.js"),
      `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(marker)}, "executed"));\nexport default () => {};\n`,
      "utf8",
    );
    const source = await createLocalPiPluginSource({ label: "no-eval", packageRoot });
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "state"),
      localPackages: new Map([["no-eval", packageRoot]]),
    });

    const inspection = await resolver.inspect(source);
    const manifest = inspection.manifest;

    expect(manifest.resources.extensions).toHaveLength(1);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      qualifyPiPackageInspection({
        inspection: { ...inspection },
        stateRoot: join(root, "forged-qualification"),
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/unchanged resolver inspection/iu);
    const qualification = await qualifyPiPackageInspection({
      inspection,
      stateRoot: join(root, "qualification"),
      observedAt: fixtureTimestamp,
    });
    expect(qualification).toMatchObject({ compatibility: "UNVERIFIED" });
    expect(() =>
      piPackageQualificationReceiptSchema.parse({
        ...qualification,
        compatibility: "VERIFIED",
      }),
    ).toThrow(/fingerprint|compatibility/iu);
  });

  it("rejects a package when its exact path or content binding changes", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-binding-");
    const packageRoot = join(root, "fixture-package");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "pi-binding-fixture", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    const source = await createLocalPiPluginSource({ label: "binding", packageRoot });
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "state"),
      localPackages: new Map([["binding", packageRoot]]),
    });

    await writeFile(join(packageRoot, "changed.txt"), "changed after approval\n", "utf8");

    await expect(resolver.resolve(source)).rejects.toThrow(/SOURCE_CHANGED/u);
    await expect(
      resolver.resolve({ ...source, pathFingerprint: `sha256:${"f".repeat(64)}` }),
    ).rejects.toThrow(/SOURCE_CHANGED/u);

    const oversizedRoot = join(root, "oversized-package");
    await mkdir(oversizedRoot);
    await writeFile(
      join(oversizedRoot, "package.json"),
      JSON.stringify({ name: "pi-oversized-fixture", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    const oversized = await open(join(oversizedRoot, "oversized.bin"), "w");
    try {
      await oversized.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await oversized.close();
    }
    await expect(
      createLocalPiPluginSource({ label: "oversized", packageRoot: oversizedRoot }),
    ).rejects.toThrow(/RESOURCE_LIMIT/u);

    const linkedRoot = join(root, "hard-linked-package");
    await mkdir(linkedRoot);
    await writeFile(
      join(linkedRoot, "package.json"),
      JSON.stringify({ name: "pi-linked-fixture", version: "1.0.0", license: "MIT" }),
      "utf8",
    );
    await link(join(linkedRoot, "package.json"), join(root, "package-json-alias"));
    await expect(
      createLocalPiPluginSource({ label: "hard-linked", packageRoot: linkedRoot }),
    ).rejects.toThrow(/one physical link/iu);
  });

  it("stages exact npm and Git sources without lifecycle execution and verifies their bindings", async () => {
    expect(createPiPackageNpmCommand("https://registry.npmjs.org")).toEqual([
      "npm",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ]);
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-staging-");
    const bundledEntry = join(root, "installed-artifact", "hpi.js");
    expect(
      createPiPackageInstallWorkerArguments("encoded-payload", {
        bundledArtifact: true,
        moduleUrl: pathToFileURL(bundledEntry).href,
      }),
    ).toEqual([bundledEntry, PI_PACKAGE_INSTALL_WORKER_ARGUMENT, "encoded-payload"]);
    const sourceModule = join(root, "source", "pi-package-resolver.js");
    expect(
      createPiPackageInstallWorkerArguments("encoded-payload", {
        bundledArtifact: false,
        moduleUrl: pathToFileURL(sourceModule).href,
      }),
    ).toEqual([join(root, "source", "pi-package-install-worker.js"), "encoded-payload"]);
    const privateInstallRoot = join(root, "private-install");
    const installEnvironment = createSanitizedPiPackageInstallEnvironment(privateInstallRoot, {
      Path: "C:/bounded-path",
      HTTPS_PROXY: "https://public-proxy.example",
      HTTP_PROXY: "http://proxy-user:proxy-password@private-proxy.example",
      NPM_TOKEN: "must-not-cross-the-worker-boundary",
      GITHUB_TOKEN: "must-not-cross-the-worker-boundary",
      NODE_OPTIONS: "--require=unapproved-loader",
    });
    expect(installEnvironment).toMatchObject({
      Path: "C:/bounded-path",
      HTTPS_PROXY: "https://public-proxy.example",
      HOME: join(privateInstallRoot, ".install-home"),
      GIT_CONFIG_GLOBAL: join(privateInstallRoot, ".gitconfig"),
      npm_config_userconfig: join(privateInstallRoot, ".npmrc"),
      npm_config_globalconfig: join(privateInstallRoot, ".npm-globalrc"),
    });
    expect(installEnvironment).not.toHaveProperty("NPM_TOKEN");
    expect(installEnvironment).not.toHaveProperty("GITHUB_TOKEN");
    expect(installEnvironment).not.toHaveProperty("NODE_OPTIONS");
    expect(installEnvironment).not.toHaveProperty("HTTP_PROXY");
    const templateRoot = join(root, "template");
    await mkdir(templateRoot);
    await writeFile(
      join(templateRoot, "package.json"),
      JSON.stringify({
        name: "pi-staged-fixture",
        version: "1.2.3",
        license: "MIT",
        pi: { skills: ["./SKILL.md"] },
      }),
      "utf8",
    );
    await writeFile(join(templateRoot, "SKILL.md"), "# Staged fixture\n", "utf8");
    const treeFingerprint = await fingerprintPiPackageDirectory(templateRoot);
    const npmSri = "sha512-Zml4dHVyZS1pbnRlZ3JpdHk=";
    const installedSources: string[] = [];
    let activeInstalledPath: string | undefined;
    let concurrentInstalls = 0;
    let maximumConcurrentInstalls = 0;
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "state"),
      createPackageManager: ({ agentDir, registry }) => ({
        async install(source) {
          concurrentInstalls += 1;
          maximumConcurrentInstalls = Math.max(maximumConcurrentInstalls, concurrentInstalls);
          try {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            installedSources.push(source);
            const kind = source.startsWith("npm:") ? "npm" : "git";
            activeInstalledPath = join(agentDir, kind, "installed", "pi-staged-fixture");
            await mkdir(dirname(activeInstalledPath), { recursive: true });
            await cp(templateRoot, activeInstalledPath, { recursive: true });
            if (kind === "npm") {
              expect(registry).toBe("https://registry.npmjs.org");
              await mkdir(join(agentDir, "npm"), { recursive: true });
              await writeFile(
                join(agentDir, "npm", "package-lock.json"),
                JSON.stringify({
                  packages: {
                    "node_modules/pi-staged-fixture": { integrity: npmSri },
                  },
                }),
                "utf8",
              );
            }
          } finally {
            concurrentInstalls -= 1;
          }
        },
        getInstalledPath() {
          return activeInstalledPath;
        },
        resolveExtensionSources() {
          if (activeInstalledPath === undefined) throw new Error("fixture not installed");
          return Promise.resolve({
            extensions: [],
            skills: [{ path: join(activeInstalledPath, "SKILL.md"), enabled: true }],
            prompts: [],
            themes: [],
          });
        },
      }),
      readGitHead: () => Promise.resolve("0123456789abcdef0123456789abcdef01234567"),
    });

    const npmSource = {
      kind: "NPM",
      registry: "https://registry.npmjs.org",
      packageName: "pi-staged-fixture",
      version: "1.2.3",
      integrity: fingerprintNpmRegistryIntegrity(npmSri),
    } as const;
    const [npmInspection] = await Promise.all([
      resolver.inspect(npmSource),
      resolver.resolve(npmSource),
    ]);
    const npmManifest = npmInspection.manifest;
    expect(npmManifest.resources.skills).toMatchObject([
      { relativePath: "SKILL.md", enabled: true },
    ]);
    expect(maximumConcurrentInstalls).toBe(1);
    await expect(
      qualifyPiPackageInspection({
        inspection: npmInspection,
        stateRoot: join(root, "injected-qualification"),
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/locked public Pi Package resolver/iu);

    const gitManifest = await resolver.resolve({
      kind: "GIT",
      remote: "https://github.com/example/pi-staged-fixture.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
      treeFingerprint,
    });
    expect(gitManifest.packageFingerprint).toBe(treeFingerprint);
    expect(installedSources).toEqual([
      "npm:pi-staged-fixture@1.2.3",
      "npm:pi-staged-fixture@1.2.3",
      "git:https://github.com/example/pi-staged-fixture.git@0123456789abcdef0123456789abcdef01234567",
    ]);
  });

  it("bounds remote staging time and disk growth and removes failed generations", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-budget-");
    const npmSri = "sha512-Ym91bmRlZC1maXh0dXJl";
    const source = {
      kind: "NPM",
      registry: "https://registry.npmjs.org",
      packageName: "bounded-fixture",
      version: "1.0.0",
      integrity: fingerprintNpmRegistryIntegrity(npmSri),
    } as const;
    const stateRoot = join(root, "resource-state");
    const resourceBounded = new PiPackageManifestResolver({
      stateRoot,
      installBudget: {
        timeoutMs: 1_000,
        maxEntries: 100,
        maxBytes: 1_024,
        minimumFreeBytes: 1,
        maxOutputBytes: 1_024,
      },
      createPackageManager: ({ agentDir }) => ({
        async install() {
          const packageRoot = join(agentDir, "npm", "node_modules", "bounded-fixture");
          await mkdir(packageRoot, { recursive: true });
          await writeFile(join(packageRoot, "oversized.bin"), Buffer.alloc(2_048));
        },
        getInstalledPath() {
          return undefined;
        },
        resolveExtensionSources() {
          return Promise.resolve({ extensions: [], skills: [], prompts: [], themes: [] });
        },
      }),
    });

    await expect(resourceBounded.resolve(source)).rejects.toThrow(/RESOURCE_LIMIT/u);
    const [sourceStateName] = await readdir(join(stateRoot, "package-staging"));
    if (sourceStateName === undefined) throw new Error("bounded fixture source state is missing");
    await expect(readdir(join(stateRoot, "package-staging", sourceStateName))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.generation-/u)]),
    );

    const timeoutBounded = new PiPackageManifestResolver({
      stateRoot: join(root, "timeout-state"),
      installBudget: {
        timeoutMs: 10,
        maxEntries: 100,
        maxBytes: 1_024 * 1_024,
        minimumFreeBytes: 1,
        maxOutputBytes: 1_024,
      },
      createPackageManager: () => ({
        async install() {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        },
        getInstalledPath() {
          return undefined;
        },
        resolveExtensionSources() {
          return Promise.resolve({ extensions: [], skills: [], prompts: [], themes: [] });
        },
      }),
    });
    await expect(timeoutBounded.resolve(source)).rejects.toThrow(/INSTALL_TIMEOUT/u);
    expect(() => {
      assertPiPackageInstallDeadline(1_000, 10, 1_010);
    }).not.toThrow();
    expect(() => {
      assertPiPackageInstallDeadline(1_000, 10, 1_011);
    }).toThrow(/INSTALL_TIMEOUT/u);
  });

  it("tolerates transient nested install entries while root loss fails closed", async () => {
    const root = "C:/bounded-install-root";
    const missing = Object.assign(new Error("transient install entry disappeared"), {
      code: "ENOENT",
    });
    const budget = {
      timeoutMs: 1_000,
      maxEntries: 10,
      maxBytes: 1_024,
      minimumFreeBytes: 1,
      maxOutputBytes: 1_024,
    };

    await expect(
      assertInstallFilesystemBudget(root, budget, {
        opendir(path) {
          if (path !== root) return Promise.reject(missing);
          const entries = [{ name: "vanished-file" }, { name: "vanished-directory" }];
          return Promise.resolve({
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                next: () => {
                  const entry = entries[index];
                  if (entry === undefined) {
                    return Promise.resolve({ done: true as const, value: undefined });
                  }
                  index += 1;
                  return Promise.resolve({ done: false as const, value: entry });
                },
              };
            },
          });
        },
        lstat(path) {
          if (path.endsWith("vanished-file")) return Promise.reject(missing);
          return Promise.resolve({
            size: 0,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          });
        },
        statfs: () => Promise.resolve({ bavail: 1, bsize: 1 }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertInstallFilesystemBudget(root, budget, {
        opendir: () => Promise.reject(missing),
        lstat: () => Promise.reject(missing),
        statfs: () => Promise.resolve({ bavail: 1, bsize: 1 }),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const asyncDirectory = (names: readonly string[]) => ({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: () => {
            const name = names[index];
            if (name === undefined) {
              return Promise.resolve({ done: true as const, value: undefined });
            }
            index += 1;
            return Promise.resolve({ done: false as const, value: { name } });
          },
        };
      },
    });
    await expect(
      assertInstallFilesystemBudget(
        root,
        { ...budget, maxEntries: 1 },
        {
          opendir: () => Promise.resolve(asyncDirectory(["first", "second"])),
          lstat: () =>
            Promise.resolve({
              size: 0,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            }),
          statfs: () => Promise.resolve({ bavail: 1, bsize: 1 }),
        },
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(
      assertInstallFilesystemBudget(
        root,
        { ...budget, minimumFreeBytes: 1 },
        {
          opendir: () => Promise.resolve(asyncDirectory([])),
          lstat: () => Promise.reject(new Error("empty fixture must not stat an entry")),
          statfs: () => Promise.resolve({ bavail: 0, bsize: 1 }),
        },
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it("imports only an explicitly selected exact Pi package root", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-pi-import-");
    const packageRoot = join(root, "pi-installed-package");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "pi-import-fixture", version: "2.3.4", license: "MIT" }),
      "utf8",
    );
    const integrity = await fingerprintPiPackageDirectory(packageRoot);
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "state"),
      importedPiPackages: new Map([["pi-import-fixture@2.3.4", packageRoot]]),
    });

    await expect(
      resolver.resolve({
        kind: "PI",
        packageName: "pi-import-fixture",
        version: "2.3.4",
        integrity,
      }),
    ).resolves.toMatchObject({
      schemaVersion: "hpi-plugin-manifest.v2",
      version: "2.3.4",
      executableSurface: "UNKNOWN_NOT_EXECUTED",
      resources: { extensions: [{ relativePath: "." }] },
    });
    await expect(
      new PiPackageManifestResolver({ stateRoot: join(root, "other-state") }).resolve({
        kind: "PI",
        packageName: "pi-import-fixture",
        version: "2.3.4",
        integrity,
      }),
    ).rejects.toThrow(/SOURCE_INVALID/u);
  });

  it("persists v2 manifests and exposes declared versus effective Pi resources", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task10-v2-registry-");
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-v2-registry-fixture",
        version: "1.0.0",
        license: "MIT",
        pi: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    await writeFile(join(packageRoot, "index.js"), "export default () => {};\n", "utf8");
    const source = await createLocalPiPluginSource({ label: "v2-registry", packageRoot });
    const resolver = new PiPackageManifestResolver({
      stateRoot: join(root, "resolver"),
      localPackages: new Map([["v2-registry", packageRoot]]),
    });
    const manager = new FilePluginManager({
      stateRoot: join(root, "registry"),
      resolve: (candidate) => resolver.resolve(candidate),
    });

    await manager.install({
      schemaVersion: "hpi-plugin-install.v1",
      operationId: "op_plugin-v2-registry-install",
      operationFingerprint: fixtureFingerprint,
      source,
      trust: "USER_APPROVED",
      provenanceAcknowledged: true,
      requestedIsolation: "PROCESS_AUTHORITY",
      compatibility: "VERIFIED",
      evidenceIds: [],
      observedAt: fixtureTimestamp,
    });

    await expect(manager.list()).resolves.toMatchObject([
      {
        schemaVersion: "hpi-plugin-record.v2",
        state: "QUARANTINED",
        manifest: { schemaVersion: "hpi-plugin-manifest.v2" },
      },
    ]);
    const inventory = await manager.inventory();
    expect(inventory).toMatchObject({
      schemaVersion: "hpi-plugin-inventory.v2",
      safeMode: true,
      declaredExtensions: [{ relativePath: "index.js" }],
      effectiveExtensions: [],
    });
    if (inventory.schemaVersion !== "hpi-plugin-inventory.v2") {
      throw new Error("expected the v2 Pi resource inventory");
    }
    expect(inventory.declaredExtensions[0]?.contentFingerprint).toMatch(/^sha256:/u);
  });
});
