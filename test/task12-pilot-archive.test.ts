import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilePilotArchiveStore, pilotArchiveSchema } from "@hunter-pi/pilot";

import { completePilotEvidence } from "./support/task12-evidence-fixture.js";
import { completePilotExecutionPlan } from "./support/task12-plan-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Task 12 trusted pilot Archive store", () => {
  it("writes an append-only package and returns a trusted handle only after digest verification", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-"));
    roots.push(root);
    const plan = completePilotExecutionPlan();
    const evidence = completePilotEvidence(plan, "LIVE_WINDOWS_PILOT");
    const store = new FilePilotArchiveStore({ stateRoot: root });

    const trusted = store.write({
      archiveId: "pilot-archive-real-test",
      planFingerprint: plan.planFingerprint,
      evidence,
      observedAt: evidence.observedAt,
    });

    expect(trusted.archive.archiveStatus).toBe("ARCHIVED");
    expect(trusted.archive.provenance).toBe("REAL_WINDOWS_PILOT");
    expect(trusted.archive.fixture).toBe(false);
    expect(Object.isFrozen(trusted.archive)).toBe(true);
    expect(Object.isFrozen(trusted.archive.evidence)).toBe(true);
    expect(Object.isFrozen(trusted.archive.evidence.taskResults)).toBe(true);
    expect(() => pilotArchiveSchema.parse(trusted.archive)).not.toThrow();
    expect(store.read("pilot-archive-real-test").archive.archiveFingerprint).toBe(
      trusted.archive.archiveFingerprint,
    );

    const packagePath = join(root, "archives", "pilot-archive-real-test", "package.json");
    const package_ = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      packagePath,
      JSON.stringify({ ...package_, archiveFingerprint: `sha256:${"f".repeat(64)}` }),
      "utf8",
    );
    expect(() => store.read("pilot-archive-real-test")).toThrow(/invalid|digest|immutable|trust/u);
  });

  it("rejects fixture provenance and a plain evidence file before evaluation can trust it", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-"));
    roots.push(root);
    const plan = completePilotExecutionPlan();
    const evidence = completePilotEvidence(plan);
    const packageDirectory = join(root, "archives", "pilot-archive-fixture");
    const body = {
      schemaVersion: "hpi-pilot-archive.v1",
      archiveId: "pilot-archive-fixture",
      archiveStatus: "ARCHIVED",
      provenance: "FIXTURE",
      fixture: true,
      planFingerprint: plan.planFingerprint,
      evidenceFingerprint: `sha256:${createHash("sha256")
        .update(JSON.stringify(evidence))
        .digest("hex")}`,
      evidence,
      observedAt: evidence.observedAt,
      archiveFingerprint: `sha256:${"a".repeat(64)}`,
      storeReceipt: {
        schemaVersion: "hpi-pilot-store-receipt.v1",
        archiveId: "pilot-archive-fixture",
        archiveFingerprint: `sha256:${"a".repeat(64)}`,
        observedAt: evidence.observedAt,
        proof: `sha256:${"b".repeat(64)}`,
      },
    };
    const evidenceOnlyPath = join(root, "evidence.json");
    writeFileSync(evidenceOnlyPath, JSON.stringify(evidence), "utf8");
    expect(() => FilePilotArchiveStore.readPackageFile(evidenceOnlyPath)).toThrow();

    const packagePath = join(packageDirectory, "package.json");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(packagePath, JSON.stringify(body), "utf8");
    expect(() => FilePilotArchiveStore.readPackageFile(packagePath)).toThrow(
      /key|fixture|invalid|trust/u,
    );
  });

  it("does not promote an Evidence set marked as a fixture into the trusted store", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-"));
    roots.push(root);
    const plan = completePilotExecutionPlan();
    const evidence = completePilotEvidence(plan);
    expect(evidence.captureProvenance).toBe("FIXTURE");

    expect(() =>
      new FilePilotArchiveStore({ stateRoot: root }).write({
        archiveId: "pilot-archive-fixture-write",
        planFingerprint: plan.planFingerprint,
        evidence,
        observedAt: evidence.observedAt,
      }),
    ).toThrow(/fixture|live|provenance/u);
  });

  it("rejects an archive directory alias before writing outside the trusted store", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-"));
    const outside = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-outside-"));
    roots.push(root, outside);
    symlinkSync(outside, join(root, "archives"), process.platform === "win32" ? "junction" : "dir");
    const plan = completePilotExecutionPlan();
    const evidence = completePilotEvidence(plan, "LIVE_WINDOWS_PILOT");

    expect(() =>
      new FilePilotArchiveStore({ stateRoot: root }).write({
        archiveId: "pilot-archive-symlink-test",
        planFingerprint: plan.planFingerprint,
        evidence,
        observedAt: evidence.observedAt,
      }),
    ).toThrow(/directory|store|exact|immutable/u);
    expect(existsSync(join(outside, "pilot-archive-symlink-test", "package.json"))).toBe(false);
  });

  it("requires the Archive observation time to bind the exact Evidence observation", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-pi-pilot-archive-"));
    roots.push(root);
    const plan = completePilotExecutionPlan();
    const evidence = completePilotEvidence(plan, "LIVE_WINDOWS_PILOT");

    expect(() =>
      new FilePilotArchiveStore({ stateRoot: root }).write({
        archiveId: "pilot-archive-observed-at-test",
        planFingerprint: plan.planFingerprint,
        evidence,
        observedAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toThrow(/observ|time|bind/u);
  });
});
