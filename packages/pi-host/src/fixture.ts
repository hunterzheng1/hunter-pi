import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PiProbeFixture {
  readonly root: string;
  readonly repository: string;
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly temporaryDirectory: string;
  readonly homeDirectory: string;
  readonly receiptDirectory: string;
}

const fixturePrefix = "hunter-pi-public-interface-probe-";
const ownedFixtureRoots = new Map<string, string>();

function assertContained(parent: string, child: string): void {
  const relativeChild = relative(parent, child);
  if (
    relativeChild.length === 0 ||
    relativeChild === ".." ||
    relativeChild.startsWith(`..${sep}`) ||
    isAbsolute(relativeChild)
  ) {
    throw new Error("temporary Pi probe fixture escaped its declared parent");
  }
}

export function createIsolatedFixtureGitEnvironment(
  fixtureRoot: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"] as const) {
    const value = inheritedEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return {
    ...environment,
    GCM_INTERACTIVE: "never",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00.000Z",
    GIT_AUTHOR_EMAIL: "probe@example.invalid",
    GIT_AUTHOR_NAME: "Hunter Pi Probe",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00.000Z",
    GIT_COMMITTER_EMAIL: "probe@example.invalid",
    GIT_COMMITTER_NAME: "Hunter Pi Probe",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: fixtureRoot,
    LANG: "C.UTF-8",
    TEMP: join(fixtureRoot, "temporary"),
    TMP: join(fixtureRoot, "temporary"),
    USERPROFILE: fixtureRoot,
    XDG_CONFIG_HOME: join(fixtureRoot, "xdg"),
  };
}

function runFixtureGit(repository: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    env: createIsolatedFixtureGitEnvironment(dirname(repository)),
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("unable to initialize the temporary Pi probe Git fixture");
  }
}

type FixtureGitRunner = (repository: string, arguments_: readonly string[]) => void;

async function removeVerifiedFixtureRoot(root: string, expectedParent: string): Promise<void> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("refusing to remove a non-directory Pi probe fixture");
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw new Error("refusing to remove a Pi probe fixture through an alias");
  }
  assertContained(expectedParent, canonicalRoot);
  if (!canonicalRoot.split(/[\\/]/u).at(-1)?.startsWith(fixturePrefix)) {
    throw new Error("refusing to remove a path without the Pi probe fixture prefix");
  }
  await rm(canonicalRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

export async function createPiProbeFixtureWithGitRunner(
  parentDirectory: string,
  gitRunner: FixtureGitRunner,
): Promise<PiProbeFixture> {
  const canonicalParent = await realpath(resolve(parentDirectory));
  const root = await realpath(await mkdtemp(join(canonicalParent, fixturePrefix)));
  assertContained(canonicalParent, root);

  const fixture: PiProbeFixture = {
    root,
    repository: join(root, "repository"),
    agentDirectory: join(root, "agent"),
    sessionDirectory: join(root, "sessions"),
    temporaryDirectory: join(root, "temporary"),
    homeDirectory: join(root, "home"),
    receiptDirectory: join(root, "receipts"),
  };

  try {
    await Promise.all(
      [
        fixture.repository,
        fixture.agentDirectory,
        fixture.sessionDirectory,
        fixture.temporaryDirectory,
        fixture.homeDirectory,
        fixture.receiptDirectory,
      ].map(async (directory) => mkdir(directory)),
    );
    await mkdir(join(root, "hooks"));

    gitRunner(fixture.repository, ["init", "--quiet", "--initial-branch=probe"]);
    gitRunner(fixture.repository, ["config", "core.hooksPath", join(root, "hooks")]);
    gitRunner(fixture.repository, ["config", "commit.gpgsign", "false"]);
    await writeFile(
      join(fixture.repository, "README.md"),
      "# Disposable Hunter Pi public-interface probe fixture\n",
      "utf8",
    );
    gitRunner(fixture.repository, ["add", "--", "README.md"]);
    gitRunner(fixture.repository, ["commit", "--quiet", "-m", "Initialize probe fixture"]);

    ownedFixtureRoots.set(root, canonicalParent);
    return fixture;
  } catch (error: unknown) {
    try {
      await removeVerifiedFixtureRoot(root, canonicalParent);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Pi probe fixture initialization and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function createPiProbeFixture(parentDirectory: string): Promise<PiProbeFixture> {
  return createPiProbeFixtureWithGitRunner(parentDirectory, runFixtureGit);
}

export async function removePiProbeFixture(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const expectedParent = ownedFixtureRoots.get(resolvedRoot);
  if (expectedParent === undefined) {
    throw new Error("refusing to remove a Pi probe fixture not created by this process");
  }

  await removeVerifiedFixtureRoot(resolvedRoot, expectedParent);
  ownedFixtureRoots.delete(resolvedRoot);
}
