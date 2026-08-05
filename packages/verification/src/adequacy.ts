import { createHash } from "node:crypto";

import { z } from "zod";

import {
  attemptIdSchema,
  checkIdSchema,
  evidenceIdSchema,
  fingerprintSchema,
  humanReceiptSchema,
  planRevisionIdSchema,
  planRevisionSchema,
  reviewReceiptSchema,
  runIdSchema,
  schemaVersion,
  schemaVersionSchema,
  stepIdSchema,
  timestampSchema,
  verificationReceiptSchema,
  type CheckId,
  type EvidenceId,
  type HumanReceipt,
  type PlanRevision,
  type ReviewReceipt,
  type VerificationReceipt,
} from "@hunter-pi/domain";

const boundedTextSchema = z.string().trim().min(1).max(256);
const nodeIdSchema = boundedTextSchema.regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  "verification node identity contains unsupported characters",
);
const lockNameSchema = boundedTextSchema.regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
  "resource lock name contains unsupported characters",
);

export const verificationNodeKindSchema = z.enum(["CHECK", "HUMAN_GATE", "REVIEW"]);
export type VerificationNodeKind = z.infer<typeof verificationNodeKindSchema>;

export const verificationNodeSchema = z.strictObject({
  nodeId: nodeIdSchema,
  kind: verificationNodeKindSchema,
  required: z.boolean(),
  dependsOn: z.array(nodeIdSchema),
});
export type VerificationNode = z.infer<typeof verificationNodeSchema>;

export const resourceLockAssignmentSchema = z.strictObject({
  nodeId: nodeIdSchema,
  lockNames: z.array(lockNameSchema),
});
export type ResourceLockAssignment = z.infer<typeof resourceLockAssignmentSchema>;

export const humanGateExpectationSchema = z.strictObject({
  stepId: stepIdSchema,
  contentHash: fingerprintSchema,
  resultFingerprint: fingerprintSchema,
});
export type HumanGateExpectation = z.infer<typeof humanGateExpectationSchema>;

export const fixbackBatchSchema = z.strictObject({
  previousAttemptId: attemptIdSchema,
  newAttemptId: attemptIdSchema,
  failureEvidenceIds: z.array(evidenceIdSchema).min(1),
  precedingFailureFingerprint: fingerprintSchema,
  focusedCheckIds: z.array(checkIdSchema).min(1),
  invalidatedCheckIds: z.array(checkIdSchema).min(1),
});
export type FixbackBatch = z.infer<typeof fixbackBatchSchema>;

export const verificationAdequacyRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  planRevision: planRevisionSchema,
  runId: runIdSchema,
  attemptId: attemptIdSchema,
  environmentFingerprint: fingerprintSchema,
  selectedCheckIds: z.array(checkIdSchema),
  nodes: z.array(verificationNodeSchema).min(1),
  resourceLocks: z.array(resourceLockAssignmentSchema),
  verificationReceipts: z.array(verificationReceiptSchema),
  humanGateExpectations: z.array(humanGateExpectationSchema),
  humanReceipts: z.array(humanReceiptSchema),
  reviewReceipts: z.array(reviewReceiptSchema),
  skippedCheckIds: z.array(checkIdSchema),
  fixbackBatch: fixbackBatchSchema.optional(),
});
/** Input-facing request type intentionally accepts plain strings; the strict schema brands them on parse. */
export type VerificationAdequacyRequest = z.input<typeof verificationAdequacyRequestSchema>;
type ParsedVerificationAdequacyRequest = z.output<typeof verificationAdequacyRequestSchema>;

export const adequacyFindingSeveritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type AdequacyFindingSeverity = z.infer<typeof adequacyFindingSeveritySchema>;

