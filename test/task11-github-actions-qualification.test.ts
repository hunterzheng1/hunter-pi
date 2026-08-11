import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { sha256Fingerprint } from "@hunter-pi/evidence";
import * as updater from "@hunter-pi/updater";

import { runQualificationCliProcess } from "../packages/updater/src/gh-cli-process.js";

import { fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import {
  createTemporaryTestDirectory,
  removeTemporaryTestDirectory,
} from "./support/temporary-test-directory.js";

const sourceCommit = "a".repeat(40);
const runId = 31_451_189_405;
const requiredJobs = [
  "ubuntu-latest / Node 24",
  "windows-latest / Node 24",
  "Pi + Task 9 + Task 10 Evidence / Windows + Ubuntu identity",
  "Task 7 containment / ubuntu-latest",
  "Task 7 containment / windows-latest",
  "Task 7 Evidence / Windows + Ubuntu identity",
] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryTestDirectory));
});

function portableFixture(releaseId = "release_task11-github-actions-qualification") {
  const engineFingerprint = sha256Fingerprint("github-actions-qualification-engine");
  const artifact = updater.createPortableBundle({
    releaseId,
    productVersion: "0.2.0",
    engineReleaseId: "engine-release_pi-0.83.0",
    engineReleaseFingerprint: engineFingerprint,
    sourceCommit,
    files: [
      { path: "hpi.cmd", bytes: Buffer.from("@echo off\r\n", "utf8") },
      { path: "node.exe", bytes: Buffer.from("portable-node-fixture\n", "utf8") },
    ],
  });
  const candidate = updater.releaseCandidateSchema.parse({
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion: "0.2.0",
    channel: "PREVIEW",
    artifact: {
      reference: `fixture/${releaseId}.bundle.tgz`,
      fingerprint: sha256Fingerprint(artifact),
      byteLength: artifact.byteLength,
    },
    engine: {
      releaseId: "engine-release_pi-0.83.0",
      fingerprint: engineFingerprint,
      piVersion: "0.83.0",
    },
    qualification: {
      status: "NOT_PROVEN",
      verifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      checks: [
        {
          name: "windows-portable-ci",
          outcome: "NOT_PROVEN",
          evidenceIds: [],
          reason: "remote Windows and Ubuntu qualification is required before promotion",
        },
      ],
      qualifiedAt: fixtureTimestamp,
    },
    updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
    licenses: [
      {
        name: "Hunter Pi",
        version: "0.2.0",
        license: "MIT",
        sourceReference: "NOTICE",
      },
    ],
  });
  return { artifact, candidate };
}

function exactObservation(
  artifact: Uint8Array,
  hostedCandidate: updater.ReleaseCandidate,
  observedRunId = runId,
) {
  return {
    run: {
      id: observedRunId,
      attempt: 1,
      event: "push",
      headBranch: "main",
      headSha: sourceCommit,
      workflowName: "CI",
      status: "completed",
      conclusion: "success",
      updatedAt: "2026-08-11T12:30:00.000Z",
      url: `https://github.com/hunterzheng1/hunter-pi/actions/runs/${String(observedRunId)}`,
      jobs: requiredJobs.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
      })),
    },
    hostedArtifact: artifact,
    hostedCandidate,
  };
}

