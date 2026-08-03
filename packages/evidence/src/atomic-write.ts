import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { DurableStoreError, storeErrorFrom } from "./errors.js";

export const atomicWriteBoundaries = [
  "BEFORE_TEMP_WRITE",
  "AFTER_TEMP_WRITE",
  "AFTER_TEMP_SYNC",
  "AFTER_PUBLISH",
] as const;
export type AtomicWriteBoundary = (typeof atomicWriteBoundaries)[number];
export type AtomicWriteFaultInjector = (boundary: AtomicWriteBoundary) => Promise<void> | void;

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
