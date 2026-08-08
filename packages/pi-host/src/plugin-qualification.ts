import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  evidenceIdSchema,
  fingerprintSchema,
  pluginIdSchema,
  timestampSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import { pluginManifestV2Schema } from "@hunter-pi/plugin-manager";
import { z } from "zod";

import {
  assertResolverPiPackageInspection,
  type PiPackageInspection,
} from "./pi-package-resolver.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): Fingerprint {
  return fingerprintSchema.parse(
    `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`,
  );
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export const PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT = digest({
  implementation: "hunter-pi-public-package-metadata-verifier",
  version: 1,
  engineRelease: "@earendil-works/pi-coding-agent@0.83.0",
  executablePolicy: "RESOURCE_ONLY",
});

const PI_PACKAGE_QUALIFICATION_CHECK_IDS = [
  "PUBLIC_PACKAGE_MANAGER_RESOLUTION",
  "EXACT_SOURCE_BINDING",
  "PORTABLE_RESOURCE_INVENTORY",
  "EXECUTABLE_SURFACE",
] as const;

const qualificationCheckSchema = z.strictObject({
  checkId: z.enum(PI_PACKAGE_QUALIFICATION_CHECK_IDS),
  outcome: z.enum(["PASS", "NOT_PROVEN"]),
});

export const piPackageQualificationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("hpi-pi-package-qualification.v1"),
    evidenceId: evidenceIdSchema,
    pluginId: pluginIdSchema,
    pluginVersion: z.string().min(1),
    packageFingerprint: fingerprintSchema,
    manifestFingerprint: fingerprintSchema,
    verifierFingerprint: z.literal(PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT),
    engineRelease: z.literal("@earendil-works/pi-coding-agent@0.83.0"),
    compatibility: z.enum(["VERIFIED", "UNVERIFIED"]),
    checks: z
      .array(qualificationCheckSchema)
      .length(PI_PACKAGE_QUALIFICATION_CHECK_IDS.length)
      .superRefine((checks, context) => {
        if (
          checks.some((check, index) => check.checkId !== PI_PACKAGE_QUALIFICATION_CHECK_IDS[index])
        ) {
          context.addIssue({
            code: "custom",
            message: "Pi Package qualification checks are not exact",
          });
        }
      }),
    observedAt: timestampSchema,
    receiptFingerprint: fingerprintSchema,
  })
  .superRefine((receipt, context) => {
    const { receiptFingerprint, ...payload } = receipt;
    if (receiptFingerprint !== digest(payload)) {
      context.addIssue({ code: "custom", message: "qualification receipt fingerprint is invalid" });
    }
    const allChecksPass = receipt.checks.every((check) => check.outcome === "PASS");
    if ((receipt.compatibility === "VERIFIED") !== allChecksPass) {
      context.addIssue({
        code: "custom",
        message: "qualification compatibility does not match its checks",
      });
    }
    const evidenceIdentity = digest({
      manifestFingerprint: receipt.manifestFingerprint,
      observedAt: receipt.observedAt,
    });
    const expectedEvidenceId = `evidence_plugin-qualification-${evidenceIdentity.slice(
      "sha256:".length,
      36,
    )}`;
    if (receipt.evidenceId !== expectedEvidenceId) {
      context.addIssue({ code: "custom", message: "qualification Evidence identity is invalid" });
    }
  });
export type PiPackageQualificationReceipt = z.infer<typeof piPackageQualificationReceiptSchema>;

async function readPhysicalQualification(path: string): Promise<PiPackageQualificationReceipt> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("Pi Package qualification Evidence must be a physical single-link file");
  }
  return piPackageQualificationReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function physicalQualificationStateRoot(stateRoot: string): Promise<string> {
  const root = resolve(stateRoot);
  const rootStatus = await lstat(root);
  const canonicalRoot = await realpath(root);
  if (
    !rootStatus.isDirectory() ||
    rootStatus.isSymbolicLink() ||
    comparablePath(canonicalRoot) !== comparablePath(root)
  ) {
    throw new Error("Pi Package qualification store must be a physical canonical directory");
  }
  return canonicalRoot;
}

export function fingerprintPiPackageManifest(manifest: unknown): Fingerprint {
  return digest(pluginManifestV2Schema.parse(manifest));
}

export async function readPiPackageQualificationReceipt(options: {
  readonly stateRoot: string;
  readonly evidenceId: string;
}): Promise<PiPackageQualificationReceipt> {
  const evidenceId = evidenceIdSchema.parse(options.evidenceId);
  const stateRoot = await physicalQualificationStateRoot(options.stateRoot);
  return readPhysicalQualification(join(stateRoot, `${evidenceId}.json`));
}

function receiptPayload(
  receipt: Omit<PiPackageQualificationReceipt, "receiptFingerprint">,
): Omit<PiPackageQualificationReceipt, "receiptFingerprint"> {
  return receipt;
}

export async function qualifyPiPackageInspection(options: {
  readonly inspection: PiPackageInspection;
  readonly stateRoot: string;
  readonly observedAt: string;
}): Promise<PiPackageQualificationReceipt> {
  assertResolverPiPackageInspection(options.inspection);
  const manifest = pluginManifestV2Schema.parse(options.inspection.manifest);
  const executableSurfacePass = manifest.executableSurface === "NONE";
  const manifestFingerprint = fingerprintPiPackageManifest(manifest);
  const evidenceIdentity = digest({ manifestFingerprint, observedAt: options.observedAt });
  const evidenceId = evidenceIdSchema.parse(
    `evidence_plugin-qualification-${evidenceIdentity.slice("sha256:".length, 36)}`,
  );
  const payload = receiptPayload({
    schemaVersion: "hpi-pi-package-qualification.v1",
    evidenceId,
    pluginId: manifest.pluginId,
    pluginVersion: manifest.version,
    packageFingerprint: manifest.packageFingerprint,
    manifestFingerprint,
    verifierFingerprint: PI_PACKAGE_METADATA_VERIFIER_FINGERPRINT,
    engineRelease: "@earendil-works/pi-coding-agent@0.83.0",
    compatibility: executableSurfacePass ? "VERIFIED" : "UNVERIFIED",
    checks: [
      { checkId: "PUBLIC_PACKAGE_MANAGER_RESOLUTION", outcome: "PASS" },
      { checkId: "EXACT_SOURCE_BINDING", outcome: "PASS" },
      { checkId: "PORTABLE_RESOURCE_INVENTORY", outcome: "PASS" },
      {
        checkId: "EXECUTABLE_SURFACE",
        outcome: executableSurfacePass ? "PASS" : "NOT_PROVEN",
      },
    ],
    observedAt: options.observedAt,
  });
  const receipt = piPackageQualificationReceiptSchema.parse({
    ...payload,
    receiptFingerprint: digest(payload),
  });
  const stateRoot = resolve(options.stateRoot);
  await mkdir(stateRoot, { recursive: true });
  await physicalQualificationStateRoot(stateRoot);
  const finalPath = join(stateRoot, `${receipt.evidenceId}.json`);
  try {
    const existing = await readPhysicalQualification(finalPath);
    if (canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error("Pi Package qualification Evidence identity changed");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = join(stateRoot, `.pending-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readPhysicalQualification(finalPath);
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new Error("Pi Package qualification identity changed during concurrent write", {
          cause: error,
        });
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return receipt;
}
