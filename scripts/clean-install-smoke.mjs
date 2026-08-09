import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runNpm } from "./npm-process.mjs";
import { createCanonicalTemporaryDirectory } from "./temporary-directory.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workspaceManifests = (
  await Promise.all(
    ["apps", "packages"].map(async (workspaceParent) =>
      (await readdir(join(repositoryRoot, workspaceParent), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => join(workspaceParent, entry.name, "package.json")),
    ),
  )
)
  .flat()
  .toSorted();
if (workspaceManifests.length === 0) {
  throw new Error("Clean-install workspace discovery found no manifests.");
}
const rootFiles = [".npmrc", "package-lock.json", "package.json"];
const temporaryRoot = await createCanonicalTemporaryDirectory("hunter-pi-clean-install-");
const npmIsolationRoot = join(temporaryRoot, ".npm-isolation");
const npmDiagnosticRoots = { fixture: temporaryRoot };

try {
  for (const relativePath of [...rootFiles, ...workspaceManifests]) {
    const destination = join(temporaryRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, relativePath), destination);
  }

  runNpm(
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    temporaryRoot,
    npmIsolationRoot,
    npmDiagnosticRoots,
  );
  runNpm(["ls", "--workspaces", "--depth=0"], temporaryRoot, npmIsolationRoot, npmDiagnosticRoots);

  process.stdout.write("Clean npm install smoke passed.\n");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
