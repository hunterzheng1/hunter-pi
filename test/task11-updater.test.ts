import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DistributionReleaseId } from "@hunter-pi/domain";
import {
  FileUpdateManager,
  ReleaseQualificationRunner,
  releaseCandidateSchema,
  type ReleaseAdapter,
  type ReleaseCandidate,
} from "@hunter-pi/updater";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const artifact = Buffer.from("hunter-pi-qualified-release-fixture\n", "utf8");
const artifactFingerprint = "sha256:" + createHash("sha256").update(artifact).digest("hex");

function candidateFor(
  releaseId: string,
  channel: "STABLE" | "PREVIEW" = "STABLE",
  qualification: "PASS" | "FAIL" | "BLOCKED" | "NOT_PROVEN" = "PASS",
): ReleaseCandidate {
  return releaseCandidateSchema.parse({
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion: "0.2.0",
    channel,
    artifact: {
      reference: "fixture/" + releaseId + ".tgz",
      fingerprint: artifactFingerprint,
      byteLength: artifact.byteLength,
    },
    engine: {
      releaseId: "engine-release_hunter-pi",
      fingerprint: fixtureFingerprint,
      piVersion: "0.83.0",
    },
    qualification: {
      status: qualification,
      verifierFingerprint: fixtureFingerprint,
      checks: [
        {
          name: "clean-install-smoke",
          outcome: qualification,
          evidenceIds: ["evidence_task11-qualification"],
        },
      ],
      qualifiedAt: fixtureTimestamp,
    },
    updatePolicy: {
      piSelfUpdate: "DISABLED",
      unsigned: channel === "PREVIEW",
    },
    licenses: [{ name: "Hunter Pi", version: "0.2.0", license: "MIT", sourceReference: "NOTICE" }],
  });
}

function adapterFor() {
  let activeReleaseId: DistributionReleaseId | undefined;
  let healthShouldFail = false;
  const stage = vi.fn((candidate: ReleaseCandidate) =>
    Promise.resolve({ releaseId: candidate.releaseId }),
  );
  type HealthResult = Awaited<ReturnType<ReleaseAdapter["healthCheck"]>>;
  const healthCheck = vi.fn<() => Promise<HealthResult>>(() =>
    Promise.resolve(
      healthShouldFail ? { status: "FAIL", reason: "fixture unhealthy" } : { status: "PASS" },
    ),
  );
  const migrationRollback = vi.fn(() => Promise.resolve());
  const migrate = vi.fn(() => Promise.resolve({ rollback: migrationRollback }));
  const activate = vi.fn((release: { readonly releaseId: DistributionReleaseId }) => {
    activeReleaseId = release.releaseId;
    return Promise.resolve();
  });
  const restore = vi.fn((release: { readonly releaseId: DistributionReleaseId }) => {
    activeReleaseId = release.releaseId;
    return Promise.resolve();
  });
  const discard = vi.fn(() => Promise.resolve());
  const current = vi.fn(() => Promise.resolve(activeReleaseId));
  const adapter: ReleaseAdapter = {
    current,
    stage,
    healthCheck,
    migrate,
    activate,
    restore,
    discard,
  };
  return {
    adapter,
    current,
    stage,
    healthCheck,
    migrate,
    migrationRollback,
    activate,
    restore,
    failHealth: () => {
      healthShouldFail = true;
    },
    recoverHealth: () => {
      healthShouldFail = false;
    },
    getActive: () => activeReleaseId,
  };
}

