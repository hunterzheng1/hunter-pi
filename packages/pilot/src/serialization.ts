import { createHash } from "node:crypto";

import { fingerprintSchema, type Fingerprint } from "@hunter-pi/domain";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("pilot JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("pilot JSON accepts only JSON-compatible values");
}

export function pilotFingerprint(value: unknown): Fingerprint {
  return fingerprintSchema.parse(
    `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`,
  );
}
