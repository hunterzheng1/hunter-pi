import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineHost } from "@hunter-pi/engine-contracts";
import { createFileLeaseManager, type LeaseManager } from "@hunter-pi/execution";
import { realManagedChangeRequestSchema, runRealManagedChange } from "@hunter-pi/managed-change";
import { Task6PiEngineHost } from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];
const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runGit(repository: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Git fixture command failed: ${arguments_.join(" ")}`);
  }
  return result.stdout;
}

async function createRepository(): Promise<{ readonly root: string; readonly repository: string }> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-real-change-");
  cleanupRoots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository);
  runGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  runGit(repository, ["config", "user.name", "Hunter Pi Test"]);
  runGit(repository, ["config", "user.email", "hunter-pi-test@example.invalid"]);
  await writeFile(join(repository, "result.txt"), "NOT_READY\n", "utf8");
  await writeFile(
    join(repository, "verify.mjs"),
    "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('result.txt', 'utf8') === 'READY\\n' ? 0 : 1);\n",
    "utf8",
  );
  runGit(repository, ["add", "--", "result.txt", "verify.mjs"]);
  runGit(repository, ["commit", "--quiet", "-m", "Initialize real-project fixture"]);
  return { root, repository };
}

async function createWriterLease(root: string): Promise<{
  readonly manager: LeaseManager;
  readonly ownerFingerprint: typeof fingerprintB;
}> {
  const leaseRoot = join(root, "leases");
  await mkdir(leaseRoot);
  return {
    manager: await createFileLeaseManager({ leaseRoot }),
    ownerFingerprint: fingerprintB,
  };
}

function createMutationHost(
  extraMutation?: (workspace: string) => Promise<void>,
  beforeMutation?: () => Promise<void>,
): EngineHost {
  return new Task6PiEngineHost({
    launchPlanForWorkspace: (workspace) =>
      Promise.resolve({
        executable: process.execPath,
        arguments: ["pi-cli.js"],
        cwd: workspace,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      }),
    runProcess: async (request) => {
      await beforeMutation?.();
      await writeFile(join(request.plan.cwd, "result.txt"), "READY\n", "utf8");
      await extraMutation?.(request.plan.cwd);
      return {
        exitCode: 0,
        timedOut: false,
        framingValid: true,
        eventTypes: ["agent_start", "tool_execution_start", "agent_end"],
        recordCount: 3,
        stdoutDigest: fingerprintA,
        stderrDigest: fingerprintB,
        capturedBytes: 128,
        outputTruncated: false,
        containment:
          process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
      };
    },
    now: () => "2026-08-06T00:00:10.000Z",
    processTimeoutMs: 30_000,
    maximumOutputBytes: 229_376,
    requireQualifiedProcess: true,
  });
}

describe("real-project Managed Change runner", () => {
  it("rejects control characters in the independent check definition", () => {
    expect(
      realManagedChangeRequestSchema.safeParse({
        schemaVersion: "hpi-managed-change-request.v1",
        title: "Reject control characters",
        goal: "The declared check must be terminal-safe.",
        nonGoals: [],
        constraints: [],
        allowedPaths: ["result.txt"],
        check: {
          label: "Project result check",
          executable: "node",
          argv: ["verify.mjs\n"],
        },
      }).success,
    ).toBe(false);
  });

  it("runs against an explicitly selected Git repository, verifies the result, and leaves the change for review", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v1",
      title: "Make the real-project check pass",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: ["Commit, push, publish, or deploy"],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: {
        label: "Project result check",
        executable: "node",
        argv: ["verify.mjs"],
      },
    });

    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      now: () => "2026-08-06T00:00:10.000Z",
      monotonicNow: (() => {
        let value = 0;
        return () => ++value;
      })(),
    });

    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v1",
      taskResult: "GO",
      repository: { scope: "EXPLICIT_OPERATOR_SELECTED" },
      productSource: { state: "CLEAN" },
      provider: { id: "openai-codex", requestStatus: "DETECTED" },
      cleanup: { status: "NOT_APPLICABLE" },
    });
    expect(artifact.projection.change.lifecycle).toBe("READY");
    expect(artifact.review.changedPaths).toEqual(["result.txt"]);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(runGit(repository, ["status", "--porcelain=v1"]).trim()).toBe("M result.txt");
  });

  it("blocks a concurrent Managed Change on the same physical repository before a second Provider send", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    let markProviderStarted = (): void => undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let releaseFirstProvider = (): void => undefined;
    const firstProviderStarted = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v1",
      title: "Hold the selected repository change",
      goal: "Change result.txt so the declared project check passes.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
    });
    const first = runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost(undefined, async () => {
        markProviderStarted();
        await firstProviderStarted;
      }),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });
    await providerStarted;

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: createMutationHost(),
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: fingerprintA,
      }),
    ).rejects.toThrow(/WORKSPACE_BUSY/u);

    releaseFirstProvider();
    await expect(first).resolves.toMatchObject({ taskResult: "GO" });
  });

  it("fails closed before the Provider operation when the explicitly selected repository is dirty", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    await writeFile(join(repository, "unrelated.txt"), "operator work\n", "utf8");
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v1",
      title: "Should not run on dirty source",
      goal: "Make the declared project check pass.",
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
    });
    let providerOperationStarted = false;
    const host = createMutationHost();
    const guardedHost: EngineHost = {
      probe: (input) => host.probe(input),
      start: (input) => host.start(input),
      send: async (...args) => {
        providerOperationStarted = true;
        return host.send(...args);
      },
      observe: (handle, cursor) => host.observe(handle, cursor),
      interrupt: (handle, input) => host.interrupt(handle, input),
      checkpoint: (handle, input) => host.checkpoint(handle, input),
      reconcile: (input) => host.reconcile(input),
      close: (handle, input) => host.close(handle, input),
    };

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: guardedHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/DIRTY_WORKTREE/u);
    expect(providerOperationStarted).toBe(false);
  });

  it("returns STOP when the Agent changes a path outside the explicit allowed scope", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v1",
      title: "Reject an out-of-scope mutation",
      goal: "Make the declared project check pass.",
      nonGoals: [],
      constraints: ["Only result.txt may change"],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
    });
    const artifact = await runRealManagedChange({
      repository,
      request,
      engineHost: createMutationHost((workspace) =>
        writeFile(join(workspace, "unexpected.txt"), "unexpected\n", "utf8"),
      ),
      providerAuthConfigured: true,
      productSource: { commit: "c".repeat(40), state: "CLEAN" },
      engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
      providerId: "openai-codex",
      environmentFingerprint: fingerprintA,
      writerLeaseManager: writerLease.manager,
      writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
    });

    expect(artifact.taskResult).toBe("STOP");
    expect(artifact.projection.change.lifecycle).toBe("REVIEWING");
    expect(artifact.review.findings).toMatchObject([
      { severity: "P1", scope: "workspace-out-of-scope-paths" },
    ]);
    expect(JSON.stringify(artifact)).not.toContain(root);
  });

  it("refuses private path material in a plan before starting the Agent", async () => {
    const { root, repository } = await createRepository();
    const writerLease = await createWriterLease(root);
    const request = realManagedChangeRequestSchema.parse({
      schemaVersion: "hpi-managed-change-request.v1",
      title: "Private path must not enter the plan",
      goal: `Do not echo ${repository} in the Provider prompt.`,
      nonGoals: [],
      constraints: [],
      allowedPaths: ["result.txt"],
      check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
    });
    let started = false;
    const host = createMutationHost();
    const guardedHost: EngineHost = {
      probe: (input) => host.probe(input),
      start: async (input) => {
        started = true;
        return host.start(input);
      },
      send: (handle, input) => host.send(handle, input),
      observe: (handle, cursor) => host.observe(handle, cursor),
      interrupt: (handle, input) => host.interrupt(handle, input),
      checkpoint: (handle, input) => host.checkpoint(handle, input),
      reconcile: (input) => host.reconcile(input),
      close: (handle, input) => host.close(handle, input),
    };

    await expect(
      runRealManagedChange({
        repository,
        request,
        engineHost: guardedHost,
        providerAuthConfigured: true,
        productSource: { commit: "c".repeat(40), state: "CLEAN" },
        engineRelease: { packageName: "@earendil-works/pi-coding-agent", version: "0.83.0" },
        providerId: "openai-codex",
        environmentFingerprint: fingerprintA,
        writerLeaseManager: writerLease.manager,
        writerLeaseOwnerFingerprint: writerLease.ownerFingerprint,
      }),
    ).rejects.toThrow(/PLAN_CONTENT_NOT_PORTABLE/u);
    expect(started).toBe(false);
    expect(request.goal).toContain(repository);
  });
});
