import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { attemptIdSchema, observationSchema, verificationReceiptSchema } from "@hunter-pi/domain";
import {
  FileWorkflowEventStore,
  LocalStorageController,
  createPortableEvidenceEnvelope,
  createRunSummaryEvidence,
} from "@hunter-pi/evidence";
import { DurableWorkflowKernel } from "@hunter-pi/workflow-kernel";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";
import {
  createWorkflowDomainFixture,
  fixtureFingerprint,
  fixtureTimestamp,
} from "./support/workflow-domain-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("human-readable Run summary Evidence", () => {
  it("derives honest statuses from replayed facts and redacts portable text", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-run-summary-");
    roots.push(root);
    const privatePrompt = "fixture private summary prompt";
    const privateRoot = "C:\\Users\\Summary Owner";
    const fixture = createWorkflowDomainFixture({
      goal: `Handle ${privatePrompt} under ${privateRoot}\\repo`,
      includeRequiredGates: true,
    });
    const kernel = new DurableWorkflowKernel(
      new FileWorkflowEventStore({
        stateRoot: root,
        storage: new LocalStorageController({
          stateRoot: root,
          reserveBytes: 4_096,
          capacityProbe: () => Promise.resolve(1_000_000_000),
        }),
        now: () => fixtureTimestamp,
      }),
    );
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "CREATE_RUN",
      ...fixture,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_replay"),
      startedAt: fixtureTimestamp,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_summary-return",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });

    const summary = createRunSummaryEvidence(
      {
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary",
        projection: await kernel.project(fixture.run.runId),
        evidence: [],
        createdAt: fixtureTimestamp,
      },
      { privatePromptValues: [privatePrompt], privatePathRoots: [privateRoot] },
    );
    const text = summary.capture.capturedText ?? "";

    expect(summary.kind).toBe("run_summary");
    expect(text).toContain("Run run_replay — VERIFYING");
    expect(text).toContain("Attempt att_replay: execution=RETURNED, verification=PENDING");
    expect(text).toContain("Check check_replay: NOT_RUN (required)");
    expect(text).toContain("Evidence: 0 envelope(s)");
    expect(text).not.toContain("PASS");
    expect(JSON.stringify(summary)).not.toContain(privatePrompt);
    expect(JSON.stringify(summary)).not.toContain(privateRoot);
  });

  it("lists unresolved required human and review gates after automated checks pass", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-run-summary-gates-");
    roots.push(root);
    const fixture = createWorkflowDomainFixture({ includeRequiredGates: true });
    const kernel = new DurableWorkflowKernel(
      new FileWorkflowEventStore({
        stateRoot: root,
        storage: new LocalStorageController({
          stateRoot: root,
          reserveBytes: 4_096,
          capacityProbe: () => Promise.resolve(1_000_000_000),
        }),
        now: () => fixtureTimestamp,
      }),
    );
    await kernel.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_replay"),
      startedAt: fixtureTimestamp,
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_summary-gates-return",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        stepId: "step_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: [],
      }),
    });
    const verificationEvidence = createPortableEvidenceEnvelope({
      schemaVersion: "1.0.0",
      evidenceId: "evidence_summary-gates-verification",
      kind: "verification",
      scope: {
        runId: fixture.run.runId,
        attemptId: "att_replay",
        verificationReceiptId: "verify_summary-gates",
      },
      createdAt: fixtureTimestamp,
      sourceFingerprint: fixtureFingerprint,
      summary: "Verification fixture output.",
      contentClass: "SUMMARY",
      content: "The declared fixture check passed.",
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: verificationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        verificationReceiptId: "verify_summary-gates",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        checkId: "check_replay",
        checkVersion: 1,
        checkDefinitionFingerprint: fixtureFingerprint,
        resultFingerprint: fixtureFingerprint,
        outcome: "PASS",
        startedAt: fixtureTimestamp,
        endedAt: fixtureTimestamp,
        observedAt: fixtureTimestamp,
        inputFingerprint: fixtureFingerprint,
        configFingerprint: fixtureFingerprint,
        workspaceFingerprint: fixtureFingerprint,
        sourceFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
        output: {
          stdoutDigest: fixtureFingerprint,
          stderrDigest: fixtureFingerprint,
          artifactDigests: [],
          capturedBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          redaction: { applied: false, fieldsRemoved: 0 },
        },
        evidenceIds: [verificationEvidence.evidenceId],
      }),
    });
    const projection = await kernel.project(fixture.run.runId);

    const summary = createRunSummaryEvidence({
      schemaVersion: "1.0.0",
      evidenceId: "evidence_run-summary-gates",
      projection,
      evidence: [verificationEvidence],
      createdAt: fixtureTimestamp,
    });
    const text = summary.capture.capturedText ?? "";

    expect(text).toContain("step_human:HUMAN_NOT_RUN");
    expect(text).toContain("step_review:REVIEW_NOT_RUN");
    expect(text).not.toContain("Unresolved: none");
  });

  it("rejects omitted Evidence and forged projection facts", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-run-summary-integrity-");
    roots.push(root);
    const fixture = createWorkflowDomainFixture();
    const kernel = new DurableWorkflowKernel(
      new FileWorkflowEventStore({
        stateRoot: root,
        storage: new LocalStorageController({
          stateRoot: root,
          reserveBytes: 4_096,
          capacityProbe: () => Promise.resolve(1_000_000_000),
        }),
      }),
    );
    await kernel.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_replay"),
      startedAt: fixtureTimestamp,
    });
    const base = await kernel.project(fixture.run.runId);
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_OBSERVATION",
      observation: observationSchema.parse({
        schemaVersion: "1.0.0",
        observationId: "obs_summary-missing-evidence",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        kind: "AGENT_RETURNED",
        observedAt: fixtureTimestamp,
        evidenceIds: ["evidence_missing"],
      }),
    });
    const withMissingReference = await kernel.project(fixture.run.runId);

    expect(() =>
      createRunSummaryEvidence({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary-missing",
        projection: withMissingReference,
        evidence: [],
        createdAt: fixtureTimestamp,
      }),
    ).toThrow(/referenced Evidence/u);

    const forgedReady = {
      ...base,
      change: { ...base.change, lifecycle: "READY" as const },
      run: { ...base.run, lifecycle: "READY" as const },
      attempts: base.attempts.map((attempt) => ({
        ...attempt,
        executionStatus: "RETURNED" as const,
        verificationStatus: "PASSED" as const,
      })),
      checks: base.checks.map((check) => ({ ...check, status: "PASS" as const })),
    };
    const unrelatedEvidence = createPortableEvidenceEnvelope({
      schemaVersion: "1.0.0",
      evidenceId: "evidence_unrelated",
      kind: "observation",
      scope: { runId: fixture.run.runId, attemptId: "att_replay" },
      createdAt: fixtureTimestamp,
      sourceFingerprint: fixtureFingerprint,
      summary: "Unrelated fixture Evidence.",
      contentClass: "SUMMARY",
      content: "This does not prove the declared check.",
    });
    expect(() =>
      createRunSummaryEvidence({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary-ready-empty",
        projection: forgedReady,
        evidence: [unrelatedEvidence],
        createdAt: fixtureTimestamp,
      }),
    ).toThrow(/derived from its exact facts/u);
  });

  it("rejects forged READY lifecycle and duplicate Receipts even with exact PASS Evidence", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-run-summary-lifecycle-");
    roots.push(root);
    const fixture = createWorkflowDomainFixture();
    const kernel = new DurableWorkflowKernel(
      new FileWorkflowEventStore({
        stateRoot: root,
        storage: new LocalStorageController({
          stateRoot: root,
          reserveBytes: 4_096,
          capacityProbe: () => Promise.resolve(1_000_000_000),
        }),
      }),
    );
    await kernel.dispatch({ schemaVersion: "1.0.0", type: "CREATE_RUN", ...fixture });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "START_ATTEMPT",
      runId: fixture.run.runId,
      attemptId: attemptIdSchema.parse("att_replay"),
      startedAt: fixtureTimestamp,
    });
    const verificationEvidence = createPortableEvidenceEnvelope({
      schemaVersion: "1.0.0",
      evidenceId: "evidence_summary-lifecycle-verification",
      kind: "verification",
      scope: {
        runId: fixture.run.runId,
        attemptId: "att_replay",
        verificationReceiptId: "verify_summary-lifecycle",
      },
      createdAt: fixtureTimestamp,
      sourceFingerprint: fixtureFingerprint,
      summary: "Verification fixture output.",
      contentClass: "SUMMARY",
      content: "The exact check passed while the Agent remained active.",
    });
    await kernel.dispatch({
      schemaVersion: "1.0.0",
      type: "RECORD_VERIFICATION",
      receipt: verificationReceiptSchema.parse({
        schemaVersion: "1.0.0",
        verificationReceiptId: "verify_summary-lifecycle",
        runId: fixture.run.runId,
        attemptId: "att_replay",
        checkId: "check_replay",
        checkVersion: 1,
        checkDefinitionFingerprint: fixtureFingerprint,
        resultFingerprint: fixtureFingerprint,
        outcome: "PASS",
        startedAt: fixtureTimestamp,
        endedAt: fixtureTimestamp,
        observedAt: fixtureTimestamp,
        inputFingerprint: fixtureFingerprint,
        configFingerprint: fixtureFingerprint,
        workspaceFingerprint: fixtureFingerprint,
        sourceFingerprint: fixtureFingerprint,
        environmentFingerprint: fixtureFingerprint,
        resultStatus: { kind: "EXIT_CODE", exitCode: 0, timedOut: false },
        output: {
          stdoutDigest: fixtureFingerprint,
          stderrDigest: fixtureFingerprint,
          artifactDigests: [],
          capturedBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          redaction: { applied: false, fieldsRemoved: 0 },
        },
        evidenceIds: [verificationEvidence.evidenceId],
      }),
    });
    const projection = await kernel.project(fixture.run.runId);
    expect(projection).toMatchObject({
      run: { lifecycle: "RUNNING" },
      attempts: [{ executionStatus: "RUNNING", verificationStatus: "PASSED" }],
      checks: [{ status: "PASS" }],
    });
    const forgedReady = {
      ...projection,
      change: { ...projection.change, lifecycle: "READY" as const },
      run: { ...projection.run, lifecycle: "READY" as const },
    };

    expect(() =>
      createRunSummaryEvidence({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary-forged-lifecycle",
        projection: forgedReady,
        evidence: [verificationEvidence],
        createdAt: fixtureTimestamp,
      }),
    ).toThrow(/lifecycle is not derived/u);

    const receipt = projection.verificationReceipts[0];
    if (receipt === undefined) {
      throw new Error("expected the exact Verification Receipt");
    }
    expect(() =>
      createRunSummaryEvidence({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary-duplicate-receipt",
        projection: {
          ...projection,
          verificationReceipts: [
            receipt,
            { ...receipt, verificationReceiptId: "verify_summary-lifecycle-duplicate" },
          ],
          eventCursor: projection.eventCursor + 1,
        },
        evidence: [verificationEvidence],
        createdAt: fixtureTimestamp,
      }),
    ).toThrow(/duplicate or unbound Verification Receipt/u);

    const counterfeitEvidence = createPortableEvidenceEnvelope({
      schemaVersion: "1.0.0",
      evidenceId: verificationEvidence.evidenceId,
      kind: "observation",
      scope: { runId: fixture.run.runId, attemptId: "att_replay" },
      createdAt: fixtureTimestamp,
      sourceFingerprint: fixtureFingerprint,
      summary: "Counterfeit Evidence with a reused identity.",
      contentClass: "SUMMARY",
      content: "This is not bound to the Verification Receipt.",
    });
    expect(() =>
      createRunSummaryEvidence({
        schemaVersion: "1.0.0",
        evidenceId: "evidence_run-summary-counterfeit-evidence",
        projection,
        evidence: [counterfeitEvidence],
        createdAt: fixtureTimestamp,
      }),
    ).toThrow(/Verification Evidence does not bind its exact Receipt/u);
  });
});
