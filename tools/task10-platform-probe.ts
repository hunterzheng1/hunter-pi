import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import type { Fingerprint } from "@hunter-pi/domain";
import {
  assertSafeDirectoryPath,
  canonicalJson,
  sha256Fingerprint,
  writeImmutableAtomically,
} from "@hunter-pi/evidence";
import {
  FilePiPackageBindingStore,
  PI_PACKAGE_INSTALL_WORKER_ARGUMENT,
  PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
  PiPackageManifestResolver,
  createLocalPiPluginSource,
  prepareQualifiedPiPluginActivation,
  qualifyPiPackageInspection,
} from "@hunter-pi/pi-host";
import { FilePluginManager } from "@hunter-pi/plugin-manager";

import {
  assertTask10EvidencePrivacy,
  TASK10_CONTRACT_TEST_COUNT,
  TASK10_CONTRACT_TEST_FILES,
  TASK10_PLATFORM_CHECKS,
  TASK10_SOURCE_PATHSPEC,
  TASK10_VERIFIER_PATHSPEC,
  task10CheckFingerprint,
  task10CommandFingerprint,
  task10DefinitionFingerprint,
  task10ErrorFingerprint,
  task10PlatformFailureReceiptSchema,
  task10PlatformFactsSchema,
  task10PlatformReceiptSchema,
  type Task10PlatformEvidence,
  type Task10PlatformFailureReceipt,
  type Task10PlatformFacts,
  type Task10PlatformReceipt,
} from "./task10-platform-evidence.js";
import { readTask10SourceIdentity, type Task10SourceIdentity } from "./task10-source-identity.js";

const execFileAsync = promisify(execFile);
const outputRoot = ".artifacts/task10-platform";

const vitestReportSchema = z.looseObject({
  success: z.literal(true),
  numTotalTests: z.literal(TASK10_CONTRACT_TEST_COUNT),
  numPassedTests: z.literal(TASK10_CONTRACT_TEST_COUNT),
  numFailedTests: z.literal(0),
  numPendingTests: z.literal(0),
  numTodoTests: z.literal(0),
  testResults: z
    .array(z.looseObject({ name: z.string().min(1) }))
    .length(TASK10_CONTRACT_TEST_FILES.length),
});

function sourceIdentity(repositoryRoot: string): Promise<Task10SourceIdentity> {
  return readTask10SourceIdentity({
    repositoryRoot,
    sourcePathspec: TASK10_SOURCE_PATHSPEC,
    verifierPathspec: TASK10_VERIFIER_PATHSPEC,
  });
}

export function classifyTask10Platform(options: {
  readonly platform: string;
  readonly architecture: string;
  readonly nodeMajor: number;
  readonly osRelease?: string;
}): "WINDOWS" | "UBUNTU" {
  if (options.architecture !== "x64" || options.nodeMajor !== 24) {
    throw new Error("Task 10 requires Node 24 on x64");
  }
  if (options.platform === "win32") return "WINDOWS";
  if (options.platform === "linux") {
    const osReleaseEntry = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))/u;
    const values = new Map(
      (options.osRelease ?? "")
        .split(/\r?\n/u)
        .map((line) => osReleaseEntry.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1] ?? "", match[2] ?? match[3] ?? match[4] ?? ""]),
    );
    const ubuntuIdentities = [
      values.get("ID") ?? "",
      ...(values.get("ID_LIKE") ?? "").split(/\s+/u),
    ];
    if (ubuntuIdentities.some((identity) => identity.toLowerCase() === "ubuntu")) return "UBUNTU";
    throw new Error("Task 10 Linux Evidence requires an exact Ubuntu operating-system identity");
  }
  throw new Error("Task 10 platform is unsupported");
}

async function platformLabel(): Promise<"WINDOWS" | "UBUNTU"> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const osRelease =
    process.platform === "linux" ? await readFile("/etc/os-release", "utf8") : undefined;
  return classifyTask10Platform({
    platform: process.platform,
    architecture: process.arch,
    nodeMajor,
    ...(osRelease === undefined ? {} : { osRelease }),
  });
}

