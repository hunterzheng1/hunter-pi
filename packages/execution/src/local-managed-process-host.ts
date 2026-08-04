import type { LeaseManager } from "./contracts.js";
import { createManagedProcessHost } from "./managed-process-host.js";
import type { ManagedProcessHost } from "./process-contracts.js";
import { ManagedProcessError } from "./process-errors.js";
import type { ManagedProcessDriver } from "./process-platform.js";
import { PosixProcessGroupDriver } from "./posix-process-group-driver.js";
import { WindowsJobObjectDriver } from "./windows-job-driver.js";

export interface LocalManagedProcessHostOptions {
  readonly leaseManager: LeaseManager;
  readonly now?: () => string;
}

function createPlatformDriver(): ManagedProcessDriver {
  if (process.platform === "win32") return new WindowsJobObjectDriver();
  if (process.platform === "linux") return new PosixProcessGroupDriver();
  throw new ManagedProcessError(
    "PROCESS_PLATFORM_UNAVAILABLE",
    "managed process containment is unavailable on this platform",
  );
}

export function createLocalManagedProcessHost(
  options: LocalManagedProcessHostOptions,
): ManagedProcessHost {
  return createManagedProcessHost({
    driver: createPlatformDriver(),
    leaseManager: options.leaseManager,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
