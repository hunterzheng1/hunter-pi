import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { packCliArtifact } from "./cli-package.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, ".artifacts", "hpi-developer-preview");
const npmIsolationRoot = join(repositoryRoot, ".artifacts", "npm-pack-isolation");
await mkdir(outputDirectory, { recursive: true });
const output = await packCliArtifact({
  destination: outputDirectory,
  npmIsolationRoot,
  diagnosticRoots: { repository: repositoryRoot },
});
const records = z
  .array(z.looseObject({ filename: z.string() }))
  .length(1)
  .parse(JSON.parse(output));
const filename = records[0]?.filename;
if (filename === undefined) throw new Error("npm pack did not report the preview archive.");
process.stdout.write(`Hunter Pi developer preview: ${join(outputDirectory, filename)}\n`);
