import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileLeaseManager,
  createLocalManagedProcessHost,
  managedProcessCancelRequestSchema,
  managedProcessSessionIdSchema,
  managedProcessStartRequestSchema,
  type ManagedProcessHost,
} from "@hunter-pi/execution";
import { LinuxSubreaperProcessTreeDriver } from "../packages/execution/src/posix-process-group-driver.js";
import {
  linuxPidfdSignalSource,
  linuxSubreaperProcessTreeHelperSource,
} from "../packages/execution/src/posix-process-group-helper-source.js";
import { windowsJobHelperSource } from "../packages/execution/src/windows-job-helper-source.js";
import { WindowsJobObjectDriver } from "../packages/execution/src/windows-job-driver.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createFixture(): Promise<{
  readonly cwd: string;
  readonly host: ManagedProcessHost;
}> {
  const parent = await createTemporaryTestDirectory(tmpdir(), "hpi-t7-platform-");
  cleanupRoots.push(parent);
  const cwd = join(parent, "working directory 测试");
  const leaseRoot = join(parent, "lease state");
  await Promise.all([mkdir(cwd), mkdir(leaseRoot)]);
  const leaseManager = await createFileLeaseManager({ leaseRoot });
  return {
    cwd,
    host: createLocalManagedProcessHost({ leaseManager }),
  };
}

function startRequest(
  cwd: string,
  argv: readonly string[],
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
) {
  const windowsSystemEnvironment =
    process.platform === "win32" && process.env["SystemRoot"] !== undefined
      ? { SystemRoot: process.env["SystemRoot"] }
      : {};
  return managedProcessStartRequestSchema.parse({
    schemaVersion: "hpi-process-start.v1" as const,
    operationId: "op_platform-start",
    operationFingerprint: fingerprint("operation:platform-start"),
    sessionId: "process_task7-platform" as const,
    executable: process.execPath,
    argv: [...argv],
    cwd,
    environment: { HPI_FIXTURE: "SAFE VALUE", ...windowsSystemEnvironment },
    timeoutMs: options.timeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
    leases: [],
  });
}

const supportedPlatform = process.platform === "win32" || process.platform === "linux";
const sessionId = managedProcessSessionIdSchema.parse("process_task7-platform");

async function readText(host: ManagedProcessHost): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly receipt: Awaited<ReturnType<ManagedProcessHost["read"]>>["receipt"];
}> {
  const log = await host.read({
    schemaVersion: "hpi-process-log-read.v1",
    sessionId,
    cursor: 0,
    maxBytes: 1_048_576,
  });
  const text = (stream: "STDOUT" | "STDERR") =>
    log.chunks
      .filter((chunk) => chunk.stream === stream)
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64"))
      .reduce((left, right) => Buffer.concat([left, right]), Buffer.alloc(0))
      .toString("utf8");
  return { stdout: text("STDOUT"), stderr: text("STDERR"), receipt: log.receipt };
}