describe("Task 11 qualified updater", () => {
  it("rejects private paths and credential-bearing artifact references", () => {
    const candidate = candidateFor("release_task11-private-reference");
    expect(() =>
      releaseCandidateSchema.parse({
        ...candidate,
        artifact: { ...candidate.artifact, reference: "C:\\fixture-private\\release.tgz" },
      }),
    ).toThrow();
    expect(() =>
      releaseCandidateSchema.parse({
        ...candidate,
        licenses: [
          {
            ...candidate.licenses[0],
            sourceReference: "https://fixture-user@example.invalid/license",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a qualification that claims PASS while a declared check failed", () => {
    const candidate = candidateFor("release_task11-forged-qualification");
    expect(() =>
      releaseCandidateSchema.parse({
        ...candidate,
        qualification: {
          ...candidate.qualification,
          status: "PASS",
          checks: [{ ...candidate.qualification.checks[0], outcome: "FAIL" }],
        },
      }),
    ).toThrow(/aggregate/);
  });

  it("does not accept a PASS qualification without bound Evidence", () => {
    const candidate = candidateFor("release_task11-no-evidence");
    expect(() =>
      releaseCandidateSchema.parse({
        ...candidate,
        qualification: {
          ...candidate.qualification,
          checks: candidate.qualification.checks.map((check) => ({ ...check, evidenceIds: [] })),
        },
      }),
    ).toThrow(/Evidence/u);
  });

  it("builds a qualified candidate only from the exact declared check results", async () => {
    const base = candidateFor("release_task11-qualified-runner");
    const { qualification, ...candidate } = base;
    void qualification;
    const runner = new ReleaseQualificationRunner({
      verifierFingerprint: fixtureFingerprint,
      now: () => fixtureTimestamp,
    });

    await expect(
      runner.qualify({
        candidate,
        checks: [
          {
            name: "clean-install-smoke",
            run: () =>
              Promise.resolve({ outcome: "PASS", evidenceIds: ["evidence_task11-runner-clean"] }),
          },
          {
            name: "windows-portable-launch",
            run: () =>
              Promise.resolve({
                outcome: "PASS",
                evidenceIds: ["evidence_task11-runner-portable"],
              }),
          },
        ],
      }),
    ).resolves.toMatchObject({
      releaseId: base.releaseId,
      qualification: {
        status: "PASS",
        verifierFingerprint: fixtureFingerprint,
        qualifiedAt: fixtureTimestamp,
        checks: [
          { name: "clean-install-smoke", outcome: "PASS" },
          { name: "windows-portable-launch", outcome: "PASS" },
        ],
      },
    });

    const unqualified = await runner.qualify({
      candidate,
      checks: [
        {
          name: "clean-install-smoke",
          run: () =>
            Promise.resolve({ outcome: "PASS", evidenceIds: ["evidence_task11-runner-clean"] }),
        },
        {
          name: "ubuntu-ci",
          run: () => Promise.reject(new Error("fixture verifier unavailable")),
        },
      ],
    });
    expect(unqualified.qualification.status).toBe("NOT_PROVEN");
    const failedCheck = unqualified.qualification.checks.find(
      (check) => check.name === "ubuntu-ci",
    );
    expect(failedCheck?.outcome).toBe("NOT_PROVEN");
    expect(failedCheck?.reason).toBe("qualification check failed");
  });

  it("redacts credential material, URLs, and POSIX paths from qualification failure receipts", async () => {
    const runner = new ReleaseQualificationRunner({
      verifierFingerprint: fixtureFingerprint,
      now: () => fixtureTimestamp,
    });
    const candidate = candidateFor("release_task11-qualification-redaction");
    const { qualification, ...baseCandidate } = candidate;
    void qualification;
    const qualified = await runner.qualify({
      candidate: baseCandidate,
      checks: [
        {
          name: "unsafe-verifier",
          run: () =>
            Promise.reject(
              new Error(
                "request failed Authorization: Bearer fixture-token-123456789 Cookie: sid=fixture-cookie\nhttps://user:password@example.invalid/api?token=fixture-query\nAPI_KEY=fixture-api-key ENV_SECRET=fixture-env-secret\n/var/lib/hunter/private.json",
              ),
            ),
        },
      ],
    });
    const reason = qualified.qualification.checks[0]?.reason ?? "";
    expect(reason).toContain("[REDACTED:CREDENTIAL]");
    expect(reason).toContain("[REDACTED:PRIVATE_PATH]");
    expect(reason).not.toMatch(/fixture-token|fixture-cookie|password|fixture-query|\/var\/lib/u);
  });

  it("applies only an exact qualified artifact and records the license inventory", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-update-");
    const { adapter, stage, getActive } = adapterFor();
    const candidate = candidateFor("release_task11-stable");
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });

    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-apply-stable",
        operationFingerprint: fixtureFingerprint,
        candidate,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED", activeReleaseId: candidate.releaseId });
    expect(getActive()).toBe(candidate.releaseId);
    expect(stage).toHaveBeenCalledOnce();
    const history = await manager.history();
    expect(history[0]?.releaseId).toBe(candidate.releaseId);
    expect(history[0]?.licenses[0]?.license).toBe("MIT");
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-apply-stable",
        operationFingerprint: fixtureFingerprint,
        candidate: candidateFor("release_task11-different-request"),
        observedAt: fixtureTimestamp,
      }),
    ).rejects.toThrow(/request|fingerprint/u);
  });

  it("blocks a validly shaped candidate from an untrusted qualification verifier", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-verifier-");
    const { adapter } = adapterFor();
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const candidate = candidateFor("release_task11-unknown-verifier");
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-unknown-verifier",
        operationFingerprint: "sha256:" + "a".repeat(64),
        candidate: {
          ...candidate,
          qualification: {
            ...candidate.qualification,
            verifierFingerprint: "sha256:" + "b".repeat(64),
          },
        },
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED", reason: /unknown verifier/ });
  });

  it("fails closed when activation does not publish the exact candidate and rolls back migration", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-activation-proof-");
    const broken = adapterFor();
    broken.activate.mockImplementationOnce(() => Promise.resolve());
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter: broken.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-activation-proof",
        operationFingerprint: "sha256:" + "9".repeat(64),
        candidate: candidateFor("release_task11-activation-proof"),
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "FAILED", reason: /activation/ });
    expect(broken.migrationRollback).toHaveBeenCalledOnce();
  });

  it("blocks preview, unqualified, self-updating, and digest-mismatched candidates before activation", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-gates-");
    const { adapter, activate } = adapterFor();
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });

    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-preview",
        operationFingerprint: fixtureFingerprint,
        candidate: candidateFor("release_task11-preview", "PREVIEW"),
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-unsigned-stable",
        operationFingerprint: "sha256:" + "e".repeat(64),
        candidate: {
          ...candidateFor("release_task11-unsigned-stable"),
          updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
        },
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED", reason: /unsigned/u });
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-unqualified",
        operationFingerprint: "sha256:" + "b".repeat(64),
        candidate: candidateFor("release_task11-unqualified", "STABLE", "NOT_PROVEN"),
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-self-update",
        operationFingerprint: "sha256:" + "c".repeat(64),
        candidate: {
          ...candidateFor("release_task11-self-update"),
          updatePolicy: { piSelfUpdate: "ENABLED", unsigned: true },
        },
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-bad-digest",
        operationFingerprint: "sha256:" + "d".repeat(64),
        candidate: {
          ...candidateFor("release_task11-bad-digest"),
          artifact: {
            ...candidateFor("release_task11-bad-digest").artifact,
            fingerprint: "sha256:" + "e".repeat(64),
          },
        },
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("recovers failed health checks and rolls back an applied release", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-rollback-");
    const { adapter, failHealth, recoverHealth, getActive } = adapterFor();
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const first = candidateFor("release_task11-first");
    const second = candidateFor("release_task11-second");
    await manager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-first",
      operationFingerprint: fixtureFingerprint,
      candidate: first,
      observedAt: fixtureTimestamp,
    });
    failHealth();
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-second-fail",
        operationFingerprint: "sha256:" + "f".repeat(64),
        candidate: second,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "FAILED", activeReleaseId: first.releaseId });
    expect(getActive()).toBe(first.releaseId);
    recoverHealth();
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-second-success",
        operationFingerprint: `sha256:${"0".repeat(64)}`,
        candidate: second,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED", activeReleaseId: second.releaseId });
    expect(getActive()).toBe(second.releaseId);
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_update-rollback",
        operationFingerprint: "sha256:" + "1".repeat(64),
        targetReleaseId: first.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
      previousReleaseId: second.releaseId,
      activeReleaseId: first.releaseId,
    });
    await expect(manager.current()).resolves.toMatchObject({ releaseId: first.releaseId });
  });

  it("fails closed when rollback activation does not publish the target identity", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-rollback-proof-");
    const broken = adapterFor();
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter: broken.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const first = candidateFor("release_task11-rollback-proof-first");
    const second = candidateFor("release_task11-rollback-proof-second");
    await manager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-rollback-proof-first",
      operationFingerprint: "sha256:" + "6".repeat(64),
      candidate: first,
      observedAt: fixtureTimestamp,
    });
    await manager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-rollback-proof-second",
      operationFingerprint: "sha256:" + "7".repeat(64),
      candidate: second,
      observedAt: fixtureTimestamp,
    });
    broken.restore.mockImplementationOnce(() => Promise.resolve());
    broken.activate.mockImplementationOnce(() => Promise.resolve());

    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_update-rollback-proof",
        operationFingerprint: "sha256:" + "8".repeat(64),
        targetReleaseId: first.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "FAILED", reason: /identity/ });
    await expect(manager.current()).resolves.toMatchObject({ releaseId: second.releaseId });
  });

  it("does not roll back to a candidate that was rejected before activation", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-rollback-rejected-",
    );
    const { adapter, activate, restore } = adapterFor();
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const rejected = candidateFor("release_task11-rejected-rollback", "PREVIEW");

    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_update-rejected-rollback-apply",
        operationFingerprint: "sha256:" + "9".repeat(64),
        candidate: rejected,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });

    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_update-rejected-rollback",
        operationFingerprint: "sha256:" + "a".repeat(64),
        targetReleaseId: rejected.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "BLOCKED" });
    expect(activate).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("redacts adapter-supplied private paths from health failure receipts", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-health-redaction-");
    const fixture = adapterFor();
    fixture.healthCheck.mockResolvedValueOnce({
      status: "FAIL",
      reason:
        "health probe failed at C:\\Users\\fixture-user\\private-state\\health.json\nAuthorization: Bearer fixture-token-123456789\nhttps://user:password@example.invalid/api?token=fixture-query\nAPI_KEY=fixture-api-key ENV_SECRET=fixture-env-secret\n/var/lib/hunter/private.json",
    });
    const manager = new FileUpdateManager({
      stateRoot: join(root, "state"),
      channel: "STABLE",
      adapter: fixture.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });

    const failure = await manager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-health-redaction",
      operationFingerprint: "sha256:" + "5".repeat(64),
      candidate: candidateFor("release_task11-health-redaction"),
      observedAt: fixtureTimestamp,
    });

    expect(failure).toMatchObject({
      outcome: "FAILED",
    });
    expect(failure.reason).toContain("[REDACTED:PRIVATE_PATH]");
    expect(failure.reason).toContain("[REDACTED:CREDENTIAL]");
    expect(failure.reason).not.toMatch(
      /fixture-user|fixture-token|password|fixture-query|\/var\/lib/u,
    );
  });

  it("records a failed recovery fact when artifact or health probing throws", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-update-failure-");
    const artifactManager = new FileUpdateManager({
      stateRoot: join(root, "artifact-state"),
      channel: "STABLE",
      adapter: adapterFor().adapter,
      artifacts: { read: () => Promise.reject(new Error("artifact source unavailable")) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const artifactFailure = await artifactManager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-artifact-unavailable",
      operationFingerprint: fixtureFingerprint,
      candidate: candidateFor("release_task11-artifact-unavailable"),
      observedAt: fixtureTimestamp,
    });
    expect(artifactFailure.outcome).toBe("FAILED");
    expect(artifactFailure.reason).toBe("qualified artifact source failed");

    const health = adapterFor();
    health.healthCheck.mockRejectedValueOnce(new Error("health probe unavailable"));
    const healthManager = new FileUpdateManager({
      stateRoot: join(root, "health-state"),
      channel: "STABLE",
      adapter: health.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const healthFailure = await healthManager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-health-unavailable",
      operationFingerprint: `sha256:${"2".repeat(64)}`,
      candidate: candidateFor("release_task11-health-unavailable"),
      observedAt: fixtureTimestamp,
    });
    expect(healthFailure.outcome).toBe("FAILED");
    expect(healthFailure.reason).toContain("release health check failed");
    expect(health.activate).not.toHaveBeenCalled();

    const migration = adapterFor();
    migration.migrate.mockRejectedValueOnce(new Error("state migration unavailable"));
    const migrationManager = new FileUpdateManager({
      stateRoot: join(root, "migration-state"),
      channel: "STABLE",
      adapter: migration.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const migrationFailure = await migrationManager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-migration-unavailable",
      operationFingerprint: `sha256:${"3".repeat(64)}`,
      candidate: candidateFor("release_task11-migration-unavailable"),
      observedAt: fixtureTimestamp,
    });
    expect(migrationFailure.outcome).toBe("FAILED");
    expect(migrationFailure.reason).toContain("release state migration failed");
    expect(migration.activate).not.toHaveBeenCalled();

    const currentState = adapterFor();
    currentState.current.mockRejectedValueOnce(new Error("current release unavailable"));
    const currentManager = new FileUpdateManager({
      stateRoot: join(root, "current-state"),
      channel: "STABLE",
      adapter: currentState.adapter,
      artifacts: { read: () => Promise.resolve(artifact) },
      qualificationVerifierFingerprint: fixtureFingerprint,
    });
    const currentFailure = await currentManager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_update-current-unavailable",
      operationFingerprint: `sha256:${"4".repeat(64)}`,
      candidate: candidateFor("release_task11-current-unavailable"),
      observedAt: fixtureTimestamp,
    });
    expect(currentFailure.outcome).toBe("FAILED");
    expect(currentFailure.reason).toContain("current release state could not be read");
  });
});
