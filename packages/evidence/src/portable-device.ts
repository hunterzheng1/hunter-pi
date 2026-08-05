import { z } from "zod";

import { fingerprintSchema, operationIdSchema, timestampSchema } from "@hunter-pi/domain";

import {
  archivePackageSchema,
  assertArchivePackage,
  assertPortableArchive,
  type ArchiveImportReceipt,
  type RunArchiveStore,
} from "./archive.js";

const profileIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "device profile must be a stable identifier");
const readinessSchema = z.enum(["PASS", "BLOCKED", "NOT_PROVEN"]);

export const portableDeviceImportRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  profileId: profileIdSchema,
  projectPolicy: z.strictObject({
    schemaVersion: z.literal("hpi-project-policy.v1"),
    policyFingerprint: fingerprintSchema,
  }),
  archive: archivePackageSchema,
  observedAt: timestampSchema,
});
export type PortableDeviceImportRequest = z.input<typeof portableDeviceImportRequestSchema>;

export const portableDeviceImportReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-device-import-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  profileId: profileIdSchema,
  archiveId: z.string().trim().min(1).max(256),
  archiveOutcome: z.enum(["APPLIED", "NOOP"]),
  policyOutcome: readinessSchema,
  doctorStatus: readinessSchema,
  loginReadiness: readinessSchema,
  outcome: z.enum(["READY", "BLOCKED", "NOT_PROVEN"]),
  observedAt: timestampSchema,
});
export type PortableDeviceImportReceipt = z.infer<typeof portableDeviceImportReceiptSchema>;

const rollbackFunctionSchema = z.custom<() => Promise<void>>(
  (value) => typeof value === "function",
  "policy clone rollback must be a function",
);

export const projectPolicyCloneResultSchema = z.strictObject({
  status: readinessSchema,
  policyFingerprint: fingerprintSchema,
  rollback: rollbackFunctionSchema.optional(),
});
export type ProjectPolicyCloneResult = z.infer<typeof projectPolicyCloneResultSchema>;

export interface ProjectPolicyCloner {
  clone(input: {
    readonly profileId: string;
    readonly policyFingerprint: string;
  }): Promise<ProjectPolicyCloneResult>;
}

export interface DeviceDoctor {
  run(input: { readonly profileId: string }): Promise<z.infer<typeof readinessSchema>>;
}

export interface DeviceLoginReadiness {
  check(input: { readonly profileId: string }): Promise<z.infer<typeof readinessSchema>>;
}

export interface PortableDeviceImporterOptions {
  readonly archiveStore: RunArchiveStore;
  readonly clonePolicy: ProjectPolicyCloner;
  readonly doctor: DeviceDoctor;
  readonly loginReadiness: DeviceLoginReadiness;
}

function overallOutcome(
  policyOutcome: z.infer<typeof readinessSchema>,
  doctorStatus: z.infer<typeof readinessSchema>,
  loginReadiness: z.infer<typeof readinessSchema>,
): "READY" | "BLOCKED" | "NOT_PROVEN" {
  const statuses = [policyOutcome, doctorStatus, loginReadiness];
  if (statuses.includes("NOT_PROVEN")) return "NOT_PROVEN";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  return "READY";
}

export class PortableDeviceImporter {
  readonly #archiveStore: RunArchiveStore;
  readonly #clonePolicy: ProjectPolicyCloner;
  readonly #doctor: DeviceDoctor;
  readonly #loginReadiness: DeviceLoginReadiness;

  public constructor(options: PortableDeviceImporterOptions) {
    this.#archiveStore = options.archiveStore;
    this.#clonePolicy = options.clonePolicy;
    this.#doctor = options.doctor;
    this.#loginReadiness = options.loginReadiness;
  }

  public async import(request: PortableDeviceImportRequest): Promise<PortableDeviceImportReceipt> {
    const parsed = portableDeviceImportRequestSchema.parse(request);
    assertPortableArchive(parsed.archive);
    assertArchivePackage(parsed.archive);
    let cloneResult: ProjectPolicyCloneResult;
    try {
      cloneResult = projectPolicyCloneResultSchema.parse(
        await this.#clonePolicy.clone({
          profileId: parsed.profileId,
          policyFingerprint: parsed.projectPolicy.policyFingerprint,
        }),
      );
    } catch (error) {
      throw new Error(
        "device policy clone result must include status and the exact policy fingerprint",
        { cause: error },
      );
    }
    const policyOutcome = cloneResult.status;
    const rollbackPolicy = cloneResult.rollback;
    if (
      cloneResult.status === "PASS" &&
      cloneResult.policyFingerprint !== parsed.projectPolicy.policyFingerprint
    ) {
      await rollbackPolicy?.();
      throw new Error("device policy clone did not bind the requested policy fingerprint");
    }
    try {
      let doctorStatus: z.infer<typeof readinessSchema> = "NOT_PROVEN";
      let loginReadiness: z.infer<typeof readinessSchema> = "NOT_PROVEN";
      if (policyOutcome === "PASS") {
        doctorStatus = await this.#doctor.run({ profileId: parsed.profileId });
        if (doctorStatus === "PASS") {
          loginReadiness = await this.#loginReadiness.check({ profileId: parsed.profileId });
        }
      }
      const archiveReceipt = await this.#importArchive(parsed);
      return this.#receipt(parsed, archiveReceipt, policyOutcome, doctorStatus, loginReadiness);
    } catch (error) {
      try {
        await rollbackPolicy?.();
      } catch (rollbackError) {
        throw new Error("device import failed and policy rollback also failed", {
          cause: rollbackError,
        });
      }
      throw error;
    }
  }

  async #importArchive(
    request: z.infer<typeof portableDeviceImportRequestSchema>,
  ): Promise<ArchiveImportReceipt> {
    return this.#archiveStore.import({
      schemaVersion: "hpi-archive-import.v1",
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      archive: request.archive,
    });
  }

  #receipt(
    request: z.infer<typeof portableDeviceImportRequestSchema>,
    archiveReceipt: ArchiveImportReceipt,
    policyOutcome: z.infer<typeof readinessSchema>,
    doctorStatus: z.infer<typeof readinessSchema>,
    loginReadiness: z.infer<typeof readinessSchema>,
  ): PortableDeviceImportReceipt {
    return portableDeviceImportReceiptSchema.parse({
      schemaVersion: "hpi-device-import-receipt.v1",
      operationId: request.operationId,
      operationFingerprint: request.operationFingerprint,
      profileId: request.profileId,
      archiveId: archiveReceipt.archiveId,
      archiveOutcome: archiveReceipt.outcome,
      policyOutcome,
      doctorStatus,
      loginReadiness,
      outcome: overallOutcome(policyOutcome, doctorStatus, loginReadiness),
      observedAt: request.observedAt,
    });
  }
}
