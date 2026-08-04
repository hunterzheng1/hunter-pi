import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writerLeaseIdSchema } from "@hunter-pi/domain";
import {
  createFileLeaseManager,
  leaseAcquireRequestSchema,
  leaseReleaseRequestSchema,
  managedProcessFinalReceiptSchema,
  managedProcessStartRequestSchema,
} from "@hunter-pi/execution";
import * as processHostModule from "../packages/execution/src/managed-process-host.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

type OutputStream = "STDOUT" | "STDERR";
type TerminationCause = "NONE" | "CANCEL" | "TIMEOUT";

interface DriverSnapshot {
  readonly phase: "RUNNING" | "EXITED" | "TERMINATING" | "TERMINAL" | "UNRECONCILED";
  readonly exitCode: number | null;
  readonly terminationCause: TerminationCause;
  readonly identityState: "MATCH" | "MISMATCH" | "NOT_PROVEN";
  readonly treeState: "ACTIVE" | "EMPTY" | "NOT_PROVEN";
  readonly stdoutState: "OPEN" | "CLOSED" | "NOT_PROVEN";
  readonly stderrState: "OPEN" | "CLOSED" | "NOT_PROVEN";
  readonly observedAt: string;
}

interface DriverStartRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly onOutput: (stream: OutputStream, chunk: Buffer) => void;
}

class ControllableDriver {
  public startRequest: DriverStartRequest | undefined;
  public startCalls = 0;
  public cancelCalls = 0;
  public terminateCalls = 0;
  public cancelResult: "ACKNOWLEDGED" | "IDENTITY_MISMATCH" | "NOT_PROVEN" = "ACKNOWLEDGED";
  #snapshot: DriverSnapshot = {
    phase: "RUNNING",
    exitCode: null,
    terminationCause: "NONE",
    identityState: "MATCH",
    treeState: "ACTIVE",
    stdoutState: "OPEN",
    stderrState: "OPEN",
    observedAt: "2026-08-04T10:00:00.000Z",
  };
  #settle: ((snapshot: DriverSnapshot) => void) | undefined;
  readonly #terminal = new Promise<DriverSnapshot>((resolve) => {
    this.#settle = resolve;
  });

  public start(request: DriverStartRequest) {
    this.startCalls += 1;
    this.startRequest = request;
    return Promise.resolve({
      identityFingerprint: fingerprint("driver-process-identity"),
      containment: "TEST_CONTAINED" as const,
      snapshot: () => Promise.resolve(this.#snapshot),
      cancel: (expectedIdentity: string) => {
        this.cancelCalls += 1;
        if (
          expectedIdentity !== fingerprint("driver-process-identity") ||
          this.cancelResult === "IDENTITY_MISMATCH"
        ) {
          this.#snapshot = {
            ...this.#snapshot,
            phase: "UNRECONCILED",
            identityState: "MISMATCH",
            treeState: "NOT_PROVEN",
          };
          return Promise.resolve({ outcome: "IDENTITY_MISMATCH" as const });
        }
        if (this.cancelResult === "NOT_PROVEN") {
          return Promise.resolve({ outcome: "NOT_PROVEN" as const });
        }
        this.terminateCalls += 1;
        this.#snapshot = {
          ...this.#snapshot,
          phase: "TERMINATING",
          terminationCause: "CANCEL",
        };
        return Promise.resolve({ outcome: "ACKNOWLEDGED" as const });
      },
      waitForSettlement: () => this.#terminal,
    });
  }

  public emit(stream: OutputStream, value: string): void {
    if (this.startRequest === undefined) throw new Error("driver did not start");
    this.startRequest.onOutput(stream, Buffer.from(value, "utf8"));
  }

  public observe(snapshot: DriverSnapshot): void {
    this.#snapshot = snapshot;
  }

  public settle(snapshot: DriverSnapshot): void {
    this.#snapshot = snapshot;
    this.#settle?.(snapshot);
  }
}

