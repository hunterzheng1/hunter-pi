import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { vitestResourcePolicy } from "./test/support/vitest-resource-runtime.js";

export default defineConfig({
  resolve: {
    alias: {
      "@hunter-pi/cli": fileURLToPath(new URL("./apps/cli/src/index.ts", import.meta.url)),
      "@hunter-pi/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/execution": fileURLToPath(
        new URL("./packages/execution/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/evidence/atomic-write": fileURLToPath(
        new URL("./packages/evidence/src/atomic-write.ts", import.meta.url),
      ),
      "@hunter-pi/evidence": fileURLToPath(
        new URL("./packages/evidence/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/engine-contracts": fileURLToPath(
        new URL("./packages/engine-contracts/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/managed-change": fileURLToPath(
        new URL("./packages/managed-change/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/pi-host": fileURLToPath(
        new URL("./packages/pi-host/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/pilot/internal-capture": fileURLToPath(
        new URL("./packages/pilot/src/capture-session.ts", import.meta.url),
      ),
      "@hunter-pi/pilot": fileURLToPath(new URL("./packages/pilot/src/index.ts", import.meta.url)),
      "@hunter-pi/plugin-manager": fileURLToPath(
        new URL("./packages/plugin-manager/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/updater": fileURLToPath(
        new URL("./packages/updater/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/testkit": fileURLToPath(
        new URL("./packages/testkit/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/verification": fileURLToPath(
        new URL("./packages/verification/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/workspace": fileURLToPath(
        new URL("./packages/workspace/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/workflow-kernel": fileURLToPath(
        new URL("./packages/workflow-kernel/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    clearMocks: true,
    fileParallelism: vitestResourcePolicy.fileParallelism,
    globalSetup: "./test/vitest.global-setup.ts",
    include: ["test/**/*.test.ts"],
    maxWorkers: vitestResourcePolicy.maxWorkers,
    passWithNoTests: false,
    restoreMocks: true,
    teardownTimeout: vitestResourcePolicy.teardownTimeoutMs,
    testTimeout: vitestResourcePolicy.testTimeoutMs,
  },
});
