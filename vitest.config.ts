import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hunter-pi/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/evidence": fileURLToPath(
        new URL("./packages/evidence/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/engine-contracts": fileURLToPath(
        new URL("./packages/engine-contracts/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/pi-host": fileURLToPath(
        new URL("./packages/pi-host/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/testkit": fileURLToPath(
        new URL("./packages/testkit/src/index.ts", import.meta.url),
      ),
      "@hunter-pi/workflow-kernel": fileURLToPath(
        new URL("./packages/workflow-kernel/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    clearMocks: true,
    include: ["test/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
