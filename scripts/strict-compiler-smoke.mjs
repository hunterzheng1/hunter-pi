import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { subprocessOutputLimitBytes } from "./npm-process.mjs";
import { assertStrictCompilerPolicy } from "./strict-compiler-policy.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const compilerPath = resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const fixtureConfig = resolve(repositoryRoot, "test", "fixtures", "strict", "tsconfig.json");

/** @type {(text: string) => unknown} */
const parseJson = JSON.parse;
assertStrictCompilerPolicy(
  parseJson(readFileSync(resolve(repositoryRoot, "tsconfig.base.json"), "utf8")),
  parseJson(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")),
);

const result = spawnSync(
  process.execPath,
  [compilerPath, "-p", fixtureConfig, "--pretty", "false"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: subprocessOutputLimitBytes,
    shell: false,
    windowsHide: true,
  },
);

if (result.error !== undefined) {
  throw new Error("Unable to run the local TypeScript compiler.");
}

const diagnostics = `${result.stdout}${result.stderr}`;
const expectedDiagnosticCodes = ["TS2322", "TS2375"];
const missingDiagnosticCodes = expectedDiagnosticCodes.filter(
  (code) => !diagnostics.includes(code),
);

if (result.status === 0 || missingDiagnosticCodes.length > 0) {
  throw new Error(
    `Strict compiler fixture did not prove: ${missingDiagnosticCodes.join(", ") || "expected rejection"}.`,
  );
}

process.stdout.write(
  `Strict compiler smoke passed (${expectedDiagnosticCodes.join(", ")}; NodeNext ESM policy).\n`,
);
