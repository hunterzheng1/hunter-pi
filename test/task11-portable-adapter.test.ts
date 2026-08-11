import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileUpdateManager,
  FileWindowsPortableReleaseAdapter,
  createPortableBundle,
  decodePortableBundle,
  releaseCandidateSchema,
  type ReleaseCandidate,
} from "@hunter-pi/updater";
import { sha256Fingerprint } from "@hunter-pi/evidence";

import { fixtureFingerprint, fixtureTimestamp } from "./support/workflow-domain-fixture.js";
import {
  createTemporaryTestDirectory,
  removeTemporaryTestDirectory,
} from "./support/temporary-test-directory.js";

const roots: string[] = [];
const sourceCommit = "a".repeat(40);

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function portableCandidate(releaseId: string): {
  readonly candidate: ReleaseCandidate;
  readonly artifact: Uint8Array;
} {
  const engineReleaseFingerprint = sha256Fingerprint("task11-portable-engine");
  const artifact = createPortableBundle({
    releaseId,
    productVersion: "0.2.0",
    engineReleaseId: "engine-release_pi-0.83.0",
    engineReleaseFingerprint,
    sourceCommit,
    files: [
      { path: "hpi.cmd", bytes: Buffer.from("@echo off\r\n", "utf8") },
      { path: "node.exe", bytes: Buffer.from("portable-node-fixture\n", "utf8") },
      {
        path: "node_modules/@hunter-pi/cli/dist/hpi.js",
        bytes: Buffer.from("console.log('portable-fixture');\n", "utf8"),
      },
    ],
  });
  const candidate = releaseCandidateSchema.parse({
    schemaVersion: "hpi-release-candidate.v1",
    releaseId,
    productVersion: "0.2.0",
    channel: "PREVIEW",
    artifact: {
      reference: `fixture/${releaseId}.bundle.tgz`,
      fingerprint: digest(artifact),
      byteLength: artifact.byteLength,
    },
    engine: {
      releaseId: "engine-release_pi-0.83.0",
      fingerprint: engineReleaseFingerprint,
      piVersion: "0.83.0",
    },
    qualification: {
      status: "PASS",
      verifierFingerprint: fixtureFingerprint,
      checks: [
        {
          name: "windows-portable-launch",
          outcome: "PASS",
          evidenceIds: ["evidence_task11-portable"],
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
  return { candidate, artifact };
}

function managerFor(
  root: string,
  adapter: FileWindowsPortableReleaseAdapter,
  artifacts: ReadonlyMap<string, Uint8Array>,
) {
  return new FileUpdateManager({
    stateRoot: join(root, "manager-state"),
    channel: "PREVIEW",
    adapter,
    artifacts: {
      read: (candidate) => {
        const artifact = artifacts.get(candidate.releaseId);
        if (artifact === undefined) throw new Error("portable fixture artifact missing");
        return Promise.resolve(artifact);
      },
    },
    qualificationVerifierFingerprint: fixtureFingerprint,
    now: () => fixtureTimestamp,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryTestDirectory));
});

describe("Task 11 Windows portable release adapter", () => {
  it("atomically activates version directories, persists migration state, and rolls back", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-portable-");
    roots.push(root);
    const first = portableCandidate("release_task11-portable-first");
    const second = portableCandidate("release_task11-portable-second");
    const artifacts = new Map([
      [first.candidate.releaseId, first.artifact],
      [second.candidate.releaseId, second.artifact],
    ]);
    const mutableState = join(root, "user-state");
    await mkdir(mutableState, { recursive: true });
    await writeFile(join(mutableState, "settings.json"), "before-first\n", "utf8");
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      mutableStateDirectory: mutableState,
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = managerFor(root, adapter, artifacts);

    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_task11-portable-first",
        operationFingerprint: sha256Fingerprint("portable-first"),
        candidate: first.candidate,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED", activeReleaseId: first.candidate.releaseId });
    await writeFile(join(mutableState, "settings.json"), "before-second\n", "utf8");
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_task11-portable-second",
        operationFingerprint: sha256Fingerprint("portable-second"),
        candidate: second.candidate,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED", activeReleaseId: second.candidate.releaseId });
    expect(await readFile(join(mutableState, "settings.json"), "utf8")).toBe("before-second\n");
    expect(
      await readFile(join(root, "portable", ".hpi-update", "migration.json"), "utf8"),
    ).toContain('"status":"COMMITTED"');

    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-portable-rollback",
        operationFingerprint: sha256Fingerprint("portable-rollback"),
        targetReleaseId: first.candidate.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
      previousReleaseId: second.candidate.releaseId,
      activeReleaseId: first.candidate.releaseId,
    });
    await expect(manager.current()).resolves.toMatchObject({
      releaseId: first.candidate.releaseId,
    });
    await expect(manager.history()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ releaseId: first.candidate.releaseId }),
        expect.objectContaining({ releaseId: second.candidate.releaseId }),
      ]),
    );
  });

  it("rolls back to a qualified portable release installed before the update journal existed", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-portable-initial-rollback-",
    );
    roots.push(root);
    const initial = portableCandidate("release_task11-portable-initial");
    const update = portableCandidate("release_task11-portable-update");
    const artifacts = new Map([
      [initial.candidate.releaseId, initial.artifact],
      [update.candidate.releaseId, update.artifact],
    ]);
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });

    const installed = await adapter.stage(initial.candidate, initial.artifact);
    await adapter.activate(installed);
    const manager = managerFor(root, adapter, artifacts);
    await expect(
      manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: "op_task11-portable-initial-update",
        operationFingerprint: sha256Fingerprint("portable-initial-update"),
        candidate: update.candidate,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "APPLIED", activeReleaseId: update.candidate.releaseId });

    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-portable-initial-rollback",
        operationFingerprint: sha256Fingerprint("portable-initial-rollback"),
        targetReleaseId: initial.candidate.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      outcome: "APPLIED",
      previousReleaseId: update.candidate.releaseId,
      activeReleaseId: initial.candidate.releaseId,
    });
    await expect(manager.current()).resolves.toMatchObject({
      releaseId: initial.candidate.releaseId,
    });
  });

  it("does not treat a qualified release that was only staged as the initial rollback target", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-portable-staged-only-",
    );
    roots.push(root);
    const active = portableCandidate("release_task11-portable-active");
    const stagedOnly = portableCandidate("release_task11-portable-staged-only");
    const artifacts = new Map([
      [active.candidate.releaseId, active.artifact],
      [stagedOnly.candidate.releaseId, stagedOnly.artifact],
    ]);
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = managerFor(root, adapter, artifacts);
    await manager.apply({
      schemaVersion: "hpi-update-apply.v1",
      operationId: "op_task11-portable-active",
      operationFingerprint: sha256Fingerprint("portable-active"),
      candidate: active.candidate,
      observedAt: fixtureTimestamp,
    });
    await adapter.stage(stagedOnly.candidate, stagedOnly.artifact);

    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-portable-staged-only-rollback",
        operationFingerprint: sha256Fingerprint("portable-staged-only-rollback"),
        targetReleaseId: stagedOnly.candidate.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({
      outcome: "BLOCKED",
      activeReleaseId: active.candidate.releaseId,
    });
    await expect(manager.current()).resolves.toMatchObject({
      releaseId: active.candidate.releaseId,
    });
  });

  it("re-verifies rollback bytes and refuses a tampered known release", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task11-portable-tamper-");
    roots.push(root);
    const first = portableCandidate("release_task11-portable-tamper-first");
    const second = portableCandidate("release_task11-portable-tamper-second");
    const artifacts = new Map([
      [first.candidate.releaseId, first.artifact],
      [second.candidate.releaseId, second.artifact],
    ]);
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = managerFor(root, adapter, artifacts);
    for (const [index, candidate] of [first.candidate, second.candidate].entries()) {
      await manager.apply({
        schemaVersion: "hpi-update-apply.v1",
        operationId: `op_task11-tamper-apply-${String(index)}`,
        operationFingerprint: sha256Fingerprint(`tamper-apply-${String(index)}`),
        candidate,
        observedAt: fixtureTimestamp,
      });
    }
    await writeFile(
      join(root, "portable", "versions", first.candidate.releaseId, ".hpi-artifact"),
      Buffer.from("tampered\n", "utf8"),
    );
    await expect(
      manager.rollback({
        schemaVersion: "hpi-update-rollback.v1",
        operationId: "op_task11-portable-tamper-rollback",
        operationFingerprint: sha256Fingerprint("tamper-rollback"),
        targetReleaseId: first.candidate.releaseId,
        observedAt: fixtureTimestamp,
      }),
    ).resolves.toMatchObject({ outcome: "FAILED", previousReleaseId: second.candidate.releaseId });
    await expect(manager.current()).resolves.toMatchObject({
      releaseId: second.candidate.releaseId,
    });
  });

  it("reconciles an activation that published before the journal was appended", async () => {
    const root = await createTemporaryTestDirectory(
      tmpdir(),
      "hunter-pi-task11-portable-recovery-",
    );
    roots.push(root);
    const first = portableCandidate("release_task11-portable-recovery");
    let interrupt = true;
    const adapter = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
      afterActivePointerPublished: () => {
        if (interrupt) {
          interrupt = false;
          return Promise.reject(new Error("injected interruption after active pointer publish"));
        }
        return Promise.resolve();
      },
    });
    const staged = await adapter.stage(first.candidate, first.artifact);
    await expect(adapter.activate(staged)).rejects.toThrow(/interruption/u);

    const reopened = new FileWindowsPortableReleaseAdapter({
      installationRoot: join(root, "portable"),
      targetPlatform: "win32-x64",
      healthCheck: () => Promise.resolve({ status: "PASS" }),
    });
    const manager = managerFor(
      root,
      reopened,
      new Map([[first.candidate.releaseId, first.artifact]]),
    );
    await expect(manager.reconcile()).resolves.toEqual([
      expect.objectContaining({
        outcome: "APPLIED",
        candidateReleaseId: first.candidate.releaseId,
      }),
    ]);
    await expect(manager.current()).resolves.toMatchObject({
      releaseId: first.candidate.releaseId,
    });
    await expect(manager.history()).resolves.toEqual([
      expect.objectContaining({ releaseId: first.candidate.releaseId }),
    ]);
  });

  it("round-trips a strict portable bundle and rejects archive path traversal", () => {
    const longPath = `node_modules/${"nested/".repeat(45)}asset.txt`;
    const bytes = createPortableBundle({
      releaseId: "release_task11-portable-bundle",
      productVersion: "0.2.0",
      engineReleaseId: "engine-release_pi-0.83.0",
      engineReleaseFingerprint: sha256Fingerprint("bundle-engine"),
      sourceCommit,
      files: [
        { path: "hpi.cmd", bytes: Buffer.from("@echo off\r\n", "utf8") },
        { path: longPath, bytes: Buffer.from("long-path\n", "utf8") },
      ],
    });
    const parsed = decodePortableBundle(bytes);
    expect(parsed.manifest.releaseId).toBe("release_task11-portable-bundle");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]?.path).toBe("hpi.cmd");
    expect(Buffer.from(parsed.files[0]?.bytes ?? []).toString("utf8")).toBe("@echo off\r\n");
    expect(Buffer.from(parsed.files.find((file) => file.path === longPath)?.bytes ?? [])).toEqual(
      Buffer.from("long-path\n", "utf8"),
    );
    expect(() =>
      createPortableBundle({
        releaseId: "release_task11-portable-invalid-path",
        productVersion: "0.2.0",
        engineReleaseId: "engine-release_pi-0.83.0",
        engineReleaseFingerprint: sha256Fingerprint("bundle-engine"),
        sourceCommit,
        files: [{ path: "../escape", bytes: Buffer.from("no\n", "utf8") }],
      }),
    ).toThrow(/portable bundle path/u);
  });
});
