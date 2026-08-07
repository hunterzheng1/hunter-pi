import { spawnSync } from "node:child_process";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectHpiPilotTarget } from "@hunter-pi/cli";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const roots: string[] = [];

function runGit(repository: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function createGitFixture(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-target-test-");
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  runGit(repository, ["init", "--quiet", "--initial-branch=main"]);
  runGit(repository, ["config", "user.name", "Hunter Pi Target Test"]);
  runGit(repository, ["config", "user.email", "hunter-pi-target@example.invalid"]);
  await writeFile(join(repository, "README.md"), "target fixture\n", "utf8");
  runGit(repository, ["add", "--", "README.md"]);
  runGit(repository, ["commit", "--quiet", "-m", "Initialize target fixture"]);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })),
  );
});

describe("Task 12 pilot target inspection", () => {
  it("returns a path-free identity for a clean physical Git root", async () => {
    const repository = await createGitFixture();

    const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");

    expect(receipt.status).toBe("READY");
    expect(receipt.targetId).toBe("repository-alpha");
    expect(receipt.repositoryFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.targetReferenceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain(repository);
  });

  it("blocks a dirty root without exposing its path or fingerprints", async () => {
    const repository = await createGitFixture();
    await writeFile(join(repository, "dirty.txt"), "uncommitted\n", "utf8");

    const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");

    expect(receipt).toMatchObject({
      status: "BLOCKED",
      reasons: ["PILOT_TARGET_DIRTY"],
      repositoryFingerprint: null,
      sourceFingerprint: null,
      targetReferenceFingerprint: null,
    });
    expect(JSON.stringify(receipt)).not.toContain(repository);
  });

  it("blocks a detached HEAD because the target reference is not an explicit branch", async () => {
    const repository = await createGitFixture();
    runGit(repository, ["checkout", "--quiet", "--detach", "HEAD"]);

    const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");

    expect(receipt.status).toBe("BLOCKED");
    expect(receipt.reasons).toContain("PILOT_TARGET_DETACHED_HEAD");
    expect(JSON.stringify(receipt)).not.toContain(repository);
  });

  it("blocks a directory symlink or junction without resolving it into a target", async () => {
    const repository = await createGitFixture();
    const linked = join(dirname(repository), "linked-repository");
    await symlink(repository, linked, process.platform === "win32" ? "junction" : "dir");

    const receipt = await inspectHpiPilotTarget(linked, "repository-alpha");

    expect(receipt.status).toBe("BLOCKED");
    expect(receipt.reasons).toContain("PILOT_TARGET_NOT_GIT_ROOT");
    expect(JSON.stringify(receipt)).not.toContain(linked);
  });

  it("does not execute a repository-configured fsmonitor command", async () => {
    const repository = await createGitFixture();
    const script = join(dirname(repository), "pilot-fsmonitor.mjs");
    const marker = join(dirname(repository), "pilot-fsmonitor.marker");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8",
    );
    runGit(repository, ["config", "core.fsmonitor", `node "${script}"`]);

    const receipt = await inspectHpiPilotTarget(repository, "repository-alpha");

    expect(receipt.status).toBe("READY");
    await expect(access(marker)).rejects.toThrow();
  });

  it("blocks a non-root path without exposing the selected path", async () => {
    const repository = await createGitFixture();

    const receipt = await inspectHpiPilotTarget(join(repository, "README.md"), "repository-alpha");

    expect(receipt.status).toBe("BLOCKED");
    expect(receipt.reasons).toContain("PILOT_TARGET_NOT_GIT_ROOT");
    expect(JSON.stringify(receipt)).not.toContain(repository);
  });
});