interface ManagedProcessHost {
  start(request: Record<string, unknown>): Promise<{
    readonly receipt: Record<string, unknown>;
  }>;
  read(request: Record<string, unknown>): Promise<{
    readonly chunks: readonly {
      readonly stream: OutputStream;
      readonly cursorStart: number;
      readonly cursorEnd: number;
      readonly dataBase64: string;
    }[];
    readonly receipt: Record<string, unknown>;
  }>;
  heartbeat(sessionId: string): Promise<{ readonly receipt: Record<string, unknown> }>;
  cancel(request: Record<string, unknown>): Promise<{ readonly receipt: Record<string, unknown> }>;
  awaitFinal(sessionId: string): Promise<{ readonly receipt: Record<string, unknown> }>;
}

type CreateManagedProcessHost = (options: {
  readonly driver: ControllableDriver;
  readonly leaseManager: Awaited<ReturnType<typeof createFileLeaseManager>>;
  readonly now?: () => string;
}) => ManagedProcessHost;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createFixture() {
  const parent = await createTemporaryTestDirectory(tmpdir(), "hpi-t7-process-");
  cleanupRoots.push(parent);
  const cwd = join(parent, "working directory 测试");
  const leaseRoot = join(parent, "lease state");
  await Promise.all([mkdir(cwd), mkdir(leaseRoot)]);
  const leaseManager = await createFileLeaseManager({
    leaseRoot,
    now: () => "2026-08-04T10:00:00.000Z",
  });
  return { parent, cwd, leaseManager };
}

function requireCreateHost(): CreateManagedProcessHost {
  const value: unknown = Reflect.get(processHostModule, "createManagedProcessHost");
  expect(value, "createManagedProcessHost must be implemented internally").toBeTypeOf("function");
  return value as CreateManagedProcessHost;
}

function startRequest(cwd: string, leases: readonly Record<string, unknown>[] = []) {
  return {
    schemaVersion: "hpi-process-start.v1",
    operationId: "op_process-start",
    operationFingerprint: fingerprint("operation:process-start"),
    sessionId: "process_task7-session",
    executable: process.execPath,
    argv: ["alpha beta", "literal&pipe", "私有参数"],
    cwd,
    environment: { HPI_FIXTURE: "SAFE" },
    timeoutMs: 60_000,
    maxOutputBytes: 8,
    leases,
    leaseBindOperationId: "op_process-lease-bind",
    leaseBindOperationFingerprint: fingerprint("operation:process-lease-bind"),
  };
}

function terminalSnapshot(
  options: {
    readonly cause?: TerminationCause;
    readonly exitCode?: number | null;
  } = {},
): DriverSnapshot {
  return {
    phase: "TERMINAL",
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    terminationCause: options.cause ?? "NONE",
    identityState: "MATCH",
    treeState: "EMPTY",
    stdoutState: "CLOSED",
    stderrState: "CLOSED",
    observedAt: "2026-08-04T10:00:05.000Z",
  };
}

