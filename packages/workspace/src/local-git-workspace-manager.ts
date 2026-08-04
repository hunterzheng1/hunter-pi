import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  fingerprintSchema,
  workspaceIdSchema,
  type Fingerprint,
  type WorkspaceId,
} from "@hunter-pi/domain";

import {
  branchHygieneReceiptSchema,
  workspaceDisposalReceiptSchema,
  workspaceDisposeRequestSchema,
  workspacePrepareRequestSchema,
  workspaceReceiptSchema,
  type BranchHygieneReceipt,
  type BranchHygieneReasonCode,
  type GitWorkspaceManager,
  type PreparedWorkspace,
  type WorkspaceDisposalReceipt,
  type WorkspaceDisposeRequest,
  type WorkspaceHandle,
  type WorkspacePrepareRequest,
} from "./contracts.js";
import { WorkspaceError } from "./errors.js";

interface LocalGitWorkspaceManagerOptions {
  readonly ownedRoot: string;
  readonly now?: () => string;
}

function sha256(value: string | Buffer): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function gitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_GLOBAL: join(root, ".hpi-empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    USERPROFILE: root,
  };
}

function runGit(
  repository: string,
  environmentRoot: string,
  arguments_: readonly string[],
): Buffer {
  const hooksRoot = join(environmentRoot, ".hpi-disabled-hooks");
  const configurationProbe = spawnSync(
    "git",
    ["-C", repository, "config", "--local", "--includes", "--name-only", "--list"],
    {
      env: gitEnvironment(environmentRoot),
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (
    configurationProbe.error !== undefined ||
    configurationProbe.status !== 0 ||
    configurationProbe.stderr.length > 0
  ) {
    throw new Error("owned Git configuration could not be inspected safely");
  }
  const effectiveKeys = configurationProbe.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((key) => key.length > 0);
  if (
    effectiveKeys.some((key) => {
      const normalized = key.toLowerCase();
      return normalized.startsWith("includeif.") || normalized === "extensions.worktreeconfig";
    })
  ) {
    throw new Error("dynamic repository Git configuration is not safe for an owned worktree");
  }
  const filterDrivers = new Set(
    effectiveKeys
      .map((key) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key)?.[1])
      .filter((driver): driver is string => driver !== undefined),
  );
  const safeConfiguration = [
    "-c",
    "core.longpaths=true",
    "-c",
    `core.hooksPath=${hooksRoot}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "submodule.recurse=false",
    ...[...filterDrivers].flatMap((driver) => [
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.smudge=`,
      "-c",
      `filter.${driver}.process=`,
      "-c",
      `filter.${driver}.required=false`,
    ]),
  ];
  const result = spawnSync("git", [...safeConfiguration, "-C", repository, ...arguments_], {
    env: gitEnvironment(environmentRoot),
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("owned Git workspace operation failed");
  }
  return Buffer.from(result.stdout);
}

function assertContained(parent: string, child: string): void {
  if (!isStrictlyContained(parent, child)) {
    throw new Error("owned workspace path escaped its declared root");
  }
}

function isStrictlyContained(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return !(
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  );
}

function parseWorkingTreeCounts(statusOutput: Buffer): {
  readonly stagedEntries: number;
  readonly unstagedEntries: number;
  readonly untrackedEntries: number;
  readonly ignoredEntries: number;
} {
  const records = statusOutput.toString("utf8").split("\0");
  let stagedEntries = 0;
  let unstagedEntries = 0;
  let untrackedEntries = 0;
  let ignoredEntries = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git working-tree status was not understood");
    }
    const status = record.slice(0, 2);
    if (status === "??") {
      untrackedEntries += 1;
      continue;
    }
    if (status === "!!") {
      ignoredEntries += 1;
      continue;
    }
    if (!status.startsWith(" ")) stagedEntries += 1;
    if (!status.endsWith(" ")) unstagedEntries += 1;
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return { stagedEntries, unstagedEntries, untrackedEntries, ignoredEntries };
}

async function hashFile(path: string): Promise<string> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw new Error("source snapshot expected a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error("source checkout changed while it was being fingerprinted");
  }
  return hash.digest("hex");
}