async function waitUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref();
    });
  }
  throw new Error("timed out waiting for managed process fixture observation");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function nestedProcessSource(): string {
  const grandchild = "setInterval(() => {}, 1000);";
  const child = [
    "const { spawn } = require('node:child_process');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });`,
    "process.stdout.write(`CHILD:${process.pid}:${grandchild.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });`,
    "process.stdout.write(`ROOT:${process.pid}:${child.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

async function waitForNestedPids(host: ManagedProcessHost): Promise<number[]> {
  return waitUntil(async () => {
    const { stdout } = await readText(host);
    const root = /ROOT:(\d+):(\d+)/u.exec(stdout);
    const child = /CHILD:(\d+):(\d+)/u.exec(stdout);
    if (root === null || child === null) return undefined;
    return [...new Set([root[1], root[2], child[1], child[2]].map(Number))];
  });
}

describe.runIf(supportedPlatform)("local managed process platform", () => {
  it("preserves Unicode paths and structured argv without shell reconstruction", async () => {
    const fixture = await createFixture();
    const argumentsToPreserve = [
      "alpha beta",
      'quote"value',
      "trailing\\",
      "literal&pipe|redirect<none>",
      "参数-测试",
    ];
    const target = [
      "const payload = {",
      "  argv: process.argv.slice(1),",
      "  cwd: process.cwd(),",
      "  environment: process.env.HPI_FIXTURE,",
      "};",
      "process.stdout.write(JSON.stringify(payload));",
      "process.stderr.write('stderr-✓');",
    ].join("\n");

    const started = await fixture.host.start(
      startRequest(fixture.cwd, ["-e", target, "--", ...argumentsToPreserve]),
    );
    expect(started.receipt).toMatchObject({
      containment:
        process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
      terminalFinality: "PENDING",
    });
    expect(JSON.stringify(started.receipt)).not.toContain(fixture.cwd);
    expect(JSON.stringify(started.receipt)).not.toContain(argumentsToPreserve[4]);

    const final = await fixture.host.awaitFinal(sessionId);
    const { stdout, stderr, receipt: logReceipt } = await readText(fixture.host);
    expect(stderr).toBe("stderr-✓");
    expect(JSON.parse(stdout)).toEqual({
      argv: argumentsToPreserve,
      cwd: fixture.cwd,
      environment: "SAFE VALUE",
    });
    expect(logReceipt).toMatchObject({ eof: true, truncated: false });
    expect(final.receipt).toMatchObject({
      executionObservation: "EXITED",
      exitCode: 0,
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      terminalFinality: "FINAL",
      reasonCodes: [],
    });
  }, 15_000);

  it("cancels an owned nested child and grandchild as one contained tree", async () => {
    const fixture = await createFixture();
    await fixture.host.start(startRequest(fixture.cwd, ["-e", nestedProcessSource()]));
    const pids = await waitForNestedPids(fixture.host);

    const cancelled = await fixture.host.cancel(
      managedProcessCancelRequestSchema.parse({
        schemaVersion: "hpi-process-cancel.v1",
        operationId: "op_platform-cancel",
        operationFingerprint: fingerprint("operation:platform-cancel"),
        sessionId,
        reason: "USER_REQUEST",
      }),
    );
    expect(cancelled.receipt).toMatchObject({
      outcome: "ACKNOWLEDGED",
      identityState: "MATCH",
      terminationAcknowledged: true,
      terminalFinality: "PENDING",
    });
    const final = await fixture.host.awaitFinal(sessionId);
    expect(final.receipt).toMatchObject({
      executionObservation: "CANCELLED",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      terminalFinality: "FINAL",
      reasonCodes: [],
    });
    expect(pids).toHaveLength(3);
    expect(pids.every((pid) => !isProcessAlive(pid))).toBe(true);
  });

  it("times out and reconciles the exact nested process tree", async () => {
    const fixture = await createFixture();
    await fixture.host.start(
      startRequest(fixture.cwd, ["-e", nestedProcessSource()], { timeoutMs: 750 }),
    );
    const pids = await waitForNestedPids(fixture.host);
    const final = await fixture.host.awaitFinal(sessionId);
    expect(final.receipt).toMatchObject({
      executionObservation: "TIMED_OUT",
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      terminalFinality: "FINAL",
      reasonCodes: [],
    });
    expect(pids.every((pid) => !isProcessAlive(pid))).toBe(true);
  });

  it("keeps finality pending while a descendant holds inherited output handles", async () => {
    const fixture = await createFixture();
    const child = [
      "process.stdout.write('child-started\\n');",
      "setTimeout(() => {",
      "  process.stdout.write('child-finished');",
      "}, 2000);",
    ].join("\n");
    const detachDescendant = process.platform === "win32";
    const root = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: ${String(detachDescendant)}, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });`,
      "child.once('error', () => { process.stderr.write('CHILD_SPAWN_FAILED'); process.exit(2); });",
      "child.once('spawn', () => {",
      "  setTimeout(() => {",
      "    process.stdout.write('root-exited\\n', () => process.exit(0));",
      "  }, 500);",
      "});",
    ].join("\n");
    await fixture.host.start(startRequest(fixture.cwd, ["-e", root]));

    const pending = await waitUntil(async () => {
      const heartbeat = await fixture.host.heartbeat(sessionId);
      return heartbeat.receipt.state === "EXITED" &&
        heartbeat.receipt.processTreeState === "ACTIVE" &&
        heartbeat.receipt.outputState === "OPEN"
        ? heartbeat.receipt
        : undefined;
    });
    expect(pending).toMatchObject({ terminalFinality: "PENDING" });
    const finalPromise = fixture.host.awaitFinal(sessionId);
    const early = await Promise.race([
      finalPromise.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => {
        const timer = setTimeout(() => {
          resolve("pending");
        }, 100);
        timer.unref();
      }),
    ]);
    expect(early).toBe("pending");
    const final = await finalPromise;
    expect(final).toMatchObject({
      receipt: {
        executionObservation: "EXITED",
        processTreeState: "EMPTY",
        outputState: "CLOSED",
        terminalFinality: "FINAL",
      },
    });
    const delayedOutput = await readText(fixture.host);
    expect(delayedOutput.stderr).toBe("");
    expect(final.receipt.exitCode).toBe(0);
    expect(delayedOutput).toMatchObject({
      stdout: "child-started\nroot-exited\nchild-finished",
    });
  }, 12_000);

  it("keeps a detached closed-stdio descendant inside the reconciled process tree", async () => {
    const fixture = await createFixture();
    const releasePath = join(fixture.cwd, "release-detached-child");
    const child = [
      "const { existsSync } = require('node:fs');",
      `const releasePath = ${JSON.stringify(releasePath)};`,
      "const deadline = Date.now() + 10000;",
      "const waitForRelease = () => {",
      "  if (existsSync(releasePath)) process.exit(0);",
      "  if (Date.now() >= deadline) process.exit(3);",
      "  setTimeout(waitForRelease, 25);",
      "};",
      "waitForRelease();",
    ].join("\n");
    const root = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, env: process.env, stdio: 'ignore' });`,
      "child.once('error', () => { process.stderr.write('CHILD_SPAWN_FAILED'); process.exit(2); });",
      "child.once('spawn', () => {",
      "  child.unref();",
      "  process.stdout.write(`DETACHED:${child.pid}\\n`, () => process.exit(0));",
      "});",
    ].join("\n");
    await fixture.host.start(startRequest(fixture.cwd, ["-e", root]));
    const detachedPid = await waitUntil(async () => {
      const { stdout } = await readText(fixture.host);
      const match = /DETACHED:(\d+)/u.exec(stdout);
      return match?.[1] === undefined ? undefined : Number(match[1]);
    });

    try {
      const pending = await waitUntil(async () => {
        const heartbeat = await fixture.host.heartbeat(sessionId);
        return heartbeat.receipt.state === "EXITED" &&
          heartbeat.receipt.processTreeState === "ACTIVE" &&
          heartbeat.receipt.outputState === "CLOSED" &&
          heartbeat.receipt.terminalFinality === "PENDING" &&
          isProcessAlive(detachedPid)
          ? heartbeat.receipt
          : undefined;
      });
      expect(pending).toMatchObject({
        state: "EXITED",
        processTreeState: "ACTIVE",
        outputState: "CLOSED",
        terminalFinality: "PENDING",
      });
      const finalPromise = fixture.host.awaitFinal(sessionId);
      await writeFile(releasePath, "RELEASE\n", "utf8");
      await expect(finalPromise).resolves.toMatchObject({
        receipt: {
          executionObservation: "EXITED",
          exitCode: 0,
          processTreeState: "EMPTY",
          outputState: "CLOSED",
          terminalFinality: "FINAL",
        },
      });
      expect(isProcessAlive(detachedPid)).toBe(false);
    } finally {
      await writeFile(releasePath, "RELEASE\n", "utf8").catch(() => undefined);
      if (isProcessAlive(detachedPid)) process.kill(detachedPid, "SIGKILL");
    }
  }, 12_000);

  it.runIf(process.platform === "win32")(
    "uses kernel signaled state instead of reserving exit code 259",
    () => {
      expect(windowsJobHelperSource).toContain("WaitForSingleObject");
      expect(windowsJobHelperSource).not.toContain(
        "return code == STILL_ACTIVE ? (int?)null : unchecked((int)code);",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "preserves literal Windows exit code 259 after the process is signaled",
    async () => {
      const fixture = await createFixture();
      await fixture.host.start(
        startRequest(fixture.cwd, ["-e", "process.exit(259);"], { timeoutMs: 5_000 }),
      );
      await expect(fixture.host.awaitFinal(sessionId)).resolves.toMatchObject({
        receipt: {
          executionObservation: "EXITED",
          exitCode: 259,
          processTreeState: "EMPTY",
          outputState: "CLOSED",
          terminalFinality: "FINAL",
          reasonCodes: [],
        },
      });
    },
    12_000,
  );

  it("bounds retained output while hashing every observed byte", async () => {
    const fixture = await createFixture();
    await fixture.host.start(
      startRequest(fixture.cwd, ["-e", "process.stdout.write('x'.repeat(131072));"], {
        maxOutputBytes: 1024,
      }),
    );
    await fixture.host.awaitFinal(sessionId);
    const { stdout, receipt } = await readText(fixture.host);
    expect(stdout).toBe("x".repeat(1024));
    expect(receipt).toMatchObject({
      observedBytes: 131_072,
      retainedBytes: 1024,
      truncated: true,
      eof: true,
    });
    expect(receipt.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("does not signal a platform process tree when its identity fingerprint differs", async () => {
    expect(linuxPidfdSignalSource).toContain("pidfd_send_signal");
    expect(linuxSubreaperProcessTreeHelperSource).not.toContain(
      'process.kill(identity.pid, "SIGKILL")',
    );
    const fixture = await createFixture();
    const driver =
      process.platform === "win32"
        ? new WindowsJobObjectDriver()
        : new LinuxSubreaperProcessTreeDriver();
    const session = await driver.start({
      executable: process.execPath,
      argv: ["-e", "setInterval(() => {}, 1000);"],
      cwd: fixture.cwd,
      environment: startRequest(fixture.cwd, []).environment,
      timeoutMs: 15_000,
      onOutput: () => undefined,
    });

    await expect(
      session.cancel(fingerprint("different-platform-identity"), "USER_REQUEST"),
    ).resolves.toEqual({ outcome: "IDENTITY_MISMATCH" });
    await expect(session.snapshot()).resolves.toMatchObject({
      phase: "RUNNING",
      identityState: "MATCH",
      treeState: "ACTIVE",
    });
    await expect(session.cancel(session.identityFingerprint, "USER_REQUEST")).resolves.toEqual({
      outcome: "ACKNOWLEDGED",
    });
    await expect(session.waitForSettlement()).resolves.toMatchObject({
      phase: "TERMINAL",
      terminationCause: "CANCEL",
      identityState: "MATCH",
      treeState: "EMPTY",
    });
  });
});
