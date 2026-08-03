import { z } from "zod";

import {
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  schemaVersionSchema,
  timestampSchema,
  type EvidenceEnvelope,
} from "@hunter-pi/domain";
import { assertRunProjectionIntegrity, runProjectionSchema } from "@hunter-pi/workflow-kernel";

import {
  createPortableEvidenceEnvelope,
  type PortableEvidencePolicy,
} from "./portable-evidence.js";

export const runSummaryEvidenceRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  evidenceId: evidenceIdSchema,
  projection: runProjectionSchema,
  evidence: z.array(evidenceEnvelopeSchema),
  createdAt: timestampSchema,
});
export type RunSummaryEvidenceRequest = z.input<typeof runSummaryEvidenceRequestSchema>;

export function createRunSummaryEvidence(
  request: RunSummaryEvidenceRequest,
  policy: PortableEvidencePolicy = {},
): EvidenceEnvelope {
  const parsed = runSummaryEvidenceRequestSchema.parse(request);
  assertRunProjectionIntegrity(parsed.projection);
  const currentAttempt = parsed.projection.attempts.at(-1);
  if (
    parsed.evidence.some(
      (envelope) =>
        envelope.scope.runId !== parsed.projection.run.runId ||
        envelope.sourceFingerprint !== parsed.projection.run.sourceFingerprint,
    )
  ) {
    throw new TypeError("Run summary Evidence must bind the same Run and source projection");
  }
  const providedEvidenceIds = new Set(parsed.evidence.map((envelope) => envelope.evidenceId));
  if (providedEvidenceIds.size !== parsed.evidence.length) {
    throw new TypeError("Run summary Evidence identities must be unique");
  }
  const referencedEvidenceIds = new Set([
    ...parsed.projection.observations.flatMap((observation) => observation.evidenceIds),
    ...parsed.projection.verificationReceipts.flatMap((receipt) => receipt.evidenceIds),
    ...parsed.projection.humanReceipts.flatMap((receipt) => receipt.evidenceIds),
    ...parsed.projection.reviewReceipts.flatMap((receipt) => [
      ...receipt.evidenceIds,
      ...receipt.findings.flatMap((finding) => finding.evidenceIds),
    ]),
  ]);
  if ([...referencedEvidenceIds].some((evidenceId) => !providedEvidenceIds.has(evidenceId))) {
    throw new TypeError("Run summary omitted referenced Evidence");
  }
  const evidenceById = new Map(
    parsed.evidence.map((envelope) => [envelope.evidenceId, envelope] as const),
  );
  for (const observation of parsed.projection.observations) {
    for (const evidenceId of observation.evidenceIds) {
      const envelope = evidenceById.get(evidenceId);
      if (envelope?.kind !== "observation" || envelope.scope.attemptId !== observation.attemptId) {
        throw new TypeError("Observation Evidence does not bind its exact Attempt");
      }
    }
  }
  for (const receipt of parsed.projection.verificationReceipts) {
    for (const evidenceId of receipt.evidenceIds) {
      const envelope = evidenceById.get(evidenceId);
      if (
        envelope?.kind !== "verification" ||
        envelope.scope.attemptId !== receipt.attemptId ||
        envelope.scope.verificationReceiptId !== receipt.verificationReceiptId
      ) {
        throw new TypeError("Verification Evidence does not bind its exact Receipt");
      }
    }
  }
  for (const receipt of parsed.projection.humanReceipts) {
    for (const evidenceId of receipt.evidenceIds) {
      const envelope = evidenceById.get(evidenceId);
      if (envelope?.kind !== "human_receipt" || envelope.scope.attemptId !== receipt.attemptId) {
        throw new TypeError("Human Evidence does not bind its exact Attempt");
      }
    }
  }
  for (const receipt of parsed.projection.reviewReceipts) {
    for (const evidenceId of [
      ...receipt.evidenceIds,
      ...receipt.findings.flatMap((finding) => finding.evidenceIds),
    ]) {
      const envelope = evidenceById.get(evidenceId);
      if (envelope?.kind !== "review" || envelope.scope.attemptId !== receipt.attemptId) {
        throw new TypeError("Review Evidence does not bind its exact Attempt");
      }
    }
  }
  if (parsed.projection.run.lifecycle === "READY" && parsed.evidence.length === 0) {
    throw new TypeError("A READY Run summary requires its referenced Evidence set");
  }

  const attempts = parsed.projection.attempts.map(
    (attempt) =>
      `Attempt ${attempt.attemptId}: execution=${attempt.executionStatus}, verification=${attempt.verificationStatus}`,
  );
  const checks = parsed.projection.checks.map(
    (check) =>
      `Check ${check.checkId}: ${check.status}${check.required ? " (required)" : " (optional)"}`,
  );
  const retentionCounts = new Map<string, number>();
  for (const envelope of parsed.evidence) {
    const status = envelope.capture.retentionStatus;
    retentionCounts.set(status, (retentionCounts.get(status) ?? 0) + 1);
  }
  const retention = [...retentionCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count.toString()}`)
    .join(", ");
  const unresolved = parsed.projection.checks
    .filter((check) => check.required && check.status !== "PASS")
    .map((check) => `${check.checkId}:${check.status}`);
  if (currentAttempt !== undefined) {
    for (const step of parsed.projection.planRevision.steps) {
      if (!step.required || (step.kind !== "human_gate" && step.kind !== "review")) {
        continue;
      }
      if (step.kind === "human_gate") {
        const receipt = parsed.projection.humanReceipts.find(
          (candidate) =>
            candidate.attemptId === currentAttempt.attemptId &&
            candidate.stepId === step.stepId &&
            candidate.contentHash === step.expectedContentHash,
        );
        if (receipt?.decision !== "APPROVED") {
          unresolved.push(
            `${step.stepId}:${receipt === undefined ? "HUMAN_NOT_RUN" : `HUMAN_${receipt.decision}`}`,
          );
        }
        continue;
      }
      const receipt = parsed.projection.reviewReceipts.find(
        (candidate) =>
          candidate.attemptId === currentAttempt.attemptId &&
          candidate.stepId === step.stepId &&
          candidate.inputFingerprint === step.inputFingerprint &&
          candidate.reviewDefinitionFingerprint === step.reviewDefinitionFingerprint &&
          candidate.configurationFingerprint === step.configurationFingerprint &&
          candidate.workspaceFingerprint === parsed.projection.planRevision.workspaceFingerprint &&
          candidate.sourceFingerprint === parsed.projection.planRevision.sourceFingerprint,
      );
      const hasBlockingFinding = receipt?.findings.some(
        (finding) => finding.severity === "P0" || finding.severity === "P1",
      );
      if (receipt?.outcome !== "PASS" || hasBlockingFinding) {
        unresolved.push(
          `${step.stepId}:${
            receipt === undefined
              ? "REVIEW_NOT_RUN"
              : hasBlockingFinding
                ? "REVIEW_BLOCKING_FINDING"
                : `REVIEW_${receipt.outcome}`
          }`,
        );
      }
    }
  }
  if (parsed.projection.run.lifecycle === "READY" && unresolved.length > 0) {
    throw new TypeError("A READY Run summary cannot contain unresolved required work");
  }
  const content = [
    `Run ${parsed.projection.run.runId} — ${parsed.projection.run.lifecycle}`,
    `Goal: ${parsed.projection.planRevision.goal}`,
    ...attempts,
    ...checks,
    `Evidence: ${parsed.evidence.length.toString()} envelope(s)${retention.length > 0 ? ` (${retention})` : ""}`,
    `Unresolved: ${unresolved.length > 0 ? unresolved.join(", ") : "none"}`,
  ].join("\n");
  const latestAttemptId = currentAttempt?.attemptId;

  return createPortableEvidenceEnvelope(
    {
      schemaVersion: "1.0.0",
      evidenceId: parsed.evidenceId,
      kind: "run_summary",
      scope: {
        runId: parsed.projection.run.runId,
        ...(latestAttemptId === undefined ? {} : { attemptId: latestAttemptId }),
      },
      createdAt: parsed.createdAt,
      sourceFingerprint: parsed.projection.run.sourceFingerprint,
      summary: `Run ${parsed.projection.run.runId} summary (${parsed.projection.run.lifecycle}).`,
      contentClass: "SUMMARY",
      content,
    },
    policy,
  );
}
