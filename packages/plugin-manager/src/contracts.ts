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

function containsNonPortableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    );
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

// v1 journal input is an immutable historical contract. Keep these two schemas
// byte-for-byte compatible with the contract that shipped before Manifest v2.
const publicReferenceV1Schema = nonEmptyTextSchema.refine(
  (value) =>
    !containsUnsafePath(value) &&
    !/(?:^|[\s"'])[A-Za-z]:[\\/]|(?:^|[\s"'])\/(?:Users|home|private|tmp)\//u.test(value) &&
    !/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu.test(value) &&
    !containsCredentialBearingUrl(value),
  "private paths and credential material are not portable Plugin references",
);
const publicUrlV1Schema = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    parsed.protocol === "https:" && parsed.username.length === 0 && parsed.password.length === 0
  );
}, "credential-bearing URLs and non-HTTPS URLs are not portable Plugin references");

const publicReferenceSchema = nonEmptyTextSchema.refine(
  (value) =>
    !containsUnsafePath(value) &&
    !/(?:^|[\s"'])[A-Za-z]:[\\/]|(?:^|[\s"'])\/(?:Users|home|private|tmp)\//u.test(value) &&
    !/(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu.test(value) &&
    !containsNonPortableUrl(value),
  "private paths and credential material are not portable Plugin references",
);
const publicUrlSchema = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    parsed.protocol === "https:" &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
}, "credential-bearing, qualified, and non-HTTPS URLs are not portable Plugin references");
const exactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const resourceNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u, "resource names must be stable path-safe identifiers");

function pluginSourceContract(
  referenceSchema: typeof publicReferenceSchema,
  urlSchema: typeof publicUrlSchema,
) {
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("LOCAL"),
      label: referenceSchema,
      pathFingerprint: fingerprintSchema,
      contentFingerprint: fingerprintSchema,
    }),
    z.strictObject({
      kind: z.literal("NPM"),
      registry: urlSchema,
      packageName: z.string().regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
      version: exactVersionSchema,
      integrity: fingerprintSchema,
    }),
    z.strictObject({
      kind: z.literal("GIT"),
      remote: urlSchema,
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
}

const pluginSourceV1Schema = pluginSourceContract(publicReferenceV1Schema, publicUrlV1Schema);
export const pluginSourceSchema = pluginSourceContract(publicReferenceSchema, publicUrlSchema);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const pluginResourceSchema = z.strictObject({
  name: resourceNameSchema,
  description: nonEmptyTextSchema,
});
export type PluginResource = z.infer<typeof pluginResourceSchema>;

const portablePluginResourceSchema = z.strictObject({
  name: resourceNameSchema,
  description: publicReferenceSchema,
});

export const pluginResourceInventorySchema = z.strictObject({
  tools: z.array(pluginResourceSchema),
  hooks: z.array(pluginResourceSchema),
});
export type PluginResourceInventory = z.infer<typeof pluginResourceInventorySchema>;

const portableRelativeResourcePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      value === "." ||
      (!value.includes("\\") &&
        !value.startsWith("/") &&
        !value.endsWith("/") &&
        value
          .split("/")
          .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")),
    "Pi Package resources require normalized contained relative paths",
  );

export const pluginPiResourceSchema = z.strictObject({
  relativePath: portableRelativeResourcePathSchema,
  contentFingerprint: fingerprintSchema,
  enabled: z.boolean(),
});
export type PluginPiResource = z.infer<typeof pluginPiResourceSchema>;

export const pluginResourceInventoryV2Schema = z.strictObject({
  tools: z.array(portablePluginResourceSchema),
  hooks: z.array(portablePluginResourceSchema),
  extensions: z.array(pluginPiResourceSchema),
  skills: z.array(pluginPiResourceSchema),
  prompts: z.array(pluginPiResourceSchema),
  themes: z.array(pluginPiResourceSchema),
});
export type PluginResourceInventoryV2 = z.infer<typeof pluginResourceInventoryV2Schema>;

const pluginProvenanceV1Schema = z.strictObject({
  upstreamName: publicReferenceV1Schema,
  sourceReference: publicReferenceV1Schema,
  sourceFingerprint: fingerprintSchema,
  licenseReference: publicReferenceV1Schema,
});

export const pluginProvenanceSchema = z.strictObject({
  upstreamName: publicReferenceSchema,
  sourceReference: publicReferenceSchema,
  sourceFingerprint: fingerprintSchema,
  licenseReference: publicReferenceSchema,
});

export const pluginManifestV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-manifest.v1"),
  pluginId: pluginIdSchema,
  version: exactVersionSchema,
  source: pluginSourceV1Schema,
  packageFingerprint: fingerprintSchema,
  license: nonEmptyTextSchema,
  provenance: pluginProvenanceV1Schema,
  resources: pluginResourceInventorySchema,
});
export const pluginManifestV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-manifest.v2"),
  pluginId: pluginIdSchema,
  version: exactVersionSchema,
  source: pluginSourceSchema,
  packageFingerprint: fingerprintSchema,
  license: publicReferenceSchema,
  provenance: pluginProvenanceSchema,
  resources: pluginResourceInventoryV2Schema,
  executableSurface: z.enum(["NONE", "DECLARED_NOT_EXECUTED", "UNKNOWN_NOT_EXECUTED"]),
});
export type PluginManifestV2 = z.infer<typeof pluginManifestV2Schema>;
export const pluginManifestSchema = z.discriminatedUnion("schemaVersion", [
  pluginManifestV1Schema,
  pluginManifestV2Schema,
]);
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

