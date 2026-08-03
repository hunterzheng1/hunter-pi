import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { z } from "zod";

import { runNpm, subprocessOutputLimitBytes, summarizeProcessFailure } from "./npm-process.mjs";
import { createRelativeFileSpecifier } from "./package-specifier.mjs";
import { createCanonicalTemporaryDirectory } from "./temporary-directory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageNames = [
  "@hunter-pi/domain",
  "@hunter-pi/evidence",
  "@hunter-pi/engine-contracts",
  "@hunter-pi/pi-host",
  "@hunter-pi/workflow-kernel",
  "@hunter-pi/testkit",
];
const packageDirectories = [
  "domain",
  "evidence",
  "engine-contracts",
  "pi-host",
  "workflow-kernel",
  "testkit",
];

/** @type {(text: string) => unknown} */
const parseJson = JSON.parse;
const packOutputSchema = z.array(z.looseObject({ filename: z.string() })).length(1);

/**
 * @param {string} output npm pack JSON output.
 * @returns {string} generated archive filename.
 */
const readArchiveFilename = (output) => {
  const record = packOutputSchema.parse(parseJson(output))[0];
  if (record === undefined) {
    throw new Error("npm pack did not return one archive record.");
  }

  return record.filename;
};

const temporaryRoot = await createCanonicalTemporaryDirectory("hunter-pi-package-smoke-");
const archiveDirectory = join(temporaryRoot, "archives");
const consumerDirectory = join(temporaryRoot, "consumer");
const npmIsolationRoot = join(temporaryRoot, "npm");
const npmDiagnosticRoots = {
  archives: archiveDirectory,
  repository: repositoryRoot,
};

try {
  await mkdir(archiveDirectory);
  await mkdir(consumerDirectory);

  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const [index, packageDirectory] of packageDirectories.entries()) {
    const packageName = packageNames[index];
    if (packageName === undefined) {
      throw new Error("Package smoke configuration is inconsistent.");
    }

    const packOutput = runNpm(
      [
        "pack",
        resolve(repositoryRoot, "packages", packageDirectory),
        "--json",
        "--pack-destination",
        archiveDirectory,
      ],
      repositoryRoot,
      npmIsolationRoot,
      npmDiagnosticRoots,
    );
    const archivePath = join(archiveDirectory, readArchiveFilename(packOutput));
    dependencies[packageName] = createRelativeFileSpecifier(consumerDirectory, archivePath);
  }

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "hunter-pi-package-smoke-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies,
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );

  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerDirectory,
    npmIsolationRoot,
    npmDiagnosticRoots,
  );

  const importProbe = `await Promise.all(${JSON.stringify(
    packageNames,
  )}.map((specifier) => import(specifier)));`;
  const importResult = spawnSync(process.execPath, ["--input-type=module", "--eval", importProbe], {
    cwd: consumerDirectory,
    encoding: "utf8",
    maxBuffer: subprocessOutputLimitBytes,
    shell: false,
    windowsHide: true,
  });

  if (importResult.error !== undefined) {
    throw new Error("Unable to start the package import probe.");
  }

  if (importResult.status !== 0) {
    throw new Error(
      summarizeProcessFailure("Package import probe", {
        status: importResult.status,
        stderr: importResult.stderr,
        stdout: importResult.stdout,
      }),
    );
  }

  process.stdout.write(`External package smoke passed (${packageNames.join(", ")}).\n`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
