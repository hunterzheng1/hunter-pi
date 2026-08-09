import { access, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import vitestConfiguration from "../vitest.config.js";
import { runCapturedProcess } from "./support/captured-process.js";
import {
  setupVitestResourceRuntime,
  vitestResourcePolicy,
} from "./support/vitest-resource-runtime.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

describe("Vitest resource fixture runtime", () => {
  it("caps repository-wide worker concurrency and installs one global Temp lifecycle", () => {
    const configuration = vitestConfiguration as unknown as {
      readonly test?: {
        readonly fileParallelism?: boolean;
        readonly globalSetup?: string | readonly string[];
        readonly maxWorkers?: number | string;
        readonly teardownTimeout?: number;
        readonly testTimeout?: number;
      };
    };

    expect(configuration.test?.fileParallelism).toBe(false);
    expect(configuration.test?.maxWorkers).toBe(vitestResourcePolicy.maxWorkers);
    expect(configuration.test?.globalSetup).toBe("./test/vitest.global-setup.ts");
    expect(configuration.test?.teardownTimeout).toBe(vitestResourcePolicy.teardownTimeoutMs);
    expect(configuration.test?.testTimeout).toBe(vitestResourcePolicy.testTimeoutMs);
    expect(vitestResourcePolicy.maxWorkers).toBe(1);
    expect(vitestResourcePolicy.testTimeoutMs).toBe(30_000);
  });

  it("gives the hosted managed-process integration room beyond one platform startup ceiling", async () => {
    const managedProcessTimeout = Reflect.get(
      vitestResourcePolicy,
      "managedProcessIntegrationTimeoutMs",
    );
    const managedChangeSource = await readFile(
      new URL("./real-managed-change-cli.test.ts", import.meta.url),
      "utf8",
    );

    expect(managedProcessTimeout).toBe(60_000);
    expect(managedProcessTimeout).toBeGreaterThan(vitestResourcePolicy.testTimeoutMs);
    expect(managedChangeSource).toContain(
      "vitestResourcePolicy.managedProcessIntegrationTimeoutMs",
    );
  });

  it("contains temporary fixtures and restores inherited Temp variables after teardown", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-vitest-parent-");
    const environment: NodeJS.ProcessEnv = {
      TEMP: "prior-temp",
      TMPDIR: "prior-tmpdir",
    };

    try {
      const runtime = await setupVitestResourceRuntime({
        environment,
        parentDirectory: parent,
      });
      const relativeRoot = relative(parent, runtime.temporaryRoot);
      expect(relativeRoot).not.toBe("");
      expect(relativeRoot).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      expect(environment).toMatchObject({
        TEMP: runtime.temporaryRoot,
        TMP: runtime.temporaryRoot,
        TMPDIR: runtime.temporaryRoot,
      });
      await writeFile(join(runtime.temporaryRoot, "sentinel.txt"), "fixture\n", "utf8");

      await runtime.teardown();
      await runtime.teardown();

      await expect(access(runtime.temporaryRoot)).rejects.toThrow();
      expect(environment["TEMP"]).toBe("prior-temp");
      expect(environment["TMP"]).toBeUndefined();
      expect(environment["TMPDIR"]).toBe("prior-tmpdir");
    } finally {
      await rm(parent, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not report a fixture timeout until the child process has closed", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-process-parent-");
    try {
      await expect(
        runCapturedProcess({
          executable: process.execPath,
          arguments: ["-e", "setInterval(() => {}, 1000)"],
          cwd: parent,
          environment: { ...process.env },
          timeoutMs: 100,
        }),
      ).rejects.toThrow("fixture process timed out");

      await expect(
        rm(parent, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(parent, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
