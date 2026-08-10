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

  it.each([
    ["AFTER_AGENT_END_PROCESS_KILL", "FORCED_PROCESS_KILL_AFTER_AGENT_END", false],
    [
      "AFTER_AGENT_END_TERMINAL_CLOSE_SIMULATION",
      "TERMINAL_CLOSE_SIMULATION_AFTER_AGENT_END",
      false,
    ],
    ["AFTER_AGENT_END_POWER_LOSS_SIMULATION", "POWER_LOSS_SIMULATION_AFTER_AGENT_END", true],
  ] as const)(
    "finalizes the qualified Pi tree for %s and retains exact usage",
    async (forcedInterruption, expectedInterruption, expectedTimedOut) => {
      const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-qualified-interrupt-");
      cleanupRoots.push(root);
      const workspace = join(root, "workspace");
      const leaseRoot = join(root, "leases");
      await Promise.all([mkdir(workspace), mkdir(leaseRoot)]);
      const runProcess = await createQualifiedPiJsonProcess({ leaseRoot });
      const script = [
        "const fs=process.getBuiltinModule('node:fs')",
        `process.stdout.write(JSON.stringify(${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", usage: validUsage },
        })})+'\\n')`,
        "process.stderr.write('HPI_AGENT_END_MARKER:'+process.env.HUNTER_PI_INTERRUPTION_NONCE+'\\n')",
        "setInterval(()=>{},1000)",
      ].join(";");

      const result = await runProcess({
        plan: {
          executable: process.execPath,
          arguments: ["-e", script, "--"],
          cwd: workspace,
          environment: {},
        },
        prompt: "Apply the bounded fixture change.",
        timeoutMs: 30_000,
        maximumOutputBytes: 32_768,
        forcedInterruption,
      });

      expect(result).toMatchObject({
        interruption: expectedInterruption,
        timedOut: expectedTimedOut,
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        leaseState: "RELEASED",
        providerUsage: {
          status: "PASS",
          requestCount: 1,
          tokenCount: 165,
          costMinorUnits: 1,
        },
      });
      expect(result.eventTypes).toEqual(["message_end"]);
    },
  );

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
      writeFile(
        join(agentDirectory, "auth.json"),
        JSON.stringify({
          "fixture-provider": { type: "api_key", key: "selected-secret" },
          "unrelated-provider": { type: "api_key", key: "must-not-copy" },
        }),
        "utf8",
      ),
      writeFile(
        join(agentDirectory, "models.json"),
        JSON.stringify({
          providers: {
            "fixture-provider": { baseUrl: "https://selected.example", models: [] },
            "unrelated-provider": { baseUrl: "https://unrelated.example", models: [] },
          },
        }),
        "utf8",
      ),
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
      `fs.writeFileSync(${JSON.stringify(observationPath)},JSON.stringify({settings:JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')),auth:JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8')),models:JSON.parse(fs.readFileSync(path.join(dir,'models.json'),'utf8')),ambientSecret:process.env.HPI_AMBIENT_SECRET_FOR_TEST??null,credentialedHttpProxy:process.env.HTTP_PROXY??null,credentialedHttpsProxy:process.env.HTTPS_PROXY??null,noProxy:process.env.NO_PROXY??null}))`,
      `for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record)+'\\n')`,
    ].join(";");

    const previousHttpProxy = process.env["HTTP_PROXY"];
    process.env["HPI_AMBIENT_SECRET_FOR_TEST"] = "must-not-inherit";
    process.env["HTTP_PROXY"] = "http://proxy-user:proxy-password@proxy.example:8080";
    let result;
    try {
      result = await runProcess({
        plan: {
          executable: process.execPath,
          arguments: ["-e", script, "--", "--provider", "fixture-provider"],
          cwd: workspace,
          environment: {
            HUNTER_PI_MODE: "MANAGED",
            PI_CODING_AGENT_DIR: agentDirectory,
            HTTPS_PROXY: "https://proxy-user:proxy-password@proxy.example:8443",
            NO_PROXY: "localhost,127.0.0.1",
          },
        },
        prompt: "Apply the bounded fixture change.",
        timeoutMs: 30_000,
        maximumOutputBytes: 32_768,
      });
    } finally {
      delete process.env["HPI_AMBIENT_SECRET_FOR_TEST"];
      if (previousHttpProxy === undefined) delete process.env["HTTP_PROXY"];
      else process.env["HTTP_PROXY"] = previousHttpProxy;
    }

    expect(result.providerUsage.status).toBe("PASS");
    expect(JSON.parse(await readFile(observationPath, "utf8"))).toEqual({
      settings: {
        retry: {
          enabled: false,
          maxRetries: 0,
          provider: { maxRetries: 0 },
        },
        compaction: { enabled: false },
      },
      auth: { "fixture-provider": { type: "api_key", key: "selected-secret" } },
      models: {
        providers: {
          "fixture-provider": { baseUrl: "https://selected.example", models: [] },
        },
      },
      ambientSecret: null,
      credentialedHttpProxy: null,
      credentialedHttpsProxy: null,
      noProxy: "localhost,127.0.0.1",
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
