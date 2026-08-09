import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import { createTemporaryTestDirectory } from "./temporary-test-directory.js";

const temporaryVariableNames = ["TEMP", "TMP", "TMPDIR"] as const;

export const vitestResourcePolicy = {
  cleanupMaxRetries: 5,
  cleanupRetryDelayMs: 100,
  fileParallelism: false,
  managedProcessIntegrationTimeoutMs: 60_000,
  maxWorkers: 1,
  testTimeoutMs: 30_000,
  temporaryRootPrefix: "hunter-pi-vitest-",
  teardownTimeoutMs: 30_000,
} as const;

export interface VitestResourceRuntime {
  readonly temporaryRoot: string;
  teardown(): Promise<void>;
}

export async function setupVitestResourceRuntime(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly parentDirectory?: string;
  } = {},
): Promise<VitestResourceRuntime> {
  const environment = options.environment ?? process.env;
  const parentDirectory = options.parentDirectory ?? tmpdir();
  const canonicalParent = await realpath(parentDirectory);
  const temporaryRoot = await createTemporaryTestDirectory(
    canonicalParent,
    vitestResourcePolicy.temporaryRootPrefix,
  );
  const relativeRoot = relative(canonicalParent, temporaryRoot);
  if (
    relativeRoot.length === 0 ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRoot)
  ) {
    throw new Error("Vitest temporary root escaped its declared parent");
  }

  const previousValues = new Map(
    temporaryVariableNames.map((name) => [
      name,
      {
        present: Object.hasOwn(environment, name),
        value: environment[name],
      },
    ]),
  );
  for (const name of temporaryVariableNames) environment[name] = temporaryRoot;

  let removed = false;
  return {
    temporaryRoot,
    teardown: async () => {
      if (removed) return;
      for (const name of temporaryVariableNames) {
        const previous = previousValues.get(name);
        if (previous?.present === true && previous.value !== undefined) {
          environment[name] = previous.value;
        } else {
          Reflect.deleteProperty(environment, name);
        }
      }
      await rm(temporaryRoot, {
        force: true,
        maxRetries: vitestResourcePolicy.cleanupMaxRetries,
        recursive: true,
        retryDelay: vitestResourcePolicy.cleanupRetryDelayMs,
      });
      removed = true;
    },
  };
}
