import { isAbsolute } from "node:path";

import { z } from "zod";

export const PI_PACKAGE_INSTALL_WORKER_ARGUMENT = "--hpi-internal-pi-package-install-worker-v1";

const piPackageInstallWorkerPayloadSchema = z.strictObject({
  stagingRoot: z.string().min(1).max(32_768).refine(isAbsolute),
  source: z.string().min(1).max(8_192),
  registry: z
    .url()
    .refine((value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username.length === 0 &&
        parsed.password.length === 0 &&
        parsed.search.length === 0 &&
        parsed.hash.length === 0
      );
    })
    .optional(),
});
export type PiPackageInstallWorkerPayload = z.infer<typeof piPackageInstallWorkerPayloadSchema>;

export function encodePiPackageInstallWorkerPayload(input: PiPackageInstallWorkerPayload): string {
  const payload = piPackageInstallWorkerPayloadSchema.parse(input);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePiPackageInstallWorkerPayload(
  encoded: string,
): PiPackageInstallWorkerPayload {
  return piPackageInstallWorkerPayloadSchema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
  );
}
