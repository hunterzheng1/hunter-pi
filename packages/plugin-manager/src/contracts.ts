import { z } from "zod";

import {
  evidenceIdSchema,
  fingerprintSchema,
  operationIdSchema,
  pluginAssuranceReceiptSchema,
  pluginCompatibilitySchema,
  pluginIdSchema,
  pluginIsolationSchema,
  pluginTrustSchema,
  timestampSchema,
} from "@hunter-pi/domain";

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
function containsCredentialBearingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

function containsUnsafePath(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded.startsWith("/") ||
      decoded.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/u.test(decoded) ||
      /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(decoded)
    );
  } catch {
    return true;
  }
}

const publicReferenceSchema = nonEmptyTextSchema.refine(
  (value) =>
    !containsUnsafePath(value) &&
    !/(?:^|[\s"'])[A-Za-z]:[\\/]|(?:^|[\s"'])\/(?:Users|home|private|tmp)\//u.test(value) &&
    !/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu.test(value) &&
    !containsCredentialBearingUrl(value),
  "private paths and credential material are not portable Plugin references",
);
const publicUrlSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0
  );
}, "credential-bearing URLs and non-HTTPS URLs are not portable Plugin references");
const exactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const resourceNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "resource names must be stable path-safe identifiers");

export const pluginSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("LOCAL"),
    label: publicReferenceSchema,
    pathFingerprint: fingerprintSchema,
    contentFingerprint: fingerprintSchema,
  }),
  z.strictObject({
    kind: z.literal("NPM"),
    registry: publicUrlSchema,
    packageName: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
    version: exactVersionSchema,
    integrity: fingerprintSchema,
  }),
  z.strictObject({
    kind: z.literal("GIT"),
    remote: publicUrlSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    treeFingerprint: fingerprintSchema,
  }),
  z.strictObject({
    kind: z.literal("PI"),
    packageName: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
    version: exactVersionSchema,
    integrity: fingerprintSchema,
  }),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const pluginResourceSchema = z.strictObject({
  name: resourceNameSchema,
  description: nonEmptyTextSchema,
});
export type PluginResource = z.infer<typeof pluginResourceSchema>;

export const pluginResourceInventorySchema = z.strictObject({
  tools: z.array(pluginResourceSchema),
  hooks: z.array(pluginResourceSchema),
});
export type PluginResourceInventory = z.infer<typeof pluginResourceInventorySchema>;

export const pluginProvenanceSchema = z.strictObject({
  upstreamName: publicReferenceSchema,
  sourceReference: publicReferenceSchema,
  sourceFingerprint: fingerprintSchema,
  licenseReference: publicReferenceSchema,
});

export const pluginManifestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-manifest.v1"),
  pluginId: pluginIdSchema,
  version: exactVersionSchema,
  source: pluginSourceSchema,
  packageFingerprint: fingerprintSchema,
  license: nonEmptyTextSchema,
  provenance: pluginProvenanceSchema,
  resources: pluginResourceInventorySchema,
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginCompatibilityVerificationSchema = z.strictObject({
  outcome: pluginCompatibilitySchema,
  verifierFingerprint: fingerprintSchema,
  evidenceIds: z.array(evidenceIdSchema),
});
export type PluginCompatibilityVerification = z.input<typeof pluginCompatibilityVerificationSchema>;

export const pluginIsolationVerificationSchema = z.strictObject({
  outcome: z.literal("CONTAINED"),
  verifierFingerprint: fingerprintSchema,
  evidenceIds: z.array(evidenceIdSchema),
});
export type PluginIsolationVerification = z.input<typeof pluginIsolationVerificationSchema>;

const pluginInstallFields = {
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  source: pluginSourceSchema,
  trust: pluginTrustSchema,
  provenanceAcknowledged: z.boolean(),
  requestedIsolation: pluginIsolationSchema,
  compatibility: pluginCompatibilitySchema,
  evidenceIds: z.array(evidenceIdSchema),
  isolationEvidenceIds: z.array(evidenceIdSchema).optional(),
  observedAt: timestampSchema,
};

export const pluginInstallRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-install.v1"),
  ...pluginInstallFields,
});
export type PluginInstallRequest = z.input<typeof pluginInstallRequestSchema>;

export const pluginImportFromPiRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-import-pi.v1"),
  ...pluginInstallFields,
  source: pluginSourceSchema.refine(
    (source) => source.kind === "PI",
    "Pi import requires a PI source",
  ),
});
export type PluginImportFromPiRequest = z.input<typeof pluginImportFromPiRequestSchema>;

