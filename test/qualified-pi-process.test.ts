import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  QualifiedPiProcessBlockedError,
  createQualifiedPiJsonProcess,
  runTask6PiJsonProcess,
  type Task6PiProcessResult,
} from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const validUsage = {
  input: 120,
  output: 30,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 165,
  cost: {
    input: 0.0012,
    output: 0.0006,
    cacheRead: 0.0001,
    cacheWrite: 0.00005,
    total: 0.00195,
  },
};

async function runRecords(
  records: readonly Record<string, unknown>[],
): Promise<Task6PiProcessResult> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-qualified-process-");
  cleanupRoots.push(root);
  const workspace = join(root, "workspace");
  const leaseRoot = join(root, "leases");
  await Promise.all([mkdir(workspace), mkdir(leaseRoot)]);

  const runProcess = await createQualifiedPiJsonProcess({
    leaseRoot,
    now: () => "2026-08-06T00:00:10.000Z",
  });
  const script = `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record)+'\\n')`;
  return runProcess({
    plan: {
      executable: process.execPath,
      arguments: ["-e", script, "--"],
      cwd: workspace,
      environment: { HUNTER_PI_MODE: "MANAGED" },
    },
    prompt: "Apply the bounded fixture change.",
    timeoutMs: 30_000,
    maximumOutputBytes: 32_768,
  });
}