async function fingerprintCheckout(root: string): Promise<string> {
  const hash = createHash("sha256");
  const pending: { readonly directory: string; readonly relativePath: string }[] = [
    { directory: root, relativePath: "" },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const entries = (await readdir(current.directory)).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const entry of entries) {
      if (current.relativePath.length === 0 && entry === ".git") continue;
      const path = join(current.directory, entry);
      const relativePath =
        current.relativePath.length === 0 ? entry : `${current.relativePath}/${entry}`;
      const status = await lstat(path, { bigint: true });
      if (status.isDirectory()) {
        hash.update(`D\0${relativePath}\0${String(status.mode)}\0`);
        pending.push({ directory: path, relativePath });
      } else if (status.isFile()) {
        hash.update(
          `F\0${relativePath}\0${String(status.mode)}\0${String(status.nlink)}\0${String(status.size)}\0`,
        );
        hash.update(await hashFile(path));
      } else if (status.isSymbolicLink()) {
        hash.update(`L\0${relativePath}\0${await readlink(path)}\0`);
      } else {
        throw new Error("source checkout contains an unsupported filesystem entry");
      }
    }
  }
  return hash.digest("hex");
}

async function sourceCheckoutSnapshot(
  repository: string,
  environmentRoot: string,
): Promise<string> {
  const [checkoutFingerprint, status, head, indexPathOutput] = await Promise.all([
    fingerprintCheckout(repository),
    Promise.resolve(
      runGit(repository, environmentRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ]),
    ),
    Promise.resolve(runGit(repository, environmentRoot, ["rev-parse", "HEAD"])),
    Promise.resolve(runGit(repository, environmentRoot, ["rev-parse", "--git-path", "index"])),
  ]);
  const rawIndexPath = indexPathOutput.toString("utf8").trim();
  const indexPath = isAbsolute(rawIndexPath) ? rawIndexPath : resolve(repository, rawIndexPath);
  const indexFingerprint = await hashFile(indexPath);
  return createHash("sha256")
    .update("hpi-source-checkout-snapshot.v1\0")
    .update(checkoutFingerprint)
    .update("\0")
    .update(status)
    .update("\0")
    .update(head)
    .update("\0")
    .update(indexFingerprint)
    .digest("hex");
}