describe("managed process host", () => {
  it("rejects a caller-authored FINAL receipt until tree, output, and leases are reconciled", () => {
    const candidate = {
      schemaVersion: "hpi-process-final-receipt.v1",
      sessionId: "process_task7-forged-final",
      executionObservation: "EXITED",
      exitCode: 0,
      processTreeState: "ACTIVE",
      outputState: "OPEN",
      leaseState: "HELD",
      observedBytes: 0,
      retainedBytes: 0,
      outputDigest: fingerprint("empty-output"),
      truncated: false,
      terminalFinality: "FINAL",
      reasonCodes: [],
      observedAt: "2026-08-04T10:00:05.000Z",
    };

    expect(managedProcessFinalReceiptSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps argv structured, bounds logs, and waits for tree, streams, and leases before finality", async () => {
    const fixture = await createFixture();
    const ownerFingerprint = fingerprint("process-owner");
    await fixture.leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: "op_process-lease-acquire",
        operationFingerprint: fingerprint("operation:process-lease-acquire"),
        leaseId: "lease_task7-process",
        workspaceId: "workspace_task7-process",
        ownerFingerprint,
        resources: ["process_slot"],
        ttlMs: 60_000,
      }),
    );
    const driver = new ControllableDriver();
    const host = requireCreateHost()({
      driver,
      leaseManager: fixture.leaseManager,
      now: () => "2026-08-04T10:00:00.000Z",
    });
    const request = startRequest(fixture.cwd, [
      {
        leaseId: "lease_task7-process",
        ownerFingerprint,
        releaseOperationId: "op_process-lease-release",
        releaseOperationFingerprint: fingerprint("operation:process-lease-release"),
      },
    ]);

    const started = await host.start(request);
    expect(driver.startRequest).toMatchObject({
      executable: process.execPath,
      argv: ["alpha beta", "literal&pipe", "私有参数"],
      cwd: fixture.cwd,
      environment: { HPI_FIXTURE: "SAFE" },
      timeoutMs: 60_000,
    });
    expect(started.receipt).toMatchObject({
      schemaVersion: "hpi-process-start-receipt.v1",
      action: "START",
      outcome: "STARTED",
      sessionId: "process_task7-session",
      containment: "TEST_CONTAINED",
      terminalFinality: "PENDING",
    });
    expect(JSON.stringify(started.receipt)).not.toContain(fixture.parent);
    expect(JSON.stringify(started.receipt)).not.toContain("私有参数");

    driver.emit("STDOUT", "ABCDE");
    driver.emit("STDERR", "secret-output");
    const firstLog = await host.read({
      schemaVersion: "hpi-process-log-read.v1",
      sessionId: "process_task7-session",
      cursor: 0,
      maxBytes: 5,
    });
    expect(
      firstLog.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")),
    ).toEqual(["ABCDE"]);
    expect(firstLog.receipt).toMatchObject({
      schemaVersion: "hpi-process-log-receipt.v1",
      cursor: 0,
      nextCursor: 5,
      returnedBytes: 5,
      retainedBytes: 8,
      observedBytes: 18,
      truncated: true,
      eof: false,
    });
    expect(firstLog.receipt["outputDigest"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(firstLog.receipt)).not.toContain("secret-output");

    await expect(host.heartbeat("process_task7-session")).resolves.toMatchObject({
      receipt: { state: "LIVE", terminalFinality: "PENDING" },
    });
    driver.observe({
      phase: "EXITED",
      exitCode: 0,
      terminationCause: "NONE",
      identityState: "MATCH",
      treeState: "ACTIVE",
      stdoutState: "OPEN",
      stderrState: "OPEN",
      observedAt: "2026-08-04T10:00:01.000Z",
    });
    await expect(host.heartbeat("process_task7-session")).resolves.toMatchObject({
      receipt: {
        state: "EXITED",
        exitCode: 0,
        processTreeState: "ACTIVE",
        terminalFinality: "PENDING",
      },
    });

    const finalPromise = host.awaitFinal("process_task7-session");
    await expect(
      Promise.race([finalPromise.then(() => "resolved"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    driver.settle(terminalSnapshot());
    const final = await finalPromise;
    expect(final.receipt).toMatchObject({
      schemaVersion: "hpi-process-final-receipt.v1",
      executionObservation: "EXITED",
      exitCode: 0,
      processTreeState: "EMPTY",
      outputState: "CLOSED",
      leaseState: "RELEASED",
      terminalFinality: "FINAL",
      reasonCodes: [],
    });
    expect(JSON.stringify(final.receipt)).not.toMatch(/\b(?:PASS|READY|SUCCESS)\b/iu);
    await expect(
      fixture.leaseManager.inspect(writerLeaseIdSchema.parse("lease_task7-process")),
    ).resolves.toMatchObject({
      receipt: { state: "RELEASED" },
    });
  });

  it("replays the same start operation without spawning twice and rejects changed argv", async () => {
    const fixture = await createFixture();
    const driver = new ControllableDriver();
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    const request = startRequest(fixture.cwd);

    const original = await host.start(request);
    await expect(host.start({ ...request })).resolves.toEqual(original);
    await expect(
      host.start({
        ...request,
        argv: ["changed"],
      }),
    ).rejects.toMatchObject({
      name: "ManagedProcessError",
      code: "PROCESS_OPERATION_CONFLICT",
    });
    expect(driver.startCalls).toBe(1);
    driver.settle(terminalSnapshot());
    await host.awaitFinal("process_task7-session");
  });

  it("fails closed instead of spawning an exact leased start replay in a second host", async () => {
    const fixture = await createFixture();
    const ownerFingerprint = fingerprint("cross-host-replay-owner");
    await fixture.leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: "op_cross-host-replay-acquire",
        operationFingerprint: fingerprint("operation:cross-host-replay-acquire"),
        leaseId: "lease_cross-host-replay",
        workspaceId: "workspace_cross-host-replay",
        ownerFingerprint,
        resources: ["cross_host_replay_slot"],
        ttlMs: 60_000,
      }),
    );
    const firstDriver = new ControllableDriver();
    const secondDriver = new ControllableDriver();
    const firstHost = requireCreateHost()({
      driver: firstDriver,
      leaseManager: fixture.leaseManager,
    });
    const secondHost = requireCreateHost()({
      driver: secondDriver,
      leaseManager: fixture.leaseManager,
    });
    const request = startRequest(fixture.cwd, [
      {
        leaseId: "lease_cross-host-replay",
        ownerFingerprint,
        releaseOperationId: "op_cross-host-replay-release",
        releaseOperationFingerprint: fingerprint("operation:cross-host-replay-release"),
      },
    ]);

    await firstHost.start(request);
    await expect(secondHost.start({ ...request })).rejects.toMatchObject({
      name: "ManagedProcessError",
      code: "PROCESS_OPERATION_REPLAY_NOT_PROVEN",
    });
    expect(firstDriver.startCalls).toBe(1);
    expect(secondDriver.startCalls).toBe(0);

    firstDriver.settle(terminalSnapshot());
    await firstHost.awaitFinal("process_task7-session");
  });

  it("durably reserves an exact unleased start operation across host instances", async () => {
    const fixture = await createFixture();
    const firstDriver = new ControllableDriver();
    const secondDriver = new ControllableDriver();
    const firstHost = requireCreateHost()({
      driver: firstDriver,
      leaseManager: fixture.leaseManager,
    });
    const secondHost = requireCreateHost()({
      driver: secondDriver,
      leaseManager: fixture.leaseManager,
    });
    const request = startRequest(fixture.cwd);

    await firstHost.start(request);
    await expect(secondHost.start({ ...request })).rejects.toMatchObject({
      code: "PROCESS_OPERATION_REPLAY_NOT_PROVEN",
    });
    expect(firstDriver.startCalls).toBe(1);
    expect(secondDriver.startCalls).toBe(0);

    firstDriver.settle(terminalSnapshot());
    await firstHost.awaitFinal("process_task7-session");
  });

  it("rejects NUL in every OS-bound process input before calling the platform driver", async () => {
    const fixture = await createFixture();
    const driver = new ControllableDriver();
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    const request = startRequest(fixture.cwd);
    const invalid = [
      { ...request, executable: `${process.execPath}\0suffix` },
      { ...request, argv: ["safe", "unsafe\0argument"] },
      { ...request, cwd: `${fixture.cwd}\0suffix` },
      { ...request, environment: { HPI_FIXTURE: "unsafe\0value" } },
      { ...request, environment: { "HPI\0FIXTURE": "unsafe" } },
    ];

    for (const candidate of invalid) {
      expect(managedProcessStartRequestSchema.safeParse(candidate).success).toBe(false);
      await expect(host.start(candidate)).rejects.toThrow();
    }
    expect(driver.startCalls).toBe(0);
  });

  it("atomically reserves a lease for one session until that session reaches finality", async () => {
    const fixture = await createFixture();
    const ownerFingerprint = fingerprint("process-race-owner");
    await fixture.leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: "op_process-race-lease-acquire",
        operationFingerprint: fingerprint("operation:process-race-lease-acquire"),
        leaseId: "lease_task7-process-race",
        workspaceId: "workspace_task7-process-race",
        ownerFingerprint,
        resources: ["process_race_slot"],
        ttlMs: 60_000,
      }),
    );
    const firstDriver = new ControllableDriver();
    const secondDriver = new ControllableDriver();
    const firstHost = requireCreateHost()({
      driver: firstDriver,
      leaseManager: fixture.leaseManager,
    });
    const secondHost = requireCreateHost()({
      driver: secondDriver,
      leaseManager: fixture.leaseManager,
    });
    const lease = {
      leaseId: "lease_task7-process-race",
      ownerFingerprint,
      releaseOperationId: "op_process-race-release-first",
      releaseOperationFingerprint: fingerprint("operation:process-race-release-first"),
    };
    await firstHost.start(startRequest(fixture.cwd, [lease]));

    await expect(
      secondHost.start({
        ...startRequest(fixture.cwd, [
          {
            ...lease,
            releaseOperationId: "op_process-race-release-second",
            releaseOperationFingerprint: fingerprint("operation:process-race-release-second"),
          },
        ]),
        operationId: "op_process-start-second",
        operationFingerprint: fingerprint("operation:process-start-second"),
        sessionId: "process_task7-session-second",
        leaseBindOperationId: "op_process-lease-bind-second",
        leaseBindOperationFingerprint: fingerprint("operation:process-lease-bind-second"),
      }),
    ).rejects.toMatchObject({ code: "PROCESS_LEASE_INVALID" });
    expect(secondDriver.startCalls).toBe(0);
    await expect(
      fixture.leaseManager.release(
        leaseReleaseRequestSchema.parse({
          schemaVersion: "hpi-lease-release.v1",
          operationId: "op_process-race-external-release",
          operationFingerprint: fingerprint("operation:process-race-external-release"),
          leaseId: "lease_task7-process-race",
          ownerFingerprint,
          bindingFingerprint: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "LEASE_BINDING_MISMATCH" });

    firstDriver.settle(terminalSnapshot());
    await expect(firstHost.awaitFinal("process_task7-session")).resolves.toMatchObject({
      receipt: { leaseState: "RELEASED", terminalFinality: "FINAL" },
    });
    await expect(
      fixture.leaseManager.acquire(
        leaseAcquireRequestSchema.parse({
          schemaVersion: "hpi-lease-acquire.v1",
          operationId: "op_process-race-lease-replacement",
          operationFingerprint: fingerprint("operation:process-race-lease-replacement"),
          leaseId: "lease_task7-process-race-replacement",
          workspaceId: "workspace_task7-process-race",
          ownerFingerprint: fingerprint("process-race-replacement-owner"),
          resources: ["process_race_slot"],
          ttlMs: 60_000,
        }),
      ),
    ).resolves.toMatchObject({ receipt: { outcome: "ACQUIRED" } });
  });

  it("refuses cancellation when the platform identity no longer matches", async () => {
    const fixture = await createFixture();
    const driver = new ControllableDriver();
    driver.cancelResult = "IDENTITY_MISMATCH";
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    await host.start(startRequest(fixture.cwd));

    const cancelled = await host.cancel({
      schemaVersion: "hpi-process-cancel.v1",
      operationId: "op_process-cancel-mismatch",
      operationFingerprint: fingerprint("operation:process-cancel-mismatch"),
      sessionId: "process_task7-session",
      reason: "USER_REQUEST",
    });
    expect(cancelled.receipt).toMatchObject({
      schemaVersion: "hpi-process-cancel-receipt.v1",
      outcome: "NOT_PROVEN",
      identityState: "MISMATCH",
      terminationAcknowledged: false,
      terminalFinality: "PENDING",
    });
    expect(driver.cancelCalls).toBe(1);
    expect(driver.terminateCalls).toBe(0);
  });

  it("keeps an acknowledged cancel pending until the owned tree and streams settle", async () => {
    const fixture = await createFixture();
    const driver = new ControllableDriver();
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    await host.start(startRequest(fixture.cwd));
    const request = {
      schemaVersion: "hpi-process-cancel.v1",
      operationId: "op_process-cancel",
      operationFingerprint: fingerprint("operation:process-cancel"),
      sessionId: "process_task7-session",
      reason: "USER_REQUEST",
    };

    const cancelled = await host.cancel(request);
    expect(cancelled.receipt).toMatchObject({
      outcome: "ACKNOWLEDGED",
      identityState: "MATCH",
      terminationAcknowledged: true,
      terminalFinality: "PENDING",
    });
    await expect(host.cancel({ ...request })).resolves.toEqual(cancelled);
    await expect(host.heartbeat("process_task7-session")).resolves.toMatchObject({
      receipt: { state: "CANCELLED", terminalFinality: "PENDING" },
    });

    const finalPromise = host.awaitFinal("process_task7-session");
    driver.settle(terminalSnapshot({ cause: "CANCEL", exitCode: null }));
    await expect(finalPromise).resolves.toMatchObject({
      receipt: { executionObservation: "CANCELLED", terminalFinality: "FINAL" },
    });
  });

  it("does not release a lease when process-tree emptiness is not proven", async () => {
    const fixture = await createFixture();
    const ownerFingerprint = fingerprint("process-ambiguous-owner");
    await fixture.leaseManager.acquire(
      leaseAcquireRequestSchema.parse({
        schemaVersion: "hpi-lease-acquire.v1",
        operationId: "op_process-ambiguous-lease-acquire",
        operationFingerprint: fingerprint("operation:process-ambiguous-lease-acquire"),
        leaseId: "lease_task7-process-ambiguous",
        workspaceId: "workspace_task7-process-ambiguous",
        ownerFingerprint,
        resources: ["process_ambiguous_slot"],
        ttlMs: 60_000,
      }),
    );
    const driver = new ControllableDriver();
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    await host.start(
      startRequest(fixture.cwd, [
        {
          leaseId: "lease_task7-process-ambiguous",
          ownerFingerprint,
          releaseOperationId: "op_process-ambiguous-lease-release",
          releaseOperationFingerprint: fingerprint("operation:process-ambiguous-lease-release"),
        },
      ]),
    );
    driver.settle({
      ...terminalSnapshot(),
      treeState: "NOT_PROVEN",
    });

    await expect(host.awaitFinal("process_task7-session")).resolves.toMatchObject({
      receipt: {
        terminalFinality: "NOT_PROVEN",
        processTreeState: "NOT_PROVEN",
        leaseState: "HELD",
        reasonCodes: ["PROCESS_TREE_NOT_PROVEN"],
      },
    });
    await expect(
      fixture.leaseManager.inspect(writerLeaseIdSchema.parse("lease_task7-process-ambiguous")),
    ).resolves.toMatchObject({ receipt: { state: "ACTIVE" } });
  });

  it("records timeout delivery as an observation and not as step success", async () => {
    const fixture = await createFixture();
    const driver = new ControllableDriver();
    const host = requireCreateHost()({ driver, leaseManager: fixture.leaseManager });
    await host.start(startRequest(fixture.cwd));
    driver.observe({
      phase: "TERMINATING",
      exitCode: null,
      terminationCause: "TIMEOUT",
      identityState: "MATCH",
      treeState: "ACTIVE",
      stdoutState: "OPEN",
      stderrState: "OPEN",
      observedAt: "2026-08-04T10:01:00.000Z",
    });

    await expect(host.heartbeat("process_task7-session")).resolves.toMatchObject({
      receipt: { state: "TIMED_OUT", terminalFinality: "PENDING" },
    });
    const finalPromise = host.awaitFinal("process_task7-session");
    driver.settle(terminalSnapshot({ cause: "TIMEOUT", exitCode: null }));
    const final = await finalPromise;
    expect(final.receipt).toMatchObject({
      executionObservation: "TIMED_OUT",
      terminalFinality: "FINAL",
    });
    expect(JSON.stringify(final.receipt)).not.toMatch(/\b(?:PASS|READY|SUCCESS)\b/iu);
  });
});