export const adequacyFindingCodeSchema = z.enum([
  "DAG_NODE_UNKNOWN",
  "DAG_DUPLICATE_NODE",
  "DAG_DEPENDENCY_UNKNOWN",
  "DAG_CYCLE",
  "DAG_KIND_MISMATCH",
  "DAG_REQUIRED_MISMATCH",
  "RESOURCE_LOCK_DUPLICATE",
  "RESOURCE_LOCK_CONFLICT",
  "CHECK_UNKNOWN",
  "CHECK_FILTERED",
  "CHECK_SKIPPED",
  "CHECK_NOT_RUN",
  "CHECK_DUPLICATE",
  "CHECK_UNDECLARED_RECEIPT",
  "CHECK_STALE_REUSE",
  "CHECK_OUTCOME_NOT_PASS",
  "CHECK_TIMEOUT",
  "CHECK_TRUNCATED",
  "OUTPUT_NOT_REDACTED",
  "HUMAN_EXPECTATION_MISSING",
  "HUMAN_EXPECTATION_DUPLICATE",
  "HUMAN_RECEIPT_MISSING",
  "HUMAN_RECEIPT_DUPLICATE",
  "HUMAN_RECEIPT_MISMATCH",
  "HUMAN_RECEIPT_NOT_APPROVED",
  "HUMAN_RECEIPT_UNBOUND",
  "REVIEW_RECEIPT_MISSING",
  "REVIEW_RECEIPT_DUPLICATE",
  "REVIEW_RECEIPT_STALE",
  "REVIEW_NOT_PASS",
  "REVIEW_BLOCKING_FINDING",
  "REVIEW_FINDING",
  "REVIEW_UNBOUND",
  "FIXBACK_INVALID",
  "ACCOUNTING_MISMATCH",
]);
export type AdequacyFindingCode = z.infer<typeof adequacyFindingCodeSchema>;

export const adequacyFindingSchema = z.strictObject({
  severity: adequacyFindingSeveritySchema,
  code: adequacyFindingCodeSchema,
  scope: boundedTextSchema,
  rationale: boundedTextSchema,
  evidenceIds: z.array(evidenceIdSchema),
  confidence: z.number().min(0).max(1),
});
export type AdequacyFinding = z.infer<typeof adequacyFindingSchema>;

export const adequacyAccountingSchema = z.strictObject({
  selected: z.number().int().nonnegative(),
  collected: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  notRun: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
  staleReuse: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  truncated: z.number().int().nonnegative(),
});
export type AdequacyAccounting = z.infer<typeof adequacyAccountingSchema>;

export const adequacyStatusSchema = z.enum(["READY", "BLOCKED", "NOT_PROVEN"]);
export type AdequacyStatus = z.infer<typeof adequacyStatusSchema>;

export const adequacyReceiptIdSchema = z.string().regex(/^adequacy_[a-f0-9]{64}$/u);

export const verificationAdequacyReceiptSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  adequacyReceiptId: adequacyReceiptIdSchema,
  planRevisionId: planRevisionIdSchema,
  runId: runIdSchema,
  attemptId: attemptIdSchema,
  workspaceFingerprint: fingerprintSchema,
  sourceFingerprint: fingerprintSchema,
  environmentFingerprint: fingerprintSchema,
  status: adequacyStatusSchema,
  decision: adequacyStatusSchema,
  accounting: adequacyAccountingSchema,
  findings: z.array(adequacyFindingSchema),
  observedAt: timestampSchema,
});
export type VerificationAdequacyReceipt = z.infer<typeof verificationAdequacyReceiptSchema>;

interface FindingInput {
  readonly severity: AdequacyFindingSeverity;
  readonly code: AdequacyFindingCode;
  readonly scope: string;
  readonly rationale: string;
  readonly evidenceIds?: readonly EvidenceId[];
}

const severityRank: Record<AdequacyFindingSeverity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function addFinding(findings: AdequacyFinding[], input: FindingInput): void {
  findings.push({
    severity: input.severity,
    code: input.code,
    scope: input.scope,
    rationale: input.rationale,
    evidenceIds: [...(input.evidenceIds ?? [])],
    confidence: 1,
  });
}

function countDuplicates(values: readonly string[]): number {
  return values.length - new Set(values).size;
}