async function inspectLinkedEntries(root: string): Promise<{
  readonly total: number;
  readonly escapingTargets: number;
  readonly unresolvedTargets: number;
}> {
  const pending = [root];
  let total = 0;
  let escapingTargets = 0;
  let unresolvedTargets = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current)) {
      const candidate = join(current, entry);
      const status = await lstat(candidate);
      if (status.isSymbolicLink()) {
        total += 1;
        try {
          const target = await realpath(candidate);
          if (!isStrictlyContained(root, target)) escapingTargets += 1;
        } catch {
          unresolvedTargets += 1;
        }
      } else if (status.isFile() && status.nlink > 1) {
        total += 1;
        unresolvedTargets += 1;
      } else if (status.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
  return { total, escapingTargets, unresolvedTargets };
}

interface OwnedWorkspaceRecord {
  readonly repository: string;
  readonly handle: WorkspaceHandle;
  readonly workspaceFingerprint: Fingerprint;
  readonly sourceFingerprint: Fingerprint;
}

async function requirePhysicalRoot(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error(`${label} must not use a path alias`);
  return canonical;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function worktreeIsRegistered(output: Buffer, directory: string): boolean {
  return output
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .includes(directory);
}

class LocalGitWorkspaceManager implements GitWorkspaceManager {
  readonly #ownedRoot: string;
  readonly #now: () => string;
  readonly #operations = new Map<
    string,
    {
      readonly operationFingerprint: string;
      readonly requestFingerprint: Fingerprint;
      readonly result: PreparedWorkspace;
    }
  >();
  readonly #workspaces = new Map<WorkspaceId, OwnedWorkspaceRecord>();
  readonly #disposalOperations = new Map<
    string,
    {
      readonly operationFingerprint: string;
      readonly requestFingerprint: Fingerprint;
      readonly result: { readonly receipt: WorkspaceDisposalReceipt };
    }
  >();

  public constructor(ownedRoot: string, now: () => string) {
    this.#ownedRoot = ownedRoot;
    this.#now = now;
  }

  public async prepare(request: WorkspacePrepareRequest): Promise<PreparedWorkspace> {
    const parsed = workspacePrepareRequestSchema.parse(request);
    const requestFingerprint = sha256(
      JSON.stringify({
        schemaVersion: parsed.schemaVersion,
        workspaceId: parsed.workspaceId,
        repository: resolve(parsed.repository),
        baseCommit: parsed.baseCommit,
      }),
    );
    const existing = this.#operations.get(parsed.operationId);
    if (existing !== undefined) {
      if (
        existing.operationFingerprint !== parsed.operationFingerprint ||
        existing.requestFingerprint !== requestFingerprint
      ) {
        throw new Error("operation replay changed its fingerprint or canonical request");
      }
      return existing.result;
    }
    const repository = await requirePhysicalRoot(parsed.repository, "repository");
    const topLevel = resolve(
      runGit(repository, this.#ownedRoot, ["rev-parse", "--show-toplevel"]).toString("utf8").trim(),
    );
    if (topLevel !== repository) throw new Error("repository must be the exact Git root");

    const resolvedBaseCommit = runGit(repository, this.#ownedRoot, [
      "rev-parse",
      "--verify",
      `${parsed.baseCommit}^{commit}`,
    ])
      .toString("utf8")
      .trim();
    if (resolvedBaseCommit !== parsed.baseCommit) {
      throw new Error("baseCommit does not resolve to the exact declared commit");
    }
    const baseTree = runGit(repository, this.#ownedRoot, [
      "rev-parse",
      `${parsed.baseCommit}^{tree}`,
    ])
      .toString("utf8")
      .trim();
    const sourceStatusBefore = runGit(repository, this.#ownedRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const sourceSnapshotBefore = await sourceCheckoutSnapshot(repository, this.#ownedRoot);
    const branchName = `hpi/${parsed.workspaceId}`;
    const destination = resolve(join(this.#ownedRoot, parsed.workspaceId));
    assertContained(this.#ownedRoot, destination);
    if (await pathExists(destination)) {
      throw new WorkspaceError(
        "WORKSPACE_DESTINATION_EXISTS",
        "owned workspace destination already exists",
        "EXISTING_TARGET_UNCHANGED",
      );
    }

    const sourceFingerprint = sha256(`hpi-git-source.v1\0${parsed.baseCommit}\0${baseTree}`);
    const workspaceFingerprint = sha256(
      JSON.stringify({
        schemaVersion: "hpi-workspace-fingerprint.v2",
        workspaceId: parsed.workspaceId,
        operationId: parsed.operationId,
        operationFingerprint: parsed.operationFingerprint,
        baseCommit: parsed.baseCommit,
        branchName,
        sourceFingerprint,
      }),
    );
    const provisional: OwnedWorkspaceRecord = {
      repository,
      handle: {
        workspaceId: parsed.workspaceId,
        directory: destination,
        branchName,
        baseCommit: parsed.baseCommit,
      },
      workspaceFingerprint,
      sourceFingerprint,
    };
    let branchCreated = false;
    let canonicalDestination: string;
    try {
      runGit(repository, this.#ownedRoot, ["branch", "--no-track", branchName, parsed.baseCommit]);
      branchCreated = true;
      runGit(repository, this.#ownedRoot, ["worktree", "add", "--quiet", destination, branchName]);
      this.#workspaces.set(parsed.workspaceId, provisional);

      canonicalDestination = await requirePhysicalRoot(destination, "created worktree");
      assertContained(this.#ownedRoot, canonicalDestination);
      const worktreeTopLevel = resolve(
        runGit(canonicalDestination, this.#ownedRoot, ["rev-parse", "--show-toplevel"])
          .toString("utf8")
          .trim(),
      );
      const worktreeHead = runGit(canonicalDestination, this.#ownedRoot, ["rev-parse", "HEAD"])
        .toString("utf8")
        .trim();
      const worktreeStatus = runGit(canonicalDestination, this.#ownedRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ]);
      const [sourceStatusAfter, sourceSnapshotAfter] = await Promise.all([
        Promise.resolve(
          runGit(repository, this.#ownedRoot, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]),
        ),
        sourceCheckoutSnapshot(repository, this.#ownedRoot),
      ]);
      if (
        worktreeTopLevel !== canonicalDestination ||
        worktreeHead !== parsed.baseCommit ||
        worktreeStatus.length !== 0
      ) {
        throw new Error("created worktree did not match its declared clean identity");
      }
      if (
        !sourceStatusAfter.equals(sourceStatusBefore) ||
        sourceSnapshotAfter !== sourceSnapshotBefore
      ) {
        throw new Error("source checkout changed while preparing the owned worktree");
      }
    } catch (error) {
      if (branchCreated) {
        const compensated = await this.#compensateFailedPrepare(provisional);
        if (compensated) this.#workspaces.delete(parsed.workspaceId);
        else {
          throw new Error(
            `${error instanceof Error ? error.message : "workspace preparation failed"}; created worktree reconciliation was not proven`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    const receipt = workspaceReceiptSchema.parse({
      schemaVersion: "hpi-workspace-receipt.v1",
      action: "PREPARE",
      outcome: "APPLIED",
      workspaceId: parsed.workspaceId,
      baseCommit: parsed.baseCommit,
      workspaceFingerprint,
      sourceFingerprint,
      sourceCheckout: {
        dirty: sourceStatusBefore.length > 0,
        preserved: true,
      },
      reasonCode: null,
      observedAt: this.#now(),
    });
    const result = {
      handle: {
        workspaceId: parsed.workspaceId,
        directory: canonicalDestination,
        branchName,
        baseCommit: parsed.baseCommit,
      },
      receipt,
    };
    this.#operations.set(parsed.operationId, {
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint,
      result,
    });
    this.#workspaces.set(parsed.workspaceId, {
      ...provisional,
      handle: result.handle,
    });
    return result;
  }

  async #compensateFailedPrepare(workspace: OwnedWorkspaceRecord): Promise<boolean> {
    try {
      const [physicalPathExists, registrationOutput] = await Promise.all([
        pathExists(workspace.handle.directory),
        Promise.resolve(
          runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
        ),
      ]);
      const registrationExists = worktreeIsRegistered(
        registrationOutput,
        workspace.handle.directory,
      );
      if (registrationExists) {
        if (!physicalPathExists) return false;
        const directory = await requirePhysicalRoot(
          workspace.handle.directory,
          "failed created worktree",
        );
        assertContained(this.#ownedRoot, directory);
        const [head, branch, status, links] = await Promise.all([
          Promise.resolve(
            runGit(directory, this.#ownedRoot, ["rev-parse", "HEAD"]).toString("utf8").trim(),
          ),
          Promise.resolve(
            runGit(directory, this.#ownedRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
              .toString("utf8")
              .trim(),
          ),
          Promise.resolve(
            runGit(directory, this.#ownedRoot, [
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
              "--ignored=matching",
            ]),
          ),
          inspectLinkedEntries(directory),
        ]);
        if (
          head !== workspace.handle.baseCommit ||
          branch !== workspace.handle.branchName ||
          status.length !== 0 ||
          links.total !== 0
        ) {
          return false;
        }
        runGit(workspace.repository, this.#ownedRoot, [
          "worktree",
          "remove",
          workspace.handle.directory,
        ]);
        if (
          (await pathExists(workspace.handle.directory)) ||
          worktreeIsRegistered(
            runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
            workspace.handle.directory,
          )
        ) {
          return false;
        }
      }
      const branchHead = runGit(workspace.repository, this.#ownedRoot, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${workspace.handle.branchName}`,
      ])
        .toString("utf8")
        .trim();
      if (branchHead.length === 0) {
        return !physicalPathExists && !registrationExists;
      }
      if (branchHead !== workspace.handle.baseCommit) return false;
      runGit(workspace.repository, this.#ownedRoot, [
        "branch",
        "-d",
        "--",
        workspace.handle.branchName,
      ]);
      return (
        runGit(workspace.repository, this.#ownedRoot, [
          "branch",
          "--list",
          workspace.handle.branchName,
        ]).length === 0 &&
        !(await pathExists(workspace.handle.directory)) &&
        !worktreeIsRegistered(
          runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
          workspace.handle.directory,
        )
      );
    } catch {
      return false;
    }
  }

  public async inspect(
    workspaceId: WorkspaceId,
  ): Promise<{ readonly receipt: BranchHygieneReceipt }> {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    const workspace = this.#workspaces.get(parsedWorkspaceId);
    if (workspace === undefined) throw new Error("workspace is not owned by this manager");

    const directory = await requirePhysicalRoot(workspace.handle.directory, "owned worktree");
    assertContained(this.#ownedRoot, directory);
    const [headCommit, branchName, mergeBase, statusOutput, upstreamReference, links] =
      await Promise.all([
        Promise.resolve(
          runGit(directory, this.#ownedRoot, ["rev-parse", "HEAD"]).toString("utf8").trim(),
        ),
        Promise.resolve(
          runGit(directory, this.#ownedRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
            .toString("utf8")
            .trim(),
        ),
        Promise.resolve(
          runGit(directory, this.#ownedRoot, ["merge-base", workspace.handle.baseCommit, "HEAD"])
            .toString("utf8")
            .trim(),
        ),
        Promise.resolve(
          runGit(directory, this.#ownedRoot, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
          ]),
        ),
        Promise.resolve(
          runGit(workspace.repository, this.#ownedRoot, [
            "for-each-ref",
            "--format=%(upstream)",
            `refs/heads/${workspace.handle.branchName}`,
          ])
            .toString("utf8")
            .trim(),
        ),
        inspectLinkedEntries(directory),
      ]);
    const workingTree = parseWorkingTreeCounts(statusOutput);
    const uniqueCommitCount = Number.parseInt(
      runGit(directory, this.#ownedRoot, [
        "rev-list",
        "--count",
        `${workspace.handle.baseCommit}..${headCommit}`,
      ])
        .toString("utf8")
        .trim(),
      10,
    );
    const unpushedCommitCount =
      upstreamReference.length === 0
        ? uniqueCommitCount
        : Number.parseInt(
            runGit(directory, this.#ownedRoot, [
              "rev-list",
              "--count",
              `${upstreamReference}..${headCommit}`,
            ])
              .toString("utf8")
              .trim(),
            10,
          );
    const reasonCodes: BranchHygieneReasonCode[] = [];
    if (
      workingTree.stagedEntries > 0 ||
      workingTree.unstagedEntries > 0 ||
      workingTree.untrackedEntries > 0
    ) {
      reasonCodes.push("DIRTY_WORKTREE");
    }
    if (workingTree.ignoredEntries > 0) reasonCodes.push("IGNORED_CONTENT");
    if (unpushedCommitCount > 0) reasonCodes.push("UNPUSHED_COMMITS");
    if (links.total > 0) reasonCodes.push("UNSAFE_LINKS");
    if (
      headCommit.length !== workspace.handle.baseCommit.length ||
      branchName !== workspace.handle.branchName ||
      mergeBase !== workspace.handle.baseCommit
    ) {
      reasonCodes.push("WORKSPACE_IDENTITY_DRIFT");
    }
    const branchDisposition =
      uniqueCommitCount === 0
        ? {
            localBranch: "REMOVE" as const,
            recoverability: "BASE_ONLY" as const,
            reviewState: "NOT_APPLICABLE" as const,
          }
        : upstreamReference.length > 0 && unpushedCommitCount === 0
          ? {
              localBranch: "PRESERVE" as const,
              recoverability: "REMOTE_REF" as const,
              reviewState: "NOT_PROVEN" as const,
            }
          : {
              localBranch: "PRESERVE" as const,
              recoverability: "NOT_PROVEN" as const,
              reviewState: "NOT_PROVEN" as const,
            };
    const observedAt = this.#now();
    const hygieneFingerprint = sha256(
      JSON.stringify({
        schemaVersion: "hpi-branch-hygiene-fingerprint.v1",
        workspaceId: parsedWorkspaceId,
        workspaceFingerprint: workspace.workspaceFingerprint,
        sourceFingerprint: workspace.sourceFingerprint,
        baseCommit: workspace.handle.baseCommit,
        headCommit,
        workingTree,
        uniqueCommitCount,
        unpushedCommitCount,
        upstreamStatus: upstreamReference.length === 0 ? "ABSENT" : "PRESENT",
        branchDisposition,
        linkedEntries: links.total,
        linkAssessment: {
          status: links.total === 0 ? "PASS" : "BLOCKED",
          escapingTargets: links.escapingTargets,
          unresolvedTargets: links.unresolvedTargets,
        },
        reasonCodes,
      }),
    );
    return {
      receipt: branchHygieneReceiptSchema.parse({
        schemaVersion: "hpi-branch-hygiene-receipt.v1",
        workspaceId: parsedWorkspaceId,
        decision: reasonCodes.length === 0 ? "REMOVABLE" : "PRESERVE",
        workspaceFingerprint: workspace.workspaceFingerprint,
        sourceFingerprint: workspace.sourceFingerprint,
        hygieneFingerprint,
        baseCommit: workspace.handle.baseCommit,
        headCommit,
        workingTree: {
          clean:
            !reasonCodes.includes("DIRTY_WORKTREE") && !reasonCodes.includes("IGNORED_CONTENT"),
          ...workingTree,
        },
        commits: {
          uniqueCommitCount,
          unpushedCommitCount,
          upstreamStatus: upstreamReference.length === 0 ? "ABSENT" : "PRESENT",
        },
        branchDisposition,
        linkedEntries: links.total,
        linkAssessment: {
          status: links.total === 0 ? "PASS" : "BLOCKED",
          escapingTargets: links.escapingTargets,
          unresolvedTargets: links.unresolvedTargets,
        },
        reasonCodes,
        observedAt,
      }),
    };
  }

  public async dispose(
    request: WorkspaceDisposeRequest,
  ): Promise<{ readonly receipt: WorkspaceDisposalReceipt }> {
    const parsed = workspaceDisposeRequestSchema.parse(request);
    const requestFingerprint = sha256(
      JSON.stringify({
        schemaVersion: parsed.schemaVersion,
        workspaceId: parsed.workspaceId,
        workspaceFingerprint: parsed.workspaceFingerprint,
      }),
    );
    const existing = this.#disposalOperations.get(parsed.operationId);
    if (existing !== undefined) {
      if (
        existing.operationFingerprint !== parsed.operationFingerprint ||
        existing.requestFingerprint !== requestFingerprint
      ) {
        throw new Error("operation replay changed its fingerprint or canonical request");
      }
      return existing.result;
    }
    const workspace = this.#workspaces.get(parsed.workspaceId);
    if (workspace === undefined) throw new Error("workspace is not owned by this manager");
    if (workspace.workspaceFingerprint !== parsed.workspaceFingerprint) {
      const [physicalPathExists, registrationOutput, branchOutput] = await Promise.all([
        pathExists(workspace.handle.directory),
        Promise.resolve(
          runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
        ),
        Promise.resolve(
          runGit(workspace.repository, this.#ownedRoot, [
            "for-each-ref",
            "--format=%(refname)",
            `refs/heads/${workspace.handle.branchName}`,
          ]),
        ),
      ]);
      const registrationExists = worktreeIsRegistered(
        registrationOutput,
        workspace.handle.directory,
      );
      const branchRemains = branchOutput.toString("utf8").trim().length > 0;
      const result = {
        receipt: workspaceDisposalReceiptSchema.parse({
          schemaVersion: "hpi-workspace-disposal-receipt.v1",
          action: "DISPOSE",
          outcome: "BLOCKED",
          workspaceId: parsed.workspaceId,
          workspaceFingerprint: parsed.workspaceFingerprint,
          hygieneFingerprint: sha256(
            JSON.stringify({
              schemaVersion: "hpi-workspace-stale-disposal.v1",
              expectedWorkspaceFingerprint: parsed.workspaceFingerprint,
              currentWorkspaceFingerprint: workspace.workspaceFingerprint,
              physicalPathExists,
              registrationExists,
              branchRemains,
            }),
          ),
          worktreeState: physicalPathExists ? "PRESERVED" : "REMOVED",
          registrationState:
            physicalPathExists === registrationExists
              ? registrationExists
                ? "REGISTERED"
                : "REMOVED"
              : "AMBIGUOUS",
          branchState: branchRemains ? "PRESERVED" : "REMOVED",
          reasonCodes: ["WORKSPACE_IDENTITY_DRIFT"],
          observedAt: this.#now(),
        }),
      };
      this.#disposalOperations.set(parsed.operationId, {
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        result,
      });
      return result;
    }
    const [physicalPathExists, registrationOutput] = await Promise.all([
      pathExists(workspace.handle.directory),
      Promise.resolve(
        runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
      ),
    ]);
    const registrationExists = worktreeIsRegistered(registrationOutput, workspace.handle.directory);
    if (!physicalPathExists || !registrationExists) {
      const branchRemains =
        runGit(workspace.repository, this.#ownedRoot, [
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${workspace.handle.branchName}`,
        ])
          .toString("utf8")
          .trim().length > 0;
      const result = {
        receipt: workspaceDisposalReceiptSchema.parse({
          schemaVersion: "hpi-workspace-disposal-receipt.v1",
          action: "DISPOSE",
          outcome: "BLOCKED",
          workspaceId: parsed.workspaceId,
          workspaceFingerprint: parsed.workspaceFingerprint,
          hygieneFingerprint: sha256(
            JSON.stringify({
              schemaVersion: "hpi-workspace-mismatch.v1",
              workspaceFingerprint: workspace.workspaceFingerprint,
              physicalPathExists,
              registrationExists,
              branchRemains,
            }),
          ),
          worktreeState: physicalPathExists ? "PRESERVED" : "REMOVED",
          registrationState:
            physicalPathExists === registrationExists
              ? registrationExists
                ? "REGISTERED"
                : "REMOVED"
              : "AMBIGUOUS",
          branchState: branchRemains ? "PRESERVED" : "REMOVED",
          reasonCodes: ["CLEANUP_AMBIGUOUS"],
          observedAt: this.#now(),
        }),
      };
      this.#disposalOperations.set(parsed.operationId, {
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        result,
      });
      return result;
    }
    const hygiene = await this.inspect(parsed.workspaceId);
    if (hygiene.receipt.decision === "REMOVABLE") {
      const sourceSnapshotBefore = await sourceCheckoutSnapshot(
        workspace.repository,
        this.#ownedRoot,
      );
      try {
        runGit(workspace.repository, this.#ownedRoot, [
          "worktree",
          "remove",
          workspace.handle.directory,
        ]);
      } catch {
        const physicalPathRemains = await pathExists(workspace.handle.directory);
        const registrationRemains = worktreeIsRegistered(
          runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
          workspace.handle.directory,
        );
        const branchRemains =
          runGit(workspace.repository, this.#ownedRoot, [
            "for-each-ref",
            "--format=%(refname)",
            `refs/heads/${workspace.handle.branchName}`,
          ])
            .toString("utf8")
            .trim().length > 0;
        const sourceSnapshotAfterFailure = await sourceCheckoutSnapshot(
          workspace.repository,
          this.#ownedRoot,
        );
        if (sourceSnapshotAfterFailure !== sourceSnapshotBefore) {
          throw new Error("source checkout changed during an ambiguous worktree cleanup");
        }
        const result = {
          receipt: workspaceDisposalReceiptSchema.parse({
            schemaVersion: "hpi-workspace-disposal-receipt.v1",
            action: "DISPOSE",
            outcome: "BLOCKED",
            workspaceId: parsed.workspaceId,
            workspaceFingerprint: parsed.workspaceFingerprint,
            hygieneFingerprint: hygiene.receipt.hygieneFingerprint,
            worktreeState: physicalPathRemains ? "PRESERVED" : "REMOVED",
            registrationState:
              physicalPathRemains === registrationRemains
                ? registrationRemains
                  ? "REGISTERED"
                  : "REMOVED"
                : "AMBIGUOUS",
            branchState: branchRemains ? "PRESERVED" : "REMOVED",
            reasonCodes: ["CLEANUP_AMBIGUOUS"],
            observedAt: this.#now(),
          }),
        };
        this.#disposalOperations.set(parsed.operationId, {
          operationFingerprint: parsed.operationFingerprint,
          requestFingerprint,
          result,
        });
        return result;
      }
      const [physicalPathRemains, registrationRemains] = await Promise.all([
        pathExists(workspace.handle.directory),
        Promise.resolve(
          worktreeIsRegistered(
            runGit(workspace.repository, this.#ownedRoot, ["worktree", "list", "--porcelain"]),
            workspace.handle.directory,
          ),
        ),
      ]);
      if (physicalPathRemains || registrationRemains) {
        const branchRemains =
          runGit(workspace.repository, this.#ownedRoot, [
            "for-each-ref",
            "--format=%(refname)",
            `refs/heads/${workspace.handle.branchName}`,
          ])
            .toString("utf8")
            .trim().length > 0;
        const sourceSnapshotAfterMismatch = await sourceCheckoutSnapshot(
          workspace.repository,
          this.#ownedRoot,
        );
        if (sourceSnapshotAfterMismatch !== sourceSnapshotBefore) {
          throw new Error("source checkout changed during an ambiguous worktree cleanup");
        }
        const result = {
          receipt: workspaceDisposalReceiptSchema.parse({
            schemaVersion: "hpi-workspace-disposal-receipt.v1",
            action: "DISPOSE",
            outcome: "BLOCKED",
            workspaceId: parsed.workspaceId,
            workspaceFingerprint: parsed.workspaceFingerprint,
            hygieneFingerprint: hygiene.receipt.hygieneFingerprint,
            worktreeState: physicalPathRemains ? "PRESERVED" : "REMOVED",
            registrationState:
              physicalPathRemains === registrationRemains
                ? registrationRemains
                  ? "REGISTERED"
                  : "REMOVED"
                : "AMBIGUOUS",
            branchState: branchRemains ? "PRESERVED" : "REMOVED",
            reasonCodes: ["CLEANUP_AMBIGUOUS"],
            observedAt: this.#now(),
          }),
        };
        this.#disposalOperations.set(parsed.operationId, {
          operationFingerprint: parsed.operationFingerprint,
          requestFingerprint,
          result,
        });
        return result;
      }
      if (hygiene.receipt.branchDisposition.localBranch === "REMOVE") {
        runGit(workspace.repository, this.#ownedRoot, [
          "branch",
          "-d",
          "--",
          workspace.handle.branchName,
        ]);
      }
      const remainingBranch = runGit(workspace.repository, this.#ownedRoot, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${workspace.handle.branchName}`,
      ])
        .toString("utf8")
        .trim();
      const sourceSnapshotAfter = await sourceCheckoutSnapshot(
        workspace.repository,
        this.#ownedRoot,
      );
      const branchStateMatches =
        hygiene.receipt.branchDisposition.localBranch === "REMOVE"
          ? remainingBranch.length === 0
          : remainingBranch.length > 0;
      if (!branchStateMatches || sourceSnapshotAfter !== sourceSnapshotBefore) {
        throw new Error("workspace disposal did not preserve its exact source identity");
      }
      this.#workspaces.delete(parsed.workspaceId);
      const result = {
        receipt: workspaceDisposalReceiptSchema.parse({
          schemaVersion: "hpi-workspace-disposal-receipt.v1",
          action: "DISPOSE",
          outcome: "APPLIED",
          workspaceId: parsed.workspaceId,
          workspaceFingerprint: parsed.workspaceFingerprint,
          hygieneFingerprint: hygiene.receipt.hygieneFingerprint,
          worktreeState: "REMOVED",
          registrationState: "REMOVED",
          branchState:
            hygiene.receipt.branchDisposition.localBranch === "REMOVE" ? "REMOVED" : "PRESERVED",
          reasonCodes: [],
          observedAt: this.#now(),
        }),
      };
      this.#disposalOperations.set(parsed.operationId, {
        operationFingerprint: parsed.operationFingerprint,
        requestFingerprint,
        result,
      });
      return result;
    }
    const result = {
      receipt: workspaceDisposalReceiptSchema.parse({
        schemaVersion: "hpi-workspace-disposal-receipt.v1",
        action: "DISPOSE",
        outcome: "BLOCKED",
        workspaceId: parsed.workspaceId,
        workspaceFingerprint: parsed.workspaceFingerprint,
        hygieneFingerprint: hygiene.receipt.hygieneFingerprint,
        worktreeState: "PRESERVED",
        registrationState: "REGISTERED",
        branchState: "PRESERVED",
        reasonCodes: hygiene.receipt.reasonCodes,
        observedAt: this.#now(),
      }),
    };
    this.#disposalOperations.set(parsed.operationId, {
      operationFingerprint: parsed.operationFingerprint,
      requestFingerprint,
      result,
    });
    return result;
  }
}

export async function createLocalGitWorkspaceManager(
  options: LocalGitWorkspaceManagerOptions,
): Promise<GitWorkspaceManager> {
  const ownedRoot = await requirePhysicalRoot(options.ownedRoot, "ownedRoot");
  const hooksRoot = join(ownedRoot, ".hpi-disabled-hooks");
  await mkdir(hooksRoot, { recursive: true });
  await requirePhysicalRoot(hooksRoot, "disabled hooks root");
  const globalConfig = join(ownedRoot, ".hpi-empty-gitconfig");
  try {
    await writeFile(globalConfig, "", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const [configStatus, canonicalConfig] = await Promise.all([
    lstat(globalConfig),
    realpath(globalConfig),
  ]);
  if (
    !configStatus.isFile() ||
    configStatus.isSymbolicLink() ||
    configStatus.nlink !== 1 ||
    canonicalConfig !== globalConfig ||
    (await readFile(globalConfig, "utf8")).length !== 0
  ) {
    throw new Error("owned Git global configuration must be an empty physical file");
  }
  return new LocalGitWorkspaceManager(ownedRoot, options.now ?? (() => new Date().toISOString()));
}
