import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Fingerprint } from "@hunter-pi/evidence";
import {
  FileWindowsPortableReleaseAdapter,
  HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
  HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES,
  createPortableBundle,
  releaseCandidateSchema,
} from "@hunter-pi/updater";

import { runWindowsPortablePromotion } from "../scripts/promote-windows-portable.mjs";

import {
  createTemporaryTestDirectory,
  removeTemporaryTestDirectory,
} from "./support/temporary-test-directory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryTestDirectory));
});

describe("Task 11 portable qualification operator script", () => {
  it("fails closed without exposing a private installation path or stack", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-promotion-script-private-",
    );
    roots.push(root);
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "promote-windows-portable.mjs"),
        "--root",
        join(root, "missing-private-installation"),
        "--run",
        "31451189405",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      schemaVersion: "hpi-portable-qualification-operation.v1",
      status: "BLOCKED",
      reason: "portable qualification could not be completed",
    });
    expect(output).not.toContain(root);
    expect(output).not.toMatch(/\bat\s+[^\n]+:\d+:\d+/u);
  });

  it("uses one live run view and one artifact download, then replays locally", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-promotion-script-success-",
    );
    roots.push(root);
    const portableRoot = join(root, "portable");
    const sourceCommit = "b".repeat(40);
    const runId = 31_451_189_405;
    const engineFingerprint = sha256Fingerprint("promotion-script-engine");
    const artifact = createPortableBundle({
      releaseId: "release_task11-promotion-script",
      productVersion: "0.2.0",
      engineReleaseId: "engine-release_pi-0.83.0",
      engineReleaseFingerprint: engineFingerprint,
      sourceCommit,
      files: [
        { path: "hpi.cmd", bytes: Buffer.from("@echo off\r\n", "utf8") },
        { path: "node.exe", bytes: Buffer.from("portable-node-fixture\n", "utf8") },
      ],
    });
    const candidate = releaseCandidateSchema.parse({
      schemaVersion: "hpi-release-candidate.v1",
      releaseId: "release_task11-promotion-script",
      productVersion: "0.2.0",
      channel: "PREVIEW",
      artifact: {
        reference: "fixture/task11-promotion-script.bundle.tgz",
        fingerprint: sha256Fingerprint(artifact),
        byteLength: artifact.byteLength,
      },
      engine: {
        releaseId: "engine-release_pi-0.83.0",
        fingerprint: engineFingerprint,
        piVersion: "0.83.0",
      },
      qualification: {
        status: "NOT_PROVEN",
        verifierFingerprint: HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
        checks: [
          {
            name: "windows-portable-ci",
            outcome: "NOT_PROVEN",
            evidenceIds: [],
            reason: "remote Windows and Ubuntu qualification is required before promotion",
          },
        ],
        qualifiedAt: "2026-08-11T12:00:00.000Z",
      },
      updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
      licenses: [
        {
          name: "Hunter Pi",
          version: "0.2.0",
          license: "MIT",
          sourceReference: "NOTICE",
        },
      ],
    });
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const staged = await adapter.stage(candidate, artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), artifact);
    const runGh = vi.fn(async (arguments_: readonly string[]) => {
      if (arguments_[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            attempt: 1,
            conclusion: "success",
            databaseId: runId,
            event: "push",
            headBranch: "main",
            headSha: sourceCommit,
            jobs: HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
            })),
            status: "completed",
            updatedAt: "2026-08-11T12:30:00.000Z",
            url: `https://github.com/hunterzheng1/hunter-pi/actions/runs/${String(runId)}`,
            workflowName: "CI",
          }),
          stderr: "",
        };
      }
      const directory = arguments_[arguments_.indexOf("--dir") + 1];
      if (directory === undefined) throw new Error("fixture download directory missing");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "update.bundle.tgz"), artifact);
      await writeFile(
        join(directory, "portable-release-candidate.json"),
        JSON.stringify(candidate),
        "utf8",
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const dependencies = {
      platform: "win32",
      arch: "x64",
      nodeVersion: "24.13.0",
      now: () => new Date("2026-08-11T12:31:00.000Z"),
      temporaryParent: root,
      runGh,
    };

    const first = await runWindowsPortablePromotion(
      ["--root", portableRoot, "--run", String(runId)],
      dependencies,
    );
    const replay = await runWindowsPortablePromotion(
      ["--root", portableRoot, "--run", String(runId)],
      dependencies,
    );

    expect(first).toMatchObject({ action: "QUALIFY", outcome: "APPLIED" });
    expect(replay).toEqual(first);
    expect(runGh).toHaveBeenCalledTimes(2);
  });
});
