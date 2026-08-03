import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runNpm } from "./npm-process.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workspaceManifests = [
  "packages/domain/package.json",
  "packages/engine-contracts/package.json",
  "packages/workflow-kernel/package.json",
  "packages/testkit/package.json",
];
const rootFiles = [".npmrc", "package-lock.json", "package.json"];
const temporaryRoot = await mkdtemp(join(tmpdir(), "hunter-pi-clean-install-"));
const npmIsolationRoot = join(temporaryRoot, ".npm-isolation");

try {
  for (const relativePath of [...rootFiles, ...workspaceManifests]) {
    const destination = join(temporaryRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, relativePath), destination);
  }

  runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], temporaryRoot, npmIsolationRoot);
  runNpm(["ls", "--workspaces", "--depth=0"], temporaryRoot, npmIsolationRoot);

  process.stdout.write("Clean npm install smoke passed.\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