function hasPath(
  nodesById: ReadonlyMap<string, VerificationNode>,
  start: string,
  target: string,
  visiting = new Set<string>(),
): boolean {
  if (start === target) return true;
  if (visiting.has(start)) return false;
  visiting.add(start);
  const node = nodesById.get(start);
  if (node === undefined) return false;
  return node.dependsOn.some((dependency) => hasPath(nodesById, dependency, target, visiting));
}

function hasCycle(nodes: readonly VerificationNode[]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.nodeId, node.dependsOn] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return nodes.some((node) => visit(node.nodeId));
}

function latestObservedAt(request: ParsedVerificationAdequacyRequest, plan: PlanRevision): string {
  const timestamps = [
    plan.createdAt,
    ...request.verificationReceipts.map((receipt) => receipt.observedAt),
    ...request.humanReceipts.map((receipt) => receipt.recordedAt),
    ...request.reviewReceipts.map((receipt) => receipt.observedAt),
  ];
  return timestamps.sort((left, right) => left.localeCompare(right)).at(-1) ?? plan.createdAt;
}

function createReceiptId(payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `adequacy_${digest}`;
}

function validateDAGAndLocks(
  request: ParsedVerificationAdequacyRequest,
  findings: AdequacyFinding[],
): void {
  const plan = request.planRevision;
  const checkIds = new Set<string>(plan.checks.map((check) => check.checkId));
  const stepsById = new Map<string, PlanRevision["steps"][number]>(
    plan.steps.map((step) => [step.stepId, step]),
  );
  const nodesById = new Map<string, VerificationNode>();

  for (const node of request.nodes) {
    if (nodesById.has(node.nodeId)) {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_DUPLICATE_NODE",
        scope: node.nodeId,
        rationale: "A verification DAG node identity appears more than once.",
      });
      continue;
    }
    nodesById.set(node.nodeId, node);
    const declaredCheck = checkIds.has(node.nodeId);
    const declaredStep = stepsById.get(node.nodeId);
    if (node.kind === "CHECK" && !declaredCheck) {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_NODE_UNKNOWN",
        scope: node.nodeId,
        rationale: "The DAG references a check that is not declared by the Plan Revision.",
      });
    }
    if (node.kind !== "CHECK" && declaredStep === undefined) {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_NODE_UNKNOWN",
        scope: node.nodeId,
        rationale:
          "The DAG references a gate or review Step that is not declared by the Plan Revision.",
      });
    }
    if (node.kind === "HUMAN_GATE" && declaredStep?.kind !== "human_gate") {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_KIND_MISMATCH",
        scope: node.nodeId,
        rationale: "A HUMAN_GATE node must bind a declared human_gate Step.",
      });
    }
    if (node.kind === "REVIEW" && declaredStep?.kind !== "review") {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_KIND_MISMATCH",
        scope: node.nodeId,
        rationale: "A REVIEW node must bind a declared review Step.",
      });
    }
    if (
      ((node.kind === "HUMAN_GATE" && declaredStep?.kind === "human_gate") ||
        (node.kind === "REVIEW" && declaredStep?.kind === "review")) &&
      declaredStep.required !== node.required
    ) {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_REQUIRED_MISMATCH",
        scope: node.nodeId,
        rationale: "The DAG required flag must match the predeclared Step.",
      });
    }
    if (node.kind === "CHECK") {
      const declaredCheckValue = plan.checks.find((check) => check.checkId === node.nodeId);
      if (declaredCheckValue !== undefined && declaredCheckValue.required !== node.required) {
        addFinding(findings, {
          severity: "P0",
          code: "DAG_REQUIRED_MISMATCH",
          scope: node.nodeId,
          rationale: "The DAG required flag must match the predeclared check.",
        });
      }
    }
  }

  for (const node of request.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodesById.has(dependency)) {
        addFinding(findings, {
          severity: "P0",
          code: "DAG_DEPENDENCY_UNKNOWN",
          scope: `${node.nodeId}->${dependency}`,
          rationale: "A verification DAG dependency is not declared as a node.",
        });
      }
    }
  }
  if (hasCycle(request.nodes)) {
    addFinding(findings, {
      severity: "P0",
      code: "DAG_CYCLE",
      scope: "verification-dag",
      rationale: "Verification nodes must form an acyclic dependency graph.",
    });
  }

  const requiredChecks = plan.checks
    .filter((check) => check.required)
    .map((check) => check.checkId);
  for (const checkId of requiredChecks) {
    const node = nodesById.get(checkId);
    if (node?.kind !== "CHECK") {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_NODE_UNKNOWN",
        scope: checkId,
        rationale: "Every required automated check must be represented by a CHECK node.",
      });
    }
  }
  for (const step of plan.steps.filter(
    (candidate) => candidate.required && candidate.kind !== "agent",
  )) {
    const expectedKind =
      step.kind === "human_gate" ? "HUMAN_GATE" : step.kind === "review" ? "REVIEW" : undefined;
    if (expectedKind !== undefined) {
      const node = nodesById.get(step.stepId);
      if (node?.kind !== expectedKind) {
        addFinding(findings, {
          severity: "P0",
          code: "DAG_NODE_UNKNOWN",
          scope: step.stepId,
          rationale:
            "Every required human gate or review must be represented in the verification DAG.",
        });
      }
    }
  }

  const assignmentsByLock = new Map<string, string[]>();
  for (const assignment of request.resourceLocks) {
    const node = nodesById.get(assignment.nodeId);
    if (node === undefined) {
      addFinding(findings, {
        severity: "P0",
        code: "DAG_NODE_UNKNOWN",
        scope: assignment.nodeId,
        rationale: "A resource lock assignment must bind a declared verification node.",
      });
    }
    if (countDuplicates(assignment.lockNames) > 0) {
      addFinding(findings, {
        severity: "P0",
        code: "RESOURCE_LOCK_DUPLICATE",
        scope: assignment.nodeId,
        rationale: "A node cannot acquire the same resource lock more than once.",
      });
    }
    for (const lockName of new Set(assignment.lockNames)) {
      const holders = assignmentsByLock.get(lockName) ?? [];
      holders.push(assignment.nodeId);
      assignmentsByLock.set(lockName, holders);
    }
  }
  for (const [lockName, holders] of assignmentsByLock) {
    for (let index = 0; index < holders.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < holders.length; otherIndex += 1) {
        const left = holders[index];
        const right = holders[otherIndex];
        if (left === undefined || right === undefined) continue;
        const leftDependsOnRight = hasPath(nodesById, left, right);
        const rightDependsOnLeft = hasPath(nodesById, right, left);
        if (leftDependsOnRight === rightDependsOnLeft) {
          addFinding(findings, {
            severity: "P1",
            code: "RESOURCE_LOCK_CONFLICT",
            scope: `${lockName}:${left},${right}`,
            rationale:
              "Concurrent verification nodes share a resource lock without a deterministic order.",
          });
        }
      }
    }
  }
}

