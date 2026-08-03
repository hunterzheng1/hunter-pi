import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { PI_CANDIDATE } from "@hunter-pi/pi-host";

export const HPI_PRODUCT_VERSION = "0.1.0-dev.0" as const;

declare const HPI_BUNDLED_ARTIFACT: boolean | undefined;

const buildInfoSchema = z.strictObject({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceState: z.enum(["CLEAN", "DIRTY"]),
  coreExtensionIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  productShellIntegrity: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

export interface HpiVersionInfo {
  readonly product: "Hunter Pi";
  readonly productVersion: typeof HPI_PRODUCT_VERSION;
  readonly engine: {
    readonly packageName: typeof PI_CANDIDATE.packageName;
    readonly version: typeof PI_CANDIDATE.version;
  };
  readonly sourceCommit: string;
  readonly sourceState: "CLEAN" | "DIRTY" | "NOT_STAMPED";
  readonly coreExtensionIntegrity: string | null;
  readonly productShellIntegrity: string | null;
  readonly updateChannel: "developer-preview";
}

export async function getHpiVersionInfo(
  buildInfoUrl: URL = new URL("./build-info.json", import.meta.url),
): Promise<HpiVersionInfo> {
  let sourceCommit = "NOT_STAMPED";
  let sourceState: HpiVersionInfo["sourceState"] = "NOT_STAMPED";
  let coreExtensionIntegrity: string | null = null;
  let productShellIntegrity: string | null = null;
  try {
    const buildInfo = buildInfoSchema.parse(JSON.parse(await readFile(buildInfoUrl, "utf8")));
    const actualProductShellIntegrity = `sha256:${createHash("sha256")
      .update(await readFile(new URL("./hpi.js", buildInfoUrl)))
      .digest("hex")}`;
    if (actualProductShellIntegrity !== buildInfo.productShellIntegrity) {
      throw new Error("The packaged Hunter Pi product shell integrity does not match its stamp.");
    }
    sourceCommit = buildInfo.sourceCommit;
    sourceState = buildInfo.sourceState;
    coreExtensionIntegrity = buildInfo.coreExtensionIntegrity;
    productShellIntegrity = buildInfo.productShellIntegrity;
  } catch (error) {
    if (typeof HPI_BUNDLED_ARTIFACT !== "undefined" && HPI_BUNDLED_ARTIFACT) {
      throw new Error("The packaged Hunter Pi build identity is missing or incompatible.", {
        cause: error,
      });
    }
    // Workspace execution is deliberately distinguishable from a stamped package artifact.
  }
  return {
    product: "Hunter Pi",
    productVersion: HPI_PRODUCT_VERSION,
    engine: {
      packageName: PI_CANDIDATE.packageName,
      version: PI_CANDIDATE.version,
    },
    sourceCommit,
    sourceState,
    coreExtensionIntegrity,
    productShellIntegrity,
    updateChannel: "developer-preview",
  };
}
