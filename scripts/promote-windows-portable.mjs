import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const failure = {
  schemaVersion: "hpi-portable-qualification-operation.v1",
  status: "BLOCKED",
  reason: "portable qualification could not be completed",
};

const minimumQualificationTimeoutMs = 3 * 60 * 1000;
const maximumQualificationTimeoutMs = 8 * 60 * 1000;
const qualificationSetupAllowanceMs = 60 * 1000;
const qualificationTransferBytesPerSecond = 1024 * 1024;
const maximumQualificationTreeEntries = 100_000;
const maximumQualificationUploadBytes = 2 * 1024 * 1024 * 1024;

/** @param {number} artifactByteLength */
export function qualificationTimeoutMsForArtifactByteLength(artifactByteLength) {
  if (!Number.isSafeInteger(artifactByteLength) || artifactByteLength <= 0) {
    throw new Error("portable qualification artifact length is invalid");
  }
  const transferAllowanceMs =
    Math.ceil(artifactByteLength / qualificationTransferBytesPerSecond) * 1000;
  return Math.min(
    maximumQualificationTimeoutMs,
    Math.max(minimumQualificationTimeoutMs, qualificationSetupAllowanceMs + transferAllowanceMs),
  );
}

/**
 * @param {{isSymbolicLink(): boolean, isDirectory(): boolean, isFile(): boolean}} status
 */
export function qualificationUploadTreeEntryKind(status) {
  if (status.isSymbolicLink()) {
    throw new Error("portable qualification upload tree contains a link");
  }
  if (status.isDirectory()) return "DIRECTORY";
  if (status.isFile()) return "FILE";
  throw new Error("portable qualification upload tree contains a non-file entry");
}

/**
 * @param {string} root
 * @param {{maximumEntries?: number, maximumBytes?: number}} [options]
 */
export async function qualificationUploadTreeByteLength(root, options = {}) {
  const maximumEntries = options.maximumEntries ?? maximumQualificationTreeEntries;
  const maximumBytes = options.maximumBytes ?? maximumQualificationUploadBytes;
  if (
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries <= 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error("portable qualification upload-tree limits are invalid");
  }
  const resolvedRoot = resolve(root);
  const rootStatus = await lstat(resolvedRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("portable qualification root is not one physical directory");
  }
  if (relative(resolvedRoot, resolve(await realpath(resolvedRoot))).length !== 0) {
    throw new Error("portable qualification root is redirected");
  }
  let entryCount = 0;
  let totalBytes = 0;
  /** @param {string} directory */
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > maximumEntries) {
        throw new Error("portable qualification upload tree has too many entries");
      }
      const path = resolve(directory, entry.name);
      const relativePath = relative(resolvedRoot, path);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error("portable qualification upload tree escaped its root");
      }
      const status = await lstat(path);
      const kind = qualificationUploadTreeEntryKind(status);
      if (kind === "DIRECTORY") {
        await walk(path);
        continue;
      }
      totalBytes += status.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        throw new Error("portable qualification upload tree is too large");
      }
    }
  }
  await walk(resolvedRoot);
  if (totalBytes <= 0) throw new Error("portable qualification upload tree is empty");
  return totalBytes;
}

/** @param {readonly string[]} arguments_ @param {string} name */
function requiredArgument(arguments_, name) {
  const indexes = arguments_.flatMap((value, index) => (value === name ? [index] : []));
  const index = indexes[0];
  const value = index === undefined ? undefined : arguments_[index + 1];
  if (
    indexes.length !== 1 ||
    value === undefined ||
    value.startsWith("--") ||
    arguments_.length !== 4
  ) {
    throw new Error("portable qualification arguments are invalid");
  }
  return value;
}

/** @param {string} path */
async function readPhysicalFile(path) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("portable qualification input is not one physical file");
  }
  return readFile(path);
}

/**
 * @param {readonly string[]} arguments_
 * @param {{platform?: string, arch?: string, nodeVersion?: string, now?: () => Date, observerNow?: () => number, temporaryParent?: string, runGh?: (arguments_: readonly string[], timeoutMs: number) => Promise<{exitCode: number | null, stdout: string, stderr: string}>}} [dependencies]
 */
export async function runWindowsPortablePromotion(arguments_, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  if (platform !== "win32" || arch !== "x64" || !nodeVersion.startsWith("24.")) {
    throw new Error("portable qualification requires the qualified Windows runtime");
  }
  const installationRoot = resolve(requiredArgument(arguments_, "--root"));
  const runText = requiredArgument(arguments_, "--run");
  if (!/^\d+$/u.test(runText)) throw new Error("portable qualification run id is invalid");
  const runId = Number(runText);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("portable qualification run id is invalid");
  }
  const canonicalRunText = String(runId);
  const updater = await import("@hunter-pi/updater");
  const candidateBytes = await readPhysicalFile(
    resolve(installationRoot, "portable-release-candidate.json"),
  );
  const candidate = updater.releaseCandidateSchema.parse(
    JSON.parse(Buffer.from(candidateBytes).toString("utf8")),
  );
  const artifactPath = resolve(installationRoot, "update.bundle.tgz");
  const hostedArtifactByteLength = await qualificationUploadTreeByteLength(installationRoot);
  const now = (dependencies.now ?? (() => new Date()))();
  const observedAt = now.toISOString();
  const deadline = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const cancellationPolicy = /** @type {const} */ ({
    mode: "FAIL_CLOSED",
    timeoutMs: qualificationTimeoutMsForArtifactByteLength(hostedArtifactByteLength),
  });
  const source = updater.githubActionsQualificationSourceSchema.parse({
    kind: "GITHUB_ACTIONS_RUN",
    repository: updater.HPI_GITHUB_REPOSITORY,
    runId,
  });
  const expectedTarget = updater.windowsPortableQualificationTargetReference(candidate);
  const operationFingerprint = updater.windowsPortableQualificationRequestFingerprint({
    expectedTarget,
    source,
    deadline,
    cancellationPolicy,
  });
  const requestIdentity = operationFingerprint.slice("sha256:".length, "sha256:".length + 16);
  const operationId = `op_update-qualify-${canonicalRunText}-${requestIdentity}`;
  const observer = new updater.GhCliGitHubActionsQualificationObserver({
    ...(dependencies.observerNow === undefined ? {} : { now: dependencies.observerNow }),
    ...(dependencies.temporaryParent === undefined
      ? {}
      : { temporaryParent: dependencies.temporaryParent }),
    ...(dependencies.runGh === undefined ? {} : { runGh: dependencies.runGh }),
  });
  const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
    observe: (input) => observer.observe(input),
  });
  const adapter = new updater.FileWindowsPortableReleaseAdapter({
    installationRoot,
    targetPlatform: "win32-x64",
    healthCheck: () => Promise.resolve({ status: "PASS" }),
  });
  const manager = new updater.FileUpdateManager({
    stateRoot: updater.windowsPortableUpdateManagerStateRoot(installationRoot),
    channel: "PREVIEW",
    adapter,
    artifacts: { read: () => readPhysicalFile(artifactPath) },
    qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
    qualificationAuthority: authority,
    now: () => observedAt,
  });
  return manager.qualify({
    schemaVersion: "hpi-update-qualification.v1",
    operationId,
    operationFingerprint,
    expectedTarget,
    source,
    deadline,
    cancellationPolicy,
    observedAt,
  });
}

async function main() {
  try {
    const receipt = await runWindowsPortablePromotion(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.outcome === "APPLIED" || receipt.outcome === "NOOP" ? 0 : 2;
  } catch {
    process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
