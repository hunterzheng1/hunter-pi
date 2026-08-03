import { randomFillSync, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rm, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { maxEvidenceCaptureBytes, schemaVersionSchema } from "@hunter-pi/domain";

import { DurableStoreError, storeErrorFrom } from "./errors.js";
import { writeImmutableAtomically } from "./atomic-write.js";

export const runLogWarningBytes = 100 * 1_024 * 1_024;
export const runLogStopBytes = 250 * 1_024 * 1_024;
export const cachePruneBytes = 2 * 1_024 * 1_024 * 1_024;
export const cacheRefuseBytes = 5 * 1_024 * 1_024 * 1_024;
export const emergencyReserveBytes = 64 * 1_024 * 1_024;
export const minimumAtomicAdmissionBytes = 64 * 1_024;

type FileStats = Awaited<ReturnType<typeof lstat>>;

function isPhysicalReserve(stats: FileStats, requiredBytes: number): boolean {
  const allocatedBlocks = typeof stats.blocks === "bigint" ? Number(stats.blocks) : stats.blocks;
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    stats.size === requiredBytes &&
    Number.isSafeInteger(allocatedBlocks) &&
    allocatedBlocks * 512 >= requiredBytes
  );
}

export const emergencyReserveStatusSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  requiredBytes: z.number().int().positive(),
  availableBytes: z.number().int().nonnegative(),
  status: z.enum(["AVAILABLE", "DEPLETED", "RELEASED"]),
});
export type EmergencyReserveStatus = z.infer<typeof emergencyReserveStatusSchema>;

export const localStorageStatusSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  streamLimitBytes: z.literal(maxEvidenceCaptureBytes),
  run: z.strictObject({
    usedBytes: z.number().int().nonnegative(),
    warningBytes: z.literal(runLogWarningBytes),
    stopBytes: z.literal(runLogStopBytes),
    status: z.enum(["OK", "WARN", "STOP"]),
  }),
  cache: z.strictObject({
    usedBytes: z.number().int().nonnegative(),
    pruneBytes: z.literal(cachePruneBytes),
    refuseBytes: z.literal(cacheRefuseBytes),
    status: z.enum(["OK", "PRUNE_REQUIRED", "REFUSE_GROWTH"]),
  }),
  emergencyReserve: z.strictObject({
    requiredBytes: z.literal(emergencyReserveBytes),
    availableBytes: z.number().int().nonnegative(),
    status: z.enum(["AVAILABLE", "DEPLETED"]),
  }),
  atomicWriteReady: z.boolean(),
  mutatingRunAllowed: z.boolean(),
});
export type LocalStorageStatus = z.infer<typeof localStorageStatusSchema>;

export function projectLocalStorageStatus(input: {
  readonly runNoncriticalBytes: number;
  readonly cacheBytes: number;
  readonly emergencyReserveAvailableBytes: number;
  readonly atomicWriteReady: boolean;
}): LocalStorageStatus {
  const runStatus =
    input.runNoncriticalBytes >= runLogStopBytes
      ? "STOP"
      : input.runNoncriticalBytes >= runLogWarningBytes
        ? "WARN"
        : "OK";
  const cacheStatus =
    input.cacheBytes >= cacheRefuseBytes
      ? "REFUSE_GROWTH"
      : input.cacheBytes >= cachePruneBytes
        ? "PRUNE_REQUIRED"
        : "OK";
  const reserveAvailable = input.emergencyReserveAvailableBytes >= emergencyReserveBytes;
  return localStorageStatusSchema.parse({
    schemaVersion: "1.0.0",
    streamLimitBytes: maxEvidenceCaptureBytes,
    run: {
      usedBytes: input.runNoncriticalBytes,
      warningBytes: runLogWarningBytes,
      stopBytes: runLogStopBytes,
      status: runStatus,
    },
    cache: {
      usedBytes: input.cacheBytes,
      pruneBytes: cachePruneBytes,
      refuseBytes: cacheRefuseBytes,
      status: cacheStatus,
    },
    emergencyReserve: {
      requiredBytes: emergencyReserveBytes,
      availableBytes: input.emergencyReserveAvailableBytes,
      status: reserveAvailable ? "AVAILABLE" : "DEPLETED",
    },
    atomicWriteReady: input.atomicWriteReady,
    mutatingRunAllowed: reserveAvailable && input.atomicWriteReady && runStatus !== "STOP",
  });
}

export class FileEmergencyReserve {
  readonly #stateRoot: string;
  readonly #reserveBytes: number;

  public constructor(options: { readonly stateRoot: string; readonly reserveBytes?: number }) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#reserveBytes = options.reserveBytes ?? emergencyReserveBytes;
    if (!Number.isSafeInteger(this.#reserveBytes) || this.#reserveBytes <= 0) {
      throw new RangeError("reserveBytes must be a positive safe integer");
    }
  }

  public get requiredBytes(): number {
    return this.#reserveBytes;
  }

