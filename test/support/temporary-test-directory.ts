import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function createTemporaryTestDirectory(
  parent: string,
  prefix: string,
): Promise<string> {
  const resolvedParent = resolve(parent);
  const canonicalParent = await realpath(resolvedParent);
  const created = await mkdtemp(join(canonicalParent, prefix));
  const canonical = await realpath(created);
  const relativeChild = relative(canonicalParent, canonical);
  if (
    relativeChild.length === 0 ||
    relativeChild === ".." ||
    relativeChild.startsWith(`..${sep}`) ||
    isAbsolute(relativeChild)
  ) {
    throw new Error("temporary fixture escaped its declared parent");
  }
  return canonical;
}

async function makeTemporaryTreeRemovable(path: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (status.isDirectory()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path)) {
      await makeTemporaryTreeRemovable(join(path, entry));
    }
    return;
  }
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * Remove a test fixture even when the product intentionally published a read-only tree.
 * This never follows symbolic links and is restricted to the caller-provided fixture root.
 */
export async function removeTemporaryTestDirectory(path: string): Promise<void> {
  await makeTemporaryTreeRemovable(path);
  await rm(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}