export const pluginDisableRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-disable.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  pluginId: pluginIdSchema,
  observedAt: timestampSchema,
});
export type PluginDisableRequest = z.input<typeof pluginDisableRequestSchema>;

export const pluginRemoveRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-remove.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  pluginId: pluginIdSchema,
  observedAt: timestampSchema,
});
export type PluginRemoveRequest = z.input<typeof pluginRemoveRequestSchema>;

export const pluginOperationReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-operation-receipt.v1"),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  action: z.enum(["INSTALL", "IMPORT_FROM_PI", "DISABLE", "REMOVE"]),
  pluginId: pluginIdSchema,
  outcome: z.enum(["APPLIED", "NOOP", "BLOCKED"]),
  compatibility: pluginCompatibilitySchema.optional(),
  trust: pluginTrustSchema.optional(),
  isolation: pluginIsolationSchema.optional(),
  reason: nonEmptyTextSchema.optional(),
  observedAt: timestampSchema,
});
export type PluginOperationReceipt = z.infer<typeof pluginOperationReceiptSchema>;

export const pluginRecordSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-record.v1"),
  pluginId: pluginIdSchema,
  manifest: pluginManifestSchema,
  state: z.enum(["ENABLED", "DISABLED", "QUARANTINED"]),
  assurance: pluginAssuranceReceiptSchema,
  installedAt: timestampSchema,
  lastOperationId: operationIdSchema,
});
export type PluginRecord = z.infer<typeof pluginRecordSchema>;

export const pluginJournalEntrySchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-journal.v1"),
  sequence: z.number().int().positive(),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
  action: z.enum(["INSTALL", "IMPORT_FROM_PI", "DISABLE", "REMOVE"]),
  pluginId: pluginIdSchema,
  record: pluginRecordSchema.optional(),
  receipt: pluginOperationReceiptSchema,
  createdAt: timestampSchema,
  previousEntryFingerprint: fingerprintSchema.nullable(),
  entryFingerprint: fingerprintSchema,
});
export type PluginJournalEntry = z.infer<typeof pluginJournalEntrySchema>;

const inventoryResourceSchema = z.strictObject({
  pluginId: pluginIdSchema,
  name: resourceNameSchema,
  description: nonEmptyTextSchema,
});

export const pluginInventorySchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-inventory.v1"),
  safeMode: z.boolean(),
  declaredTools: z.array(inventoryResourceSchema),
  declaredHooks: z.array(inventoryResourceSchema),
  effectiveTools: z.array(inventoryResourceSchema),
  effectiveHooks: z.array(inventoryResourceSchema),
  conflicts: z.array(
    z.strictObject({
      pluginId: pluginIdSchema,
      resourceKind: z.enum(["TOOL", "HOOK"]),
      resourceName: resourceNameSchema,
      reason: nonEmptyTextSchema,
    }),
  ),
});
export type PluginInventory = z.infer<typeof pluginInventorySchema>;

export const pluginStartupDecisionSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-startup.v1"),
  mode: z.enum(["NORMAL", "SAFE_MODE"]),
  reasons: z.array(
    z.enum(["JOURNAL_CORRUPT", "PLUGIN_QUARANTINED", "RESERVED_RESOURCE_COLLISION"]),
  ),
  pluginIds: z.array(pluginIdSchema),
});
export type PluginStartupDecision = z.infer<typeof pluginStartupDecisionSchema>;

export const pluginSafeModeRecoveryRequestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-safe-mode-recovery.v1"),
  operations: z.array(pluginDisableRequestSchema),
});
export type PluginSafeModeRecoveryRequest = z.input<typeof pluginSafeModeRecoveryRequestSchema>;

export interface PluginSourceResolver {
  resolve(source: PluginSource): Promise<PluginManifest>;
}

export interface PluginManager {
  list(): Promise<readonly PluginRecord[]>;
  install(request: PluginInstallRequest): Promise<PluginOperationReceipt>;
  importFromPi(request: PluginImportFromPiRequest): Promise<PluginOperationReceipt>;
  disable(request: PluginDisableRequest): Promise<PluginOperationReceipt>;
  remove(request: PluginRemoveRequest): Promise<PluginOperationReceipt>;
  inventory(): Promise<PluginInventory>;
  startup(): Promise<PluginStartupDecision>;
  recoverSafeMode(
    request: PluginSafeModeRecoveryRequest,
  ): Promise<readonly PluginOperationReceipt[]>;
}
