import {
  pilotDecisionSchema,
  pilotEvidenceSchema,
  type PilotDecision,
  type PilotEvidence,
  type PilotMetrics,
} from "./contracts.js";
import { pilotFingerprint } from "./serialization.js";

export function nearestRank(samples: readonly number[], rank: number): number {
  if (!Number.isInteger(rank) || rank < 1 || rank > samples.length) {
    throw new Error("nearest-rank percentile requires a rank within the sample set");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error("nearest-rank sample is missing");
  return value;
}

function p95(samples: readonly number[]): number {
  return nearestRank(samples, Math.ceil(samples.length * 0.95));
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error("median sample is missing");
  return value;
}

function metricsFor(evidence: PilotEvidence): PilotMetrics {
  const applicableFacts = evidence.pairedComparators.reduce(
    (total, comparator) => total + comparator.applicableFactCount,
    0,
  );
  const capturedFacts = evidence.pairedComparators.reduce(
    (total, comparator) => total + comparator.hunterCapturedFactCount,
    0,
  );
  const rawPiManualInterventions = evidence.pairedComparators.reduce(
    (total, comparator) => total + comparator.rawPiManualInterventions,
    0,
  );
  const hunterManualInterventions = evidence.pairedComparators.reduce(
    (total, comparator) => total + comparator.hunterManualInterventions,
    0,
  );
  return {
    taskCount: evidence.taskResults.length,
    correctTaskCount: evidence.taskResults.filter(
      (result) => result.terminalOutcome === result.oracleOutcome,
    ).length,
    interruptionCount: evidence.interruptions.length,
    resumedInterruptionCount: evidence.interruptions.filter(
      (interruption) => !["BLOCKED", "NOT_PROVEN"].includes(interruption.resumeOutcome),
    ).length,
    warmStartP95Ms: p95(evidence.warmStartSamplesMs),
    acknowledgementP95Ms: p95(evidence.acknowledgementSamplesMs),
    memoryP95MiB: p95(evidence.memorySamplesMiB),
    comparatorFactScore: applicableFacts === 0 ? 0 : capturedFacts / applicableFacts,
    rawPiManualInterventions,
    hunterManualInterventions,
    manualInterventionReductionRatio:
      rawPiManualInterventions === 0
        ? 0
        : (rawPiManualInterventions - hunterManualInterventions) / rawPiManualInterventions,
    hunterAdditionalOverheadMedianMinutes: median(
      evidence.pairedComparators.map((comparator) => comparator.hunterAdditionalOverheadMinutes),
    ),
  };
}

function identityProblems(evidence: PilotEvidence): string[] {
  const reasons: string[] = [];
  const oracleIds = new Set(evidence.taskOracles.map((oracle) => oracle.taskId));
  const resultIds = new Set(evidence.taskResults.map((result) => result.taskId));
  if (
    oracleIds.size !== evidence.taskOracles.length ||
    resultIds.size !== evidence.taskResults.length
  ) {
    reasons.push("task oracle or result identities are duplicated");
  }
  if (
    evidence.taskOracles.some((oracle) => {
      const result =
        evidence.taskResults.find((candidate) => candidate.taskId === oracle.taskId) ?? null;
      if (result === null) return true;
      return (
        result.repositoryFingerprint !== oracle.repositoryFingerprint ||
        result.sourceFingerprint !== oracle.sourceFingerprint ||
        result.mode !== oracle.mode ||
        result.oracleOutcome !== oracle.expectedOutcome
      );
    })
  ) {
    reasons.push("task results do not bind the frozen oracle identities");
  }
  if (
    evidence.pairedComparators.some(
      (comparator) => comparator.hunterCapturedFactCount < comparator.rawPiCapturedFactCount,
    )
  ) {
    reasons.push("Hunter captured fewer workflow facts than raw Pi in a paired task");
  }
  return reasons;
}

export class PilotEvaluator {
  public evaluate(input: PilotEvidence): PilotDecision {
    const parsed = pilotEvidenceSchema.safeParse(input);
    if (!parsed.success) {
      return pilotDecisionSchema.parse({
        schemaVersion: "hpi-pilot-decision.v2",
        evidenceFingerprint: pilotFingerprint(input),
        outcome: "STOP",
        reasons: ["pilot Evidence failed strict identity and consistency validation"],
        metrics: {
          taskCount: 0,
          correctTaskCount: 0,
          interruptionCount: 0,
          resumedInterruptionCount: 0,
          warmStartP95Ms: 0,
          acknowledgementP95Ms: 0,
          memoryP95MiB: 0,
          comparatorFactScore: 0,
          rawPiManualInterventions: 0,
          hunterManualInterventions: 0,
          manualInterventionReductionRatio: 0,
          hunterAdditionalOverheadMedianMinutes: 0,
        },
        observedAt: new Date().toISOString(),
      });
    }
    const evidence = parsed.data;
    const metrics = metricsFor(evidence);
    const reasons = identityProblems(evidence);
    const missingEvidence: string[] = [];
    if (evidence.ci.windows.status !== "PASS" || evidence.ci.ubuntu.status !== "PASS") {
      missingEvidence.push("exact Windows and Ubuntu CI are not both PASS");
    }
    if (!evidence.providerLatencySeparated) {
      missingEvidence.push("Provider/model latency is not separately observed from Hunter latency");
    }
    const zeroToleranceFailures: string[] = [];
    if (
      evidence.taskResults.some(
        (result) =>
          !result.sourcePreserved || result.rawSecretLeakage || !result.providerSendAcknowledged,
      )
    ) {
      zeroToleranceFailures.push(
        "source loss, raw secret leakage, or unacknowledged Provider send",
      );
    }
    if (
      evidence.interruptions.some(
        (interruption) => !interruption.historyPreserved || !interruption.sourcePreserved,
      )
    ) {
      zeroToleranceFailures.push("forced interruption did not preserve history and source");
    }
    if (
      evidence.updateRollbackCycles.some(
        (cycle) =>
          !cycle.statePreserved ||
          !cycle.usableKnownGood ||
          cycle.applyOutcome !== "APPLIED" ||
          cycle.rollbackOutcome !== "APPLIED",
      )
    ) {
      zeroToleranceFailures.push(
        "an update-and-rollback cycle did not restore a usable known-good release",
      );
    }
    if (evidence.pluginFixtures.some((fixture) => !fixture.safeMode || fixture.userCodeEvaluated)) {
      zeroToleranceFailures.push(
        "a broken or malicious Plugin fixture evaluated user code outside Safe Mode",
      );
    }
    if (!evidence.privacyGate) zeroToleranceFailures.push("privacy/hash gate failed");
    if (!evidence.storageGate)
      zeroToleranceFailures.push("bounded-storage and critical-reserve gate failed");
    if (evidence.reviewP0P1Count > 0)
      zeroToleranceFailures.push("unresolved P0/P1 review finding remains");
    if (metrics.comparatorFactScore < 0.95)
      zeroToleranceFailures.push("paired workflow-fact score is below 95%");
    if (
      metrics.manualInterventionReductionRatio < 0.3 &&
      !evidence.pairedComparators.some((comparator) => comparator.containedFalseCompletion)
    ) {
      zeroToleranceFailures.push(
        "paired comparison did not reduce manual intervention by 30% or contain a false completion",
      );
    }

    const quantitativeMisses: string[] = [];
    if (metrics.correctTaskCount < 9)
      quantitativeMisses.push("fewer than 9 of 10 tasks matched the frozen oracle");
    if (metrics.resumedInterruptionCount < 2)
      quantitativeMisses.push("fewer than two forced interruptions resumed successfully");
    if (evidence.interruptions.some((interruption) => !interruption.actionableWithinFiveMinutes)) {
      quantitativeMisses.push("a forced interruption was not actionable within five minutes");
    }
    if (metrics.warmStartP95Ms > 3_000) quantitativeMisses.push("warm-start p95 exceeds 3 seconds");
    if (metrics.acknowledgementP95Ms > 250)
      quantitativeMisses.push("local acknowledgement p95 exceeds 250 ms");
    if (metrics.memoryP95MiB > 1_536)
      quantitativeMisses.push("Hunter-owned memory p95 exceeds 1.5 GiB");
    if (metrics.hunterAdditionalOverheadMedianMinutes > 10) {
      quantitativeMisses.push("Hunter-only overhead exceeds 10 minutes");
    }

    const allEvidenceAvailable = reasons.length === 0 && missingEvidence.length === 0;
    let outcome: PilotDecision["outcome"];
    if (zeroToleranceFailures.length > 0) {
      outcome = "STOP";
    } else if (!allEvidenceAvailable) {
      outcome = "NOT_PROVEN";
    } else if (quantitativeMisses.length > 0) {
      outcome = "REVISE";
    } else {
      outcome = "GO";
    }
    const decisionReasons = [
      ...zeroToleranceFailures,
      ...reasons,
      ...missingEvidence,
      ...quantitativeMisses,
    ];
    if (decisionReasons.length === 0) decisionReasons.push("all frozen Task 12 gates passed");
    return pilotDecisionSchema.parse({
      schemaVersion: "hpi-pilot-decision.v2",
      evidenceFingerprint: pilotFingerprint(evidence),
      outcome,
      reasons: decisionReasons,
      metrics,
      observedAt: evidence.observedAt,
    });
  }
}
