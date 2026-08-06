import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createQualifiedPiJsonProcess } from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("qualified Pi JSON process runner", () => {
  it("uses the Task 7 managed process host and returns final containment facts", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-qualified-process-");
    cleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const leaseRoot = join(root, "leases");
    await Promise.all([mkdir(workspace), mkdir(leaseRoot)]);

    const runProcess = await createQualifiedPiJsonProcess({
      leaseRoot,
      now: () => "2026-08-06T00:00:10.000Z",
    });
    const result = await runProcess({
      plan: {
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write(JSON.stringify({type:'agent_end'}) + '\\n')", "--"],
        cwd: workspace,
        environment: { HUNTER_PI_MODE: "MANAGED" },
      },
      prompt: "Apply the bounded fixture change.",
      timeoutMs: 30_000,
      maximumOutputBytes: 32_768,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      framingValid: true,
      eventTypes: ["agent_end"],
      containment:
        process.platform === "win32" ? "WINDOWS_JOB_OBJECT" : "LINUX_SUBREAPER_PROCESS_TREE",
      terminalFinality: "FINAL",
      processTreeState: "EMPTY",
      leaseState: "RELEASED",
    });
  });
});
