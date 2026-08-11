import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const failure = {
  schemaVersion: "hpi-portable-qualification-operation.v1",
  status: "BLOCKED",
  reason: "portable qualification could not be completed",
};

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
  const now = (dependencies.now ?? (() => new Date()))();
  const observedAt = now.toISOString();
  const deadline = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const cancellationPolicy = /** @type {const} */ ({
    mode: "FAIL_CLOSED",
    timeoutMs: 120_000,
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
    stateRoot: resolve(installationRoot, ".hpi-update", "qualification-manager"),
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