export const pluginRecordV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-record.v1"),
  pluginId: pluginIdSchema,
  manifest: pluginManifestV1Schema,
  state: z.enum(["ENABLED", "DISABLED", "QUARANTINED"]),
  assurance: pluginAssuranceReceiptSchema,
  installedAt: timestampSchema,
  lastOperationId: operationIdSchema,
});
export const pluginRecordV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-record.v2"),
  pluginId: pluginIdSchema,
  manifest: pluginManifestV2Schema,
  state: z.enum(["ENABLED", "DISABLED", "QUARANTINED"]),
  assurance: pluginAssuranceReceiptSchema,
  installedAt: timestampSchema,
  lastOperationId: operationIdSchema,
});
export const pluginRecordSchema = z.discriminatedUnion("schemaVersion", [
  pluginRecordV1Schema,
  pluginRecordV2Schema,
]);
export type PluginRecord = z.infer<typeof pluginRecordSchema>;

const pluginJournalEntryFields = {
  sequence: z.number().int().positive(),
  operationId: operationIdSchema,
  operationFingerprint: fingerprintSchema,
  requestFingerprint: fingerprintSchema,
  action: z.enum(["INSTALL", "IMPORT_FROM_PI", "DISABLE", "REMOVE"]),
  pluginId: pluginIdSchema,
  receipt: pluginOperationReceiptSchema,
  createdAt: timestampSchema,
  previousEntryFingerprint: fingerprintSchema.nullable(),
  entryFingerprint: fingerprintSchema,
};

export const pluginJournalEntryV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-journal.v1"),
  ...pluginJournalEntryFields,
  record: pluginRecordV1Schema.optional(),
});
export const pluginJournalEntryV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-journal.v2"),
  ...pluginJournalEntryFields,
  record: pluginRecordV2Schema.optional(),
});
export const pluginJournalEntrySchema = z.discriminatedUnion("schemaVersion", [
  pluginJournalEntryV1Schema,
  pluginJournalEntryV2Schema,
]);
export type PluginJournalEntry = z.infer<typeof pluginJournalEntrySchema>;

const inventoryResourceSchema = z.strictObject({
  pluginId: pluginIdSchema,
  name: resourceNameSchema,
  description: nonEmptyTextSchema,
});

const inventoryConflictSchema = z.strictObject({
  pluginId: pluginIdSchema,
  resourceKind: z.enum(["TOOL", "HOOK"]),
  resourceName: resourceNameSchema,
  reason: nonEmptyTextSchema,
});

export const pluginInventoryV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-inventory.v1"),
  safeMode: z.boolean(),
  declaredTools: z.array(inventoryResourceSchema),
  declaredHooks: z.array(inventoryResourceSchema),
  effectiveTools: z.array(inventoryResourceSchema),
  effectiveHooks: z.array(inventoryResourceSchema),
  conflicts: z.array(inventoryConflictSchema),
});
const inventoryPiResourceSchema = pluginPiResourceSchema.extend({ pluginId: pluginIdSchema });
export const pluginInventoryV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-plugin-inventory.v2"),
  safeMode: z.boolean(),
  declaredTools: z.array(inventoryResourceSchema),
  declaredHooks: z.array(inventoryResourceSchema),
  effectiveTools: z.array(inventoryResourceSchema),
  effectiveHooks: z.array(inventoryResourceSchema),
  declaredExtensions: z.array(inventoryPiResourceSchema),
  declaredSkills: z.array(inventoryPiResourceSchema),
  declaredPrompts: z.array(inventoryPiResourceSchema),
  declaredThemes: z.array(inventoryPiResourceSchema),
  effectiveExtensions: z.array(inventoryPiResourceSchema),
  effectiveSkills: z.array(inventoryPiResourceSchema),
  effectivePrompts: z.array(inventoryPiResourceSchema),
  effectiveThemes: z.array(inventoryPiResourceSchema),
  conflicts: z.array(inventoryConflictSchema),
});
export const pluginInventorySchema = z.discriminatedUnion("schemaVersion", [
  pluginInventoryV1Schema,
  pluginInventoryV2Schema,
]);
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
