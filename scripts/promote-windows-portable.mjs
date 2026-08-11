import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
  promoteWindowsPortableQualification,
  releaseCandidateSchema,
} from "@hunter-pi/updater";

/** @param {string} name */
function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(value);
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Portable qualification promotion requires Windows x64");
}
if (!process.versions.node.startsWith("24.")) {
  throw new Error("Portable qualification promotion requires Node 24");
}

const installationRoot = requiredArgument("--root");
const candidatePath = requiredArgument("--candidate");
const candidateStatus = await lstat(candidatePath);
if (!candidateStatus.isFile() || candidateStatus.isSymbolicLink()) {
  throw new Error("--candidate must identify one physical JSON file");
}
const candidate = releaseCandidateSchema.parse(JSON.parse(await readFile(candidatePath, "utf8")));
const receipt = await promoteWindowsPortableQualification({
  installationRoot,
  candidate,
  qualificationVerifierFingerprint: HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
