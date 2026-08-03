import type { ZodType } from "zod";
import { beforeAll, describe, expect, it } from "vitest";

const identityFixtures = {
  attemptIdSchema: "att_alpha-1",
  changeIdSchema: "chg_alpha-1",
  checkIdSchema: "check_alpha-1",
  checkpointIdSchema: "checkpoint_alpha-1",
  compatibilityReceiptIdSchema: "compat_alpha-1",
  distributionReleaseIdSchema: "release_alpha-1",
  engineReleaseIdSchema: "engine-release_alpha-1",
  evidenceIdSchema: "evidence_alpha-1",
  humanReceiptIdSchema: "human_alpha-1",
  observationIdSchema: "obs_alpha-1",
  operationIdSchema: "op_alpha-1",
  operationReceiptIdSchema: "opreceipt_alpha-1",
  planRevisionIdSchema: "plan_alpha-1",
  pluginIdSchema: "plugin_alpha-1",
  pluginAssuranceReceiptIdSchema: "assurance_alpha-1",
  reviewReceiptIdSchema: "review_alpha-1",
  reconciliationReceiptIdSchema: "reconcile_alpha-1",
  runIdSchema: "run_alpha-1",
  stepIdSchema: "step_alpha-1",
  verificationReceiptIdSchema: "verify_alpha-1",
  workspaceIdSchema: "workspace_alpha-1",
  writerLeaseIdSchema: "lease_alpha-1",
} as const;

describe("domain identities", () => {
  let domain: Readonly<Record<string, unknown>>;

  beforeAll(async () => {
    domain = await import("@hunter-pi/domain");
  });

  for (const [schemaName, validIdentity] of Object.entries(identityFixtures)) {
    it(`exports ${schemaName} as a strict branded identity schema`, () => {
      const schema = domain[schemaName];
      expect(schema).toBeDefined();

      const identitySchema = schema as ZodType;
      expect(identitySchema.parse(validIdentity)).toBe(validIdentity);
      expect(identitySchema.safeParse("").success).toBe(false);
      expect(identitySchema.safeParse(`wrong_${validIdentity}`).success).toBe(false);
      expect(identitySchema.safeParse(`${validIdentity} with-space`).success).toBe(false);
    });
  }
});
