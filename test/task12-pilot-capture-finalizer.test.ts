import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FilePilotArchiveStore,
  PilotEvidenceCaptureFinalizer,
  type PilotEvidenceDraft,
} from "@hunter-pi/pilot";

import {
  createPilotEvidenceCaptureRuntime,
  finalizePilotEvidenceDraft,
} from "../packages/pilot/src/capture.js";
import { completePilotEvidence } from "./support/task12-evidence-fixture.js";
import { completePilotExecutionPlan } from "./support/task12-plan-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function draftFor(plan: ReturnType<typeof completePilotExecutionPlan>): PilotEvidenceDraft {
  const { captureProvenance, ...draft } = completePilotEvidence(plan, "FIXTURE");
  void captureProvenance;
  return draft;
}

function finalizerFor(
  plan: ReturnType<typeof completePilotExecutionPlan>,
  draft: PilotEvidenceDraft = draftFor(plan),
) {
  return new PilotEvidenceCaptureFinalizer({
    plan,
    runtime: createPilotEvidenceCaptureRuntime(vi.fn(() => draft)),
  });
}

describe("Task 12 production pilot capture finalizer", () => {
  it("issues a frozen live capture only from a plan-bound runtime draft", async () => {
    const plan = completePilotExecutionPlan();
    const finalizer = finalizerFor(plan);

    if (process.platform !== "win32") {
      await expect(finalizer.finalize()).rejects.toThrow(/Windows/u);
      return;
    }

    const capture = await finalizer.finalize();

    expect(capture.evidence.captureProvenance).toBe("LIVE_WINDOWS_PILOT");
    expect(capture.evidence.planFingerprint).toBe(plan.planFingerprint);
    expect(capture.evidence.operatorScope).toEqual(plan.operatorScope);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.evidence)).toBe(true);
    expect(Object.isFrozen(capture.evidence.taskResults)).toBe(true);

    const stateRoot = mkdtempSync(join(tmpdir(), "hunter-pi-finalizer-"));
    roots.push(stateRoot);
    const archive = new FilePilotArchiveStore({ stateRoot }).write({
      archiveId: "pilot-finalizer-integration",
      planFingerprint: plan.planFingerprint,
      capture,
      observedAt: capture.evidence.observedAt,
    });
    expect(archive.archive.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("validates the full draft contract on every platform before issuing authority", () => {
    const plan = completePilotExecutionPlan();
    const evidence = finalizePilotEvidenceDraft(plan, draftFor(plan));

    expect(evidence.captureProvenance).toBe("LIVE_WINDOWS_PILOT");
    expect(evidence.planFingerprint).toBe(plan.planFingerprint);
    expect(evidence.operatorScope).toEqual(plan.operatorScope);
  });

  it("rejects an unbranded public collector before it can create an Archive", () => {
    const plan = completePilotExecutionPlan();
    const stateRoot = mkdtempSync(join(tmpdir(), "hunter-pi-finalizer-unbranded-"));
    roots.push(stateRoot);
    expect(
      () =>
        new PilotEvidenceCaptureFinalizer({
          plan,
          runtime: { collectEvidence: vi.fn(() => draftFor(plan)) } as never,
        }),
    ).toThrow(/capability|runtime/u);
    expect(existsSync(join(stateRoot, "archives"))).toBe(false);
  });

  it("redacts invalid frozen-plan failures", () => {
    const privatePlanSentinel = "C:\\Users\\pilot-plan-private-sentinel";
    let error: unknown;
    try {
      new PilotEvidenceCaptureFinalizer({
        plan: { privatePlanSentinel } as never,
        runtime: {} as never,
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/plan|frozen|valid/u);
    expect(String(error)).not.toContain(privatePlanSentinel);
  });

  it("rejects a runtime draft that attempts to choose its own provenance", () => {
    const plan = completePilotExecutionPlan();
    const draft = {
      ...draftFor(plan),
      captureProvenance: "FIXTURE",
    } as never;

    expect(() => finalizePilotEvidenceDraft(plan, draft)).toThrow(/provenance|capture|runtime/u);
  });

  it("rejects a draft whose plan or operator scope is not the frozen runtime plan", () => {
    const plan = completePilotExecutionPlan();
    const otherPlan = completePilotExecutionPlan();
    const mismatchedPlan = {
      ...draftFor(plan),
      planFingerprint: `sha256:${"f".repeat(64)}`,
    } as PilotEvidenceDraft;

    expect(() => finalizePilotEvidenceDraft(otherPlan, mismatchedPlan)).toThrow(
      /plan|fingerprint/u,
    );

    const mismatchedScope = {
      ...draftFor(plan),
      operatorScope: {
        ...plan.operatorScope,
        maxProviderRequests: (plan.operatorScope.maxProviderRequests ?? 1) - 1,
      },
    } satisfies PilotEvidenceDraft;
    expect(() => finalizePilotEvidenceDraft(otherPlan, mismatchedScope)).toThrow(
      /plan|scope|operator/u,
    );
  });

  it("rejects credential-shaped or path-bearing runtime extras without echoing them", () => {
    const plan = completePilotExecutionPlan();
    const credentialSentinel = "pilot-finalizer-credential-sentinel";
    const privatePathSentinel = "C:\\Users\\pilot-finalizer-private";
    const draft = {
      ...draftFor(plan),
      credential: credentialSentinel,
      privatePath: privatePathSentinel,
    } as never;

    let error: unknown;
    try {
      finalizePilotEvidenceDraft(plan, draft);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/invalid|unsupported|runtime/u);
    expect(String(error)).not.toContain(credentialSentinel);
    expect(String(error)).not.toContain(privatePathSentinel);
  });

  it("rejects a machine identity drift before issuing opaque authority", () => {
    const plan = completePilotExecutionPlan();
    const draft = {
      ...draftFor(plan),
      machine: { ...plan.machineProfile, osBuild: "different-windows-build" },
    } satisfies PilotEvidenceDraft;

    expect(() => finalizePilotEvidenceDraft(plan, draft)).toThrow(/plan|machine|identity/u);
  });

  it("consumes the runtime collector once and cannot be replayed", async () => {
    const plan = completePilotExecutionPlan();
    const collectEvidence = vi.fn(() => draftFor(plan));
    const finalizer = new PilotEvidenceCaptureFinalizer({
      plan,
      runtime: createPilotEvidenceCaptureRuntime(collectEvidence),
    });

    if (process.platform !== "win32") {
      await expect(finalizer.finalize()).rejects.toThrow(/Windows/u);
      expect(collectEvidence).not.toHaveBeenCalled();
      return;
    }

    await expect(finalizer.finalize()).resolves.toBeDefined();
    await expect(finalizer.finalize()).rejects.toThrow(/already|finalized|consumed/u);
    expect(collectEvidence).toHaveBeenCalledOnce();
  });
});
