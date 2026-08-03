import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runNpm } from "./npm-process.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const buildInfoPath = join(repositoryRoot, "apps", "cli", "dist", "build-info.json");
const coreExtensionPath = join(repositoryRoot, "apps", "cli", "dist", "core-extension.js");
const productShellPath = join(repositoryRoot, "apps", "cli", "dist", "hpi.js");

/** @param {readonly string[]} arguments_ */
function gitOutput(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Unable to stamp the Hunter Pi package from Git identity.");
  }
  return result.stdout.trim();
}

async function writeBuildStamp() {
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error("Git returned an invalid source commit for the CLI package stamp.");
  }
  const dirtyOutput = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude)apps/cli/dist/build-info.json",
  ]);
  const coreExtensionIntegrity = `sha256:${createHash("sha256")
    .update(await readFile(coreExtensionPath))
    .digest("hex")}`;
  const productShellIntegrity = `sha256:${createHash("sha256")
    .update(await readFile(productShellPath))
    .digest("hex")}`;
  await writeFile(
    buildInfoPath,
    `${JSON.stringify(
      {
        sourceCommit,
        sourceState: dirtyOutput.length === 0 ? "CLEAN" : "DIRTY",
        coreExtensionIntegrity,
        productShellIntegrity,
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * @param {{ readonly destination: string; readonly npmIsolationRoot: string; readonly diagnosticRoots?: Readonly<Record<string, string>> }} options
 */
export async function packCliArtifact(options) {
  await writeBuildStamp();
  try {
    return runNpm(
      [
        "pack",
        join(repositoryRoot, "apps", "cli"),
        "--json",
        "--pack-destination",
        options.destination,
      ],
      repositoryRoot,
      options.npmIsolationRoot,
      options.diagnosticRoots,
    );
  } finally {
    await rm(buildInfoPath, { force: true });
  }
}
