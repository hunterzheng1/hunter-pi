import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import * as workspaceModule from "@hunter-pi/workspace";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

interface PreparedWorkspace {
  readonly handle: {
    readonly workspaceId: string;
    readonly directory: string;
    readonly branchName: string;
    readonly baseCommit: string;
  };
  readonly receipt: {
    readonly schemaVersion: "hpi-workspace-receipt.v1";
    readonly action: "PREPARE";
    readonly outcome: "APPLIED";
    readonly workspaceId: string;
    readonly baseCommit: string;
    readonly workspaceFingerprint: string;
    readonly sourceFingerprint: string;
    readonly sourceCheckout: {
      readonly dirty: boolean;
      readonly preserved: boolean;
    };
    readonly reasonCode: null;
    readonly observedAt: string;
  };
}

interface GitWorkspaceManager {
  prepare(request: {
    readonly schemaVersion: "hpi-workspace-prepare.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly workspaceId: string;
    readonly repository: string;
    readonly baseCommit: string;
  }): Promise<PreparedWorkspace>;
  inspect(workspaceId: string): Promise<{
    readonly receipt: {
      readonly schemaVersion: "hpi-branch-hygiene-receipt.v1";
      readonly workspaceId: string;
      readonly decision: "REMOVABLE" | "PRESERVE";
      readonly workspaceFingerprint: string;
      readonly sourceFingerprint: string;
      readonly baseCommit: string;
      readonly headCommit: string;
      readonly workingTree: {
        readonly clean: boolean;
        readonly stagedEntries: number;
        readonly unstagedEntries: number;
        readonly untrackedEntries: number;
        readonly ignoredEntries: number;
      };
      readonly commits: {
        readonly uniqueCommitCount: number;
        readonly unpushedCommitCount: number;
        readonly upstreamStatus: "ABSENT" | "PRESENT";
      };
      readonly branchDisposition: {
        readonly localBranch: "REMOVE" | "PRESERVE";
        readonly recoverability: "BASE_ONLY" | "REMOTE_REF" | "NOT_PROVEN";
        readonly reviewState: "NOT_APPLICABLE" | "NOT_PROVEN";
      };
      readonly linkedEntries: number;
      readonly linkAssessment: {
        readonly status: "PASS" | "BLOCKED";
        readonly escapingTargets: number;
        readonly unresolvedTargets: number;
      };
      readonly reasonCodes: readonly string[];
      readonly observedAt: string;
    };
  }>;
  dispose(request: {
    readonly schemaVersion: "hpi-workspace-dispose.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly workspaceId: string;
  }): Promise<{
    readonly receipt: {
      readonly schemaVersion: "hpi-workspace-disposal-receipt.v1";
      readonly action: "DISPOSE";
      readonly outcome: "APPLIED" | "BLOCKED";
      readonly workspaceId: string;
      readonly worktreeState: "REMOVED" | "PRESERVED";
      readonly registrationState: "REMOVED" | "REGISTERED" | "AMBIGUOUS";
      readonly branchState: "REMOVED" | "PRESERVED";
      readonly reasonCodes: readonly string[];
      readonly observedAt: string;
    };
  }>;
}

type CreateGitWorkspaceManager = (options: {
  readonly ownedRoot: string;
  readonly now?: () => string;
}) => Promise<GitWorkspaceManager>;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function requireCreateManager(): CreateGitWorkspaceManager {
  const value: unknown = Reflect.get(workspaceModule, "createLocalGitWorkspaceManager");
  expect(value, "createLocalGitWorkspaceManager must be exported").toBeTypeOf("function");
  return value as CreateGitWorkspaceManager;
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GIT_AUTHOR_EMAIL: "workspace-fixture@example.invalid",
    GIT_AUTHOR_NAME: "Hunter Pi Workspace Fixture",
    GIT_COMMITTER_EMAIL: "workspace-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Hunter Pi Workspace Fixture",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    USERPROFILE: root,
  };
}

