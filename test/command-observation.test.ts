import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createQualifiedControlledCommandRunner,
  observeControlledCommand,
  type ControlledCommandProcessResult,
  type ProcessRunner,
} from "@hunter-pi/verification";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];
const fingerprints = {
  definitionFingerprint: `sha256:${"1".repeat(64)}` as const,
  configurationFingerprint: `sha256:${"2".repeat(64)}` as const,
  sourceFingerprint: `sha256:${"3".repeat(64)}` as const,
  workspaceFingerprint: `sha256:${"4".repeat(64)}` as const,
  environmentFingerprint: `sha256:${"5".repeat(64)}` as const,
};

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finalProcessResult(
  overrides: Partial<ControlledCommandProcessResult> = {},
): ControlledCommandProcessResult {
  return {
    exitCode: 0,
    timedOut: false,
    processError: false,
    stdout: Buffer.from("accepted\n"),
    stderr: Buffer.alloc(0),
    observedOutputBytes: 9,
    stdoutTruncated: false,
    stderrTruncated: false,
    terminalFinality: "FINAL",
    processTreeState: "EMPTY",
    outputState: "CLOSED",
    ...overrides,
  };
}

function runnerReturning(result: ControlledCommandProcessResult): ProcessRunner {
  return { run: vi.fn().mockResolvedValue(result) };
}

async function fixtureRoot(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hpi-command-observation-");
  cleanupRoots.push(root);
  return root;
}

function request(root: string) {
  return {
    workingDirectory: root,
    executable: "node",
    argv: ["check.mjs"],
    ...fingerprints,
    timeoutMs: 5_000,
    maximumOutputBytes: 4_096,
  } as const;
}

