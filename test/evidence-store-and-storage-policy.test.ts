import { link, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileEmergencyReserve,
  FileEvidenceStore,
  LocalStorageController,
  cachePruneBytes,
  cacheRefuseBytes,
  createPortableEvidenceEnvelope,
  emergencyReserveBytes,
  projectLocalStorageStatus,
  runLogStopBytes,
  runLogWarningBytes,
  type AtomicWriteBoundary,
} from "@hunter-pi/evidence";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createRoot(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-evidence-store-");
  roots.push(root);
  return root;
}

function createEnvelope(content = "bounded evidence") {
  return createPortableEvidenceEnvelope({
    schemaVersion: "1.0.0",
    evidenceId: "evidence_store",
    kind: "observation",
    scope: { runId: "run_store", attemptId: "att_store" },
    createdAt: timestamp,
    sourceFingerprint: fingerprint,
    summary: "A portable Evidence fixture.",
    contentClass: "LOG",
    content,
  });
}

function createRequest(content = "bounded evidence") {
  return {
    schemaVersion: "1.0.0" as const,
    evidenceId: "evidence_store",
    kind: "observation" as const,
    scope: { runId: "run_store", attemptId: "att_store" },
    createdAt: timestamp,
    sourceFingerprint: fingerprint,
    summary: "A portable Evidence fixture.",
    contentClass: "LOG" as const,
    content,
  };
}

