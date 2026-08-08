import {
  atomicWriteBoundaries,
  writeImmutableAtomically,
  type AtomicWriteBoundary,
} from "../../packages/evidence/src/atomic-write.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`fixture requires ${name}`);
  return value;
}

const boundaryValue = requiredEnvironment("HPI_TEST_ATOMIC_BOUNDARY");
if (!atomicWriteBoundaries.some((boundary) => boundary === boundaryValue)) {
  throw new Error("fixture received an unsupported atomic-write boundary");
}
const boundary = boundaryValue as AtomicWriteBoundary;

await writeImmutableAtomically({
  directory: requiredEnvironment("HPI_TEST_ATOMIC_DIRECTORY"),
  filename: requiredEnvironment("HPI_TEST_ATOMIC_FILENAME"),
  content: Buffer.from(requiredEnvironment("HPI_TEST_ATOMIC_CONTENT"), "base64").toString("utf8"),
  faultInjector: async (observed) => {
    if (observed !== boundary) return;
    process.stdout.write(`${JSON.stringify({ event: "ATOMIC_WRITE_PAUSED", boundary })}\n`);
    process.stdin.resume();
    await new Promise<void>((resolvePromise) => {
      process.stdin.once("data", () => resolvePromise());
    });
  },
});
