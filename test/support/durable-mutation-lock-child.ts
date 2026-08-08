import { setTimeout as delay } from "node:timers/promises";

import { withDurableMutationLock } from "../../packages/evidence/src/atomic-write.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`fixture requires ${name}`);
  }
  return value;
}

const lockPath = requiredEnvironment("HPI_TEST_LOCK_PATH");
const mode = requiredEnvironment("HPI_TEST_LOCK_MODE");
const holdMs = Number.parseInt(process.env["HPI_TEST_LOCK_HOLD_MS"] ?? "0", 10);

await withDurableMutationLock(lockPath, async () => {
  process.stdout.write(`${JSON.stringify({ event: "LOCKED", pid: process.pid })}\n`);
  if (mode === "EXIT_WHILE_HELD") {
    process.exit(73);
  }
  if (mode === "WAIT_FOR_INPUT") {
    process.stdin.resume();
    await new Promise<void>((resolvePromise) => {
      process.stdin.once("data", () => {
        resolvePromise();
      });
    });
    return;
  }
  if (mode !== "HOLD_FOR_MS" || !Number.isSafeInteger(holdMs) || holdMs < 0) {
    throw new Error("fixture received an unsupported lock mode");
  }
  await delay(holdMs);
});

process.stdout.write(`${JSON.stringify({ event: "RELEASED", pid: process.pid })}\n`);