function runGit(repository: string, root: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: gitEnvironment(root),
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`fixture Git command failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function createRepositoryFixture(): Promise<{
  readonly parent: string;
  readonly repository: string;
  readonly ownedRoot: string;
  readonly baseCommit: string;
}> {
  const parent = await createTemporaryTestDirectory(tmpdir(), "hpi-t7-ws-");
  cleanupRoots.push(parent);
  const repository = join(parent, "source repo 测试");
  const ownedRoot = join(parent, "owned worktrees");
  await Promise.all([mkdir(repository), mkdir(ownedRoot)]);
  runGit(repository, parent, ["init", "--quiet", "--initial-branch=main"]);
  await Promise.all([
    writeFile(join(repository, "tracked.txt"), "BASE\n", "utf8"),
    writeFile(join(repository, "staged.txt"), "BASE\n", "utf8"),
    writeFile(join(repository, "filtered.txt"), "FILTER_BASE\n", "utf8"),
    writeFile(join(repository, ".gitattributes"), "filtered.txt filter=hpiunsafe\n", "utf8"),
  ]);
  runGit(repository, parent, [
    "add",
    "--",
    "tracked.txt",
    "staged.txt",
    "filtered.txt",
    ".gitattributes",
  ]);
  runGit(repository, parent, ["commit", "--quiet", "-m", "fixture base"]);
  const baseCommit = runGit(repository, parent, ["rev-parse", "HEAD"]).trim();
  await Promise.all([
    writeFile(join(repository, "tracked.txt"), "UNSTAGED\n", "utf8"),
    writeFile(join(repository, "staged.txt"), "STAGED\n", "utf8"),
    writeFile(join(repository, "untracked.txt"), "UNTRACKED\n", "utf8"),
  ]);
  runGit(repository, parent, ["add", "--", "staged.txt"]);
  return { parent, repository, ownedRoot, baseCommit };
}

describe("local Git Workspace Interface", () => {
  it("prepares an exact clean worktree without changing dirty source-checkout work", async () => {
    const fixture = await createRepositoryFixture();
    const sourceStatusBefore = runGit(fixture.repository, fixture.parent, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:00:00.000Z",
    });

    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-prepare-1",
      operationFingerprint: fingerprint("task7-prepare-1"),
      workspaceId: "workspace_task7-1",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });

    expect(prepared.receipt).toMatchObject({
      schemaVersion: "hpi-workspace-receipt.v1",
      action: "PREPARE",
      outcome: "APPLIED",
      workspaceId: "workspace_task7-1",
      baseCommit: fixture.baseCommit,
      sourceCheckout: { dirty: true, preserved: true },
      reasonCode: null,
      observedAt: "2026-08-04T08:00:00.000Z",
    });
    expect(prepared.receipt.workspaceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(prepared.receipt.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(prepared.receipt)).not.toContain(fixture.parent);
    expect(JSON.stringify(prepared.receipt)).not.toContain(fixture.repository);
    expect(prepared.handle.directory.startsWith(fixture.ownedRoot)).toBe(true);
    expect(prepared.handle.baseCommit).toBe(fixture.baseCommit);
    expect(prepared.handle.branchName).toBe("hpi/workspace_task7-1");
    expect(runGit(prepared.handle.directory, fixture.parent, ["rev-parse", "HEAD"]).trim()).toBe(
      fixture.baseCommit,
    );
    expect(
      runGit(prepared.handle.directory, fixture.parent, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).toBe("");
    expect(
      runGit(fixture.repository, fixture.parent, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ).toBe(sourceStatusBefore);
  });

  it("returns the original prepared workspace for an exact operation replay", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:00:00.000Z",
    });
    const request = {
      schemaVersion: "hpi-workspace-prepare.v1" as const,
      operationId: "op_task7-replay-1",
      operationFingerprint: fingerprint("task7-replay-1"),
      workspaceId: "workspace_task7-replay-1",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    };

    const first = await manager.prepare(request);
    const replay = await manager.prepare({ ...request });

    expect(replay).toEqual(first);
    const registered = runGit(fixture.repository, fixture.parent, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(registered.match(/^worktree /gmu)).toHaveLength(2);
  });

  it("disables repository hooks while preparing an owned worktree", async () => {
    const fixture = await createRepositoryFixture();
    const hookPath = join(fixture.repository, ".git", "hooks", "post-checkout");
    const hookSentinel = join(fixture.ownedRoot, "hook-was-run.txt");
    await writeFile(hookPath, "#!/bin/sh\nprintf 'HOOK_RAN' > ../hook-was-run.txt\n", "utf8");
    await chmod(hookPath, 0o755);
    const manager = await requireCreateManager()({ ownedRoot: fixture.ownedRoot });

    await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-hook-neutralization",
      operationFingerprint: fingerprint("task7-hook-neutralization"),
      workspaceId: "workspace_task7-hook-neutralization",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });

    await expect(access(hookSentinel)).rejects.toThrow();
  });

  it("neutralizes repository-configured checkout filters", async () => {
    const fixture = await createRepositoryFixture();
    const filterPath = join(fixture.parent, "unsafe-filter.sh");
    const filterSentinel = join(fixture.ownedRoot, "filter-was-run.txt");
    await writeFile(
      filterPath,
      "#!/bin/sh\nprintf 'FILTER_RAN' > ../owned\\ worktrees/filter-was-run.txt\ncat\n",
      "utf8",
    );
    await chmod(filterPath, 0o755);
    runGit(fixture.repository, fixture.parent, [
      "config",
      "filter.hpiunsafe.smudge",
      `"${filterPath.replaceAll("\\", "/")}"`,
    ]);
    runGit(fixture.repository, fixture.parent, ["config", "filter.hpiunsafe.required", "true"]);
    const manager = await requireCreateManager()({ ownedRoot: fixture.ownedRoot });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-filter-neutralization",
      operationFingerprint: fingerprint("task7-filter-neutralization"),
      workspaceId: "workspace_task7-filter-neutralization",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });

    await expect(access(filterSentinel)).rejects.toThrow();
    await expect(readFile(join(prepared.handle.directory, "filtered.txt"), "utf8")).resolves.toBe(
      "FILTER_BASE\n",
    );
  });

  it("preserves ignored files instead of deleting them with an otherwise clean worktree", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(join(fixture.repository, ".git", "info", "exclude"), "ignored.log\n", "utf8");
    const manager = await requireCreateManager()({ ownedRoot: fixture.ownedRoot });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-ignored-prepare",
      operationFingerprint: fingerprint("task7-ignored-prepare"),
      workspaceId: "workspace_task7-ignored",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const ignoredFile = join(prepared.handle.directory, "ignored.log");
    await writeFile(ignoredFile, "PRESERVE\n", "utf8");

    await expect(manager.inspect(prepared.handle.workspaceId)).resolves.toMatchObject({
      receipt: {
        decision: "PRESERVE",
        workingTree: { clean: false, ignoredEntries: 1 },
        reasonCodes: ["IGNORED_CONTENT"],
      },
    });
    await expect(
      manager.dispose({
        schemaVersion: "hpi-workspace-dispose.v1",
        operationId: "op_task7-ignored-dispose",
        operationFingerprint: fingerprint("task7-ignored-dispose"),
        workspaceId: prepared.handle.workspaceId,
      }),
    ).resolves.toMatchObject({ receipt: { outcome: "BLOCKED", reasonCodes: ["IGNORED_CONTENT"] } });
    await expect(readFile(ignoredFile, "utf8")).resolves.toBe("PRESERVE\n");
  });

  it("detects same-shape source content drift and compensates the created worktree", async () => {
    const fixture = await createRepositoryFixture();
    const workspaceId = "workspace_task7-source-race";
    const destination = join(fixture.ownedRoot, workspaceId);
    const manager = await requireCreateManager()({ ownedRoot: fixture.ownedRoot });
    const prepare = manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-source-race",
      operationFingerprint: fingerprint("task7-source-race"),
      workspaceId,
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const mutateSource = (async () => {
      for (let attempt = 0; attempt < 5_000; attempt += 1) {
        try {
          await access(destination);
          await writeFile(join(fixture.repository, "tracked.txt"), "RACE_CHANGED\n", "utf8");
          return;
        } catch {
          await delay(1);
        }
      }
      throw new Error("fixture did not observe the created worktree");
    })();

    await expect(prepare).rejects.toThrow(/source checkout changed/u);
    await mutateSource;
    await expect(access(destination)).rejects.toThrow();
    expect(
      runGit(fixture.repository, fixture.parent, ["branch", "--list", `hpi/${workspaceId}`]),
    ).toBe("");
    expect(
      runGit(fixture.repository, fixture.parent, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gmu,
      ),
    ).toHaveLength(1);
  });

  it("returns a blocked receipt when the physical worktree disappears but registration remains", async () => {
    const fixture = await createRepositoryFixture();
    const manager = await requireCreateManager()({ ownedRoot: fixture.ownedRoot });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-missing-physical-prepare",
      operationFingerprint: fingerprint("task7-missing-physical-prepare"),
      workspaceId: "workspace_task7-missing-physical",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    await rm(prepared.handle.directory, { force: true, recursive: true });

    await expect(
      manager.dispose({
        schemaVersion: "hpi-workspace-dispose.v1",
        operationId: "op_task7-missing-physical-dispose",
        operationFingerprint: fingerprint("task7-missing-physical-dispose"),
        workspaceId: prepared.handle.workspaceId,
      }),
    ).resolves.toMatchObject({
      receipt: {
        outcome: "BLOCKED",
        worktreeState: "REMOVED",
        registrationState: "AMBIGUOUS",
        branchState: "PRESERVED",
        reasonCodes: ["CLEANUP_AMBIGUOUS"],
      },
    });
  });

  it("rejects an operation replay whose fingerprint or canonical request changed", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({ ownedRoot: fixture.ownedRoot });
    const request = {
      schemaVersion: "hpi-workspace-prepare.v1" as const,
      operationId: "op_task7-replay-conflict",
      operationFingerprint: fingerprint("task7-replay-original"),
      workspaceId: "workspace_task7-replay-original",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    };
    await manager.prepare(request);

    await expect(
      manager.prepare({
        ...request,
        operationFingerprint: fingerprint("task7-replay-changed"),
        workspaceId: "workspace_task7-replay-changed",
      }),
    ).rejects.toThrow(/operation replay/u);
  });

  it("preserves a worktree and branch that contain an unpushed unique commit", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:15:00.000Z",
    });
    expect(Reflect.get(manager, "inspect"), "inspect must be part of the Interface").toBeTypeOf(
      "function",
    );
    expect(Reflect.get(manager, "dispose"), "dispose must be part of the Interface").toBeTypeOf(
      "function",
    );
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-preserve-prepare",
      operationFingerprint: fingerprint("task7-preserve-prepare"),
      workspaceId: "workspace_task7-preserve",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    await writeFile(join(prepared.handle.directory, "unique.txt"), "UNPUSHED\n", "utf8");
    runGit(prepared.handle.directory, fixture.parent, ["add", "--", "unique.txt"]);
    runGit(prepared.handle.directory, fixture.parent, [
      "commit",
      "--quiet",
      "-m",
      "unique unpushed work",
    ]);

    const hygiene = await manager.inspect(prepared.handle.workspaceId);
    expect(hygiene.receipt).toMatchObject({
      schemaVersion: "hpi-branch-hygiene-receipt.v1",
      workspaceId: prepared.handle.workspaceId,
      decision: "PRESERVE",
      baseCommit: fixture.baseCommit,
      workingTree: {
        clean: true,
        stagedEntries: 0,
        unstagedEntries: 0,
        untrackedEntries: 0,
      },
      commits: {
        uniqueCommitCount: 1,
        unpushedCommitCount: 1,
        upstreamStatus: "ABSENT",
      },
      linkedEntries: 0,
      reasonCodes: ["UNPUSHED_COMMITS"],
      observedAt: "2026-08-04T08:15:00.000Z",
    });
    expect(hygiene.receipt.headCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(JSON.stringify(hygiene.receipt)).not.toContain(fixture.parent);

    const disposal = await manager.dispose({
      schemaVersion: "hpi-workspace-dispose.v1",
      operationId: "op_task7-preserve-dispose",
      operationFingerprint: fingerprint("task7-preserve-dispose"),
      workspaceId: prepared.handle.workspaceId,
    });
    expect(disposal.receipt).toMatchObject({
      schemaVersion: "hpi-workspace-disposal-receipt.v1",
      action: "DISPOSE",
      outcome: "BLOCKED",
      workspaceId: prepared.handle.workspaceId,
      worktreeState: "PRESERVED",
      registrationState: "REGISTERED",
      branchState: "PRESERVED",
      reasonCodes: ["UNPUSHED_COMMITS"],
      observedAt: "2026-08-04T08:15:00.000Z",
    });
    await expect(access(prepared.handle.directory)).resolves.toBeUndefined();
    const registered = runGit(fixture.repository, fixture.parent, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(registered).toContain(prepared.handle.directory.replaceAll("\\", "/"));
    expect(
      runGit(fixture.repository, fixture.parent, ["branch", "--list", prepared.handle.branchName]),
    ).not.toBe("");
  });

  it("removes only a clean owned worktree and its zero-unique-commit local branch", async () => {
    const fixture = await createRepositoryFixture();
    const sourceStatusBefore = runGit(fixture.repository, fixture.parent, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:20:00.000Z",
    });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-remove-prepare",
      operationFingerprint: fingerprint("task7-remove-prepare"),
      workspaceId: "workspace_task7-remove",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const hygiene = await manager.inspect(prepared.handle.workspaceId);
    expect(hygiene.receipt).toMatchObject({
      decision: "REMOVABLE",
      workingTree: { clean: true },
      commits: { uniqueCommitCount: 0, unpushedCommitCount: 0, upstreamStatus: "ABSENT" },
      linkedEntries: 0,
      reasonCodes: [],
    });

    const disposal = await manager.dispose({
      schemaVersion: "hpi-workspace-dispose.v1",
      operationId: "op_task7-remove-dispose",
      operationFingerprint: fingerprint("task7-remove-dispose"),
      workspaceId: prepared.handle.workspaceId,
    });
    expect(disposal.receipt).toMatchObject({
      schemaVersion: "hpi-workspace-disposal-receipt.v1",
      action: "DISPOSE",
      outcome: "APPLIED",
      workspaceId: prepared.handle.workspaceId,
      worktreeState: "REMOVED",
      registrationState: "REMOVED",
      branchState: "REMOVED",
      reasonCodes: [],
      observedAt: "2026-08-04T08:20:00.000Z",
    });
    expect(JSON.stringify(disposal.receipt)).not.toContain(fixture.parent);
    await expect(access(prepared.handle.directory)).rejects.toThrow();
    const registered = runGit(fixture.repository, fixture.parent, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(registered).not.toContain(prepared.handle.directory.replaceAll("\\", "/"));
    expect(
      runGit(fixture.repository, fixture.parent, ["branch", "--list", prepared.handle.branchName]),
    ).toBe("");
    expect(
      runGit(fixture.repository, fixture.parent, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ).toBe(sourceStatusBefore);
  });

  it("blocks cleanup without traversing a junction or symlink that escapes the owned worktree", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:25:00.000Z",
    });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-link-prepare",
      operationFingerprint: fingerprint("task7-link-prepare"),
      workspaceId: "workspace_task7-link",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const outsideTarget = join(fixture.parent, "outside link target");
    await mkdir(outsideTarget);
    const sentinel = join(outsideTarget, "sentinel.txt");
    await writeFile(sentinel, "PRESERVE\n", "utf8");
    await symlink(
      outsideTarget,
      join(prepared.handle.directory, "escape-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const hygiene = await manager.inspect(prepared.handle.workspaceId);
    expect(hygiene.receipt).toMatchObject({
      decision: "PRESERVE",
      linkedEntries: 1,
      linkAssessment: {
        status: "BLOCKED",
        escapingTargets: 1,
        unresolvedTargets: 0,
      },
      reasonCodes: ["DIRTY_WORKTREE", "UNSAFE_LINKS"],
    });

    const disposal = await manager.dispose({
      schemaVersion: "hpi-workspace-dispose.v1",
      operationId: "op_task7-link-dispose",
      operationFingerprint: fingerprint("task7-link-dispose"),
      workspaceId: prepared.handle.workspaceId,
    });
    expect(disposal.receipt).toMatchObject({
      outcome: "BLOCKED",
      worktreeState: "PRESERVED",
      registrationState: "REGISTERED",
      branchState: "PRESERVED",
      reasonCodes: ["DIRTY_WORKTREE", "UNSAFE_LINKS"],
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("PRESERVE\n");
    await expect(access(prepared.handle.directory)).resolves.toBeUndefined();
  });

  it("removes a clean worktree but preserves its pushed unmerged branch", async () => {
    const fixture = await createRepositoryFixture();
    const remote = join(fixture.parent, "fixture-remote.git");
    runGit(fixture.parent, fixture.parent, ["init", "--quiet", "--bare", remote]);
    runGit(fixture.repository, fixture.parent, ["remote", "add", "origin", remote]);
    runGit(fixture.repository, fixture.parent, [
      "push",
      "--quiet",
      "--set-upstream",
      "origin",
      "main",
    ]);
    const createManager = requireCreateManager();
    const manager = await createManager({
      ownedRoot: fixture.ownedRoot,
      now: () => "2026-08-04T08:30:00.000Z",
    });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-pushed-prepare",
      operationFingerprint: fingerprint("task7-pushed-prepare"),
      workspaceId: "workspace_task7-pushed",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    await writeFile(join(prepared.handle.directory, "pushed.txt"), "PUSHED\n", "utf8");
    runGit(prepared.handle.directory, fixture.parent, ["add", "--", "pushed.txt"]);
    runGit(prepared.handle.directory, fixture.parent, [
      "commit",
      "--quiet",
      "-m",
      "pushed unique work",
    ]);
    runGit(prepared.handle.directory, fixture.parent, [
      "push",
      "--quiet",
      "--set-upstream",
      "origin",
      prepared.handle.branchName,
    ]);

    const hygiene = await manager.inspect(prepared.handle.workspaceId);
    expect(hygiene.receipt).toMatchObject({
      decision: "REMOVABLE",
      commits: {
        uniqueCommitCount: 1,
        unpushedCommitCount: 0,
        upstreamStatus: "PRESENT",
      },
      branchDisposition: {
        localBranch: "PRESERVE",
        recoverability: "REMOTE_REF",
        reviewState: "NOT_PROVEN",
      },
      reasonCodes: [],
    });

    const disposal = await manager.dispose({
      schemaVersion: "hpi-workspace-dispose.v1",
      operationId: "op_task7-pushed-dispose",
      operationFingerprint: fingerprint("task7-pushed-dispose"),
      workspaceId: prepared.handle.workspaceId,
    });
    expect(disposal.receipt).toMatchObject({
      outcome: "APPLIED",
      worktreeState: "REMOVED",
      registrationState: "REMOVED",
      branchState: "PRESERVED",
      reasonCodes: [],
    });
    await expect(access(prepared.handle.directory)).rejects.toThrow();
    expect(
      runGit(fixture.repository, fixture.parent, ["branch", "--list", prepared.handle.branchName]),
    ).not.toBe("");
    expect(
      runGit(fixture.repository, fixture.parent, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/remotes/origin/${prepared.handle.branchName}`,
      ]).trim(),
    ).toMatch(/^[a-f0-9]{40}$/u);
  }, 15_000);

  it.skipIf(process.platform !== "win32")(
    "returns an ambiguous cleanup receipt while another process owns the worktree cwd",
    async () => {
      const fixture = await createRepositoryFixture();
      const createManager = requireCreateManager();
      const manager = await createManager({
        ownedRoot: fixture.ownedRoot,
        now: () => "2026-08-04T08:35:00.000Z",
      });
      const prepared = await manager.prepare({
        schemaVersion: "hpi-workspace-prepare.v1",
        operationId: "op_task7-ambiguous-prepare",
        operationFingerprint: fingerprint("task7-ambiguous-prepare"),
        workspaceId: "workspace_task7-ambiguous",
        repository: fixture.repository,
        baseCommit: fixture.baseCommit,
      });
      const child = spawn(
        process.execPath,
        ["-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'],
        {
          cwd: prepared.handle.directory,
          env: { SystemRoot: process.env["SystemRoot"], PATH: process.env["PATH"] },
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      try {
        const [ready] = (await once(child.stdout, "data")) as [Buffer];
        expect(ready.toString("utf8")).toContain("READY");

        const disposal = await manager.dispose({
          schemaVersion: "hpi-workspace-dispose.v1",
          operationId: "op_task7-ambiguous-dispose",
          operationFingerprint: fingerprint("task7-ambiguous-dispose"),
          workspaceId: prepared.handle.workspaceId,
        });
        expect(disposal.receipt).toMatchObject({
          outcome: "BLOCKED",
          worktreeState: "PRESERVED",
          branchState: "PRESERVED",
          reasonCodes: ["CLEANUP_AMBIGUOUS"],
        });
        expect(["REGISTERED", "AMBIGUOUS"]).toContain(disposal.receipt.registrationState);
        expect(JSON.stringify(disposal.receipt)).not.toContain(fixture.parent);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill();
          await closed;
        }
      }
    },
  );

  it("rejects a pre-existing destination before Git can mutate or delete it", async () => {
    const fixture = await createRepositoryFixture();
    const destination = join(fixture.ownedRoot, "workspace_task7-existing");
    await mkdir(destination);
    const sentinel = join(destination, "sentinel.txt");
    await writeFile(sentinel, "EXISTING\n", "utf8");
    const sourceStatusBefore = runGit(fixture.repository, fixture.parent, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const createManager = requireCreateManager();
    const manager = await createManager({ ownedRoot: fixture.ownedRoot });

    await expect(
      manager.prepare({
        schemaVersion: "hpi-workspace-prepare.v1",
        operationId: "op_task7-existing-prepare",
        operationFingerprint: fingerprint("task7-existing-prepare"),
        workspaceId: "workspace_task7-existing",
        repository: fixture.repository,
        baseCommit: fixture.baseCommit,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "WORKSPACE_DESTINATION_EXISTS",
      preservedState: "EXISTING_TARGET_UNCHANGED",
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("EXISTING\n");
    expect(
      runGit(fixture.repository, fixture.parent, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ).toBe(sourceStatusBefore);
  });

  it("returns the original disposal receipt for an exact operation replay", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({ ownedRoot: fixture.ownedRoot });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-disposal-replay-prepare",
      operationFingerprint: fingerprint("task7-disposal-replay-prepare"),
      workspaceId: "workspace_task7-disposal-replay",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const request = {
      schemaVersion: "hpi-workspace-dispose.v1" as const,
      operationId: "op_task7-disposal-replay",
      operationFingerprint: fingerprint("task7-disposal-replay"),
      workspaceId: prepared.handle.workspaceId,
    };

    const first = await manager.dispose(request);
    const replay = await manager.dispose({ ...request });

    expect(first.receipt.outcome).toBe("APPLIED");
    expect(replay).toEqual(first);
  });

  it("rejects a disposal operation replay whose fingerprint changed", async () => {
    const fixture = await createRepositoryFixture();
    const createManager = requireCreateManager();
    const manager = await createManager({ ownedRoot: fixture.ownedRoot });
    const prepared = await manager.prepare({
      schemaVersion: "hpi-workspace-prepare.v1",
      operationId: "op_task7-disposal-conflict-prepare",
      operationFingerprint: fingerprint("task7-disposal-conflict-prepare"),
      workspaceId: "workspace_task7-disposal-conflict",
      repository: fixture.repository,
      baseCommit: fixture.baseCommit,
    });
    const request = {
      schemaVersion: "hpi-workspace-dispose.v1" as const,
      operationId: "op_task7-disposal-conflict",
      operationFingerprint: fingerprint("task7-disposal-original"),
      workspaceId: prepared.handle.workspaceId,
    };
    await manager.dispose(request);

    await expect(
      manager.dispose({
        ...request,
        operationFingerprint: fingerprint("task7-disposal-changed"),
      }),
    ).rejects.toThrow(/operation replay/u);
  });
});