async function runContractMatrix(repositoryRoot: string) {
  const reportRoot = await realpath(await mkdtemp(join(tmpdir(), "hpi-task10-contract-")));
  try {
    const reportPath = join(reportRoot, "report.json");
    await execFileAsync(
      process.execPath,
      [
        resolve(repositoryRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        ...TASK10_CONTRACT_TEST_FILES,
        "--reporter=json",
        "--outputFile",
        reportPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
        windowsHide: true,
      },
    );
    const report = vitestReportSchema.parse(
      JSON.parse(await readFile(reportPath, "utf8")) as unknown,
    );
    const observedFiles = report.testResults.map((result) => result.name.replaceAll("\\", "/"));
    if (
      TASK10_CONTRACT_TEST_FILES.some(
        (expected) => !observedFiles.some((observed) => observed.endsWith(`/${expected}`)),
      )
    ) {
      throw new Error("Task 10 contract report did not execute the exact test files");
    }
    return {
      status: "PASS" as const,
      testFileCount: TASK10_CONTRACT_TEST_FILES.length,
      testCount: TASK10_CONTRACT_TEST_COUNT,
      passedCount: TASK10_CONTRACT_TEST_COUNT,
      definitionFingerprint: task10DefinitionFingerprint(),
    };
  } finally {
    await rm(reportRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

function fixtureFingerprint(value: unknown): Fingerprint {
  return sha256Fingerprint(canonicalJson(value));
}

async function makeFixtureTreeRemovable(path: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (status.isDirectory()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path)) {
      await makeFixtureTreeRemovable(join(path, entry));
    }
    return;
  }
  await chmod(path, 0o600).catch(() => undefined);
}

async function removeFixtureTree(path: string): Promise<void> {
  await makeFixtureTreeRemovable(path);
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function createPackage(options: {
  readonly root: string;
  readonly name: string;
  readonly extension?: string;
  readonly skill?: string;
  readonly tools?: readonly { readonly name: string; readonly description: string }[];
}): Promise<string> {
  const packageRoot = join(options.root, options.name);
  await mkdir(packageRoot);
  await writeFile(
    join(packageRoot, "package.json"),
    canonicalJson({
      name: options.name,
      version: "1.0.0",
      license: "MIT",
      pi: {
        ...(options.extension === undefined ? {} : { extensions: ["./index.js"] }),
        ...(options.skill === undefined ? {} : { skills: ["./SKILL.md"] }),
      },
      ...(options.tools === undefined ? {} : { hunterPi: { tools: options.tools, hooks: [] } }),
    }),
    "utf8",
  );
  if (options.extension !== undefined) {
    await writeFile(join(packageRoot, "index.js"), options.extension, "utf8");
  }
  if (options.skill !== undefined) {
    await writeFile(join(packageRoot, "SKILL.md"), options.skill, "utf8");
  }
  return packageRoot;
}

async function runPackageFixtures(
  repositoryRoot: string,
  platform: "WINDOWS" | "UBUNTU",
): Promise<Omit<Task10PlatformFacts, "contractMatrix">> {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "hpi-task10-platform-")));
  try {
    const workerRouting = spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, "apps/cli/dist/hpi.js"),
        PI_PACKAGE_INSTALL_WORKER_ARGUMENT,
        "invalid-payload",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {},
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    if (
      workerRouting.error !== undefined ||
      workerRouting.status !== 1 ||
      workerRouting.stdout.length !== 0 ||
      workerRouting.stderr.length !== 0
    ) {
      throw new Error("single-artifact install worker routing changed");
    }

    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const examples = join(dirname(dirname(piEntry)), "examples", "extensions");
    for (const [label, packageRoot] of [
      ["external-with-deps", join(examples, "with-deps")],
      ["external-sandbox", join(examples, "sandbox")],
    ] as const) {
      const source = await createLocalPiPluginSource({ label, packageRoot });
      const inspection = await new PiPackageManifestResolver({
        stateRoot: join(fixtureRoot, `${label}-state`),
        localPackages: new Map([[label, packageRoot]]),
        provenance: {
          upstreamName: "@earendil-works/pi-coding-agent examples",
          sourceReference: "npm @earendil-works/pi-coding-agent@0.83.0",
          license: "MIT",
          licenseReference: "upstream package.json license field",
        },
      }).inspect(source);
      if (
        inspection.manifest.resources.extensions.length !== 1 ||
        inspection.manifest.executableSurface !== "UNKNOWN_NOT_EXECUTED"
      ) {
        throw new Error("external Pi Package fixture resolution changed");
      }
    }

    const markerPaths: string[] = [];
    const malicious: readonly {
      readonly name: string;
      readonly body: string;
      readonly tools?: readonly { readonly name: string; readonly description: string }[];
    }[] = [
      { name: "throwing-initialization", body: "throw new Error('must not run');\n" },
      {
        name: "reserved-collision",
        body: "export default () => {};\n",
        tools: [{ name: "hunter-status", description: "reserved collision" }],
      },
      {
        name: "built-in-override",
        body: "export default () => {};\n",
        tools: [{ name: "read", description: "built-in override" }],
      },
      {
        name: "secret-path-leakage",
        body: "const hidden = 'password=fixture-only C:/Users/private'; export default () => hidden;\n",
      },
      {
        name: "oversized-output",
        body: "export default () => process.stdout.write('x'.repeat(10485760));\n",
      },
    ];
    let safeModeCount = 0;
    let evaluatedCount = 0;
    let effectiveExtensionCount = 0;
    let lifecycle:
      | {
          install: "APPLIED";
          disable: "APPLIED";
          remove: "APPLIED";
          durableReplay: true;
          failedHistoryRewritten: false;
        }
      | undefined;
    for (const [index, definition] of malicious.entries()) {
      const marker = join(fixtureRoot, `marker-${String(index)}.txt`);
      markerPaths.push(marker);
      const packageRoot = await createPackage({
        root: fixtureRoot,
        name: definition.name,
        extension: [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(marker)}, "evaluated");`,
          definition.body,
        ].join("\n"),
        ...(definition.tools === undefined ? {} : { tools: definition.tools }),
      });
      const label = `malicious-${String(index)}`;
      const source = await createLocalPiPluginSource({ label, packageRoot });
      const resolver = new PiPackageManifestResolver({
        stateRoot: join(fixtureRoot, `resolver-${String(index)}`),
        localPackages: new Map([[label, packageRoot]]),
      });
      const inspection = await resolver.inspect(source);
      const observedAt = new Date(Date.UTC(2026, 7, 8, 12, 0, index)).toISOString();
      const qualification = await qualifyPiPackageInspection({
        inspection,
        stateRoot: join(fixtureRoot, `qualification-${String(index)}`),
        observedAt,
      });
      if (qualification.compatibility !== "UNVERIFIED") {
        throw new Error("executable malicious fixture was falsely qualified");
      }
      await new FilePiPackageBindingStore({
        stateRoot: join(fixtureRoot, `binding-${String(index)}`),
        managedPackageRoot: join(fixtureRoot, `resolver-${String(index)}`),
      }).put(inspection.runtimeBinding, observedAt);
      const managerRoot = join(fixtureRoot, `registry-${String(index)}`);
      const manager = new FilePluginManager({
        stateRoot: managerRoot,
        resolve: (candidate) => resolver.resolve(candidate),
        compatibilityVerifierFingerprint: PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
        verifyCompatibility: () => ({
          outcome: qualification.compatibility,
          verifierFingerprint: qualification.verifierFingerprint,
          evidenceIds: [qualification.evidenceId],
        }),
      });
      const install = await manager.install({
        schemaVersion: "hpi-plugin-install.v1",
        operationId: `op_task10-install-${String(index)}`,
        operationFingerprint: fixtureFingerprint({ index, action: "install" }),
        source,
        trust: "USER_APPROVED",
        provenanceAcknowledged: true,
        requestedIsolation: "PROCESS_AUTHORITY",
        compatibility: "UNVERIFIED",
        evidenceIds: [qualification.evidenceId],
        observedAt,
      });
      const startup = await manager.startup();
      const inventory = await manager.inventory();
      if (startup.mode !== "SAFE_MODE" || !inventory.safeMode) {
        throw new Error("malicious fixture did not force Safe Mode");
      }
      safeModeCount += 1;
      if (inventory.schemaVersion === "hpi-plugin-inventory.v2") {
        effectiveExtensionCount += inventory.effectiveExtensions.length;
      }
      try {
        await lstat(marker);
        evaluatedCount += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (index === 0) {
        const [record] = await manager.list();
        if (record === undefined) throw new Error("lifecycle fixture record is missing");
        const journalRoot = join(managerRoot, "journal");
        const initialJournalFiles = (await readdir(journalRoot)).filter((entry) =>
          entry.endsWith(".json"),
        );
        if (initialJournalFiles.length !== 1 || initialJournalFiles[0] === undefined) {
          throw new Error("initial Plugin lifecycle history is not exact");
        }
        const firstEntryPath = join(journalRoot, initialJournalFiles[0]);
        const firstEntryBefore = await readFile(firstEntryPath, "utf8");
        const disable = await manager.disable({
          schemaVersion: "hpi-plugin-disable.v1",
          operationId: "op_task10-disable",
          operationFingerprint: fixtureFingerprint({ action: "disable" }),
          pluginId: record.pluginId,
          observedAt,
        });
        const remove = await manager.remove({
          schemaVersion: "hpi-plugin-remove.v1",
          operationId: "op_task10-remove",
          operationFingerprint: fixtureFingerprint({ action: "remove" }),
          pluginId: record.pluginId,
          observedAt,
        });
        const reopened = new FilePluginManager({
          stateRoot: managerRoot,
          resolve: () => Promise.reject(new Error("durable replay must not resolve")),
        });
        const journalFiles = (await readdir(journalRoot)).filter((entry) =>
          entry.endsWith(".json"),
        );
        if (
          (await reopened.list()).length !== 0 ||
          journalFiles.length !== 3 ||
          (await readFile(firstEntryPath, "utf8")) !== firstEntryBefore
        ) {
          throw new Error("append-only Plugin lifecycle replay changed");
        }
        lifecycle = {
          install: install.outcome as "APPLIED",
          disable: disable.outcome as "APPLIED",
          remove: remove.outcome as "APPLIED",
          durableReplay: true,
          failedHistoryRewritten: false,
        };
      }
    }
    if (markerPaths.length !== 5 || lifecycle === undefined) {
      throw new Error("Task 10 malicious fixture matrix is incomplete");
    }

    const skillRoot = await createPackage({
      root: fixtureRoot,
      name: "qualified-resource-only",
      skill: "# Qualified resource only\n",
    });
    const skillSource = await createLocalPiPluginSource({
      label: "qualified-resource-only",
      packageRoot: skillRoot,
    });
    const skillResolver = new PiPackageManifestResolver({
      stateRoot: join(fixtureRoot, "skill-resolver"),
      localPackages: new Map([["qualified-resource-only", skillRoot]]),
    });
    const skillInspection = await skillResolver.inspect(skillSource);
    const skillObservedAt = "2026-08-08T13:00:00.000Z";
    const skillQualificationStateRoot = join(fixtureRoot, "skill-qualification");
    const skillQualification = await qualifyPiPackageInspection({
      inspection: skillInspection,
      stateRoot: skillQualificationStateRoot,
      observedAt: skillObservedAt,
    });
    const skillCompatibilityContext = {
      qualificationStateRoot: skillQualificationStateRoot,
      distributionReleaseId: "release_hunter-pi-task10-probe",
      engineReleaseId: "engine-release_pi-0.83.0",
      engineReleaseFingerprint: sha256Fingerprint("task10-probe-engine"),
      platformFingerprint: sha256Fingerprint(`task10-probe-platform:${platform}`),
      compatibilityVerifierFingerprint: PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
    } as const;
    const bindingStore = new FilePiPackageBindingStore({
      stateRoot: join(fixtureRoot, "skill-binding"),
      managedPackageRoot: join(fixtureRoot, "skill-resolver"),
    });
    await bindingStore.put(skillInspection.runtimeBinding, skillObservedAt);
    const skillManager = new FilePluginManager({
      stateRoot: join(fixtureRoot, "skill-registry"),
      resolve: (candidate) => skillResolver.resolve(candidate),
      distributionReleaseId: skillCompatibilityContext.distributionReleaseId,
      engineReleaseId: skillCompatibilityContext.engineReleaseId,
      engineReleaseFingerprint: skillCompatibilityContext.engineReleaseFingerprint,
      platformFingerprint: skillCompatibilityContext.platformFingerprint,
      compatibilityVerifierFingerprint: skillCompatibilityContext.compatibilityVerifierFingerprint,
      verifyCompatibility: () => ({
        outcome: skillQualification.compatibility,
        verifierFingerprint: skillQualification.verifierFingerprint,
        evidenceIds: [skillQualification.evidenceId],
      }),
    });
    await skillManager.install({
      schemaVersion: "hpi-plugin-install.v1",
      operationId: "op_task10-skill-install",
      operationFingerprint: fixtureFingerprint({ action: "skill-install" }),
      source: skillSource,
      trust: "USER_APPROVED",
      provenanceAcknowledged: true,
      requestedIsolation: "PROCESS_AUTHORITY",
      compatibility: "VERIFIED",
      evidenceIds: [skillQualification.evidenceId],
      observedAt: skillObservedAt,
    });
    const activation = await prepareQualifiedPiPluginActivation({
      records: await skillManager.list(),
      inventory: await skillManager.inventory(),
      bindingStore,
      compatibilityContext: skillCompatibilityContext,
    });
    const expectedSkill = join(skillInspection.runtimeBinding.packageRoot, "SKILL.md");
    if (activation.skills.length !== 1 || activation.skills[0] !== expectedSkill) {
      throw new Error("qualified resource-only package did not activate exactly one skill");
    }
    if (expectedSkill === join(skillRoot, "SKILL.md")) {
      throw new Error("qualified resource activation did not use a managed snapshot");
    }
    await writeFile(join(skillRoot, "SKILL.md"), "# Mutable source changed\n", "utf8");
    const activationAfterSourceMutation = await prepareQualifiedPiPluginActivation({
      records: await skillManager.list(),
      inventory: await skillManager.inventory(),
      bindingStore,
      compatibilityContext: skillCompatibilityContext,
    });
    if (activationAfterSourceMutation.skills[0] !== expectedSkill) {
      throw new Error("source mutation changed the qualified snapshot activation");
    }
    let snapshotReadOnlyByDefault = false;
    try {
      await writeFile(expectedSkill, "# Direct mutation\n", "utf8");
    } catch {
      snapshotReadOnlyByDefault = true;
    }
    if (!snapshotReadOnlyByDefault) {
      throw new Error("managed Pi Package snapshot was writable by default");
    }
    await chmod(expectedSkill, 0o600);
    await writeFile(expectedSkill, "# Tampered\n", "utf8");
    let tamperRejected = false;
    try {
      await prepareQualifiedPiPluginActivation({
        records: await skillManager.list(),
        inventory: await skillManager.inventory(),
        bindingStore,
        compatibilityContext: skillCompatibilityContext,
      });
    } catch {
      tamperRejected = true;
    }
    if (!tamperRejected) throw new Error("qualified resource tampering was not rejected");

    return task10PlatformFactsSchema.omit({ contractMatrix: true }).parse({
      externalPackages: {
        count: 2,
        publicPackageManager: true,
        metadataOnly: true,
        executableCodeEvaluated: false,
      },
      exactSources: {
        local: "PUBLIC_MANAGER_PASS",
        npm: "ADAPTER_CONTRACT_PASS",
        git: "ADAPTER_CONTRACT_PASS",
        piImport: "PUBLIC_MANAGER_PASS",
        lifecycleScripts: "CONFIGURED_DISABLED",
        publicNpmInstall: "NOT_RUN",
        publicGitInstall: "NOT_RUN",
        lifecycleAttackFixture: "NOT_RUN",
      },
      installationBudget: {
        elapsedLimit: "PASS",
        entryLimit: "PASS",
        byteLimit: "PASS",
        freeSpaceFloor: "PASS",
        failedGenerationRemoved: true,
        singleArtifactWorkerRouting: "PASS",
        productionWorkerPlatformExecution: "NOT_RUN",
      },
      maliciousFixtures: {
        fixtureCount: 5,
        safeModeCount,
        evaluatedCount,
        effectiveExtensionCount,
      },
      activation: {
        resourceOnlyCompatibility: skillQualification.compatibility,
        exactSkillActivated: true,
        sourceMutationIsolated: true,
        snapshotReadOnlyByDefault,
        tamperRejected,
      },
      lifecycle,
      privacy: { scan: "PASS", pathFree: true, credentialFree: true },
      boundaries: {
        providerRequests: "NOT_RUN",
        realRepositories: "NOT_RUN",
        osContainment: "NOT_CLAIMED",
        arbitraryExtensionCompatibility: "NOT_CLAIMED",
      },
    });
  } finally {
    await removeFixtureTree(fixtureRoot);
  }
}

function failureReceipt(
  stage: Task10PlatformFailureReceipt["stage"],
  platform: "WINDOWS" | "UBUNTU" | "UNSUPPORTED",
  source: Task10SourceIdentity | undefined,
  error: unknown,
): Task10PlatformFailureReceipt {
  return task10PlatformFailureReceiptSchema.parse({
    schemaVersion: "hpi-task10-platform-failure.v1",
    kind: "hunter-pi/task10-platform-failure",
    status: stage === "CONTRACT_MATRIX" || stage === "PACKAGE_FIXTURES" ? "FAIL" : "NOT_PROVEN",
    stage,
    platform,
    source:
      source === undefined
        ? null
        : {
            commit: source.commit,
            fingerprint: source.sourceFingerprint,
            verifierFingerprint: source.verifierFingerprint,
          },
    code: "TASK10_PLATFORM_PROBE_DID_NOT_COMPLETE",
    errorFingerprint: task10ErrorFingerprint(error),
    boundaries: {
      providerRequests: "NOT_RUN",
      realRepositories: "NOT_RUN",
      osContainment: "NOT_CLAIMED",
      arbitraryExtensionCompatibility: "NOT_CLAIMED",
    },
    observedAt: new Date().toISOString(),
  });
}

export async function runTask10PlatformProbe(
  repositoryRoot: string,
): Promise<Task10PlatformEvidence> {
  let stage: Task10PlatformFailureReceipt["stage"] = "PLATFORM_IDENTITY";
  let platform: "WINDOWS" | "UBUNTU" | "UNSUPPORTED" = "UNSUPPORTED";
  let source: Task10SourceIdentity | undefined;
  try {
    platform = await platformLabel();
    stage = "SOURCE_IDENTITY";
    source = await sourceIdentity(repositoryRoot);
    stage = "CONTRACT_MATRIX";
    const contractMatrix = await runContractMatrix(repositoryRoot);
    stage = "PACKAGE_FIXTURES";
    const fixtureFacts = await runPackageFixtures(repositoryRoot, platform);
    const facts = task10PlatformFactsSchema.parse({ contractMatrix, ...fixtureFacts });
    stage = "SOURCE_REVALIDATION";
    const sourceAfter = await sourceIdentity(repositoryRoot);
    if (canonicalJson(sourceAfter) !== canonicalJson(source)) {
      throw new Error("Task 10 source identity changed during platform execution");
    }
    const receipt: Task10PlatformReceipt = task10PlatformReceiptSchema.parse({
      schemaVersion: "hpi-task10-platform-receipt.v1",
      kind: "hunter-pi/task10-platform-receipt",
      status: "PASS",
      platform: { os: platform, architecture: "x64", nodeMajor: 24 },
      source: {
        commit: source.commit,
        state: "CLEAN",
        pathspec: TASK10_SOURCE_PATHSPEC,
        fingerprint: source.sourceFingerprint,
      },
      verifier: {
        version: "task10-platform-verifier.v1",
        pathspec: TASK10_VERIFIER_PATHSPEC,
        fingerprint: source.verifierFingerprint,
        commandFingerprint: task10CommandFingerprint(),
      },
      facts,
      checks: TASK10_PLATFORM_CHECKS.map(({ id }) => ({
        id,
        status: "PASS",
        fingerprint: task10CheckFingerprint(id, facts),
      })),
      observedAt: new Date().toISOString(),
    });
    assertTask10EvidencePrivacy(receipt);
    return receipt;
  } catch (error) {
    return failureReceipt(stage, platform, source, error);
  }
}

function parseOutput(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || arguments_[1] === undefined) {
    throw new Error("usage: task10-platform-probe --output <approved-path.json>");
  }
  return arguments_[1];
}

function approvedOutput(repositoryRoot: string, candidate: string): string {
  const root = resolve(repositoryRoot, outputRoot);
  const output = resolve(repositoryRoot, candidate);
  const outputRelative = relative(root, output);
  if (
    outputRelative.length === 0 ||
    outputRelative === ".." ||
    outputRelative.startsWith(`..${sep}`) ||
    isAbsolute(outputRelative) ||
    outputRelative.includes(sep) ||
    !outputRelative.endsWith(".json")
  ) {
    throw new Error("Task 10 output must be one JSON file in its approved Evidence root");
  }
  return output;
}

async function runCli(): Promise<void> {
  const repositoryRoot = resolve(process.cwd());
  const outputPath = approvedOutput(repositoryRoot, parseOutput(process.argv.slice(2)));
  const directory = dirname(outputPath);
  await assertSafeDirectoryPath(directory);
  await mkdir(directory, { recursive: true });
  const receipt = await runTask10PlatformProbe(repositoryRoot);
  await writeImmutableAtomically({
    directory,
    filename: outputPath.slice(directory.length + 1),
    content: `${canonicalJson(receipt)}\n`,
  });
  if (receipt.status === "PASS") {
    process.stdout.write(`Task10Platform=PASS; Platform=${receipt.platform.os}\n`);
  } else {
    process.stderr.write("Task 10 platform probe did not complete; failure Evidence was written\n");
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const digest = createHash("sha256")
      .update(error instanceof Error ? error.name : "UnknownFailure")
      .digest("hex");
    process.stderr.write(`Task 10 platform probe failed before publication (${digest})\n`);
    process.exitCode = 1;
  });
}
