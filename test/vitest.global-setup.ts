import { setupVitestResourceRuntime } from "./support/vitest-resource-runtime.js";

export default async function setup(): Promise<() => Promise<void>> {
  const runtime = await setupVitestResourceRuntime();
  return () => runtime.teardown();
}