  public async ensure(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true });
    const reservePath = join(this.#stateRoot, ".critical-reserve");
    try {
      const existing = await lstat(reservePath);
      if (isPhysicalReserve(existing, this.#reserveBytes)) {
        return;
      }
      throw new DurableStoreError(
        "RESERVE_CORRUPT",
        "The emergency reserve has an unexpected identity or size.",
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const temporaryPath = join(this.#stateRoot, `.critical-reserve.pending-${randomUUID()}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, this.#reserveBytes));
      let written = 0;
      while (written < this.#reserveBytes) {
        randomFillSync(chunk);
        const remaining = this.#reserveBytes - written;
        const bytes = remaining < chunk.byteLength ? chunk.subarray(0, remaining) : chunk;
        const result = await handle.write(bytes);
        if (result.bytesWritten <= 0) {
          throw new DurableStoreError(
            "RESERVE_CORRUPT",
            "The emergency reserve write made no forward progress.",
          );
        }
        written += result.bytesWritten;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, reservePath);
      await rm(temporaryPath, { force: true });
      const committed = await lstat(reservePath);
      if (!isPhysicalReserve(committed, this.#reserveBytes)) {
        await rm(reservePath, { force: true });
        throw new DurableStoreError(
          "RESERVE_CORRUPT",
          "The emergency reserve did not allocate its promised physical capacity.",
        );
      }
    } catch (error) {
      throw storeErrorFrom(error, "RESERVE_CORRUPT");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  public async release(): Promise<void> {
    const status = await this.status();
    if (status.status === "RELEASED") {
      return;
    }
    if (status.status !== "AVAILABLE") {
      throw new DurableStoreError(
        "RESERVE_CORRUPT",
        "An invalid emergency reserve cannot be treated as reclaimable capacity.",
      );
    }
    await rm(join(this.#stateRoot, ".critical-reserve"), { force: true });
  }

  public async status(): Promise<EmergencyReserveStatus> {
    try {
      const reserve = await lstat(join(this.#stateRoot, ".critical-reserve"));
      const available = isPhysicalReserve(reserve, this.#reserveBytes);
      const availableBytes = available ? reserve.size : 0;
      return emergencyReserveStatusSchema.parse({
        schemaVersion: "1.0.0",
        requiredBytes: this.#reserveBytes,
        availableBytes,
        status: available ? "AVAILABLE" : "DEPLETED",
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emergencyReserveStatusSchema.parse({
          schemaVersion: "1.0.0",
          requiredBytes: this.#reserveBytes,
          availableBytes: 0,
          status: "RELEASED",
        });
      }
      throw storeErrorFrom(error, "RESERVE_CORRUPT");
    }
  }
}

export interface LocalStorageControllerOptions {
  readonly stateRoot: string;
  readonly reserveBytes?: number;
  readonly capacityProbe?: () => Promise<number>;
}

export class LocalStorageController {
  readonly #stateRoot: string;
  readonly #capacityProbe: () => Promise<number>;
  readonly #reserve: FileEmergencyReserve;

  public constructor(options: LocalStorageControllerOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#reserve = new FileEmergencyReserve({
      stateRoot: this.#stateRoot,
      ...(options.reserveBytes === undefined ? {} : { reserveBytes: options.reserveBytes }),
    });
    this.#capacityProbe =
      options.capacityProbe ??
      (async () => {
        await mkdir(this.#stateRoot, { recursive: true });
        const capacity = await statfs(this.#stateRoot);
        return capacity.bavail * capacity.bsize;
      });
  }

  public async assertNonCriticalGrowth(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("growth bytes must be a nonnegative safe integer");
    }
    await this.#reserve.ensure();
    const availableBytes = await this.#capacityProbe();
    if (!Number.isSafeInteger(availableBytes) || availableBytes < bytes) {
      throw new DurableStoreError(
        "RESERVE_REQUIRED",
        "Noncritical content was reduced to preserve critical-state capacity.",
      );
    }
  }

  public async assertMutatingRunAllowed(): Promise<void> {
    try {
      await this.#reserve.ensure();
      const status = await this.#reserve.status();
      if (status.status !== "AVAILABLE" || status.availableBytes !== status.requiredBytes) {
        throw new DurableStoreError(
          "RESERVE_REQUIRED",
          "A new mutating Run requires an intact emergency reserve.",
        );
      }
      const availableBytes = await this.#capacityProbe();
      if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumAtomicAdmissionBytes) {
        throw new DurableStoreError(
          "RESERVE_REQUIRED",
          "A new mutating Run requires free space beyond the emergency reserve.",
        );
      }
      const probeDirectory = join(this.#stateRoot, ".atomic-admission-probe");
      const probeFilename = `probe-${randomUUID()}.json`;
      try {
        await writeImmutableAtomically({
          directory: probeDirectory,
          filename: probeFilename,
          content: '{"schemaVersion":"1.0.0"}\n',
        });
      } finally {
        await rm(join(probeDirectory, probeFilename), { force: true }).catch(() => undefined);
        await rm(probeDirectory).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof DurableStoreError && error.code === "RESERVE_REQUIRED") {
        throw error;
      }
      throw new DurableStoreError(
        "RESERVE_REQUIRED",
        "A new mutating Run is blocked because the emergency reserve is unavailable.",
        error,
      );
    }
  }

  public async writeCritical(write: () => Promise<void>): Promise<void> {
    await this.#reserve.ensure();
    try {
      await write();
      return;
    } catch (error) {
      const durableError = storeErrorFrom(error, "FAULT_INJECTED");
      if (durableError.code !== "STORAGE_EXHAUSTED") {
        throw durableError;
      }
    }

    await this.#reserve.release();
    let retryError: unknown;
    try {
      await write();
    } catch (error) {
      retryError = error;
    }
    try {
      await this.#reserve.ensure();
    } catch (error) {
      throw new DurableStoreError(
        "RESERVE_REQUIRED",
        "The critical write committed, but the emergency reserve could not be restored.",
        error,
      );
    }
    if (retryError !== undefined) {
      throw storeErrorFrom(retryError, "STORAGE_EXHAUSTED");
    }
  }
}
