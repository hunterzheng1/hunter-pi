import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { format } from "prettier";
import { z } from "zod";

import {
  PI_CANDIDATE,
  PiProbeStageError,
  createPiProbeFixture,
  piPublicInterfaceProbeFailureReportSchema,
  removePiProbeFixture,
  runPiPublicInterfaceProbe,
  type PiProbeFailureStage,
  type PiPublicInterfaceProbeFailureReport,
} from "@hunter-pi/pi-host";

const approvedOutputRoots = [
  ".artifacts/pi-probe",
  ".artifacts/pi-probe-aggregate",
  "docs/validation/evidence/pi",
] as const;
const outputFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;

const isContained = (parent: string, child: string): boolean => {
  const relativeChild = relative(parent, child);
  return (
    relativeChild.length > 0 &&
    relativeChild !== ".." &&
    !relativeChild.startsWith(`..${sep}`) &&
    !isAbsolute(relativeChild)
  );
};

export const resolvePiProbeOutputPath = (repositoryRoot: string, requestedPath: string): string => {
  const root = resolve(repositoryRoot);
  const target = resolve(root, requestedPath);
  const outputRoot = approvedOutputRoots
    .map((candidate) => resolve(root, candidate))
    .find((candidate) => isContained(candidate, target));

  if (outputRoot === undefined) {
    throw new Error("Pi probe output must stay in an approved evidence root");
  }
  if (dirname(target) !== outputRoot || !outputFilenamePattern.test(basename(target))) {
    throw new Error("Pi probe output must be a flat JSON file");
  }
  return target;
};

export const formatPiProbeEvidence = async (value: unknown): Promise<string> => {
  const serialized = JSON.stringify(value);
  return format(serialized, {
    endOfLine: "lf",
    parser: "json",
    printWidth: 100,
  });
};

export const createPiProbeFailureEvidence = (
  observedAt = new Date().toISOString(),
  stage: PiProbeFailureStage = "REPORT_ASSEMBLY",
): PiPublicInterfaceProbeFailureReport =>
  piPublicInterfaceProbeFailureReportSchema.parse({
    schemaVersion: "1.0.0",
    kind: "hunter-pi/pi-public-interface-probe-failure",
    observedAt,
    status: "NOT_PROVEN",
    expectedCandidate: {
      packageName: PI_CANDIDATE.packageName,
      version: PI_CANDIDATE.version,
      registryGitHead: PI_CANDIDATE.registryGitHead,
      integrity: PI_CANDIDATE.integrity,
    },
    failure: {
      code: "PROBE_DID_NOT_COMPLETE",
      stage,
      classification: "NOT_PROVEN",
      reason:
        "The provider-independent probe did not complete; no interface capability was established.",
    },
  });

const parseOutputArgument = (arguments_: readonly string[]): string => {
  if (arguments_.length === 0) {
    return `.artifacts/pi-probe/${process.platform}-node24-${String(process.pid)}.json`;
  }
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output" ||
    arguments_[1] === undefined ||
    arguments_[1].length === 0
  ) {
    throw new Error("usage: pi-public-interface-probe [--output <approved-path.json>]");
  }
  return arguments_[1];
};

const assertRepositoryRoot = async (repositoryRoot: string): Promise<void> => {
  const packageManifest = z
    .looseObject({ name: z.literal("hunter-pi") })
    .parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown);
  void packageManifest;
};

export const preparePiProbeOutput = async (
  repositoryRoot: string,
  outputPath: string,
): Promise<void> => {
  const outputRoot = dirname(outputPath);
  const normalizedRelativeRoot = relative(resolve(repositoryRoot), outputRoot).split(sep).join("/");
  if (!(approvedOutputRoots as readonly string[]).includes(normalizedRelativeRoot)) {
    throw new Error("Pi probe output root is not an approved Evidence directory");
  }

  let currentDirectory = resolve(repositoryRoot);
  for (const segment of normalizedRelativeRoot.split("/")) {
    currentDirectory = join(currentDirectory, segment);
    try {
      await mkdir(currentDirectory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const entry = await lstat(currentDirectory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Pi probe output directories must not contain links or reparse redirects");
    }
  }

  const [canonicalRepository, canonicalOutputRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(outputRoot),
  ]);
  const expectedCanonicalRoot = resolve(canonicalRepository, ...normalizedRelativeRoot.split("/"));
  if (relative(expectedCanonicalRoot, canonicalOutputRoot).length !== 0) {
    throw new Error("Pi probe output root resolves through an unexpected redirect");
  }

  try {
    const outputEntry = await lstat(outputPath);
    if (outputEntry.isSymbolicLink() || !outputEntry.isFile() || outputEntry.nlink !== 1) {
      throw new Error("existing Pi probe output must be a regular single-link file");
    }
    throw new Error("Pi probe Evidence output must not already exist");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
};

const runCli = async (): Promise<void> => {
  const repositoryRoot = resolve(process.cwd());
  await assertRepositoryRoot(repositoryRoot);
  const outputPath = resolvePiProbeOutputPath(
    repositoryRoot,
    parseOutputArgument(process.argv.slice(2)),
  );
  await preparePiProbeOutput(repositoryRoot, outputPath);

  const writeEvidence = async (evidence: unknown): Promise<void> =>
    writeFile(outputPath, await formatPiProbeEvidence(evidence), {
      encoding: "utf8",
      flag: "wx",
    });

  let failureStage: PiProbeFailureStage = "FIXTURE_SETUP";
  try {
    const fixture = await createPiProbeFixture(tmpdir());
    failureStage = "REPORT_ASSEMBLY";
    const report = await (async () => {
      try {
        return await runPiPublicInterfaceProbe({
          fixture,
          coreExtensionPath: join(
            repositoryRoot,
            "test",
            "fixtures",
            "pi",
            "core-extension-probe.ts",
          ),
        });
      } finally {
        failureStage = "FIXTURE_CLEANUP";
        await removePiProbeFixture(fixture.root);
      }
    })();
    failureStage = "EVIDENCE_WRITE";
    await writeEvidence(report);
    process.stdout.write(
      `ProviderIndependentProbe=SUPPORTED; RealProvider=${report.surfaces.realProvider.status}; Evidence=${relative(
        repositoryRoot,
        outputPath,
      )}\n`,
    );
  } catch (error: unknown) {
    const stage = error instanceof PiProbeStageError ? error.stage : failureStage;
    try {
      await writeEvidence(createPiProbeFailureEvidence(new Date().toISOString(), stage));
    } catch (writeError: unknown) {
      throw new AggregateError(
        [error, writeError],
        "Pi probe failed and its structured failure Evidence could not be written",
        { cause: writeError },
      );
    }
    throw new Error("Pi probe failed; a structured NOT_PROVEN receipt was written", {
      cause: error,
    });
  }
};

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown probe failure";
    process.stderr.write(`Pi public-interface probe failed: ${message}\n`);
    process.exitCode = 1;
  });
}
