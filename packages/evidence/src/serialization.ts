import { createHash } from "node:crypto";

import type { Fingerprint } from "@hunter-pi/domain";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON rejects non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        normalized[key] = normalize(item);
      }
    }
    return normalized;
  }
  throw new TypeError("canonical JSON accepts only JSON-compatible values");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Fingerprint(value: string | Uint8Array): Fingerprint {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