function validateChecks(
  request: ParsedVerificationAdequacyRequest,
  findings: AdequacyFinding[],
): AdequacyAccounting {
  const plan = request.planRevision;
  const checksById = new Map(plan.checks.map((check) => [check.checkId, check] as const));
  const selectedSet = new Set(request.selectedCheckIds);
  const skippedSet = new Set(request.skippedCheckIds);
  const duplicateSelectionCount = countDuplicates(request.selectedCheckIds);
  const requiredChecks = plan.checks.filter((check) => check.required);
  const filteredCount = requiredChecks.filter((check) => !selectedSet.has(check.checkId)).length;
  const skippedCount = skippedSet.size;

  if (duplicateSelectionCount > 0) {
    addFinding(findings, {
      severity: "P0",
      code: "CHECK_DUPLICATE",
      scope: "selected-checks",
      rationale: "A selected automated check appears more than once.",
    });
  }
  for (const checkId of request.selectedCheckIds) {
    if (!checksById.has(checkId)) {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_UNKNOWN",
        scope: checkId,
        rationale: "The selected check is not declared by the Plan Revision.",
      });
    }
  }
  for (const check of requiredChecks) {
    if (!selectedSet.has(check.checkId)) {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_FILTERED",
        scope: check.checkId,
        rationale: "A required check was filtered out of the selected verification set.",
      });
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_NOT_RUN",
        scope: check.checkId,
        rationale: "A required check that was filtered has no execution receipt for this Attempt.",
      });
    }
  }
  for (const checkId of request.skippedCheckIds) {
    if (!checksById.has(checkId)) {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_UNKNOWN",
        scope: checkId,
        rationale: "A skipped check is not declared by the Plan Revision.",
      });
    } else {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_SKIPPED",
        scope: checkId,
        rationale: "A selected check was explicitly skipped and cannot prove readiness.",
      });
      if (!selectedSet.has(checkId)) {
        addFinding(findings, {
          severity: "P1",
          code: "CHECK_FILTERED",
          scope: checkId,
          rationale: "A skipped check must also be part of the selected verification set.",
        });
      }
    }
  }

  const receiptsByCheck = new Map<CheckId, VerificationReceipt[]>();
  let staleReuse = 0;
  let timedOut = 0;
  let truncated = 0;
  for (const receipt of request.verificationReceipts) {
    const check = checksById.get(receipt.checkId);
    if (check === undefined) {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_UNDECLARED_RECEIPT",
        scope: receipt.checkId,
        rationale: "A verification receipt is not bound to a declared Plan Revision check.",
        evidenceIds: receipt.evidenceIds,
      });
      continue;
    }
    const receipts = receiptsByCheck.get(receipt.checkId) ?? [];
    receipts.push(receipt);
    receiptsByCheck.set(receipt.checkId, receipts);
    if (!selectedSet.has(receipt.checkId)) {
      addFinding(findings, {
        severity: "P1",
        code: "CHECK_FILTERED",
        scope: receipt.checkId,
        rationale: "A receipt exists for a check that was not selected for this adequacy decision.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    const stale =
      receipt.runId !== request.runId ||
      receipt.attemptId !== request.attemptId ||
      receipt.checkVersion !== check.version ||
      receipt.checkDefinitionFingerprint !== check.definitionFingerprint ||
      receipt.configFingerprint !== check.configurationFingerprint ||
      receipt.workspaceFingerprint !== plan.workspaceFingerprint ||
      receipt.sourceFingerprint !== plan.sourceFingerprint ||
      receipt.environmentFingerprint !== request.environmentFingerprint;
    if (stale) {
      staleReuse += 1;
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_STALE_REUSE",
        scope: receipt.checkId,
        rationale:
          "A verification receipt does not match the active Run, Attempt, source, configuration, workspace, or environment identity.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (receipt.resultStatus.timedOut) {
      timedOut += 1;
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_TIMEOUT",
        scope: receipt.checkId,
        rationale: "A timed-out verification cannot prove readiness.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (receipt.output.stdoutTruncated || receipt.output.stderrTruncated) {
      truncated += 1;
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_TRUNCATED",
        scope: receipt.checkId,
        rationale: "A truncated verification result is not complete evidence.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (!receipt.output.redaction.applied) {
      addFinding(findings, {
        severity: "P0",
        code: "OUTPUT_NOT_REDACTED",
        scope: receipt.checkId,
        rationale:
          "Verification output must carry an explicit redaction result before it can become Evidence.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (receipt.outcome !== "PASS") {
      addFinding(findings, {
        severity: "P1",
        code: "CHECK_OUTCOME_NOT_PASS",
        scope: receipt.checkId,
        rationale: "Only a current PASS verification can contribute to readiness.",
        evidenceIds: receipt.evidenceIds,
      });
    }
  }

  let executed = 0;
  let passed = 0;
  let notRun = 0;
  for (const checkId of selectedSet) {
    const receipts = receiptsByCheck.get(checkId) ?? [];
    if (receipts.length > 1) {
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_DUPLICATE",
        scope: checkId,
        rationale: "A selected check has more than one receipt in the same Attempt.",
        evidenceIds: receipts.flatMap((receipt) => receipt.evidenceIds),
      });
    }
    const check = checksById.get(checkId);
    const currentReceipt =
      check === undefined
        ? undefined
        : receipts.find(
            (receipt) =>
              receipt.runId === request.runId &&
              receipt.attemptId === request.attemptId &&
              receipt.checkVersion === check.version &&
              receipt.checkDefinitionFingerprint === check.definitionFingerprint &&
              receipt.configFingerprint === check.configurationFingerprint &&
              receipt.workspaceFingerprint === plan.workspaceFingerprint &&
              receipt.sourceFingerprint === plan.sourceFingerprint &&
              receipt.environmentFingerprint === request.environmentFingerprint,
          );
    if (currentReceipt === undefined) {
      notRun += 1;
      addFinding(findings, {
        severity: "P0",
        code: "CHECK_NOT_RUN",
        scope: checkId,
        rationale: "The selected check has no current, identity-matching receipt.",
      });
    } else {
      executed += 1;
      if (currentReceipt.outcome === "PASS") passed += 1;
    }
  }

  return {
    selected: request.selectedCheckIds.length,
    collected: request.verificationReceipts.length,
    executed,
    passed,
    skipped: skippedCount,
    notRun,
    duplicates:
      duplicateSelectionCount +
      [...receiptsByCheck.values()].reduce(
        (total, receipts) => total + Math.max(0, receipts.length - 1),
        0,
      ),
    filtered: filteredCount,
    staleReuse,
    timedOut,
    truncated,
  };
}

function validateHumanGates(
  request: ParsedVerificationAdequacyRequest,
  findings: AdequacyFinding[],
): void {
  const requiredGates = request.planRevision.steps.filter(
    (step): step is Extract<PlanRevision["steps"][number], { kind: "human_gate" }> =>
      step.kind === "human_gate" && step.required,
  );
  const expectationsByStep = new Map<string, HumanGateExpectation[]>();
  for (const expectation of request.humanGateExpectations) {
    const values = expectationsByStep.get(expectation.stepId) ?? [];
    values.push(expectation);
    expectationsByStep.set(expectation.stepId, values);
  }
  const receiptsByStep = new Map<string, HumanReceipt[]>();
  for (const receipt of request.humanReceipts) {
    const values = receiptsByStep.get(receipt.stepId) ?? [];
    values.push(receipt);
    receiptsByStep.set(receipt.stepId, values);
  }

  for (const gate of requiredGates) {
    const expectations = expectationsByStep.get(gate.stepId) ?? [];
    if (expectations.length === 0) {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_EXPECTATION_MISSING",
        scope: gate.stepId,
        rationale:
          "A required human gate must declare the exact content and result fingerprints it accepts.",
      });
      continue;
    }
    if (expectations.length > 1) {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_EXPECTATION_DUPLICATE",
        scope: gate.stepId,
        rationale: "A required human gate has more than one exact expectation.",
      });
    }
    const expectation = expectations[0];
    const receipts = receiptsByStep.get(gate.stepId) ?? [];
    if (receipts.length === 0) {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_RECEIPT_MISSING",
        scope: gate.stepId,
        rationale: "A required human gate has no Human Receipt.",
      });
      continue;
    }
    if (receipts.length > 1) {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_RECEIPT_DUPLICATE",
        scope: gate.stepId,
        rationale: "A required human gate has multiple Human Receipts for one Attempt.",
        evidenceIds: receipts.flatMap((receipt) => receipt.evidenceIds),
      });
    }
    const receipt = receipts[0];
    if (receipt === undefined) continue;
    if (
      expectation === undefined ||
      receipt.runId !== request.runId ||
      receipt.attemptId !== request.attemptId ||
      receipt.contentHash !== expectation.contentHash ||
      receipt.contentHash !== gate.expectedContentHash ||
      receipt.resultFingerprint !== expectation.resultFingerprint
    ) {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_RECEIPT_MISMATCH",
        scope: gate.stepId,
        rationale:
          "The Human Receipt is not bound to the active Run, Attempt, frozen content, and expected result.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (receipt.decision !== "APPROVED") {
      addFinding(findings, {
        severity: "P0",
        code: "HUMAN_RECEIPT_NOT_APPROVED",
        scope: gate.stepId,
        rationale: "A required human gate must have an APPROVED Human Receipt.",
        evidenceIds: receipt.evidenceIds,
      });
    }
  }
  for (const receipt of request.humanReceipts) {
    if (!requiredGates.some((gate) => gate.stepId === receipt.stepId)) {
      addFinding(findings, {
        severity: "P1",
        code: "HUMAN_RECEIPT_UNBOUND",
        scope: receipt.stepId,
        rationale:
          "A Human Receipt must bind a predeclared required human gate in this Plan Revision.",
        evidenceIds: receipt.evidenceIds,
      });
    }
  }
}

