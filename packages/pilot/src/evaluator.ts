import {
  pilotExecutionPlanSchema,
  pilotDecisionSchema,
  pilotEvidenceSchema,
  type PilotDecision,
  type PilotExecutionPlan,
  type PilotEvidence,
  type PilotMetrics,
} from "./contracts.js";
import { isTrustedPilotArchive, type TrustedPilotArchive } from "./archive.js";
import { canonicalJson, pilotFingerprint } from "./serialization.js";

const invalidEvidenceFingerprint = pilotFingerprint({
  schemaVersion: "hpi-pilot-invalid-evidence.v1",
});

function safePilotFingerprint(input: unknown) {
  try {
    return pilotFingerprint(input);
  } catch {
    return invalidEvidenceFingerprint;
  }
}

function safeParseEvidence(input: unknown) {
  try {
    return pilotEvidenceSchema.safeParse(input);
  } catch {
    return null;
  }
}

function safeParsePlan(input: unknown) {
  try {
    return pilotExecutionPlanSchema.safeParse(input);
  } catch {
    return null;
  }
}

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

function successfullyResumedInterruptionCount(evidence: PilotEvidence): number {
  const runById = new Map(evidence.runArchives.map((run) => [run.runId, run]));
  const countedReplacementRunIds = new Set<string>();
  return evidence.interruptions.filter((interruption) => {
    const interrupted = runById.get(interruption.interruptedRunId);
    const replacement = runById.get(interruption.replacementRunId);
    const resumed =
      interruption.resumeOutcome === "READY" &&
      (interrupted?.terminalOutcome === "INCOMPLETE" ||
        interrupted?.terminalOutcome === "CANCELLED") &&
      replacement?.replacementOfRunId === interruption.interruptedRunId &&
      replacement.archiveFingerprint === interruption.replacementArchiveFingerprint &&
      replacement.terminalOutcome === "READY";
    if (!resumed || countedReplacementRunIds.has(interruption.replacementRunId)) return false;
    countedReplacementRunIds.add(interruption.replacementRunId);
    return true;
  }).length;
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
    resumedInterruptionCount: successfullyResumedInterruptionCount(evidence),
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

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function identityProblems(evidence: PilotEvidence, plan: PilotExecutionPlan | null): string[] {
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
  if (plan !== null) {
    if (evidence.planFingerprint !== plan.planFingerprint) {
      reasons.push("Evidence does not bind the exact frozen pilot plan fingerprint");
    }
    if (!sameCanonicalValue(evidence.operatorScope, plan.operatorScope)) {
      reasons.push("Evidence does not bind the exact frozen Provider authorization scope");
    }
    if (!sameCanonicalValue(evidence.machine, plan.machineProfile)) {
      reasons.push("Evidence does not bind the exact frozen pilot machine profile");
    }
    const targetById = new Map(
      plan.repositoryTargets.map((target) => [target.targetId, target.repositoryFingerprint]),
    );
    const targetReferenceById = new Map(
      plan.repositoryTargets.map((target) => [target.targetId, target.targetReferenceFingerprint]),
    );
    const acceptanceDefinitionById = new Map(
      plan.acceptanceChecks.map((check) => [check.checkId, check.definitionFingerprint]),
    );
    const planTaskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
    const evidenceTaskIds = new Set(evidence.taskOracles.map((oracle) => oracle.taskId));
    if (
      plan.tasks.some((task) => {
        const oracle = evidence.taskOracles.find((candidate) => candidate.taskId === task.taskId);
        const repositoryFingerprint = targetById.get(task.targetId);
        const targetReferenceFingerprint = targetReferenceById.get(task.targetId);
        const acceptanceDefinitionFingerprints = task.acceptanceCheckIds.map((checkId) =>
          acceptanceDefinitionById.get(checkId),
        );
        return (
          oracle === undefined ||
          repositoryFingerprint === undefined ||
          targetReferenceFingerprint === undefined ||
          oracle.repositoryFingerprint !== repositoryFingerprint ||
          oracle.targetReferenceFingerprint !== targetReferenceFingerprint ||
          oracle.sourceFingerprint !== task.sourceFingerprint ||
          oracle.mode !== task.mode ||
          oracle.expectedOutcome !== task.expectedOutcome ||
          JSON.stringify(oracle.acceptanceCheckIds) !== JSON.stringify(task.acceptanceCheckIds) ||
          JSON.stringify(oracle.acceptanceCheckDefinitionFingerprints) !==
            JSON.stringify(acceptanceDefinitionFingerprints)
        );
      }) ||
      evidence.taskOracles.some((oracle) => !planTaskById.has(oracle.taskId)) ||
      evidenceTaskIds.size !== plan.tasks.length
    ) {
      reasons.push("Evidence task oracles do not bind the exact frozen pilot task set");
    }
    const pairedTaskIds = new Set(plan.pairedTaskIds);
    const evidenceComparatorIds = new Set(
      evidence.pairedComparators.map((comparator) => comparator.taskId),
    );
    if (
      evidenceComparatorIds.size !== pairedTaskIds.size ||
      [...pairedTaskIds].some((taskId) => !evidenceComparatorIds.has(taskId))
    ) {
      reasons.push("Evidence paired comparators do not bind the exact frozen paired task set");
    }
    const planPluginFixturesById = new Map(
      plan.pluginFixtures.map((fixture) => [fixture.fixtureId, fixture]),
    );
    const evidencePluginFixtureIds = new Set(
      evidence.pluginFixtures.map((fixture) => fixture.fixtureId),
    );
    if (
      planPluginFixturesById.size !== evidencePluginFixtureIds.size ||
      evidence.pluginFixtures.some(
        (fixture) =>
          planPluginFixturesById.get(fixture.fixtureId)?.definitionFingerprint !==
          fixture.definitionFingerprint,
      )
    ) {
      reasons.push("Evidence Plugin fixtures do not bind the exact frozen fixture set");
    }
    const planUpdateCandidatesById = new Map(
      plan.updateCandidates.map((candidate) => [candidate.candidateId, candidate]),
    );
    const evidenceUpdateCandidateIds = new Set(
      evidence.updateRollbackCycles.map((cycle) => cycle.candidateId),
    );
    if (
      planUpdateCandidatesById.size !== evidenceUpdateCandidateIds.size ||
      evidence.updateRollbackCycles.some((cycle) => {
        const candidate = planUpdateCandidatesById.get(cycle.candidateId);
        return (
          candidate?.artifactFingerprint !== cycle.artifactFingerprint ||
          candidate.qualificationFingerprint !== cycle.qualificationFingerprint
        );
      })
    ) {
      reasons.push("Evidence update cycles do not bind the exact frozen update candidates");
    }
  }
  return reasons;
}

function archiveProblems(
  evidence: PilotEvidence,
  plan: PilotExecutionPlan | null,
  trustedArchive: TrustedPilotArchive | undefined,
): string[] {
  if (trustedArchive === undefined) return [];
  if (!isTrustedPilotArchive(trustedArchive)) {
    return ["trusted pilot Archive handle was not issued by the trusted store"];
  }
  const archive = trustedArchive.archive;
  const reasons: string[] = [];
  if (
    archive.provenance !== "REAL_WINDOWS_PILOT" ||
    archive.fixture ||
    archive.evidenceFingerprint !== safePilotFingerprint(evidence) ||
    !sameCanonicalValue(archive.evidence, evidence)
  ) {
    reasons.push("trusted pilot Archive does not bind the exact immutable Evidence");
  }
  if (plan !== null && archive.planFingerprint !== plan.planFingerprint) {
    reasons.push("trusted pilot Archive does not bind the exact frozen pilot plan");
  }
  return reasons;
}

export class PilotEvaluator {
  public evaluate(
    input: unknown,
    planInput?: unknown,
    trustedArchive?: TrustedPilotArchive,
  ): PilotDecision {
    const parsed = safeParseEvidence(input);
    if (parsed?.success !== true) {
      return pilotDecisionSchema.parse({
        schemaVersion: "hpi-pilot-decision.v2",
        evidenceFingerprint: safePilotFingerprint(input),
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
    const parsedPlan = planInput === undefined ? undefined : safeParsePlan(planInput);
    if (parsedPlan !== undefined && parsedPlan?.success !== true) {
      return pilotDecisionSchema.parse({
        schemaVersion: "hpi-pilot-decision.v2",
        evidenceFingerprint: safePilotFingerprint(input),
        outcome: "STOP",
        reasons: ["pilot execution plan failed strict identity validation"],
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
    const plan = parsedPlan?.data ?? null;
    const metrics = metricsFor(evidence);
    const reasons = [
      ...identityProblems(evidence, plan),
      ...archiveProblems(evidence, plan, trustedArchive),
    ];
    const missingEvidence: string[] = [];
    if (plan === null) {
      missingEvidence.push("the exact frozen pilot execution plan was not supplied");
    }
    if (trustedArchive === undefined) {
      missingEvidence.push("the immutable pilot Archive was not resolved from the trusted store");
    }
    if (evidence.captureProvenance !== "LIVE_WINDOWS_PILOT") {
      missingEvidence.push("Evidence is not marked as a live Windows pilot capture");
    }
    if (evidence.ci.windows.status !== "PASS" || evidence.ci.ubuntu.status !== "PASS") {
      missingEvidence.push("exact Windows and Ubuntu CI are not both PASS");
    }
    if (!evidence.providerLatencySeparated) {
      missingEvidence.push("Provider/model latency is not separately observed from Hunter latency");
    }
    const frozenProviderRequestPolicy =
      plan?.operatorScope.providerRequestPolicy ?? evidence.operatorScope.providerRequestPolicy;
    const providerUsage = evidence.runArchives.reduce(
      (usage, run) => ({
        requests: usage.requests + run.providerRequestCount,
        tokens: usage.tokens + run.providerTokenCount,
        costMinor: usage.costMinor + run.providerCostMinor,
      }),
      { requests: 0, tokens: 0, costMinor: 0 },
    );
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
      frozenProviderRequestPolicy === "NO_PROVIDER_REQUESTS" &&
      (evidence.taskResults.some((result) => result.providerSendAcknowledged) ||
        providerUsage.requests > 0)
    ) {
      zeroToleranceFailures.push(
        "Provider request was acknowledged under a no-request pilot scope",
      );
    }
    const providerScope = plan?.operatorScope ?? evidence.operatorScope;
    if (
      providerScope.providerRequestPolicy === "EXPLICIT_OPERATOR_AUTHORIZED" &&
      (providerScope.maxProviderRequests === null ||
        providerScope.maxProviderTokens === null ||
        providerScope.maxProviderCostMinor === null ||
        providerUsage.requests > providerScope.maxProviderRequests ||
        providerUsage.tokens > providerScope.maxProviderTokens ||
        providerUsage.costMinor > providerScope.maxProviderCostMinor)
    ) {
      zeroToleranceFailures.push(
        "Provider usage exceeds the frozen maximum request, token, or cost authorization",
      );
    }
    if (
      evidence.taskResults.some(
        (result) => result.terminalOutcome === "READY" && result.oracleOutcome !== "READY",
      )
    ) {
      zeroToleranceFailures.push("false READY outcome observed");
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
    if (evidence.manualStateEditingRequired)
      zeroToleranceFailures.push("manual Hunter state editing was required");
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
      evidenceFingerprint: safePilotFingerprint(evidence),
      outcome,
      reasons: decisionReasons,
      metrics,
      observedAt: evidence.observedAt,
    });
  }
}