describe("Task 11 GitHub Actions portable qualification", () => {
  it("creates PASS qualification only from the exact successful main run and hosted bundle", async () => {
    const fixture = portableFixture();
    const Constructor = Reflect.get(updater, "GitHubActionsWindowsPortableQualificationAuthority");
    expect(Constructor).toEqual(expect.any(Function));
    const Authority = Constructor as new (options: {
      readonly observe: () => Promise<unknown>;
    }) => {
      qualify(input: unknown): Promise<{
        readonly candidate: updater.ReleaseCandidate;
        readonly evidence: { readonly evidenceId: string; readonly run: { readonly id: number } };
      }>;
    };
    const authority = new Authority({
      observe: () => Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    });

    await expect(
      authority.qualify({
        candidate: fixture.candidate,
        artifact: fixture.artifact,
        source: {
          kind: "GITHUB_ACTIONS_RUN",
          repository: "hunterzheng1/hunter-pi",
          runId,
        },
        deadline: "2026-08-11T13:00:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      }),
    ).resolves.toMatchObject({
      candidate: {
        releaseId: fixture.candidate.releaseId,
        qualification: {
          status: "PASS",
          verifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
          qualifiedAt: "2026-08-11T12:30:00.000Z",
          checks: [
            {
              name: "windows-portable-ci",
              outcome: "PASS",
              evidenceIds: [`evidence_main-ci-${String(runId)}-portable`],
            },
          ],
        },
      },
      evidence: {
        schemaVersion: "hpi-windows-portable-qualification-evidence.v1",
        evidenceId: `evidence_main-ci-${String(runId)}-portable`,
        sourceCommit,
        artifact: {
          fingerprint: fixture.candidate.artifact.fingerprint,
          byteLength: fixture.candidate.artifact.byteLength,
        },
        run: { id: runId, attempt: 1 },
      },
    });
  });

  it("promotes an active packaged candidate through one replayable manager operation", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-manager-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const updateFixture = portableFixture("release_task11-github-actions-update");
    const qualifiedUpdate = updater.releaseCandidateSchema.parse({
      ...updateFixture.candidate,
      qualification: {
        status: "PASS",
        verifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
        checks: [
          {
            name: "windows-portable-ci",
            outcome: "PASS",
            evidenceIds: ["evidence_task11-qualified-update"],
          },
        ],
        qualifiedAt: "2026-08-11T12:30:00.000Z",
      },
    });
    const portableRoot = join(root, "portable");
    const adapter = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const staged = await adapter.stage(fixture.candidate, fixture.artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), fixture.artifact);
    const observe = vi.fn(() =>
      Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    );
    const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({ observe });
    const artifacts = new Map([
      [fixture.candidate.releaseId, fixture.artifact],
      [qualifiedUpdate.releaseId, updateFixture.artifact],
    ]);
    const manager = new updater.FileUpdateManager({
      stateRoot: join(root, "qualification-manager"),
      channel: "PREVIEW",
      adapter,
      artifacts: {
        read: (candidate) => {
          const artifact = artifacts.get(candidate.releaseId);
          if (artifact === undefined) throw new Error("qualification fixture artifact missing");
          return Promise.resolve(artifact);
        },
      },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: authority,
      now: () => "2026-08-11T12:31:00.000Z",
    });
    const expectedTarget = updater.windowsPortableQualificationTargetReference(fixture.candidate);
    const operationPayload = {
      expectedTarget,
      source: {
        kind: "GITHUB_ACTIONS_RUN",
        repository: "hunterzheng1/hunter-pi",
        runId,
      },
      deadline: "2026-08-11T13:00:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
    } as const;
    const request = updater.updateQualificationRequestSchema.parse({
      schemaVersion: "hpi-update-qualification.v1",
      operationId: `op_update-qualify-${String(runId)}`,
      operationFingerprint:
        updater.windowsPortableQualificationRequestFingerprint(operationPayload),
      ...operationPayload,
      observedAt: "2026-08-11T12:31:00.000Z",
    });

    const first = await manager.qualify(request);
    await expect(manager.qualify(request)).resolves.toEqual(first);
    expect(first).toMatchObject({
      action: "QUALIFY",
      outcome: "APPLIED",
      candidateReleaseId: fixture.candidate.releaseId,
      activeReleaseId: fixture.candidate.releaseId,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    const installedInitialCandidatePath = join(
      portableRoot,
      "versions",
      fixture.candidate.releaseId,
      ".hpi-candidate.json",
    );
    const qualifiedInitialCandidate = updater.releaseCandidateSchema.parse(
      JSON.parse(await readFile(installedInitialCandidatePath, "utf8")) as unknown,
    );
    expect(qualifiedInitialCandidate).toMatchObject({ qualification: { status: "PASS" } });
    await expect(
      readFile(
        join(portableRoot, ".hpi-update", "qualification-evidence", `${String(runId)}.json`),
      ),
    ).resolves.toBeInstanceOf(Buffer);
    const qualificationEvidencePath = join(
      portableRoot,
      ".hpi-update",
      "qualification-evidence",
      `${String(runId)}.json`,
    );
    const qualificationEvidence = await readFile(qualificationEvidencePath);
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_task11-qualified-first-update",
        operationFingerprint: sha256Fingerprint("task11-qualified-first-update"),
        candidate: qualifiedUpdate,
        observedAt: "2026-08-11T12:32:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
      previousReleaseId: fixture.candidate.releaseId,
      activeReleaseId: qualifiedUpdate.releaseId,
    });
    const replacementRunId = runId + 17;
    const replacementAuthority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
      observe: () =>
        Promise.resolve(exactObservation(fixture.artifact, fixture.candidate, replacementRunId)),
    });
    const replacementQualification = await replacementAuthority.qualify({
      candidate: fixture.candidate,
      artifact: fixture.artifact,
      source: {
        kind: "GITHUB_ACTIONS_RUN",
        repository: "hunterzheng1/hunter-pi",
        runId: replacementRunId,
      },
      deadline: "2026-08-11T13:00:00.000Z",
      cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
    });
    await writeFile(
      join(
        portableRoot,
        ".hpi-update",
        "qualification-evidence",
        `${String(replacementRunId)}.json`,
      ),
      JSON.stringify(replacementQualification.evidence),
      "utf8",
    );
    await writeFile(
      installedInitialCandidatePath,
      JSON.stringify(replacementQualification.candidate),
      "utf8",
    );
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-qualified-first-rollback-replaced-identity",
        operationFingerprint: sha256Fingerprint(
          "task11-qualified-first-rollback-replaced-identity",
        ),
        targetReleaseId: fixture.candidate.releaseId,
        observedAt: "2026-08-11T12:32:15.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      previousReleaseId: qualifiedUpdate.releaseId,
      activeReleaseId: qualifiedUpdate.releaseId,
    });
    await writeFile(
      installedInitialCandidatePath,
      JSON.stringify(qualifiedInitialCandidate),
      "utf8",
    );
    await rm(qualificationEvidencePath);
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-qualified-first-rollback-missing-evidence",
        operationFingerprint: sha256Fingerprint("task11-qualified-first-rollback-missing-evidence"),
        targetReleaseId: fixture.candidate.releaseId,
        observedAt: "2026-08-11T12:32:30.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      previousReleaseId: qualifiedUpdate.releaseId,
      activeReleaseId: qualifiedUpdate.releaseId,
    });
    await writeFile(qualificationEvidencePath, qualificationEvidence);
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-qualified-first-rollback",
        operationFingerprint: sha256Fingerprint("task11-qualified-first-rollback"),
        targetReleaseId: fixture.candidate.releaseId,
        observedAt: "2026-08-11T12:33:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
      previousReleaseId: qualifiedUpdate.releaseId,
      activeReleaseId: fixture.candidate.releaseId,
    });
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-qualified-history-without-evidence",
        operationFingerprint: sha256Fingerprint("task11-qualified-history-without-evidence"),
        targetReleaseId: qualifiedUpdate.releaseId,
        observedAt: "2026-08-11T12:33:30.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      previousReleaseId: fixture.candidate.releaseId,
      activeReleaseId: fixture.candidate.releaseId,
    });
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(
      join(portableRoot, "versions", fixture.candidate.releaseId, ".hpi-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await expect(
      manager.qualify(
        updater.updateQualificationRequestSchema.parse({
          ...request,
          operationId: `op_update-qualify-${String(runId)}-metadata-repair`,
        }),
      ),
    ).resolves.toMatchObject({ action: "QUALIFY", outcome: "APPLIED" });
    expect(observe).toHaveBeenCalledTimes(2);
    await expect(adapter.installedCandidate(staged)).resolves.toMatchObject({
      qualification: { status: "PASS" },
    });
  });

  it("reconciles qualification interrupted after the root candidate was published", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-recovery-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const portableRoot = join(root, "portable");
    const afterQualificationRootCandidatePublished = vi.fn(() =>
      Promise.reject(new Error("injected interruption after root qualification publish")),
    );
    const adapter = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
      afterQualificationRootCandidatePublished,
    });
    const staged = await adapter.stage(fixture.candidate, fixture.artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), fixture.artifact);
    const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
      observe: () => Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    });
    const source = {
      kind: "GITHUB_ACTIONS_RUN" as const,
      repository: "hunterzheng1/hunter-pi" as const,
      runId,
    };
    const deadline = "2026-08-11T13:00:00.000Z";
    const cancellationPolicy = { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 };
    const expectedTarget = updater.windowsPortableQualificationTargetReference(fixture.candidate);
    const operationFingerprint = updater.windowsPortableQualificationRequestFingerprint({
      expectedTarget,
      source,
      deadline,
      cancellationPolicy,
    });
    const operationId = `op_update-qualify-${String(runId)}-recovery` as const;
    const result = await authority.qualify({
      candidate: fixture.candidate,
      artifact: fixture.artifact,
      source,
      deadline,
      cancellationPolicy,
    });

    await expect(
      adapter.promoteQualification({
        operationId,
        operationFingerprint,
        requestFingerprint: operationFingerprint,
        baseCandidate: fixture.candidate,
        candidate: result.candidate,
        evidence: result.evidence,
        artifact: fixture.artifact,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).rejects.toThrow(/interruption/u);
    expect(afterQualificationRootCandidatePublished).toHaveBeenCalledTimes(1);

    const qualificationIntentPath = join(portableRoot, ".hpi-update", "qualification-intent.json");
    const qualificationIntent = JSON.parse(
      await readFile(qualificationIntentPath, "utf8"),
    ) as Record<string, unknown>;
    const evidence = qualificationIntent["evidence"] as Record<string, unknown>;
    const run = evidence["run"] as Record<string, unknown>;
    const driftedCommit = "c".repeat(40);
    await writeFile(
      qualificationIntentPath,
      JSON.stringify({
        ...qualificationIntent,
        evidence: {
          ...evidence,
          sourceCommit: driftedCommit,
          run: { ...run, headSha: driftedCommit },
        },
      }),
      "utf8",
    );
    await rm(join(portableRoot, ".hpi-update", "qualification-evidence", `${String(runId)}.json`));
    const rejectingReopen = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    await expect(rejectingReopen.reconcile()).rejects.toThrow(/Evidence|source/u);
    await writeFile(qualificationIntentPath, JSON.stringify(qualificationIntent), "utf8");

    const reopened = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = new updater.FileUpdateManager({
      stateRoot: join(root, "qualification-manager"),
      channel: "PREVIEW",
      adapter: reopened,
      artifacts: { read: () => Promise.resolve(fixture.artifact) },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: new updater.GitHubActionsWindowsPortableQualificationAuthority({
        observe: () => Promise.reject(new Error("reconciliation must not query GitHub again")),
      }),
      now: () => "2026-08-11T12:32:00.000Z",
    });
    const [receipt] = await manager.reconcile();
    expect(receipt).toMatchObject({
      operationId,
      operationFingerprint,
      action: "QUALIFY",
      outcome: "APPLIED",
      candidateReleaseId: fixture.candidate.releaseId,
    });
    await expect(
      manager.qualify({
        schemaVersion: "hpi-update-qualification.v1",
        operationId,
        operationFingerprint,
        expectedTarget,
        source,
        deadline,
        cancellationPolicy,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).resolves.toEqual(receipt);
    await expect(reopened.installedCandidate(staged)).resolves.toMatchObject({
      qualification: { status: "PASS" },
    });
  });

  it("retains a successful qualification intent until the manager journals its Receipt", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-finality-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const portableRoot = join(root, "portable");
    const adapter = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const staged = await adapter.stage(fixture.candidate, fixture.artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), fixture.artifact);
    const source = {
      kind: "GITHUB_ACTIONS_RUN" as const,
      repository: "hunterzheng1/hunter-pi" as const,
      runId,
    };
    const deadline = "2026-08-11T13:00:00.000Z";
    const cancellationPolicy = { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 };
    const expectedTarget = updater.windowsPortableQualificationTargetReference(fixture.candidate);
    const operationFingerprint = updater.windowsPortableQualificationRequestFingerprint({
      expectedTarget,
      source,
      deadline,
      cancellationPolicy,
    });
    const operationId = `op_update-qualify-${String(runId)}-finality` as const;
    const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
      observe: () => Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    });
    const result = await authority.qualify({
      candidate: fixture.candidate,
      artifact: fixture.artifact,
      source,
      deadline,
      cancellationPolicy,
    });

    await expect(
      adapter.promoteQualification({
        operationId,
        operationFingerprint,
        requestFingerprint: operationFingerprint,
        baseCandidate: fixture.candidate,
        candidate: result.candidate,
        evidence: result.evidence,
        artifact: fixture.artifact,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).resolves.toBe("PROMOTED");
    const qualificationIntentPath = join(portableRoot, ".hpi-update", "qualification-intent.json");
    await expect(readFile(qualificationIntentPath)).resolves.toBeInstanceOf(Buffer);

    const finalizationBlocked = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
      beforeQualificationIntentCleared: () =>
        Promise.reject(new Error("injected interruption after qualification Receipt append")),
    });
    const managerState = join(root, "qualification-manager");
    const interruptedManager = new updater.FileUpdateManager({
      stateRoot: managerState,
      channel: "PREVIEW",
      adapter: finalizationBlocked,
      artifacts: { read: () => Promise.resolve(fixture.artifact) },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: new updater.GitHubActionsWindowsPortableQualificationAuthority({
        observe: () => Promise.reject(new Error("reconciliation must not query GitHub again")),
      }),
      now: () => "2026-08-11T12:32:00.000Z",
    });
    await expect(interruptedManager.reconcile()).rejects.toThrow(/interruption/u);
    await expect(readFile(qualificationIntentPath)).resolves.toBeInstanceOf(Buffer);

    const reopened = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const recoveredManager = new updater.FileUpdateManager({
      stateRoot: managerState,
      channel: "PREVIEW",
      adapter: reopened,
      artifacts: { read: () => Promise.resolve(fixture.artifact) },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: new updater.GitHubActionsWindowsPortableQualificationAuthority({
        observe: () => Promise.reject(new Error("reconciliation must not query GitHub again")),
      }),
      now: () => "2026-08-11T12:32:00.000Z",
    });
    await expect(recoveredManager.reconcile()).resolves.toEqual([]);
    await expect(
      recoveredManager.qualify({
        schemaVersion: "hpi-update-qualification.v1",
        operationId,
        operationFingerprint,
        expectedTarget,
        source,
        deadline,
        cancellationPolicy,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).resolves.toMatchObject({ operationId, action: "QUALIFY", outcome: "APPLIED" });
    await expect(readFile(qualificationIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never publishes a partial qualification Evidence file after an interrupted write", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-evidence-atomic-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const portableRoot = join(root, "portable");
    const adapter = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
      qualificationEvidenceFaultInjector: (boundary: string) => {
        if (boundary === "AFTER_TEMP_WRITE") {
          throw new Error("injected qualification Evidence write interruption");
        }
      },
    });
    const staged = await adapter.stage(fixture.candidate, fixture.artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), fixture.artifact);
    const source = {
      kind: "GITHUB_ACTIONS_RUN" as const,
      repository: "hunterzheng1/hunter-pi" as const,
      runId,
    };
    const deadline = "2026-08-11T13:00:00.000Z";
    const cancellationPolicy = { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 };
    const expectedTarget = updater.windowsPortableQualificationTargetReference(fixture.candidate);
    const operationFingerprint = updater.windowsPortableQualificationRequestFingerprint({
      expectedTarget,
      source,
      deadline,
      cancellationPolicy,
    });
    const operationId = `op_update-qualify-${String(runId)}-evidence-atomic` as const;
    const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
      observe: () => Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    });
    const result = await authority.qualify({
      candidate: fixture.candidate,
      artifact: fixture.artifact,
      source,
      deadline,
      cancellationPolicy,
    });

    await expect(
      adapter.promoteQualification({
        operationId,
        operationFingerprint,
        requestFingerprint: operationFingerprint,
        baseCandidate: fixture.candidate,
        candidate: result.candidate,
        evidence: result.evidence,
        artifact: fixture.artifact,
        observedAt: "2026-08-11T12:31:00.000Z",
      }),
    ).rejects.toThrow();
    const evidencePath = join(
      portableRoot,
      ".hpi-update",
      "qualification-evidence",
      `${String(runId)}.json`,
    );
    await expect(readFile(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(portableRoot, "portable-release-candidate.json"), "utf8").then((value) =>
        updater.releaseCandidateSchema.parse(JSON.parse(value) as unknown),
      ),
    ).resolves.toMatchObject({ qualification: { status: "NOT_PROVEN" } });

    const reopened = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = new updater.FileUpdateManager({
      stateRoot: join(root, "qualification-manager"),
      channel: "PREVIEW",
      adapter: reopened,
      artifacts: { read: () => Promise.resolve(fixture.artifact) },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: authority,
      now: () => "2026-08-11T12:32:00.000Z",
    });
    await expect(manager.reconcile()).resolves.toEqual([
      expect.objectContaining({ operationId, action: "QUALIFY", outcome: "APPLIED" }),
    ]);
    await expect(readFile(evidencePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("does not journal FAILED when the manager can reconcile a qualification interruption", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-manager-recovery-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const portableRoot = join(root, "portable");
    let interrupted = false;
    const adapter = new updater.FileWindowsPortableReleaseAdapter({
      installationRoot: portableRoot,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
      afterQualificationRootCandidatePublished: () => {
        if (!interrupted) {
          interrupted = true;
          return Promise.reject(new Error("injected manager qualification interruption"));
        }
        return Promise.resolve();
      },
    });
    const staged = await adapter.stage(fixture.candidate, fixture.artifact);
    await adapter.activate(staged);
    await writeFile(
      join(portableRoot, "portable-release-candidate.json"),
      JSON.stringify(fixture.candidate),
      "utf8",
    );
    await writeFile(join(portableRoot, "update.bundle.tgz"), fixture.artifact);
    const observe = vi.fn(() =>
      Promise.resolve(exactObservation(fixture.artifact, fixture.candidate)),
    );
    const manager = new updater.FileUpdateManager({
      stateRoot: join(root, "qualification-manager"),
      channel: "PREVIEW",
      adapter,
      artifacts: { read: () => Promise.resolve(fixture.artifact) },
      qualificationVerifierFingerprint: updater.HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
      qualificationAuthority: new updater.GitHubActionsWindowsPortableQualificationAuthority({
        observe,
      }),
      now: () => "2026-08-11T12:31:00.000Z",
    });
    const expectedTarget = updater.windowsPortableQualificationTargetReference(fixture.candidate);
    const source = {
      kind: "GITHUB_ACTIONS_RUN" as const,
      repository: "hunterzheng1/hunter-pi" as const,
      runId,
    };
    const deadline = "2026-08-11T13:00:00.000Z";
    const cancellationPolicy = { mode: "FAIL_CLOSED" as const, timeoutMs: 30_000 };
    const operationFingerprint = updater.windowsPortableQualificationRequestFingerprint({
      expectedTarget,
      source,
      deadline,
      cancellationPolicy,
    });
    const request = updater.updateQualificationRequestSchema.parse({
      schemaVersion: "hpi-update-qualification.v1",
      operationId: "op_update-qualify-manager-recovery",
      operationFingerprint,
      expectedTarget,
      source,
      deadline,
      cancellationPolicy,
      observedAt: "2026-08-11T12:31:00.000Z",
    });

    const receipt = await manager.qualify(request);
    expect(receipt).toMatchObject({
      action: "QUALIFY",
      outcome: "APPLIED",
      operationId: request.operationId,
      operationFingerprint,
    });
    await expect(manager.qualify(request)).resolves.toEqual(receipt);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("rejects immutable metadata drift in the hosted candidate", async () => {
    const fixture = portableFixture();
    const hostedCandidate = updater.releaseCandidateSchema.parse({
      ...fixture.candidate,
      licenses: fixture.candidate.licenses.map((license) => ({
        ...license,
        version: "9.9.9",
      })),
    });
    const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
      observe: () => Promise.resolve(exactObservation(fixture.artifact, hostedCandidate)),
    });

    await expect(
      authority.qualify({
        candidate: fixture.candidate,
        artifact: fixture.artifact,
        source: {
          kind: "GITHUB_ACTIONS_RUN",
          repository: "hunterzheng1/hunter-pi",
          runId,
        },
        deadline: "2026-08-11T13:00:00.000Z",
        cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
      }),
    ).rejects.toThrow(/hosted candidate/u);
  });

  it("rejects non-main runs, incomplete job sets, source drift, and hosted byte drift", async () => {
    const fixture = portableFixture();
    const exact = exactObservation(fixture.artifact, fixture.candidate);
    const tamperedArtifact = Buffer.from(fixture.artifact);
    tamperedArtifact[0] = (tamperedArtifact[0] ?? 0) ^ 0xff;
    const observations = [
      { ...exact, run: { ...exact.run, event: "pull_request" } },
      { ...exact, run: { ...exact.run, jobs: exact.run.jobs.slice(1) } },
      { ...exact, run: { ...exact.run, headSha: "d".repeat(40) } },
      { ...exact, hostedArtifact: tamperedArtifact },
    ];

    for (const observation of observations) {
      const authority = new updater.GitHubActionsWindowsPortableQualificationAuthority({
        observe: () => Promise.resolve(observation),
      });
      await expect(
        authority.qualify({
          candidate: fixture.candidate,
          artifact: fixture.artifact,
          source: {
            kind: "GITHUB_ACTIONS_RUN",
            repository: "hunterzheng1/hunter-pi",
            runId,
          },
          deadline: "2026-08-11T13:00:00.000Z",
          cancellationPolicy: { mode: "FAIL_CLOSED", timeoutMs: 30_000 },
        }),
      ).rejects.toThrow();
    }
  });

  it("observes one run snapshot and one hosted artifact download without polling", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-source-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const runGh = vi.fn(async (arguments_: readonly string[], timeoutMs: number) => {
      void timeoutMs;
      if (arguments_[0] === "run" && arguments_[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ...exactObservation(fixture.artifact, fixture.candidate).run,
            databaseId: runId,
            extraIgnoredField: "not retained",
            jobs: requiredJobs.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
              databaseId: 1,
              steps: [],
            })),
          }),
          stderr: "",
        };
      }
      const directory = arguments_[arguments_.indexOf("--dir") + 1];
      if (directory === undefined) throw new Error("fixture download directory missing");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "update.bundle.tgz"), fixture.artifact);
      await writeFile(
        join(directory, "portable-release-candidate.json"),
        JSON.stringify(fixture.candidate),
        "utf8",
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const Constructor = Reflect.get(updater, "GhCliGitHubActionsQualificationObserver");
    expect(Constructor).toEqual(expect.any(Function));
    const Observer = Constructor as new (options: unknown) => {
      observe(input: unknown): Promise<updater.GitHubActionsQualificationObservation>;
    };
    const clockStart = Date.parse("2026-08-11T12:00:00.000Z");
    const observerNow = vi
      .fn<() => number>()
      .mockReturnValue(clockStart + 10_000)
      .mockReturnValueOnce(clockStart)
      .mockReturnValueOnce(clockStart);
    const observer = new Observer({
      temporaryParent: root,
      runGh,
      now: observerNow,
    });

    await expect(
      observer.observe({
        source: {
          kind: "GITHUB_ACTIONS_RUN",
          repository: "hunterzheng1/hunter-pi",
          runId,
        },
        deadline: "2026-08-11T12:01:00.000Z",
        timeoutMs: 30_000,
      }),
    ).resolves.toMatchObject({
      run: { id: runId, jobs: requiredJobs.map((name) => ({ name })) },
      hostedCandidate: { releaseId: fixture.candidate.releaseId },
    });
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(runGh.mock.calls[0]?.[0]).toEqual([
      "run",
      "view",
      String(runId),
      "--repo",
      "hunterzheng1/hunter-pi",
      "--json",
      "attempt,conclusion,databaseId,event,headBranch,headSha,jobs,status,updatedAt,url,workflowName",
    ]);
    expect(runGh.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "run",
        "download",
        String(runId),
        "--repo",
        "hunterzheng1/hunter-pi",
        "--name",
        "hpi-windows-x64-portable",
        "--dir",
      ]),
    );
    expect(runGh.mock.calls.map((call) => call[1])).toEqual([30_000, 20_000]);
  });

  it("rejects a successful download observed after the shared elapsed deadline", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-expired-",
    );
    roots.push(root);
    const fixture = portableFixture();
    const clockStart = Date.parse("2026-08-11T12:00:00.000Z");
    let currentTime = clockStart;
    const runGh = vi.fn(async (arguments_: readonly string[], timeoutMs: number) => {
      void timeoutMs;
      if (arguments_[1] === "view") {
        currentTime += 10_000;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ...exactObservation(fixture.artifact, fixture.candidate).run,
            databaseId: runId,
            jobs: requiredJobs.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
            })),
          }),
          stderr: "",
        };
      }
      const directory = arguments_[arguments_.indexOf("--dir") + 1];
      if (directory === undefined) throw new Error("fixture download directory missing");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "update.bundle.tgz"), fixture.artifact);
      await writeFile(
        join(directory, "portable-release-candidate.json"),
        JSON.stringify(fixture.candidate),
        "utf8",
      );
      currentTime += 20_001;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const observer = new updater.GhCliGitHubActionsQualificationObserver({
      temporaryParent: root,
      runGh,
      now: () => currentTime,
    });

    await expect(
      observer.observe({
        source: {
          kind: "GITHUB_ACTIONS_RUN",
          repository: "hunterzheng1/hunter-pi",
          runId,
        },
        deadline: "2026-08-11T12:01:00.000Z",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/unavailable/u);
    expect(runGh.mock.calls.map((call) => call[1])).toEqual([30_000, 20_000]);
  });

  it("counts platform setup against the qualification process deadline", async () => {
    const identityFingerprint = `sha256:${"a".repeat(64)}` as const;
    const cancel = vi.fn(() => Promise.resolve({ outcome: "ACKNOWLEDGED" as const }));
    const terminalSnapshot = {
      phase: "TERMINAL" as const,
      exitCode: 0,
      terminationCause: "NONE" as const,
      identityState: "MATCH" as const,
      treeState: "EMPTY" as const,
      stdoutState: "CLOSED" as const,
      stderrState: "CLOSED" as const,
      observedAt: fixtureTimestamp,
    };
    const createDriver = vi.fn(() => ({
      start: async () => {
        await delay(25);
        return {
          identityFingerprint,
          containment: "WINDOWS_JOB_OBJECT" as const,
          snapshot: () => Promise.resolve(terminalSnapshot),
          cancel,
          waitForSettlement: () => Promise.resolve(terminalSnapshot),
        };
      },
    }));

    await expect(
      runQualificationCliProcess("must-not-run", [], 10, { createDriver }),
    ).resolves.toEqual({ exitCode: null, stdout: "", stderr: "" });
    expect(createDriver).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(identityFingerprint, "TIMEOUT");
  });

  it("does not expose the internal qualification process runner from the updater package", () => {
    expect(Reflect.has(updater, "runBoundedProcess")).toBe(false);
    expect(Reflect.has(updater, "runQualificationCliProcess")).toBe(false);
  });

  it("hard-stops a detached inherited-pipe descendant after its parent exits", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-github-qualification-timeout-",
    );
    roots.push(root);
    const processIdsPath = join(root, "process-ids.json");
    const overflowTriggerPath = join(root, "overflow.trigger");
    const grandchildSource = [
      'const { existsSync } = require("node:fs");',
      "const insurance = setTimeout(() => process.exit(91), 50000);",
      "const poll = setInterval(() => {",
      "  if (!existsSync(process.argv[1])) return;",
      "  clearInterval(poll);",
      '  process.stdout.write("x".repeat(1_100_000));',
      "}, 25);",
      "void insurance;",
    ].join("\n");
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, process.argv[2]], { detached: true, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });`,
      "writeFileSync(process.argv[1], JSON.stringify([process.pid, grandchild.pid]));",
      "grandchild.unref();",
      "process.exit(0);",
    ].join("\n");
    const startedAt = Date.now();
    const run = runQualificationCliProcess(
      process.execPath,
      ["-e", childSource, processIdsPath, overflowTriggerPath],
      40_000,
    );
    let processIds: number[] | undefined;
    const identityDeadline = Date.now() + 30_000;
    while (processIds === undefined && Date.now() < identityDeadline) {
      try {
        processIds = z
          .array(z.number().int().positive())
          .length(2)
          .parse(JSON.parse(await readFile(processIdsPath, "utf8")) as unknown);
      } catch {
        await delay(25);
      }
    }
    expect(processIds).toBeDefined();
    const [parentProcessId, grandchildProcessId] = processIds ?? [];
    expect(parentProcessId).toBeDefined();
    expect(grandchildProcessId).toBeDefined();

    const isAlive = (processId: number): boolean => {
      try {
        process.kill(processId, 0);
        return true;
      } catch {
        return false;
      }
    };
    const parentExitDeadline = Date.now() + 1_000;
    while (
      parentProcessId !== undefined &&
      isAlive(parentProcessId) &&
      Date.now() < parentExitDeadline
    ) {
      await delay(25);
    }
    expect(parentProcessId === undefined ? true : isAlive(parentProcessId)).toBe(false);
    expect(grandchildProcessId === undefined ? false : isAlive(grandchildProcessId)).toBe(true);

    await writeFile(overflowTriggerPath, "overflow", "utf8");
    await expect(run).resolves.toEqual({ exitCode: null, stdout: "", stderr: "" });
    expect(Date.now() - startedAt).toBeLessThan(45_000);
    for (const processId of processIds ?? []) {
      const processExitDeadline = Date.now() + 2_000;
      while (isAlive(processId) && Date.now() < processExitDeadline) {
        await delay(25);
      }
      expect(isAlive(processId)).toBe(false);
    }
  }, 60_000);

  it("applies one shared byte limit across stdout and stderr", async () => {
    const childSource = [
      'process.stdout.write("o".repeat(700_000));',
      'process.stderr.write("e".repeat(700_000));',
    ].join("\n");

    await expect(
      runQualificationCliProcess(process.execPath, ["-e", childSource], 10_000),
    ).resolves.toEqual({ exitCode: null, stdout: "", stderr: "" });
  });
});