describe("immutable FileEvidenceStore and local storage policy", () => {
  it("writes an immutable hash-addressed envelope and returns it after reopen", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });
    const envelope = createEnvelope();

    expect(await store.capture(createRequest())).toEqual(envelope);
    expect(await store.capture(createRequest())).toEqual(envelope);
    const reopened = new FileEvidenceStore({ stateRoot: root, storage });
    expect(await reopened.read("evidence_store")).toEqual(envelope);
    expect(await reopened.listEvidenceIds()).toEqual(["evidence_store"]);
    expect(
      (await readdir(join(root, "evidence", "evidence_store"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  });

  it("rejects conflicting Evidence identity and corrupted immutable content", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });
    await store.capture(createRequest());

    await expect(store.capture(createRequest("different content"))).rejects.toMatchObject({
      code: "IDENTITY_CONFLICT",
    });

    const directory = join(root, "evidence", "evidence_store");
    const [recordName] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    if (recordName === undefined) {
      throw new Error("expected an immutable Evidence record");
    }
    await writeFile(join(directory, recordName), "{}\n", "utf8");
    await expect(store.read("evidence_store")).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("rejects reuse of one Evidence identity for different forbidden content", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });
    const first = {
      ...createRequest("first private fixture"),
      contentClass: "PRIVATE_PROMPT" as const,
    };

    await store.capture(first);
    await expect(
      store.capture({ ...first, content: "second private fixture" }),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
  });

  it("forces new Evidence through the portable redaction boundary", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });
    const fixtureSecret = "sk-fixture-store-secret-123456789";

    const persisted = await store.capture(createRequest(`Authorization: Bearer ${fixtureSecret}`), {
      sensitiveValues: [fixtureSecret],
    });

    expect(JSON.stringify(persisted)).not.toContain(fixtureSecret);
    expect(persisted.redaction.categories).toContain("CREDENTIAL");
    expect("write" in store).toBe(false);
  });

  it("falls back to explicit digest-only retention before noncritical output consumes reserve", async () => {
    const root = await createRoot();
    const reserveBytes = 4_096;
    let probes = 0;
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes,
      capacityProbe: () => Promise.resolve(probes++ === 0 ? 8 : 1_000_000_000),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });

    const persisted = await store.capture(createRequest("content too large for free growth"));

    expect(persisted.capture).toMatchObject({
      retentionStatus: "DIGEST_ONLY",
      capturedBytes: 0,
      truncated: false,
    });
    expect(persisted.capture.capturedText).toBeUndefined();
    expect(persisted.contentHash).toBe(
      createEnvelope("content too large for free growth").contentHash,
    );
    expect(await store.read("evidence_store")).toEqual(persisted);
  });

  it("returns the committed retained record when disk-full is observed after publish", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    let injected = false;
    const store = new FileEvidenceStore({
      stateRoot: root,
      storage,
      faultInjector: (boundary: AtomicWriteBoundary) => {
        if (!injected && boundary === "AFTER_PUBLISH") {
          injected = true;
          const error = new Error("fixture disk full after publish") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
      },
    });

    const persisted = await store.capture(createRequest("committed retained content"));

    expect(persisted.capture.retentionStatus).toBe("RETAINED");
    expect(await store.read("evidence_store")).toEqual(persisted);
    expect(
      (await readdir(join(root, "evidence", "evidence_store"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  });

  it("confirms committed critical Evidence and restores the reserve after publish disk-full", async () => {
    const root = await createRoot();
    const reserveBytes = 4_096;
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    let injected = false;
    const store = new FileEvidenceStore({
      stateRoot: root,
      storage,
      faultInjector: (boundary: AtomicWriteBoundary) => {
        if (!injected && boundary === "AFTER_PUBLISH") {
          injected = true;
          const error = new Error(
            "fixture critical disk full after publish",
          ) as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
      },
    });
    const request = {
      ...createRequest("private critical summary fixture"),
      evidenceId: "evidence_critical-summary",
      kind: "run_summary" as const,
      scope: { runId: "run_store" },
      contentClass: "PRIVATE_PROMPT" as const,
    };

    const persisted = await store.capture(request);

    expect(persisted.capture.retentionStatus).toBe("DIGEST_ONLY");
    expect(await store.read(request.evidenceId)).toEqual(persisted);
    await expect(
      new FileEmergencyReserve({ stateRoot: root, reserveBytes }).status(),
    ).resolves.toMatchObject({ status: "AVAILABLE", availableBytes: reserveBytes });
  });

  it("stops retaining additional noncritical Run content at its configured test boundary", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const content = "x".repeat(2_000);
    const digestEnvelope = createPortableEvidenceEnvelope({
      ...createRequest(content),
      contentClass: "PRIVATE_PROMPT",
    });
    const store = new FileEvidenceStore({
      stateRoot: root,
      storage,
      runNoncriticalStopBytes: Buffer.byteLength(JSON.stringify(digestEnvelope), "utf8") + 100,
    });

    const persisted = await store.capture(createRequest(content));

    expect(persisted.capture.retentionStatus).toBe("DIGEST_ONLY");
    expect(await store.retainedBytesForRun("run_store")).toBe(0);
  });

  it("does not spend the emergency reserve on noncritical digest-only metadata", async () => {
    const root = await createRoot();
    const reserve = new FileEmergencyReserve({ stateRoot: root, reserveBytes: 4_096 });
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(0),
    });
    const store = new FileEvidenceStore({ stateRoot: root, storage });

    await expect(
      store.capture({ ...createRequest("private fixture"), contentClass: "PRIVATE_PROMPT" }),
    ).rejects.toMatchObject({ code: "RESERVE_REQUIRED" });
    expect(await reserve.status()).toMatchObject({ status: "AVAILABLE", availableBytes: 4_096 });
    expect(await store.listEvidenceIds()).toEqual([]);
  });

  it("counts noncritical digest-only records toward the per-Run stop", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    const firstRequest = {
      ...createRequest("private fixture one"),
      evidenceId: "evidence_digest-one",
      contentClass: "PRIVATE_PROMPT" as const,
    };
    const recordBytes = Buffer.byteLength(
      JSON.stringify(createPortableEvidenceEnvelope(firstRequest)),
      "utf8",
    );
    const store = new FileEvidenceStore({
      stateRoot: root,
      storage,
      runNoncriticalStopBytes: recordBytes + 100,
    });

    await expect(store.capture(firstRequest)).resolves.toMatchObject({
      capture: { retentionStatus: "DIGEST_ONLY" },
    });
    await expect(
      store.capture({
        ...firstRequest,
        evidenceId: "evidence_digest-two",
        content: "private fixture two",
      }),
    ).rejects.toMatchObject({ code: "RESERVE_REQUIRED" });
    expect(await store.listEvidenceIds()).toEqual(["evidence_digest-one"]);
  });

  it("fails closed when the Evidence root contains an unknown committed entry", async () => {
    const root = await createRoot();
    await mkdir(join(root, "evidence"), { recursive: true });
    await writeFile(join(root, "evidence", "unexpected.json"), "{}\n", "utf8");
    const store = new FileEvidenceStore({ stateRoot: root });

    await expect(store.listEvidenceIds()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("reports a committed critical write as reserve-required when reserve restoration fails", async () => {
    const root = await createRoot();
    const storage = new LocalStorageController({
      stateRoot: root,
      reserveBytes: 4_096,
      capacityProbe: () => Promise.resolve(1_000_000_000),
    });
    let attempts = 0;

    await expect(
      storage.writeCritical(async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("fixture disk full") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
        await mkdir(join(root, ".critical-reserve"));
      }),
    ).rejects.toMatchObject({ code: "RESERVE_REQUIRED" });
    expect(attempts).toBe(2);
  });

  it("maintains and explicitly releases an emergency reserve file", async () => {
    const root = await createRoot();
    const reserve = new FileEmergencyReserve({ stateRoot: root, reserveBytes: 4_096 });

    await reserve.ensure();
    expect(await reserve.status()).toEqual({
      schemaVersion: "1.0.0",
      requiredBytes: 4_096,
      availableBytes: 4_096,
      status: "AVAILABLE",
    });
    expect((await stat(join(root, ".critical-reserve"))).size).toBe(4_096);

    await reserve.release();
    expect(await reserve.status()).toMatchObject({ availableBytes: 0, status: "RELEASED" });
  });

  it("rejects a same-sized hard-linked reserve as non-reclaimable capacity", async () => {
    const root = await createRoot();
    const reserve = new FileEmergencyReserve({ stateRoot: root, reserveBytes: 4_096 });
    await reserve.ensure();
    await link(join(root, ".critical-reserve"), join(root, "fixture-hardlink"));

    expect(await reserve.status()).toMatchObject({ availableBytes: 0, status: "DEPLETED" });
    await expect(reserve.ensure()).rejects.toMatchObject({ code: "RESERVE_CORRUPT" });
    await expect(reserve.release()).rejects.toMatchObject({ code: "RESERVE_CORRUPT" });
  });

  it("projects the frozen stream, Run, cache, reserve, and mutating-Run limits", () => {
    expect(
      projectLocalStorageStatus({
        runNoncriticalBytes: runLogWarningBytes,
        cacheBytes: cachePruneBytes,
        emergencyReserveAvailableBytes: emergencyReserveBytes,
        atomicWriteReady: true,
      }),
    ).toMatchObject({
      streamLimitBytes: 8 * 1_024 * 1_024,
      run: { status: "WARN" },
      cache: { status: "PRUNE_REQUIRED" },
      emergencyReserve: { status: "AVAILABLE" },
      mutatingRunAllowed: true,
    });

    expect(
      projectLocalStorageStatus({
        runNoncriticalBytes: runLogStopBytes,
        cacheBytes: cacheRefuseBytes,
        emergencyReserveAvailableBytes: emergencyReserveBytes - 1,
        atomicWriteReady: false,
      }),
    ).toMatchObject({
      run: { status: "STOP" },
      cache: { status: "REFUSE_GROWTH" },
      emergencyReserve: { status: "DEPLETED" },
      mutatingRunAllowed: false,
    });
  });
});
