import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rmdir, rm } from "node:fs/promises";
import { join, parse, resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DurableStoreError, storeErrorFrom } from "./errors.js";

export const atomicWriteBoundaries = [
  "BEFORE_TEMP_WRITE",
  "AFTER_TEMP_WRITE",
  "AFTER_TEMP_SYNC",
  "AFTER_PUBLISH",
] as const;
export type AtomicWriteBoundary = (typeof atomicWriteBoundaries)[number];
export type AtomicWriteFaultInjector = (boundary: AtomicWriteBoundary) => Promise<void> | void;

export async function assertSafeDirectoryPath(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new DurableStoreError(
          "INVALID_TARGET",
          "An immutable state directory cannot contain a symbolic link or non-directory component.",
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function withDurableMutationLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const absoluteLockPath = resolve(lockPath);
  const parent = dirname(absoluteLockPath);
  await assertSafeDirectoryPath(parent);
  await mkdir(parent, { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(absoluteLockPath);
      acquired = true;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      await delay(5);
    }
  }
  if (!acquired) {
    throw new DurableStoreError(
      "STORE_BUSY",
      "A durable state mutation lock could not be acquired; retry after the owner exits.",
    );
  }
  try {
    return await operation();
  } finally {
    await rmdir(absoluteLockPath);
  }
}

export async function writeImmutableAtomically(options: {
  readonly directory: string;
  readonly filename: string;
  readonly content: string;
  readonly faultInjector?: AtomicWriteFaultInjector;
}): Promise<void> {
  if (
    options.filename.length === 0 ||
    options.filename === "." ||
    options.filename === ".." ||
    options.filename.includes("/") ||
    options.filename.includes("\\") ||
    options.filename.includes("\0")
  ) {
    throw new DurableStoreError(
      "INVALID_TARGET",
      "An immutable write filename must be one contained path segment.",
    );
  }
  await assertSafeDirectoryPath(options.directory);
  await mkdir(options.directory, { recursive: true });
  const temporaryName = `.pending-${randomUUID()}`;
  const temporaryPath = join(options.directory, temporaryName);
  const finalPath = join(options.directory, options.filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await options.faultInjector?.("BEFORE_TEMP_WRITE");
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(options.content, "utf8");
    await options.faultInjector?.("AFTER_TEMP_WRITE");
    await handle.sync();
    await options.faultInjector?.("AFTER_TEMP_SYNC");
    await handle.close();
    handle = undefined;
    await link(temporaryPath, finalPath);
    await options.faultInjector?.("AFTER_PUBLISH");
  } catch (error) {
    throw storeErrorFrom(error, "FAULT_INJECTED");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
