import { describe, expect, it } from "vitest";

import { WindowsJobObjectDriver } from "../packages/execution/src/windows-job-driver.js";

describe.runIf(process.platform === "win32")("Windows Job Object environment", () => {
  it("normalizes case-insensitive names before the helper parses JSON", async () => {
    const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
    if (systemRoot === undefined) throw new Error("Windows system root is unavailable");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const driver = new WindowsJobObjectDriver();
    const session = await driver.start({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write(process.env.HPI_CASE_VALUE ?? 'MISSING');"],
      cwd: process.cwd(),
      environment: {
        SystemRoot: systemRoot,
        HPI_CASE_VALUE: "UPPER",
        hpi_case_value: "lower",
      },
      timeoutMs: 10_000,
      onOutput: (stream, chunk) => {
        (stream === "STDOUT" ? stdout : stderr).push(Buffer.from(chunk));
      },
    });

    const snapshot = await session.waitForSettlement();
    expect(Buffer.concat(stdout).toString("utf8")).toBe("UPPER");
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(snapshot).toMatchObject({
      phase: "TERMINAL",
      exitCode: 0,
      terminationCause: "NONE",
      identityState: "MATCH",
      treeState: "EMPTY",
      stdoutState: "CLOSED",
      stderrState: "CLOSED",
    });
  }, 15_000);
});
