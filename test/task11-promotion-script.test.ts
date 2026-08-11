import { spawnSync } from "node:child_process";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
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
  windowsPortableQualificationRequestFingerprint,
  windowsPortableQualificationTargetReference,
} from "@hunter-pi/updater";
import { resolveHpiPaths } from "@hunter-pi/pi-host";

import { createDefaultUpdateManager } from "../apps/cli/src/cli.js";

import {
  qualificationTimeoutMsForArtifactByteLength,
  qualificationUploadTreeByteLength,
  qualificationUploadTreeEntryKind,
  runWindowsPortablePromotion,
} from "../scripts/promote-windows-portable.mjs";

import {
  createTemporaryTestDirectory,
  removeTemporaryTestDirectory,
} from "./support/temporary-test-directory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryTestDirectory));
});

describe("Task 11 portable qualification operator script", () => {
  it("uses one finite transfer-aware budget for the hosted portable artifact", () => {
    expect(qualificationTimeoutMsForArtifactByteLength(1)).toBe(180_000);
    expect(qualificationTimeoutMsForArtifactByteLength(377_795_154)).toBe(421_000);
    expect(qualificationTimeoutMsForArtifactByteLength(512 * 1024 * 1024)).toBe(480_000);
  });

  it("fails closed for unsafe or out-of-budget hosted upload trees", async () => {
    const emptyRoot = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-empty-upload-tree-",
    );
    roots.push(emptyRoot);
    await expect(qualificationUploadTreeByteLength(emptyRoot)).rejects.toThrow("empty");

    const boundedRoot = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-bounded-upload-tree-",
    );
    roots.push(boundedRoot);
    await Promise.all([
      writeFile(join(boundedRoot, "first.bin"), Buffer.alloc(2)),
      writeFile(join(boundedRoot, "second.bin"), Buffer.alloc(2)),
    ]);
    await expect(
      qualificationUploadTreeByteLength(boundedRoot, { maximumEntries: 1 }),
    ).rejects.toThrow("too many entries");
    await expect(
      qualificationUploadTreeByteLength(boundedRoot, { maximumBytes: 3 }),
    ).rejects.toThrow("too large");
    if (process.platform === "win32") {
      const caseVariantRoot = `${boundedRoot.slice(0, 1).toLowerCase()}${boundedRoot.slice(1)}`;
      await expect(qualificationUploadTreeByteLength(caseVariantRoot)).resolves.toBe(4);
    }

    const outsideRoot = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-upload-tree-outside-",
    );
    const linkContainer = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-upload-tree-links-",
    );
    roots.push(linkContainer, outsideRoot);
    const redirectedRoot = join(linkContainer, "redirected-root");
    await symlink(outsideRoot, redirectedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(qualificationUploadTreeByteLength(redirectedRoot)).rejects.toThrow(
      "physical directory",
    );

    const nestedLinkRoot = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-upload-tree-nested-link-",
    );
    roots.push(nestedLinkRoot);
    await writeFile(join(nestedLinkRoot, "payload.bin"), "payload");
    await symlink(
      outsideRoot,
      join(nestedLinkRoot, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(qualificationUploadTreeByteLength(nestedLinkRoot)).rejects.toThrow(
      "contains a link",
    );

    expect(() =>
      qualificationUploadTreeEntryKind({
        isSymbolicLink: () => false,
        isDirectory: () => false,
        isFile: () => false,
      }),
    ).toThrow("non-file entry");
  });

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

  it("uses one live run view and one artifact download, then resolves a later invocation locally", async () => {
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
    const hostedUploadShape = await open(join(portableRoot, "hosted-upload-shape.bin"), "w");
    try {
      await hostedUploadShape.truncate(200 * 1024 * 1024);
    } finally {
      await hostedUploadShape.close();
    }
    const runGh = vi.fn(async (arguments_: readonly string[], timeoutMs: number) => {
      void timeoutMs;
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
    const requestNow = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-08-11T12:31:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-11T12:32:00.000Z"));
    const dependencies = {
      platform: "win32",
      arch: "x64",
      nodeVersion: "24.13.0",
      now: requestNow,
      observerNow: () => Date.parse("2026-08-11T12:31:00.000Z"),
      temporaryParent: root,
      runGh,
    };

    const first = await runWindowsPortablePromotion(
      ["--root", portableRoot, "--run", `0${String(runId)}`],
      dependencies,
    );
    const replay = await runWindowsPortablePromotion(
      ["--root", portableRoot, "--run", String(runId)],
      dependencies,
    );

    expect(first).toMatchObject({ action: "QUALIFY", outcome: "APPLIED" });
    expect(first.operationId).toMatch(
      new RegExp(`^op_update-qualify-${String(runId)}-[a-f0-9]{16}$`, "u"),
    );
    expect(replay).toMatchObject({ action: "QUALIFY", outcome: "NOOP" });
    expect(replay.operationId).not.toBe(first.operationId);
    expect(runGh).toHaveBeenCalledTimes(2);
    const observedTimeouts = runGh.mock.calls.map((call) => call[1]);
    expect(observedTimeouts).toHaveLength(2);
    const observedTimeout = observedTimeouts[0];
    if (observedTimeout === undefined) throw new Error("qualification timeout was not observed");
    expect(observedTimeout).toBeGreaterThanOrEqual(260_000);
    expect(observedTimeouts[1]).toBe(observedTimeout);

    const paths = resolveHpiPaths({
      env: { HUNTER_PI_HOME: join(root, "profile") },
      homeDirectory: root,
    });
    const cliManager = await createDefaultUpdateManager(
      {
        environment: { HUNTER_PI_PORTABLE_ROOT: portableRoot },
        platform: "win32",
        now: () => "2026-08-11T12:33:00.000Z",
      },
      { paths },
    );
    expect(cliManager).toBeDefined();
    if (cliManager === undefined) throw new Error("portable CLI manager was not created");
    const replayPayload = {
      expectedTarget: windowsPortableQualificationTargetReference(candidate),
      source: {
        kind: "GITHUB_ACTIONS_RUN" as const,
        repository: "hunterzheng1/hunter-pi" as const,
        runId,
      },
      deadline: "2026-08-11T12:41:00.000Z",
      cancellationPolicy: {
        mode: "FAIL_CLOSED" as const,
        timeoutMs: observedTimeout,
      },
    };
    const replayFingerprint = windowsPortableQualificationRequestFingerprint(replayPayload);
    const replayOperationId = `op_update-qualify-${String(runId)}-${replayFingerprint.slice(
      "sha256:".length,
      "sha256:".length + 16,
    )}` as const;
    await expect(
      cliManager.qualify({
        schemaVersion: "hpi-update-qualification.v1",
        operationId: replayOperationId,
        operationFingerprint: replayFingerprint,
        ...replayPayload,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).resolves.toEqual(first);
  });
});
