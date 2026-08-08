import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Fingerprint } from "@hunter-pi/domain";
import { canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

const execFileAsync = promisify(execFile);

async function commandText(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(executable, [...arguments_], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.stderr.length > 0) throw new Error("source identity command wrote stderr");
  return result.stdout;
}

async function trackedFingerprint(
  repositoryRoot: string,
  pathspec: readonly string[],
): Promise<Fingerprint> {
  const output = await commandText(
    "git",
    ["ls-files", "--stage", "-z", "--", ...pathspec],
    repositoryRoot,
  );
  const entries = output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new Error("Task 10 pathspec contains an unsafe tracked entry");
      }
      return { mode: match[1], blob: match[2], path: match[3] };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const expected of pathspec) {
    if (
      !entries.some((entry) => entry.path === expected || entry.path.startsWith(`${expected}/`))
    ) {
      throw new Error("Task 10 source pathspec selected no tracked file");
    }
  }
  return sha256Fingerprint(canonicalJson(entries));
}

export interface Task10SourceIdentity {
  readonly commit: string;
  readonly sourceFingerprint: Fingerprint;
  readonly verifierFingerprint: Fingerprint;
}

export async function readTask10SourceIdentity(options: {
  readonly repositoryRoot: string;
  readonly sourcePathspec: readonly string[];
  readonly verifierPathspec: readonly string[];
}): Promise<Task10SourceIdentity> {
  const status = await commandText(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options.repositoryRoot,
  );
  if (status.trim().length > 0) throw new Error("Task 10 entire worktree is not clean");
  const commit = (await commandText("git", ["rev-parse", "HEAD"], options.repositoryRoot)).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Task 10 source commit is invalid");
  const [sourceFingerprint, verifierFingerprint] = await Promise.all([
    trackedFingerprint(options.repositoryRoot, options.sourcePathspec),
    trackedFingerprint(options.repositoryRoot, options.verifierPathspec),
  ]);
  return { commit, sourceFingerprint, verifierFingerprint };
}
