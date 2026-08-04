import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const fixturePrefix = "hunter-pi-managed-change-";

export interface Task6DisposableFixture {
  readonly root: string;
  readonly repository: string;
  readonly baseCommit: string;
}

export interface Task6QuickSessionPromotion {
  readonly schemaVersion: "hpi-quick-session-promotion.v1";
  readonly fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY";
  readonly baseCommit: string;
  readonly includePaths: readonly string[];
  readonly excludePaths: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly workspaceFingerprint: string;
  readonly sourceFingerprint: string;
  readonly excludedContentFingerprint: string;
}

interface OwnedFixture {
  readonly parent: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownershipNonce: string;
}

const ownedFixtures = new Map<string, OwnedFixture>();

function createFixtureGitEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    GCM_INTERACTIVE: "never",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00.000Z",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_NAME: "Hunter Pi Fixture",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00.000Z",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Hunter Pi Fixture",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    LANG: "C.UTF-8",
    TEMP: join(root, "temporary"),
    TMP: join(root, "temporary"),
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
  };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertContained(parent: string, child: string): void {
  const childRelative = relative(parent, child);
  if (
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    isAbsolute(childRelative)
  ) {
    throw new Error("temporary Managed Change fixture escaped its declared parent");
  }
}

function runGit(
  fixture: Task6DisposableFixture | { readonly root: string; readonly repository: string },
  arguments_: readonly string[],
): string {
  const result = spawnSync("git", ["-C", fixture.repository, ...arguments_], {
    encoding: "utf8",
    env: createFixtureGitEnvironment(fixture.root),
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("temporary Managed Change Git operation failed");
  }
  return result.stdout;
}

function requireOwnedFixture(fixture: Task6DisposableFixture): OwnedFixture {
  const resolvedRoot = resolve(fixture.root);
  const owned = ownedFixtures.get(resolvedRoot);
  if (owned === undefined) {
    throw new Error("fixture was not created by this Managed Change process");
  }
  if (resolve(fixture.repository) !== owned.repository || fixture.baseCommit !== owned.baseCommit) {
    throw new Error("fixture was not created by this Managed Change process");
  }
  return owned;
}

function parseDirtyPaths(output: string): string[] {
  const paths: string[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("temporary Managed Change Git status was not understood");
    }
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      throw new Error("renamed or copied dirty paths are not supported by Task 6 promotion");
    }
    paths.push(record.slice(3).replaceAll("\\", "/"));
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function normalizeSelectedPaths(paths: readonly string[], label: string): string[] {
  const normalized = paths.map((path) => {
    if (
      path.length === 0 ||
      path.includes("\0") ||
      path.includes("\\") ||
      isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path === "." ||
      path === ".." ||
      path.startsWith("../")
    ) {
      throw new Error(`${label} must contain normalized repository-relative paths`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} paths must be unique`);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

async function inspectSelectedPath(repository: string, repositoryPath: string): Promise<Buffer> {
  const candidate = resolve(repository, ...repositoryPath.split("/"));
  assertContained(repository, candidate);
  let cursor = repository;
  for (const segment of repositoryPath.split("/")) {
    cursor = join(cursor, segment);
    const status = await lstat(cursor);
    if (status.isSymbolicLink() || (status.isFile() && status.nlink > 1)) {
      throw new Error("promotion rejected a linked mutation target");
    }
  }
  const canonicalRepository = await realpath(repository);
  const canonicalCandidate = await realpath(candidate);
  assertContained(canonicalRepository, canonicalCandidate);
  const status = await lstat(canonicalCandidate);
  if (!status.isFile()) {
    throw new Error("Task 6 promotion supports regular-file changes only");
  }
  return readFile(canonicalCandidate);
}

async function contentFingerprint(repository: string, paths: readonly string[]): Promise<string> {
  const entries = [];
  for (const path of paths) {
    entries.push({ path, digest: sha256(await inspectSelectedPath(repository, path)) });
  }
  return sha256(JSON.stringify(entries));
}

async function removeVerifiedFixtureRoot(root: string, owned: OwnedFixture): Promise<void> {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("refusing to remove a non-directory Managed Change fixture");
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw new Error("refusing to remove a Managed Change fixture through an alias");
  }
  assertContained(owned.parent, canonicalRoot);
  if (!canonicalRoot.split(/[\\/]/u).at(-1)?.startsWith(fixturePrefix)) {
    throw new Error("refusing to remove a path without the Managed Change fixture prefix");
  }
  await rm(canonicalRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

export async function createTask6DisposableFixture(
  parentDirectory: string,
): Promise<Task6DisposableFixture> {
  const canonicalParent = await realpath(resolve(parentDirectory));
  const root = await realpath(await mkdtemp(join(canonicalParent, fixturePrefix)));
  assertContained(canonicalParent, root);
  const repository = join(root, "repository");
  const fixtureBase = { root, repository };
  try {
    await Promise.all([
      mkdir(repository),
      mkdir(join(root, "hooks")),
      mkdir(join(root, "temporary")),
    ]);
    runGit(fixtureBase, ["init", "--quiet", "--initial-branch=fixture"]);
    runGit(fixtureBase, ["config", "core.hooksPath", join(root, "hooks")]);
    runGit(fixtureBase, ["config", "commit.gpgsign", "false"]);
    await Promise.all([
      writeFile(
        join(repository, "README.md"),
        "# Disposable Hunter Pi Managed Change fixture\n\nOnly result.txt may be fixed.\n",
        "utf8",
      ),
      writeFile(join(repository, "result.txt"), "BASELINE\n", "utf8"),
      writeFile(
        join(repository, "verify.mjs"),
        [
          'import { readFile } from "node:fs/promises";',
          'const value = await readFile(new URL("./result.txt", import.meta.url), "utf8");',
          'if (value !== "READY\\n") {',
          '  process.stderr.write("RESULT_NOT_READY\\n");',
          "  process.exitCode = 1;",
          "} else {",
          '  process.stdout.write("RESULT_READY\\n");',
          "}",
          "",
        ].join("\n"),
        "utf8",
      ),
    ]);
    runGit(fixtureBase, ["add", "--", "README.md", "result.txt", "verify.mjs"]);
    runGit(fixtureBase, ["commit", "--quiet", "-m", "Initialize Managed Change fixture"]);
    const baseCommit = runGit(fixtureBase, ["rev-parse", "HEAD"]).trim();
    if (!/^[a-f0-9]{40}$/u.test(baseCommit)) {
      throw new Error("temporary Managed Change fixture has an invalid base commit");
    }
    await Promise.all([
      writeFile(join(repository, "result.txt"), "NOT_READY\n", "utf8"),
      writeFile(join(repository, "scratch.txt"), "EXCLUDED_FIXTURE_NOTE\n", "utf8"),
    ]);
    const fixture = { root, repository, baseCommit };
    ownedFixtures.set(root, {
      parent: canonicalParent,
      repository,
      baseCommit,
      ownershipNonce: randomBytes(16).toString("hex"),
    });
    return fixture;
  } catch (error: unknown) {
    const owned: OwnedFixture = {
      parent: canonicalParent,
      repository,
      baseCommit: "",
      ownershipNonce: "",
    };
    try {
      await removeVerifiedFixtureRoot(root, owned);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Managed Change fixture initialization and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function captureTask6QuickSessionPromotion(
  fixture: Task6DisposableFixture,
  selection: {
    readonly includePaths: readonly string[];
    readonly excludePaths: readonly string[];
  },
): Promise<Task6QuickSessionPromotion> {
  const owned = requireOwnedFixture(fixture);
  const includePaths = normalizeSelectedPaths(selection.includePaths, "includePaths");
  const excludePaths = normalizeSelectedPaths(selection.excludePaths, "excludePaths");
  if (includePaths.length === 0) {
    throw new Error("Task 6 promotion requires at least one included path");
  }
  if (includePaths.some((path) => excludePaths.includes(path))) {
    throw new Error("a dirty path cannot be both included and excluded");
  }
  const dirtyPaths = parseDirtyPaths(
    runGit(fixture, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const classified = [...includePaths, ...excludePaths].sort((left, right) =>
    left.localeCompare(right),
  );
  const unclassified = dirtyPaths.filter((path) => !classified.includes(path));
  const nonexistent = classified.filter((path) => !dirtyPaths.includes(path));
  if (unclassified.length > 0) {
    throw new Error(`unclassified dirty path: ${unclassified.join(", ")}`);
  }
  if (nonexistent.length > 0) {
    throw new Error(`selected path is not dirty: ${nonexistent.join(", ")}`);
  }

  const [includedContentFingerprint, excludedContentFingerprint] = await Promise.all([
    contentFingerprint(fixture.repository, includePaths),
    contentFingerprint(fixture.repository, excludePaths),
  ]);
  return {
    schemaVersion: "hpi-quick-session-promotion.v1",
    fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
    baseCommit: fixture.baseCommit,
    includePaths,
    excludePaths,
    dirtyPaths,
    workspaceFingerprint: sha256(
      JSON.stringify({
        policy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
        ownershipNonce: owned.ownershipNonce,
        baseCommit: fixture.baseCommit,
      }),
    ),
    sourceFingerprint: sha256(
      JSON.stringify({
        baseCommit: fixture.baseCommit,
        includePaths,
        includedContentFingerprint,
      }),
    ),
    excludedContentFingerprint,
  };
}

export async function removeTask6DisposableFixture(fixture: Task6DisposableFixture): Promise<void> {
  const owned = requireOwnedFixture(fixture);
  await removeVerifiedFixtureRoot(resolve(fixture.root), owned);
  ownedFixtures.delete(resolve(fixture.root));
}