describe("qualified Pi JSON process runner", () => {
  it("does not trust Provider usage until hidden transport retries are proven disabled", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-unqualified-process-");
    cleanupRoots.push(root);
    const records = [
      { type: "message_end", message: { role: "assistant", usage: validUsage } },
      { type: "agent_end" },
    ];
    const script = `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record)+'\\n')`;
    const result = await runTask6PiJsonProcess({
      plan: {
        executable: process.execPath,
        arguments: ["-e", script, "--"],
        cwd: root,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      },
      prompt: "Apply the bounded fixture change.",
      timeoutMs: 30_000,
      maximumOutputBytes: 32_768,
    });

    expect(result.providerUsage).toEqual({
      status: "NOT_PROVEN",
      requestCount: null,
      tokenCount: null,
      costMinorUnits: null,
      reasons: ["PROVIDER_RETRY_POLICY_NOT_PROVEN"],
    });
  });

  it("uses the Task 7 managed process host and returns final containment facts", async () => {
    const result = await runRecords([
      { type: "message_end", message: { role: "assistant", usage: validUsage } },
      { type: "agent_end" },
    ]);

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      framingValid: true,
      eventTypes: ["message_end", "agent_end"],
      providerUsage: {
        status: "PASS",
        requestCount: 1,
        tokenCount: 165,
        costMinorUnits: 1,
        reasons: [],
      },
      containment:
        process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
      terminalFinality: "FINAL",
      processTreeState: "EMPTY",
      leaseState: "RELEASED",
    });
  });

  it("fails closed when the Provider token total disagrees with its components", async () => {
    const result = await runRecords([
      {
        type: "message_end",
        message: { role: "assistant", usage: { ...validUsage, totalTokens: 166 } },
      },
      { type: "agent_end" },
    ]);

    expect(result.providerUsage).toEqual({
      status: "NOT_PROVEN",
      requestCount: null,
      tokenCount: null,
      costMinorUnits: null,
      reasons: ["USAGE_TOTAL_MISMATCH"],
    });
  });

  it("fails closed when the Provider cost total disagrees with its components", async () => {
    const result = await runRecords([
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: { ...validUsage, cost: { ...validUsage.cost, total: 0 } },
        },
      },
      { type: "agent_end" },
    ]);

    expect(result.providerUsage).toEqual({
      status: "NOT_PROVEN",
      requestCount: null,
      tokenCount: null,
      costMinorUnits: null,
      reasons: ["USAGE_COST_MISMATCH"],
    });
  });

  it("fails closed unless agent_end terminates the complete event stream", async () => {
    const result = await runRecords([
      { type: "agent_end" },
      { type: "message_end", message: { role: "assistant", usage: validUsage } },
    ]);

    expect(result.providerUsage).toEqual({
      status: "NOT_PROVEN",
      requestCount: null,
      tokenCount: null,
      costMinorUnits: null,
      reasons: ["EVENT_STREAM_INCOMPLETE"],
    });
  });

  it("uses an isolated runtime snapshot with hidden Provider and Agent retries disabled", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-qualified-retry-");
    cleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const leaseRoot = join(root, "leases");
    const agentDirectory = join(root, "agent");
    const observationPath = join(root, "observed-settings.json");
    await Promise.all([mkdir(workspace), mkdir(leaseRoot), mkdir(agentDirectory)]);
    const sourceSettings = {
      retry: {
        enabled: true,
        maxRetries: 3,
        provider: { maxRetries: 4, maxRetryDelayMs: 60_000 },
      },
      compaction: { enabled: true },
      transport: "sse",
    };
    await writeFile(
      join(agentDirectory, "settings.json"),
      `${JSON.stringify(sourceSettings)}\n`,
      "utf8",
    );
    await Promise.all([
      writeFile(join(agentDirectory, "auth.json"), '{"fixture":"auth"}\n', "utf8"),
      writeFile(join(agentDirectory, "models.json"), '{"fixture":"models"}\n', "utf8"),
    ]);
    const runProcess = await createQualifiedPiJsonProcess({
      leaseRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    const records = [
      { type: "message_end", message: { role: "assistant", usage: validUsage } },
      { type: "agent_end" },
    ];
    const script = [
      "const fs=process.getBuiltinModule('node:fs')",
      "const path=process.getBuiltinModule('node:path')",
      "const dir=process.env.PI_CODING_AGENT_DIR",
      `fs.writeFileSync(${JSON.stringify(observationPath)},JSON.stringify({settings:JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')),auth:JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8')),models:JSON.parse(fs.readFileSync(path.join(dir,'models.json'),'utf8'))}))`,
      `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record)+'\\n')`,
    ].join(";");

    const result = await runProcess({
      plan: {
        executable: process.execPath,
        arguments: ["-e", script, "--"],
        cwd: workspace,
        environment: {
          HUNTER_PI_MODE: "MANAGED",
          PI_CODING_AGENT_DIR: agentDirectory,
        },
      },
      prompt: "Apply the bounded fixture change.",
      timeoutMs: 30_000,
      maximumOutputBytes: 32_768,
    });

    expect(result.providerUsage.status).toBe("PASS");
    expect(JSON.parse(await readFile(observationPath, "utf8"))).toEqual({
      settings: {
        retry: {
          enabled: false,
          maxRetries: 0,
          provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
        },
        compaction: { enabled: false },
        transport: "sse",
      },
      auth: { fixture: "auth" },
      models: { fixture: "models" },
    });
    expect(JSON.parse(await readFile(join(agentDirectory, "settings.json"), "utf8"))).toEqual(
      sourceSettings,
    );
    expect(await readdir(join(root, "pi-runtime-snapshots"))).toEqual([]);
  });

  it("normalizes runtime configuration failures without leaking paths and releases the process lease", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-qualified-config-");
    cleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const leaseRoot = join(root, "leases");
    await Promise.all([mkdir(workspace), mkdir(leaseRoot)]);
    const runProcess = await createQualifiedPiJsonProcess({
      leaseRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    const records = [
      { type: "message_end", message: { role: "assistant", usage: validUsage } },
      { type: "agent_end" },
    ];
    const script = `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record)+'\\n')`;
    const request = {
      plan: {
        executable: process.execPath,
        arguments: ["-e", script, "--"],
        cwd: workspace,
        environment: {
          HUNTER_PI_MODE: "MANAGED",
          PI_CODING_AGENT_DIR: join(root, "missing-private-agent-directory"),
        },
      },
      prompt: "Apply the bounded fixture change.",
      timeoutMs: 30_000,
      maximumOutputBytes: 32_768,
    };

    let failure: unknown;
    try {
      await runProcess(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(QualifiedPiProcessBlockedError);
    expect(failure).toMatchObject({ reason: "RUNTIME_CONFIGURATION_NOT_PROVEN" });
    expect((failure as Error).message).not.toContain(root);

    const recovered = await runProcess({
      ...request,
      plan: { ...request.plan, environment: { HUNTER_PI_MODE: "MANAGED" } },
    });
    expect(recovered.providerUsage.status).toBe("PASS");
  });

  it("does not double count assistant messages repeated inside agent_end", async () => {
    const result = await runRecords([
      {
        type: "agent_end",
        messages: [{ role: "assistant", usage: validUsage }],
      },
    ]);

    expect(result.providerUsage).toEqual({
      status: "NOT_PROVEN",
      requestCount: null,
      tokenCount: null,
      costMinorUnits: null,
      reasons: ["ASSISTANT_USAGE_MISSING"],
    });
  });
});