describe("provider-neutral controlled command observation", () => {
  it("binds a passing observation without returning paths, commands, or raw output", async () => {
    const root = await fixtureRoot();
    const canonicalRoot = await realpath(root);
    const processResult = finalProcessResult();
    const run = vi.fn().mockResolvedValue(processResult);
    const runner: ProcessRunner = { run };
    const times = ["2026-08-10T00:00:01.000Z", "2026-08-10T00:00:02.000Z"];

    const result = await observeControlledCommand(
      request(root),
      runner,
      () => times.shift() ?? "2026-08-10T00:00:03.000Z",
    );

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: process.execPath,
        argv: ["check.mjs"],
        cwd: canonicalRoot,
        shell: false,
        timeoutMs: 5_000,
        maximumOutputBytes: 4_096,
      }),
    );
    expect(result.receipt).toEqual({
      schemaVersion: "hpi-command-observation.v1",
      ...fingerprints,
      workingDirectoryFingerprint: digest(Buffer.from(canonicalRoot, "utf8")),
      commandFingerprint: digest(
        Buffer.from(
          JSON.stringify({ executable: process.execPath, argv: ["check.mjs"], shell: false }),
          "utf8",
        ),
      ),
      outcome: "PASS",
      startedAt: "2026-08-10T00:00:01.000Z",
      endedAt: "2026-08-10T00:00:02.000Z",
      resultStatus: {
        exitCode: 0,
        timedOut: false,
        terminalFinality: "FINAL",
        processTreeState: "EMPTY",
        outputState: "CLOSED",
      },
      output: {
        stdoutDigest: digest(processResult.stdout),
        stderrDigest: digest(processResult.stderr),
        capturedBytes: 9,
        observedBytes: 9,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("check.mjs");
    expect(serialized).not.toContain("accepted");
    expect(result.receipt).not.toHaveProperty("runId");
    expect(result.receipt).not.toHaveProperty("attemptId");
    expect(result.receipt).not.toHaveProperty("verificationReceiptId");
  });

  it("classifies an ordinary non-zero exit as FAIL", async () => {
    const root = await fixtureRoot();
    const result = await observeControlledCommand(
      request(root),
      runnerReturning(finalProcessResult({ exitCode: 7 })),
    );

    expect(result.receipt).toMatchObject({
      outcome: "FAIL",
      resultStatus: { exitCode: 7, timedOut: false },
    });
  });

  it.each([
    ["process error", { processError: true, exitCode: null }],
    ["missing exit code", { exitCode: null }],
    ["timeout", { timedOut: true, exitCode: null }],
    ["stdout truncation", { stdoutTruncated: true, observedOutputBytes: 10 }],
    ["stderr truncation", { stderrTruncated: true, observedOutputBytes: 10 }],
    ["unreconciled terminal", { terminalFinality: "NOT_PROVEN" as const }],
    ["non-empty process tree", { processTreeState: "ACTIVE" as const }],
    ["open output", { outputState: "OPEN" as const }],
  ])("classifies %s as NOT_PROVEN", async (_label, overrides) => {
    const root = await fixtureRoot();
    const result = await observeControlledCommand(
      request(root),
      runnerReturning(finalProcessResult(overrides)),
    );

    expect(result.receipt.outcome).toBe("NOT_PROVEN");
  });

  it("bounds combined retained output and treats module-side truncation as NOT_PROVEN", async () => {
    const root = await fixtureRoot();
    const result = await observeControlledCommand(
      { ...request(root), maximumOutputBytes: 5 },
      runnerReturning(
        finalProcessResult({
          stdout: Buffer.from("1234"),
          stderr: Buffer.from("5678"),
          observedOutputBytes: 8,
        }),
      ),
    );

    expect(result.receipt).toMatchObject({
      outcome: "NOT_PROVEN",
      output: {
        capturedBytes: 5,
        observedBytes: 8,
        stdoutTruncated: false,
        stderrTruncated: true,
      },
    });
    expect(result.receipt.output.stdoutDigest).toBe(digest(Buffer.from("1234")));
    expect(result.receipt.output.stderrDigest).toBe(digest(Buffer.from("5")));
  });

  it("converts a thrown process-runner error into a path-free NOT_PROVEN receipt", async () => {
    const root = await fixtureRoot();
    const runner: ProcessRunner = {
      run: vi.fn().mockRejectedValue(new Error(`unable to launch ${root} check.mjs`)),
    };

    const result = await observeControlledCommand(request(root), runner);

    expect(result.receipt).toMatchObject({
      outcome: "NOT_PROVEN",
      resultStatus: {
        exitCode: null,
        timedOut: false,
        terminalFinality: "NOT_PROVEN",
        processTreeState: "NOT_PROVEN",
        outputState: "NOT_PROVEN",
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(root);
    expect(JSON.stringify(result.receipt)).not.toContain("check.mjs");
  });

  it.each([
    ["working directory", (root: string) => ({ ...request(root), workingDirectory: `${root}\n` })],
    ["executable", (root: string) => ({ ...request(root), executable: "node\u0000bad" })],
    ["argv", (root: string) => ({ ...request(root), argv: ["check.mjs\t"] })],
  ])("rejects control characters in %s", async (_label, createInvalidRequest) => {
    const root = await fixtureRoot();
    const run = vi.fn().mockResolvedValue(finalProcessResult());
    const runner: ProcessRunner = { run };

    await expect(observeControlledCommand(createInvalidRequest(root), runner)).rejects.toThrow(
      /control character/u,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 86_400_001 },
    { maximumOutputBytes: 0 },
    { maximumOutputBytes: 1.5 },
    { maximumOutputBytes: 268_435_457 },
  ])("rejects invalid limits: %j", async (limits) => {
    const root = await fixtureRoot();
    const run = vi.fn().mockResolvedValue(finalProcessResult());
    const runner: ProcessRunner = { run };

    await expect(observeControlledCommand({ ...request(root), ...limits }, runner)).rejects.toThrow(
      /limits/u,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "resolves the Windows npm shim through Node while keeping shell disabled",
    async () => {
      const root = await fixtureRoot();
      const run = vi.fn().mockResolvedValue(finalProcessResult());
      const runner: ProcessRunner = { run };

      await observeControlledCommand(
        { ...request(root), executable: "npm", argv: ["--version"] },
        runner,
      );

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          executable: process.execPath,
          argv: [expect.stringMatching(/npm-cli\.js$/u), "--version"],
          shell: false,
        }),
      );
    },
  );

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "executes the acceptance command through qualified OS containment",
    async () => {
      const root = await fixtureRoot();
      const leaseRoot = join(root, "lease-state");
      const script = join(root, "check.mjs");
      await mkdir(leaseRoot);
      await writeFile(script, 'process.stdout.write("qualified acceptance\\n");\n', "utf8");
      const runner = await createQualifiedControlledCommandRunner({ leaseRoot });

      const result = await observeControlledCommand(request(root), runner);

      expect(result.receipt).toMatchObject({
        outcome: "PASS",
        resultStatus: {
          exitCode: 0,
          timedOut: false,
          terminalFinality: "FINAL",
          processTreeState: "EMPTY",
          outputState: "CLOSED",
        },
        output: {
          capturedBytes: 21,
          observedBytes: 21,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      });
      expect(JSON.stringify(result.receipt)).not.toContain("qualified acceptance");
      expect(JSON.stringify(result.receipt)).not.toContain(root);
    },
  );
});
