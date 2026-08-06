import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHpiCli, type HpiCliDependencies, type HpiCliIo } from "@hunter-pi/cli";
import {
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  resolveHpiPaths,
  saveHpiConfiguration,
  type Task6PiProcessRequest,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];
const coreSource = "export default () => {};\n";
const coreIntegrity = `sha256:${createHash("sha256").update(coreSource).digest("hex")}`;

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
  const sourceCommit = "d".repeat(40);
  const dependencies: HpiCliDependencies = {
    cwd: repository,
    environment: { HUNTER_PI_HOME: join(root, "profile") },
    homeDirectory: root,
    io,
    now: () => "2026-08-06T00:00:10.000Z",
    inspectRepository: (target) =>
      Promise.resolve({ root: target, name: "repository", branch: "main", dirty: false }),
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
  await writeFile(join(root, "core-extension.js"), coreSource, "utf8");
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

function plan(): Record<string, unknown> {
  return {
    schemaVersion: "hpi-managed-change-request.v1",
    title: "Make the CLI project check pass",
    goal: "Change result.txt so the declared project check passes.",
    nonGoals: ["Commit, push, publish, or deploy"],
    constraints: ["Only result.txt may change"],
    allowedPaths: ["result.txt"],
    check: { label: "Project result check", executable: "node", argv: ["verify.mjs"] },
  };
}

describe("hpi change command", () => {
  it("requires explicit Provider authorization before it can inspect or run a target", async () => {
    const { dependencies, io, root } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    await writeFile(planPath, JSON.stringify(plan()), "utf8");

    expect(
      await runHpiCli(["change", "--repo", root, "--plan", planPath, "--json"], dependencies),
    ).toBe(2);
    expect(io.stderr.join("\n")).toContain("PROVIDER_REQUEST_NOT_AUTHORIZED");
    expect(io.stderr.join("\n")).not.toContain(root);
  });

  it("runs an explicitly scoped real-project change and emits portable Evidence", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    await writeFile(planPath, JSON.stringify(plan()), "utf8");
    let processRequests = 0;
    const runTask6Process = async (
      request: Task6PiProcessRequest,
    ): Promise<Task6PiProcessResult> => {
      processRequests += 1;
      expect(request.plan.environment["HUNTER_PI_MODE"]).toBe("MANAGED");
      expect(request.plan.environment["HUNTER_PI_PERMISSION_PROFILE"]).toBe("FULL_ACCESS");
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
      };
    };

    expect(
      await runHpiCli(
        ["change", "--repo", repository, "--plan", planPath, "--json", "--allow-provider-request"],
        { ...dependencies, runTask6Process },
      ),
    ).toBe(0);
    expect(processRequests).toBe(1);
    const artifact = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v1",
      taskResult: "GO",
      repository: { scope: "EXPLICIT_OPERATOR_SELECTED" },
      cleanup: { status: "NOT_APPLICABLE", targetWorkingTree: "PRESERVED_CHANGED" },
    });
    expect(JSON.stringify(artifact)).not.toContain(root);
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
  });

  it("uses the qualified process and writer-lease path by default", async () => {
    const { dependencies, io, root, repository } = await createCliFixture();
    const planPath = join(root, "change-plan.json");
    await writeFile(
      join(root, "pi-cli.js"),
      "const fs = require('node:fs');\nfs.writeFileSync('result.txt', 'READY\\n');\nprocess.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');\n",
      "utf8",
    );
    await writeFile(planPath, JSON.stringify(plan()), "utf8");

    expect(
      await runHpiCli(
        ["change", "--repo", repository, "--plan", planPath, "--json", "--allow-provider-request"],
        dependencies,
      ),
    ).toBe(0);
    const artifact = JSON.parse(io.stdout.join("")) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: "hpi-managed-change.v1",
      taskResult: "GO",
      writerLease: { acquireOutcome: "ACQUIRED", releaseOutcome: "RELEASED" },
    });
    expect(JSON.stringify(artifact)).toMatch(
      /containment=(?:WINDOWS_JOB_OBJECT|LINUX_SUBREAPER_PROCESS_TREE)/u,
    );
    expect(await readFile(join(repository, "result.txt"), "utf8")).toBe("READY\n");
  }, 30_000);
});
