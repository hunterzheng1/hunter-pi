import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const documentationFiles = new Set([
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
]);

/**
 * @param {readonly string[]} paths
 * @returns {"docs" | "full"}
 */
export function classifyPaths(paths) {
  if (paths.length === 0) return "full";

  return paths.every((input) => {
    const path = input.replaceAll("\\", "/");
    return documentationFiles.has(path) || path.startsWith("docs/");
  })
    ? "docs"
    : "full";
}

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * @param {string} base
 * @param {string} head
 * @returns {string[] | undefined}
 */
function changedPaths(base, head) {
  if (!/^[0-9a-f]{40}$/iu.test(base) || /^0{40}$/u.test(base)) return undefined;
  if (!/^[0-9a-f]{40}$/iu.test(head)) return undefined;

  // Disable rename detection so both the deleted source and added destination
  // are classified. Deletions must never disappear from the scope decision.
  const result = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", base, head],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

/**
 * @param {string} json
 * @returns {string[]}
 */
function parsePaths(json) {
  const parsed = /** @type {unknown} */ (JSON.parse(json));
  if (!Array.isArray(parsed)) throw new TypeError("--paths-json must contain an array");

  const values = /** @type {unknown[]} */ (parsed);
  return values.map((value) => {
    if (typeof value !== "string") throw new TypeError("changed paths must be strings");
    return value;
  });
}

const pathsJson = argument("--paths-json");
const forceFull = process.env["CI_FORCE_FULL"] === "true" || process.argv.includes("--force-full");
const base = argument("--base") ?? "";
const discoveredPaths =
  pathsJson === undefined ? changedPaths(base, argument("--head") ?? "") : parsePaths(pathsJson);
const mode = forceFull || discoveredPaths === undefined ? "full" : classifyPaths(discoveredPaths);
const outputPath = argument("--github-output");

if (outputPath !== undefined) {
  appendFileSync(outputPath, `mode=${mode}\nbase=${base}\n`, "utf8");
}
process.stdout.write(`${mode}\n`);