function validateReviews(
  request: ParsedVerificationAdequacyRequest,
  findings: AdequacyFinding[],
): void {
  const requiredReviews = request.planRevision.steps.filter(
    (step): step is Extract<PlanRevision["steps"][number], { kind: "review" }> =>
      step.kind === "review" && step.required,
  );
  const receiptsByStep = new Map<string, ReviewReceipt[]>();
  for (const receipt of request.reviewReceipts) {
    const values = receiptsByStep.get(receipt.stepId) ?? [];
    values.push(receipt);
    receiptsByStep.set(receipt.stepId, values);
  }
  for (const review of requiredReviews) {
    const receipts = receiptsByStep.get(review.stepId) ?? [];
    if (receipts.length === 0) {
      addFinding(findings, {
        severity: "P0",
        code: "REVIEW_RECEIPT_MISSING",
        scope: review.stepId,
        rationale: "A required review has no Review Receipt.",
      });
      continue;
    }
    if (receipts.length > 1) {
      addFinding(findings, {
        severity: "P0",
        code: "REVIEW_RECEIPT_DUPLICATE",
        scope: review.stepId,
        rationale: "A required review has multiple Review Receipts for one Attempt.",
        evidenceIds: receipts.flatMap((receipt) => receipt.evidenceIds),
      });
    }
    const receipt = receipts[0];
    if (receipt === undefined) continue;
    const stale =
      receipt.runId !== request.runId ||
      receipt.attemptId !== request.attemptId ||
      receipt.inputFingerprint !== review.inputFingerprint ||
      receipt.reviewDefinitionFingerprint !== review.reviewDefinitionFingerprint ||
      receipt.configurationFingerprint !== review.configurationFingerprint ||
      receipt.workspaceFingerprint !== request.planRevision.workspaceFingerprint ||
      receipt.sourceFingerprint !== request.planRevision.sourceFingerprint;
    if (stale) {
      addFinding(findings, {
        severity: "P0",
        code: "REVIEW_RECEIPT_STALE",
        scope: review.stepId,
        rationale:
          "The Review Receipt does not bind the active Run, Attempt, review definition, source, or workspace.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    if (receipt.outcome !== "PASS") {
      addFinding(findings, {
        severity: "P1",
        code: "REVIEW_NOT_PASS",
        scope: review.stepId,
        rationale: "A required review must produce a PASS outcome before readiness.",
        evidenceIds: receipt.evidenceIds,
      });
    }
    for (const finding of receipt.findings) {
      if (finding.severity === "P0" || finding.severity === "P1") {
        addFinding(findings, {
          severity: "P1",
          code: "REVIEW_BLOCKING_FINDING",
          scope: `${review.stepId}:${finding.scope}`,
          rationale: "A required review contains an unresolved P0 or P1 finding.",
          evidenceIds: finding.evidenceIds,
        });
      } else {
        addFinding(findings, {
          severity: finding.severity,
          code: "REVIEW_FINDING",
          scope: `${review.stepId}:${finding.scope}`,
          rationale: finding.rationale,
          evidenceIds: finding.evidenceIds,
        });
      }
    }
  }
  for (const receipt of request.reviewReceipts) {
    if (!requiredReviews.some((review) => review.stepId === receipt.stepId)) {
      addFinding(findings, {
        severity: "P1",
        code: "REVIEW_UNBOUND",
        scope: receipt.stepId,
        rationale: "A Review Receipt must bind a predeclared required review Step.",
        evidenceIds: receipt.evidenceIds,
      });
    }
  }
}

function validateFixback(
  request: ParsedVerificationAdequacyRequest,
  findings: AdequacyFinding[],
): void {
  const batch = request.fixbackBatch;
  if (batch === undefined) return;
  const declaredChecks = new Set(request.planRevision.checks.map((check) => check.checkId));
  const selectedChecks = new Set(request.selectedCheckIds);
  const invalid =
    batch.previousAttemptId === batch.newAttemptId ||
    batch.newAttemptId !== request.attemptId ||
    batch.focusedCheckIds.some((checkId) => !declaredChecks.has(checkId)) ||
    batch.invalidatedCheckIds.some((checkId) => !declaredChecks.has(checkId)) ||
    batch.invalidatedCheckIds.some((checkId) => !selectedChecks.has(checkId)) ||
    batch.invalidatedCheckIds.some((checkId) => !batch.focusedCheckIds.includes(checkId));
  if (invalid) {
    addFinding(findings, {
      severity: "P0",
      code: "FIXBACK_INVALID",
      scope: `${batch.previousAttemptId}->${batch.newAttemptId}`,
      rationale:
        "A fixback batch must link a distinct prior Attempt to the active Attempt and focus on selected invalidated checks.",
      evidenceIds: batch.failureEvidenceIds,
    });
  }
}

export function validateVerificationAdequacy(
  input: VerificationAdequacyRequest,
): VerificationAdequacyReceipt {
  const request = verificationAdequacyRequestSchema.parse(input);
  const findings: AdequacyFinding[] = [];
  validateDAGAndLocks(request, findings);
  const accounting = validateChecks(request, findings);
  validateHumanGates(request, findings);
  validateReviews(request, findings);
  validateFixback(request, findings);

  const selectedChecks = new Set(request.selectedCheckIds);
  if (
    accounting.executed !== selectedChecks.size ||
    accounting.passed !== selectedChecks.size ||
    accounting.notRun !== 0 ||
    accounting.skipped !== 0 ||
    accounting.duplicates !== 0 ||
    accounting.staleReuse !== 0 ||
    accounting.timedOut !== 0 ||
    accounting.truncated !== 0
  ) {
    if (
      !findings.some((finding) => finding.code === "ACCOUNTING_MISMATCH") &&
      (accounting.executed !== selectedChecks.size ||
        accounting.passed !== selectedChecks.size ||
        accounting.notRun !== 0)
    ) {
      addFinding(findings, {
        severity: "P0",
        code: "ACCOUNTING_MISMATCH",
        scope: "verification-accounting",
        rationale: "Selected, executed, and passed counts must reconcile exactly before READY.",
      });
    }
  }

  findings.sort((left, right) => {
    const severity = severityRank[left.severity] - severityRank[right.severity];
    if (severity !== 0) return severity;
    const code = left.code.localeCompare(right.code);
    if (code !== 0) return code;
    return left.scope.localeCompare(right.scope);
  });
  const status: AdequacyStatus =
    findings.length === 0
      ? "READY"
      : findings.some((finding) => finding.severity === "P0")
        ? "BLOCKED"
        : "NOT_PROVEN";
  const receiptWithoutId = {
    schemaVersion,
    planRevisionId: request.planRevision.planRevisionId,
    runId: request.runId,
    attemptId: request.attemptId,
    workspaceFingerprint: request.planRevision.workspaceFingerprint,
    sourceFingerprint: request.planRevision.sourceFingerprint,
    environmentFingerprint: request.environmentFingerprint,
    status,
    decision: status,
    accounting,
    findings,
    observedAt: latestObservedAt(request, request.planRevision),
  } as const;
  return verificationAdequacyReceiptSchema.parse({
    ...receiptWithoutId,
    adequacyReceiptId: createReceiptId(receiptWithoutId),
  });
}
