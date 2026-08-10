import { z } from "zod";

import { fingerprintSchema, type Fingerprint } from "@hunter-pi/domain";

import { pilotExecutionPlanSchema, type PilotExecutionPlan } from "./contracts.js";
import { pilotFingerprint } from "./serialization.js";

const pathFreeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }),
    "runtime identity contains a control character",
  );

export const pilotRuntimeBindingSchema = z.strictObject({
  schemaVersion: z.literal("hpi-pilot-runtime-binding.v1"),
  sourceFingerprint: fingerprintSchema,
  artifactFingerprint: fingerprintSchema,
  engineReleaseFingerprint: fingerprintSchema,
  providerEndpointFingerprint: fingerprintSchema,
  providerModelFingerprint: fingerprintSchema,
  credentialScopeFingerprint: fingerprintSchema,
});
export type PilotRuntimeBinding = z.infer<typeof pilotRuntimeBindingSchema>;

export function fingerprintPilotProductSource(input: {
  readonly sourceCommit: string;
}): Fingerprint {
  const sourceCommit = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(input.sourceCommit);
  return pilotFingerprint({
    schemaVersion: "hpi-pilot-product-source.v1",
    sourceCommit,
    sourceState: "CLEAN",
  });
}

export function fingerprintPilotEngineRelease(input: {
  readonly packageName: string;
  readonly version: string;
}): Fingerprint {
  return pilotFingerprint({
    packageName: pathFreeTextSchema.parse(input.packageName),
    version: pathFreeTextSchema.parse(input.version),
  });
}

export function fingerprintPilotProviderEndpoint(input: {
  readonly providerId: string;
  readonly configuredOrigin: string;
  readonly pristineOrigin: string | null;
}): Fingerprint {
  return pilotFingerprint({
    schemaVersion: "hpi-pilot-provider-endpoint.v1",
    providerId: pathFreeTextSchema.parse(input.providerId),
    configuredOrigin: z.url().parse(input.configuredOrigin),
    pristineOrigin: input.pristineOrigin === null ? null : z.url().parse(input.pristineOrigin),
  });
}

export function fingerprintPilotProviderModel(input: {
  readonly providerId: string;
  readonly modelId: string;
}): Fingerprint {
  return pilotFingerprint({
    schemaVersion: "hpi-pilot-provider-model.v1",
    providerId: pathFreeTextSchema.parse(input.providerId),
    modelId: pathFreeTextSchema.parse(input.modelId),
  });
}

export function fingerprintPilotCredentialScope(input: {
  readonly providerId: string;
  readonly source: string;
}): Fingerprint {
  return pilotFingerprint({
    schemaVersion: "hpi-pilot-credential-scope.v1",
    providerId: pathFreeTextSchema.parse(input.providerId),
    source: pathFreeTextSchema.parse(input.source),
    configured: true,
    secretMaterialIncluded: false,
  });
}

export function createPilotRuntimeBinding(input: {
  readonly sourceCommit: string;
  readonly artifactFingerprint: string;
  readonly enginePackageName: string;
  readonly engineVersion: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configuredOrigin: string;
  readonly pristineOrigin: string | null;
  readonly credentialSource: string;
}): PilotRuntimeBinding {
  return pilotRuntimeBindingSchema.parse({
    schemaVersion: "hpi-pilot-runtime-binding.v1",
    sourceFingerprint: fingerprintPilotProductSource({ sourceCommit: input.sourceCommit }),
    artifactFingerprint: input.artifactFingerprint,
    engineReleaseFingerprint: fingerprintPilotEngineRelease({
      packageName: input.enginePackageName,
      version: input.engineVersion,
    }),
    providerEndpointFingerprint: fingerprintPilotProviderEndpoint({
      providerId: input.providerId,
      configuredOrigin: input.configuredOrigin,
      pristineOrigin: input.pristineOrigin,
    }),
    providerModelFingerprint: fingerprintPilotProviderModel({
      providerId: input.providerId,
      modelId: input.modelId,
    }),
    credentialScopeFingerprint: fingerprintPilotCredentialScope({
      providerId: input.providerId,
      source: input.credentialSource,
    }),
  });
}

export function pilotRuntimeBindingMatchesPlan(planInput: unknown, bindingInput: unknown): boolean {
  const plan = pilotExecutionPlanSchema.safeParse(planInput);
  const binding = pilotRuntimeBindingSchema.safeParse(bindingInput);
  if (!plan.success || !binding.success) return false;
  return (
    plan.data.sourceFingerprint === binding.data.sourceFingerprint &&
    plan.data.artifactFingerprint === binding.data.artifactFingerprint &&
    plan.data.engineReleaseFingerprint === binding.data.engineReleaseFingerprint &&
    plan.data.operatorScope.providerRequestPolicy === "EXPLICIT_OPERATOR_AUTHORIZED" &&
    plan.data.operatorScope.providerEndpointFingerprint ===
      binding.data.providerEndpointFingerprint &&
    plan.data.operatorScope.providerModelFingerprint === binding.data.providerModelFingerprint &&
    plan.data.operatorScope.credentialScopeFingerprint === binding.data.credentialScopeFingerprint
  );
}

export function assertPilotRuntimeBinding(
  planInput: PilotExecutionPlan,
  bindingInput: PilotRuntimeBinding,
): void {
  if (!pilotRuntimeBindingMatchesPlan(planInput, bindingInput)) {
    throw new Error(
      "the installed product and Provider runtime do not match the frozen pilot plan",
    );
  }
}
