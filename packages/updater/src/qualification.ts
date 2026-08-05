import { z } from "zod";

import { fingerprintSchema, timestampSchema } from "@hunter-pi/domain";
import { redactPortableText } from "@hunter-pi/evidence";

import {
  qualificationProbeResultSchema,
  aggregateQualificationOutcome,
  releaseCandidateBaseSchema,
  releaseCandidateSchema,
} from "./contracts.js";
import type {
  ReleaseCandidate,
  ReleaseQualificationRunnerInput,
  ReleaseQualificationRunnerOptions,
  releaseQualificationCheckSchema,
} from "./contracts.js";

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "qualification check failed";
  const redaction = redactPortableText(raw);
  const markers = redaction.categories.map((category) => `[REDACTED:${category}]`).join(" ");
  return `qualification check failed${markers === "" ? "" : ` ${markers}`}`;
}

export class ReleaseQualificationRunner {
  readonly #verifierFingerprint: string;
  readonly #now: () => string;

  public constructor(options: ReleaseQualificationRunnerOptions) {
    this.#verifierFingerprint = fingerprintSchema.parse(options.verifierFingerprint);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async qualify(input: ReleaseQualificationRunnerInput): Promise<ReleaseCandidate> {
    const candidate = releaseCandidateBaseSchema.parse(input.candidate);
    if (input.checks.length === 0) {
      throw new Error("release qualification requires at least one declared check");
    }
    const names = new Set<string>();
    const checks: z.infer<typeof releaseQualificationCheckSchema>[] = [];
    for (const probe of input.checks) {
      if (names.has(probe.name)) {
        throw new Error(`release qualification contains duplicate check: ${probe.name}`);
      }
      names.add(probe.name);
      let result: z.infer<typeof qualificationProbeResultSchema>;
      try {
        result = qualificationProbeResultSchema.parse(await probe.run());
      } catch (error) {
        result = {
          outcome: "NOT_PROVEN",
          evidenceIds: [],
          reason: safeReason(error),
        };
      }
      checks.push({ name: z.string().trim().min(1).max(4_096).parse(probe.name), ...result });
    }
    const qualifiedAt = timestampSchema.parse(input.qualifiedAt ?? this.#now());
    return releaseCandidateSchema.parse({
      ...candidate,
      qualification: {
        status: aggregateQualificationOutcome(checks),
        verifierFingerprint: this.#verifierFingerprint,
        checks,
        qualifiedAt,
      },
    });
  }
}
