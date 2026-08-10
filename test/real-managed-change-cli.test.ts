import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectHpiRepository,
  inspectHpiPilotTarget,
  runHpiCli,
  type HpiCliDependencies,
  type HpiCliIo,
} from "@hunter-pi/cli";
import {
  fingerprintRealManagedChangeCheckDefinition,
  fingerprintRealManagedChangeTaskDefinition,
  realManagedChangeEvidenceSchema,
  realManagedChangeRequestSchema,
  realManagedChangeTaskReceiptSchema,
  type RealManagedChangeRequest,
  type RealManagedChangeTarget,
} from "@hunter-pi/managed-change";
import { FileRunArchiveStore, FileWorkflowEventStore } from "@hunter-pi/evidence";
import { DurableWorkflowKernel } from "@hunter-pi/workflow-kernel";
import {
  PilotPlanCompiler,
  createPilotRuntimeBinding,
  pilotQuickWorkflowFactChecklistFingerprint,
  type PilotExecutionPlan,
} from "@hunter-pi/pilot";
import {
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  resolveHpiPaths,
  saveHpiConfiguration,
  type Task6PiProcessRequest,
  type Task6PiProcessBoundary,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { fixturePiProviderUsage } from "./support/pi-provider-usage-fixture.js";
import { completePilotPlanInput } from "./support/task12-plan-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";
import { vitestResourcePolicy } from "./support/vitest-resource-runtime.js";

const cleanupRoots: string[] = [];
const coreSource = "export default () => {};\n";
const coreIntegrity = `sha256:${createHash("sha256").update(coreSource).digest("hex")}`;
const pilotArtifactFingerprint = `sha256:${"8".repeat(64)}`;
const pilotSourceCommit = "d".repeat(40);

function pilotRuntimeBindingForFixture() {
  return createPilotRuntimeBinding({
    sourceCommit: pilotSourceCommit,
    artifactFingerprint: pilotArtifactFingerprint,
    enginePackageName: "@earendil-works/pi-coding-agent",
    engineVersion: "0.83.0",
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    configuredOrigin: "https://provider-managed.example",
    pristineOrigin: "https://provider-managed.example",
    credentialSource: "stored",
  });
}

function managedPilotPlanForFixture(options: {
  readonly target: RealManagedChangeTarget;
  readonly request: RealManagedChangeRequest;
  readonly taskId: string;
}): PilotExecutionPlan {
  const input = completePilotPlanInput();
  const runtimeBinding = pilotRuntimeBindingForFixture();
  const selectedTask = input.tasks.find((task) => task.taskId === options.taskId);
  const selectedCheckId = selectedTask?.acceptanceCheckIds[0];
  if (selectedTask === undefined || selectedCheckId === undefined) {
    throw new Error("Managed pilot task fixture is missing");
  }
  return new PilotPlanCompiler().compile({
    ...input,
    sourceFingerprint: runtimeBinding.sourceFingerprint,
    artifactFingerprint: runtimeBinding.artifactFingerprint,
    engineReleaseFingerprint: runtimeBinding.engineReleaseFingerprint,
    workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
    machineProfile: {
      ...input.machineProfile,
      sourceFingerprint: runtimeBinding.sourceFingerprint,
      hunterReleaseFingerprint: runtimeBinding.artifactFingerprint,
      engineReleaseFingerprint: runtimeBinding.engineReleaseFingerprint,
    },
    operatorScope: {
      ...input.operatorScope,
      providerEndpointFingerprint: runtimeBinding.providerEndpointFingerprint,
      providerModelFingerprint: runtimeBinding.providerModelFingerprint,
      credentialScopeFingerprint: runtimeBinding.credentialScopeFingerprint,
    },
    repositoryTargets: input.repositoryTargets.map((candidate) =>
      candidate.targetId === options.target.targetId
        ? {
            ...candidate,
            repositoryFingerprint: options.target.repositoryFingerprint,
            sourceFingerprint: options.target.sourceFingerprint,
            targetReferenceFingerprint: options.target.targetReferenceFingerprint,
          }
        : candidate,
    ),
    acceptanceChecks: input.acceptanceChecks.map((check) =>
      check.checkId === selectedCheckId
        ? {
            ...check,
            definitionFingerprint: fingerprintRealManagedChangeCheckDefinition(options.request),
          }
        : check,
    ),
    tasks: input.tasks.map((task) => {
      if (task.taskId === options.taskId) {
        return {
          taskId: task.taskId,
          targetId: options.target.targetId,
          sourceFingerprint: options.target.sourceFingerprint,
          taskDefinitionFingerprint: fingerprintRealManagedChangeTaskDefinition(options.request),
          mode: "MANAGED" as const,
          expectedOutcome: "READY" as const,
          acceptanceCheckIds: task.acceptanceCheckIds,
        };
      }
      return task.targetId === options.target.targetId
        ? { ...task, sourceFingerprint: options.target.sourceFingerprint }
        : task;
    }),
  });
}
const qualifiedPiSuccessScript = [
  "const fs = require('node:fs');",
  "fs.writeFileSync('result.txt', 'READY\\n');",
  "const usage={input:120,output:30,cacheRead:10,cacheWrite:5,totalTokens:165,cost:{input:0.0012,output:0.0006,cacheRead:0.0001,cacheWrite:0.00005,total:0.00195}};",
  "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',usage}})+'\\n');",
  "process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');",
  "process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');",
].join("\n");

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runGit(repository: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Git fixture command failed: ${arguments_.join(" ")}`);
  }
  return result.stdout;
}

async function createCliFixture(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly io: HpiCliIo & { readonly stdout: string[]; readonly stderr: string[] };
  readonly dependencies: HpiCliDependencies;
}> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-real-change-cli-");
  cleanupRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  runGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  runGit(repository, ["config", "user.name", "Hunter Pi CLI Test"]);
  runGit(repository, ["config", "user.email", "hunter-pi-cli@example.invalid"]);
  await writeFile(join(repository, "result.txt"), "NOT_READY\n", "utf8");
  await writeFile(
    join(repository, "verify.mjs"),
    "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('result.txt', 'utf8') === 'READY\\n' ? 0 : 1);\n",
    "utf8",
  );
  runGit(repository, ["add", "--", "result.txt", "verify.mjs"]);
  runGit(repository, ["commit", "--quiet", "-m", "Initialize CLI real-project fixture"]);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout,
    stderr,
    confirm: () => Promise.resolve(true),
    writeStdout: (text: string) => stdout.push(text),
    writeStderr: (text: string) => stderr.push(text),
  };
  const sourceCommit = pilotSourceCommit;
  const dependencies: HpiCliDependencies = {
    cwd: repository,
    environment: {
      HUNTER_PI_HOME: join(root, "profile"),
      HUNTER_PI_PORTABLE_ROOT: root,
    },
    homeDirectory: root,
    io,
    now: () => "2026-08-06T00:00:10.000Z",
    inspectRepository: (target) =>
      Promise.resolve({ root: target, name: "repository", branch: "main", dirty: false }),
    inspectPilotTarget: inspectHpiPilotTarget,
    readProviderAuthStatus: () => Promise.resolve({ configured: true, source: "stored" }),
    resolveProviderDestination: () =>
      Promise.resolve({
        configuredOrigin: "https://provider-managed.example",
        pristineOrigin: "https://provider-managed.example",
      }),
    launch: () => Promise.resolve(0),
    temporaryParent: root,
    piCliPath: join(root, "pi-cli.js"),
    coreExtensionPath: join(root, "core-extension.js"),
    platform: process.platform,
    getVersionInfo: () =>
      Promise.resolve({
        product: "Hunter Pi",
        productVersion: "0.1.0-dev.0",
        engine: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        sourceCommit,
        sourceState: "CLEAN" as const,
        coreExtensionIntegrity: coreIntegrity,
        productShellIntegrity: `sha256:${"e".repeat(64)}`,
        updateChannel: "developer-preview" as const,
      }),
    readTextFile: (path) => readFile(path, "utf8"),
  };
  const runtimeBinding = pilotRuntimeBindingForFixture();
  await Promise.all([
    writeFile(join(root, "core-extension.js"), coreSource, "utf8"),
    writeFile(
      join(root, "portable-manifest.json"),
      JSON.stringify({
        schemaVersion: "hpi-windows-portable.v2",
        product: "Hunter Pi",
        platform: "win32-x64",
        nodeVersion: process.versions.node,
        sourceCommit,
        sourceState: "CLEAN",
        updateChannel: "developer-preview",
        installer: "PORTABLE_DIRECTORY",
        signed: false,
        releaseId: "release_hunter-pi-fixture",
        productVersion: "0.1.0-dev.0",
        engineReleaseId: "engine-release_pi-0.83.0",
        engineReleaseFingerprint: runtimeBinding.engineReleaseFingerprint,
        artifactFingerprint: runtimeBinding.artifactFingerprint,
        artifactByteLength: 1,
        versionDirectory: "versions/release_hunter-pi-fixture",
        cliPackageFingerprint: `sha256:${"c".repeat(64)}`,
        productShellIntegrity: `sha256:${"e".repeat(64)}`,
        coreExtensionIntegrity: coreIntegrity,
        nodeRuntimeIntegrity: `sha256:${"f".repeat(64)}`,
      }),
      "utf8",
    ),
  ]);
  await saveHpiConfiguration(
    resolveHpiPaths({ env: dependencies.environment, homeDirectory: dependencies.homeDirectory }),
    {
      ...acknowledgeProviderDisclosure(createDefaultHpiConfiguration(), {
        acceptedAt: "2026-08-06T00:00:00.000Z",
        resolvedDestinationOrigin: "https://provider-managed.example",
      }),
      setupCompletedAt: "2026-08-06T00:00:01.000Z",
    },
  );
  return { root, repository, io, dependencies };
}

async function targetFor(repository: string): Promise<RealManagedChangeTarget> {
  const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");
  if (
    receipt.status !== "READY" ||
    receipt.repositoryFingerprint === null ||
    receipt.sourceFingerprint === null ||
    receipt.targetReferenceFingerprint === null
  ) {
    throw new Error(`target fixture was not ready: ${JSON.stringify(receipt)}`);
  }
  return {
    targetId: receipt.targetId,
    selectionMode: receipt.selectionMode,
    repositoryFingerprint: receipt.repositoryFingerprint,
    sourceFingerprint: receipt.sourceFingerprint,
    targetReferenceFingerprint: receipt.targetReferenceFingerprint,
  };
}

function plan(target: RealManagedChangeTarget): Record<string, unknown> {
  return {
    schemaVersion: "hpi-managed-change-request.v2",
    title: "Make the CLI project check pass",
    goal: "Change result.txt so the declared project check passes.",
    nonGoals: ["Commit, push, publish, or deploy"],
    constraints: ["Only result.txt may change"],
    allowedPaths: ["result.txt"],
    check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
    target,
  };
}

describe("hpi change command", { timeout: 30_000 }, () => {
  it("rejects external Git filters during CLI repository inspection without executing them", async () => {
    const { root, repository } = await createCliFixture();
    const filterScript = join(root, "cli-filter.mjs");
    const marker = join(root, "cli-filter-executed.marker");
    await writeFile(
      filterScript,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    runGit(repository, ["config", "filter.hpiunsafe.process", `node "${filterScript}"`]);

    expect(() => inspectHpiRepository(repository)).toThrow(/Git repository inspection failed/u);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("requires explicit Provider authorization before it can inspect or run a target", async () => {
    const { dependencies, io, root } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    const target = await targetFor(join(root, "repository"));
    await writeFile(planPath, JSON.stringify(plan(target)), "utf8");

    expect(
      await runHpiCli(["change", "--repo", root, "--plan", planPath, "--json"], dependencies),
    ).toBe(2);
    expect(io.stderr.join("\n")).toContain("PROVIDER_REQUEST_NOT_AUTHORIZED");
    expect(io.stderr.join("\n")).not.toContain(root);
  });

  it("rejects a Managed pilot request that aliases the frozen target identity", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const frozenTarget = await targetFor(repository);
    const frozenRequest = realManagedChangeRequestSchema.parse(plan(frozenTarget));
    const aliasRequest = realManagedChangeRequestSchema.parse({
      ...frozenRequest,
      target: { ...frozenTarget, targetId: "repository-alias" },
    });
    const pilotPlan = managedPilotPlanForFixture({
      target: frozenTarget,
      request: frozenRequest,
      taskId: "pilot-task-01",
    });
    const requestPath = join(root, "alias-change-plan.json");
    const pilotPlanPath = join(root, "alias-pilot-plan.json");
    await Promise.all([
      writeFile(requestPath, JSON.stringify(aliasRequest), "utf8"),
      writeFile(pilotPlanPath, JSON.stringify(pilotPlan), "utf8"),
    ]);
    let processRequests = 0;
    const runTask6Process = async (
      _request: Task6PiProcessRequest,
      boundary?: Task6PiProcessBoundary,
    ): Promise<Task6PiProcessResult> => {
      processRequests += 1;
      await boundary?.beforeExternalOperation();
      throw new Error("an aliased pilot target must not reach the process runner");
    };

    expect(
      await runHpiCli(
        [
          "change",
          "--repo",
          repository,
          "--plan",
          requestPath,
          "--run-archive-id",
          "archive_cli-target-alias",
          "--pilot-plan",
          pilotPlanPath,
          "--pilot-task-id",
          "pilot-task-01",
          "--pilot-session-id",
          "pilot-target-alias-session",
          "--pilot-operation-id",
          "capture-target-alias-task-01",
          "--json",
          "--allow-provider-request",
        ],
        { ...dependencies, platform: "win32", runTask6Process },
      ),
    ).toBe(2);
    expect(processRequests).toBe(0);
    expect(io.stderr.join("\n")).toContain("PILOT_TASK_BINDING_MISMATCH");
  });

  it("runs an explicitly scoped real-project change and emits portable Evidence", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    const pilotPlanPath = join(root, "pilot-plan.json");
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse(plan(target));
    const pilotPlan = managedPilotPlanForFixture({
      target,
      request,
      taskId: "pilot-task-01",
    });
    await Promise.all([
      writeFile(planPath, JSON.stringify(request), "utf8"),
      writeFile(pilotPlanPath, JSON.stringify(pilotPlan), "utf8"),
    ]);
    const pilotSessionId = "pilot-real-cli-session";
    const pilotOperationId = "capture-real-cli-task-01";
    expect(
      await runHpiCli(
        [
          "pilot",
          "capture",
          "open",
          "--plan",
          pilotPlanPath,
          "--session-id",
          pilotSessionId,
          "--archive-id",
          "pilot-real-cli-archive",
          "--json",
        ],
        dependencies,
      ),
    ).toBe(0);
    io.stdout.splice(0);
    let processRequests = 0;
    const runTask6Process = async (
      request: Task6PiProcessRequest,
      boundary?: Task6PiProcessBoundary,
    ): Promise<Task6PiProcessResult> => {
      processRequests += 1;
      expect(request.plan.environment["HUNTER_PI_MODE"]).toBe("MANAGED");
      expect(request.plan.environment["HUNTER_PI_PERMISSION_PROFILE"]).toBe("FULL_ACCESS");
      await boundary?.beforeExternalOperation();
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: `sha256:${"a".repeat(64)}`,
        stderrDigest: `sha256:${"b".repeat(64)}`,
        capturedBytes: 128,
        outputTruncated: false,
        providerUsage: fixturePiProviderUsage,
        containment:
          process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
      };
    };
    const pilotChangeArguments = [
      "change",
      "--repo",
      repository,
      "--plan",
      planPath,
      "--run-archive-id",
      "archive_cli-real-pilot-01",
      "--pilot-plan",
      pilotPlanPath,
      "--pilot-task-id",
      "pilot-task-01",
      "--pilot-session-id",
      pilotSessionId,
      "--pilot-operation-id",
      pilotOperationId,
      "--json",
      "--allow-provider-request",
    ];
    const confirmationPrompts: string[] = [];
    const pilotIo = {
      ...io,
      confirm: (message: string) => {
        confirmationPrompts.push(message);
        return Promise.resolve(true);
      },
    };

    expect(
      await runHpiCli(pilotChangeArguments, {
        ...dependencies,
        io: pilotIo,
        platform: "linux",
        runTask6Process,
      }),
    ).toBe(2);
    expect(processRequests).toBe(0);
    expect(io.stderr.join("\n")).toContain("PILOT_HOST_MISMATCH");
    io.stderr.splice(0);

    expect(
      await runHpiCli(pilotChangeArguments, {
        ...dependencies,
        io: pilotIo,
        platform: "win32",
        runTask6Process,
      }),
    ).toBe(0);
    expect(processRequests).toBe(1);
    expect(confirmationPrompts).toEqual([
      expect.stringContaining(
        "frozen pilot allowance of 20 Provider requests, 20000 tokens, and 500 minor-cost units",
      ),
    ]);
    const artifact = realManagedChangeEvidenceSchema.parse(JSON.parse(io.stdout.join("")));
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v3",
      taskResult: "GO",
      repository: { scope: "EXPLICIT_OPERATOR_SELECTED" },
      cleanup: { status: "NOT_APPLICABLE", targetWorkingTree: "PRESERVED_CHANGED" },
    });
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
    const paths = resolveHpiPaths({
      env: dependencies.environment,
      homeDirectory: dependencies.homeDirectory,
    });
    const managedRunRoot = join(paths.root, "pilot", "managed-runs");
    const eventStore = new FileWorkflowEventStore({
      stateRoot: join(managedRunRoot, "workflow"),
    });
    const archiveStore = new FileRunArchiveStore({
      stateRoot: join(managedRunRoot, "archive"),
      kernel: new DurableWorkflowKernel(eventStore),
    });
    const archive = await archiveStore.read("archive_cli-real-pilot-01");
    expect(archive).toMatchObject({
      schemaVersion: "hpi-archive.v1",
      archiveId: "archive_cli-real-pilot-01",
      outcome: "READY",
    });
    const canonicalPackage = await archiveStore.readCanonicalPackage("archive_cli-real-pilot-01");
    const taskReceiptEvidence = canonicalPackage.evidence.find(
      (evidence) => evidence.evidenceId === "evidence_real-task-receipt",
    );
    if (taskReceiptEvidence === undefined) throw new Error("Managed task receipt is missing");
    expect(
      realManagedChangeTaskReceiptSchema.parse(
        JSON.parse(taskReceiptEvidence.capture.capturedText ?? "null"),
      ),
    ).toMatchObject({
      targetId: target.targetId,
      pilotExecutionBinding: { targetId: target.targetId },
    });

    io.stdout.splice(0);
    expect(
      await runHpiCli(
        [
          "pilot",
          "capture",
          "managed-task",
          "--session-id",
          pilotSessionId,
          "--operation-id",
          pilotOperationId,
          "--task-id",
          "pilot-task-01",
          "--archive-ids",
          "archive_cli-real-pilot-01",
          "--json",
        ],
        dependencies,
      ),
    ).toBe(0);
    const capture = JSON.parse(io.stdout.at(-1) ?? "null") as Record<string, unknown>;
    expect(capture).toMatchObject({
      schemaVersion: "hpi-pilot-capture-record-receipt.v1",
      outcome: "RECORDED",
      status: {
        counts: { taskChains: 1, runArchives: 1 },
        providerUsage: { requests: 1, tokens: 165, costMinor: 1 },
      },
    });
    expect(JSON.stringify(capture)).not.toContain(root);
  });

  it("executes and records a product-derived Quick pilot task through the CLI", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const target = await targetFor(repository);
    const request = realManagedChangeRequestSchema.parse(plan(target));
    const requestPath = join(root, "quick-request.json");
    const pilotPlanPath = join(root, "quick-pilot-plan.json");
    const input = completePilotPlanInput();
    const runtimeBinding = pilotRuntimeBindingForFixture();
    const taskDefinitionFingerprint = fingerprintRealManagedChangeTaskDefinition(request);
    const checkDefinitionFingerprint = fingerprintRealManagedChangeCheckDefinition(request);
    const pilotPlan = new PilotPlanCompiler().compile({
      ...input,
      sourceFingerprint: runtimeBinding.sourceFingerprint,
      artifactFingerprint: runtimeBinding.artifactFingerprint,
      engineReleaseFingerprint: runtimeBinding.engineReleaseFingerprint,
      workflowFactChecklistFingerprint: pilotQuickWorkflowFactChecklistFingerprint,
      machineProfile: {
        ...input.machineProfile,
        sourceFingerprint: runtimeBinding.sourceFingerprint,
        hunterReleaseFingerprint: runtimeBinding.artifactFingerprint,
        engineReleaseFingerprint: runtimeBinding.engineReleaseFingerprint,
      },
      operatorScope: {
        ...input.operatorScope,
        providerEndpointFingerprint: runtimeBinding.providerEndpointFingerprint,
        providerModelFingerprint: runtimeBinding.providerModelFingerprint,
        credentialScopeFingerprint: runtimeBinding.credentialScopeFingerprint,
      },
      repositoryTargets: input.repositoryTargets.map((candidate) =>
        candidate.targetId === target.targetId
          ? {
              ...candidate,
              repositoryFingerprint: target.repositoryFingerprint,
              sourceFingerprint: target.sourceFingerprint,
              targetReferenceFingerprint: target.targetReferenceFingerprint,
            }
          : candidate,
      ),
      acceptanceChecks: input.acceptanceChecks.map((check) =>
        check.checkId === "check_pilot-01"
          ? { ...check, definitionFingerprint: checkDefinitionFingerprint }
          : check,
      ),
      tasks: input.tasks.map((task) =>
        task.targetId === target.targetId
          ? {
              ...task,
              sourceFingerprint: target.sourceFingerprint,
              ...(task.taskId === "pilot-task-01" ? { taskDefinitionFingerprint } : {}),
            }
          : task,
      ),
    });
    await Promise.all([
      writeFile(requestPath, JSON.stringify(request), "utf8"),
      writeFile(pilotPlanPath, JSON.stringify(pilotPlan), "utf8"),
    ]);
    expect(
      await runHpiCli(
        [
          "pilot",
          "capture",
          "open",
          "--plan",
          pilotPlanPath,
          "--session-id",
          "pilot-quick-cli-session",
          "--archive-id",
          "pilot-quick-cli-archive",
          "--json",
        ],
        dependencies,
      ),
    ).toBe(0);
    io.stdout.splice(0);
    let processRequests = 0;
    const runTask6Process = async (
      processRequest: Task6PiProcessRequest,
      boundary?: Task6PiProcessBoundary,
    ): Promise<Task6PiProcessResult> => {
      processRequests += 1;
      await boundary?.beforeExternalOperation();
      await writeFile(join(processRequest.plan.cwd, "result.txt"), "READY\n", "utf8");
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["message_end", "agent_end"],
        recordCount: 2,
        stdoutDigest: `sha256:${"a".repeat(64)}`,
        stderrDigest: `sha256:${"b".repeat(64)}`,
        capturedBytes: 128,
        outputTruncated: false,
        providerUsage: fixturePiProviderUsage,
        containment:
          process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
      };
    };
    const quickArguments = [
      "pilot",
      "capture",
      "quick-task",
      "--session-id",
      "pilot-quick-cli-session",
      "--operation-id",
      "pilot-quick-cli-operation",
      "--task-id",
      "pilot-task-01",
      "--repo",
      repository,
      "--request",
      requestPath,
      "--json",
      "--allow-provider-request",
    ];

    expect(
      await runHpiCli(quickArguments, {
        ...dependencies,
        platform: "linux",
        runTask6Process,
      }),
    ).toBe(2);
    expect(processRequests).toBe(0);
    expect(io.stdout.join("\n")).toContain("PILOT_HOST_MISMATCH");
    io.stdout.splice(0);

    const exitCode = await runHpiCli(quickArguments, {
      ...dependencies,
      platform: "win32",
      runTask6Process,
    });

    expect(exitCode, [...io.stderr, ...io.stdout].join("\n")).toBe(0);
    expect(processRequests).toBe(1);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      outcome: "RECORDED",
      status: {
        counts: { taskChains: 1, runArchives: 0 },
        providerUsage: { requests: 1, tokens: 165, costMinor: 1 },
      },
    });
    expect(JSON.stringify(io.stdout)).not.toContain(root);
  });

  it.each([
    {
      requested: "FORCED_PROCESS_KILL",
      processRequest: "AFTER_AGENT_END_PROCESS_KILL",
      observed: "FORCED_PROCESS_KILL_AFTER_AGENT_END",
      timedOut: false,
    },
    {
      requested: "TERMINAL_CLOSE_SIMULATION",
      processRequest: "AFTER_AGENT_END_TERMINAL_CLOSE_SIMULATION",
      observed: "TERMINAL_CLOSE_SIMULATION_AFTER_AGENT_END",
      timedOut: false,
    },
    {
      requested: "POWER_LOSS_SIMULATION",
      processRequest: "AFTER_AGENT_END_POWER_LOSS_SIMULATION",
      observed: "POWER_LOSS_SIMULATION_AFTER_AGENT_END",
      timedOut: true,
    },
  ] as const)(
    "injects and archives the exact $requested pilot interruption",
    async ({ requested, processRequest, observed, timedOut }) => {
      const { dependencies, io, root, repository } = await createCliFixture();
      const planPath = join(root, "change-plan.json");
      const pilotPlanPath = join(root, `pilot-plan-${requested.toLowerCase()}.json`);
      const target = await targetFor(repository);
      const request = realManagedChangeRequestSchema.parse(plan(target));
      const taskIdByInterruption = {
        FORCED_PROCESS_KILL: "pilot-task-02",
        TERMINAL_CLOSE_SIMULATION: "pilot-task-06",
        POWER_LOSS_SIMULATION: "pilot-task-10",
      } as const;
      const taskId = taskIdByInterruption[requested];
      const pilotPlan = managedPilotPlanForFixture({ target, request, taskId });
      await Promise.all([
        writeFile(planPath, JSON.stringify(request), "utf8"),
        writeFile(pilotPlanPath, JSON.stringify(pilotPlan), "utf8"),
      ]);
      const processInterruptions: Task6PiProcessRequest["forcedInterruption"][] = [];
      const archiveId = `archive_cli-${requested.toLowerCase().replaceAll("_", "-")}`;
      const pilotSessionId = `pilot-cli-${requested.toLowerCase().replaceAll("_", "-")}`;
      const pilotOperationId = `capture-cli-${requested.toLowerCase().replaceAll("_", "-")}`;
      expect(
        await runHpiCli(
          [
            "pilot",
            "capture",
            "open",
            "--plan",
            pilotPlanPath,
            "--session-id",
            pilotSessionId,
            "--archive-id",
            `pilot-evidence-${requested.toLowerCase().replaceAll("_", "-")}`,
            "--json",
          ],
          dependencies,
        ),
      ).toBe(0);
      io.stdout.splice(0);
      const runTask6Process = async (
        request: Task6PiProcessRequest,
        boundary?: Task6PiProcessBoundary,
      ): Promise<Task6PiProcessResult> => {
        processInterruptions.push(request.forcedInterruption);
        await boundary?.beforeExternalOperation();
        await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
        const interrupted = request.forcedInterruption === processRequest;
        return {
          exitCode: interrupted ? 1 : 0,
          timedOut: interrupted && timedOut,
          framingValid: true,
          eventTypes: interrupted ? ["message_end"] : ["message_end", "agent_end"],
          recordCount: interrupted ? 1 : 2,
          stdoutDigest: `sha256:${"a".repeat(64)}`,
          stderrDigest: `sha256:${"b".repeat(64)}`,
          capturedBytes: 128,
          outputTruncated: false,
          providerUsage: fixturePiProviderUsage,
          ...(interrupted ? { interruption: observed } : {}),
          containment:
            process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
          terminalFinality: "FINAL",
          processTreeState: "EMPTY",
          leaseState: "RELEASED",
        };
      };

      const exitCode = await runHpiCli(
        [
          "change",
          "--repo",
          repository,
          "--plan",
          planPath,
          "--run-archive-id",
          archiveId,
          "--pilot-plan",
          pilotPlanPath,
          "--pilot-task-id",
          taskId,
          "--pilot-session-id",
          pilotSessionId,
          "--pilot-operation-id",
          pilotOperationId,
          "--pilot-interruption",
          requested,
          "--json",
          "--allow-provider-request",
        ],
        { ...dependencies, platform: "win32", runTask6Process },
      );
      expect(exitCode, io.stderr.join("\n")).toBe(0);
      expect(processInterruptions).toEqual([processRequest, undefined]);
      const artifact = realManagedChangeEvidenceSchema.parse(JSON.parse(io.stdout.join("")));
      expect(artifact.projection).toMatchObject({
        run: { lifecycle: "READY" },
        attempts: [
          { attemptId: "att_real-1" },
          {
            attemptId: "att_real-2",
            previousAttemptId: "att_real-1",
          },
        ],
      });
      expect(artifact.projection.attempts[1]?.recoveryCheckpointId).toMatch(/^checkpoint_/u);
      expect(artifact.projection.checkpoints[0]?.checkpointId).toMatch(/^checkpoint_/u);

      const paths = resolveHpiPaths({
        env: dependencies.environment,
        homeDirectory: dependencies.homeDirectory,
      });
      const managedRunRoot = join(paths.root, "pilot", "managed-runs");
      const archivePackage = await new FileRunArchiveStore({
        stateRoot: join(managedRunRoot, "archive"),
        kernel: new DurableWorkflowKernel(
          new FileWorkflowEventStore({ stateRoot: join(managedRunRoot, "workflow") }),
        ),
      }).readCanonicalPackage(archiveId);
      const taskReceiptEvidence = archivePackage.evidence.find(
        (candidate) => candidate.evidenceId === "evidence_real-task-receipt",
      );
      expect(JSON.parse(taskReceiptEvidence?.capture.capturedText ?? "null")).toMatchObject({
        schemaVersion: "hpi-real-managed-change-task-receipt.v4",
        interruptionKind: observed,
        providerUsage: { status: "PASS", requestCount: 2 },
      });
      expect(
        await runHpiCli(
          [
            "pilot",
            "capture",
            "managed-task",
            "--session-id",
            pilotSessionId,
            "--operation-id",
            pilotOperationId,
            "--task-id",
            taskId,
            "--archive-ids",
            archiveId,
            "--json",
          ],
          dependencies,
        ),
      ).toBe(0);
    },
  );

  it("rejects a pilot interruption without a durable Run Archive", async () => {
    const { dependencies, root, repository } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    const target = await targetFor(repository);
    await writeFile(planPath, JSON.stringify(plan(target)), "utf8");

    expect(
      await runHpiCli(
        [
          "change",
          "--repo",
          repository,
          "--plan",
          planPath,
          "--pilot-interruption",
          "FORCED_PROCESS_KILL",
          "--json",
          "--allow-provider-request",
        ],
        dependencies,
      ),
    ).toBe(2);
  });

  it("emits a structured STOP artifact when the declared project check is unavailable", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    const target = await targetFor(repository);
    await writeFile(
      planPath,
      JSON.stringify({
        ...plan(target),
        check: {
          label: "Unavailable project check",
          executable: "hpi-check-executable-that-does-not-exist",
          argv: ["--version"],
        },
      }),
      "utf8",
    );

    const runTask6Process = async (
      request: Task6PiProcessRequest,
      boundary?: Task6PiProcessBoundary,
    ): Promise<Task6PiProcessResult> => {
      await boundary?.beforeExternalOperation();
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: `sha256:${"a".repeat(64)}`,
        stderrDigest: `sha256:${"b".repeat(64)}`,
        capturedBytes: 128,
        outputTruncated: false,
        providerUsage: fixturePiProviderUsage,
        containment:
          process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
      };
    };

    expect(
      await runHpiCli(
        ["change", "--repo", repository, "--plan", planPath, "--json", "--allow-provider-request"],
        { ...dependencies, runTask6Process },
      ),
    ).toBe(2);
    const artifact = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v3",
      taskResult: "STOP",
      projection: {
        change: { lifecycle: "BLOCKED" },
        verificationReceipts: [{ outcome: "BLOCKED" }],
      },
    });
    expect(io.stderr.join("\n")).not.toContain("CommandStatus=INCOMPATIBLE");
  });

  it(
    "uses the qualified process and writer-lease path by default",
    { timeout: vitestResourcePolicy.managedProcessIntegrationTimeoutMs },
    async () => {
      const { dependencies, io, root, repository } = await createCliFixture();
      const planPath = join(root, "change-plan.json");
      const target = await targetFor(repository);
      await writeFile(join(root, "pi-cli.js"), qualifiedPiSuccessScript, "utf8");
      await writeFile(planPath, JSON.stringify(plan(target)), "utf8");

      expect(
        await runHpiCli(
          [
            "change",
            "--repo",
            repository,
            "--plan",
            planPath,
            "--json",
            "--allow-provider-request",
          ],
          dependencies,
        ),
      ).toBe(0);
      const artifact = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        schemaVersion: "hpi-managed-change.v3",
        taskResult: "GO",
        writerLease: { acquireOutcome: "ACQUIRED", releaseOutcome: "RELEASED" },
      });
      expect(JSON.stringify(artifact)).toMatch(
        /containment=(?:WINDOWS_JOB_OBJECT|LINUX_SUBREAPER_PROCESS_TREE)/u,
      );
      expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
    },
  );
});
