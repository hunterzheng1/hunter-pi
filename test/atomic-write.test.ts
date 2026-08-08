import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { withDurableMutationLock, writeImmutableAtomically } from "@hunter-pi/evidence";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const roots: string[] = [];
const childProcesses = new Set<ChildProcessWithoutNullStreams>();
const childCompletions = new Map<ChildProcessWithoutNullStreams, Promise<FixtureCompletion>>();
const fixtureSource = fileURLToPath(
  new URL("./support/durable-mutation-lock-child.ts", import.meta.url),
);
let fixtureRoot: string;
let fixtureBundle: string;

interface FixtureCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface LockFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<FixtureCompletion>;
  readonly pid: number;
  output(): string;
}

beforeAll(async () => {
  fixtureRoot = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-lock-fixture-");
  fixtureBundle = join(fixtureRoot, "durable-mutation-lock-child.mjs");
  await build({
    alias: {
      "@hunter-pi/domain": fileURLToPath(
        new URL("../packages/domain/src/index.ts", import.meta.url),
      ),
    },
    bundle: true,
    entryPoints: [fixtureSource],
    format: "esm",
    logLevel: "silent",
    outfile: fixtureBundle,
    platform: "node",
    target: "node24",
  });
});

afterEach(async () => {
  const completions: Promise<FixtureCompletion>[] = [];
  for (const child of childProcesses) {
    const completion = childCompletions.get(child);
    if (completion !== undefined) completions.push(completion);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.allSettled(completions);
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

function startLockFixture(
  lockPath: string,
  mode: "EXIT_WHILE_HELD" | "HOLD_FOR_MS" | "WAIT_FOR_INPUT",
  holdMs = 0,
  extraEnvironment: Readonly<NodeJS.ProcessEnv> = {},
): LockFixture {
  const child = spawn(process.execPath, [fixtureBundle], {
    env: {
      ...process.env,
      ...extraEnvironment,
      HPI_TEST_LOCK_MODE: mode,
      HPI_TEST_LOCK_PATH: lockPath,
      HPI_TEST_LOCK_HOLD_MS: holdMs.toString(),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error("lock fixture did not receive a process id");
  childProcesses.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<FixtureCompletion>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      childProcesses.delete(child);
      childCompletions.delete(child);
      resolvePromise({ code, signal, stderr, stdout });
    });
  });
  childCompletions.set(child, completion);
  return { child, completion, pid: child.pid, output: () => stdout };
}

async function waitForFixtureOutput(fixture: LockFixture, marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fixture.output().includes(marker)) {
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
      const result = await fixture.completion;
      throw new Error(`lock fixture exited before ${marker}: ${result.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`lock fixture did not emit ${marker}`);
    await delay(10);
  }
}

async function forceKill(fixture: LockFixture): Promise<FixtureCompletion> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGKILL");
  }
  return fixture.completion;
}

async function createRoot(prefix = "hunter-pi-mutation-lock-"): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), prefix);
  roots.push(root);
  return root;
}

async function readReconciliationReceipts(lockPath: string): Promise<readonly string[]> {
  const directory = join(dirname(lockPath), ".pending-hpi-mutation-lock-metadata", "receipts");
  let filenames: readonly string[];
  try {
    filenames = (await readdir(directory)).filter((filename) => filename.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(filenames.map((filename) => readFile(join(directory, filename), "utf8")));
}

async function readClaimRecoveryReceipts(lockPath: string): Promise<readonly string[]> {
  const directory = join(
    dirname(lockPath),
    ".pending-hpi-mutation-lock-metadata",
    "claim-receipts",
  );
  try {
    const filenames = (await readdir(directory))
      .filter((filename) => filename.endsWith(".json"))
      .sort();
    return await Promise.all(
      filenames.map((filename) => readFile(join(directory, filename), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("atomic durable write target containment", () => {
  it.each(["../escaped.txt", "..\\escaped.txt"])(
    "rejects an escaping filename %s before touching the target",
    async (filename) => {
      const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-atomic-target-");
      roots.push(root);
      const directory = join(root, "state");
      const escaped = join(root, "escaped.txt");

      await expect(
        writeImmutableAtomically({ directory, filename, content: "must not escape" }),
      ).rejects.toMatchObject({ code: "INVALID_TARGET" });
      await expect(access(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("never replaces an existing immutable target", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-atomic-immutable-");
    roots.push(root);
    const directory = join(root, "state");

    await writeImmutableAtomically({ directory, filename: "record.json", content: "first" });
    await expect(
      writeImmutableAtomically({ directory, filename: "record.json", content: "second" }),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFLICT" });
    await expect(readFile(join(directory, "record.json"), "utf8")).resolves.toBe("first");
  });
});

describe("durable mutation-lock recovery", () => {
  it("publishes a complete owner record atomically before running the operation", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "WAIT_FOR_INPUT");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');

    const ownerStats = await lstat(lockPath);
    const ownerRecord = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;

    expect(ownerStats.isFile()).toBe(true);
    expect(Object.keys(ownerRecord).sort()).toEqual([
      "acquiredAt",
      "lockId",
      "ownerLivenessId",
      "ownerPid",
      "ownerPublicKey",
      "schemaVersion",
    ]);
    expect(ownerRecord).toMatchObject({
      schemaVersion: "hpi-durable-mutation-lock-owner.v2",
      ownerPid: owner.pid,
    });
    owner.child.stdin.end("release\n");
    await expect(owner.completion).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("never steals from a live owner, even when its acquisition timestamp is old", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "WAIT_FOR_INPUT");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    const ownerRecord = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    await rm(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify({ ...ownerRecord, acquiredAt: "1970-01-01T00:00:00.000Z" })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    let entered = false;

    await expect(
      withDurableMutationLock(lockPath, () => {
        entered = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: "STORE_BUSY" });
    expect(entered).toBe(false);
    expect(owner.child.exitCode).toBeNull();
    expect(await readReconciliationReceipts(lockPath)).toEqual([]);
    owner.child.stdin.end("release\n");
    await expect(owner.completion).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("reclaims a lock only after its exact signed owner endpoint no longer exists", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    await expect(owner.completion).resolves.toMatchObject({ code: 73 });

    await expect(
      withDurableMutationLock(lockPath, () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
    expect(await readReconciliationReceipts(lockPath)).toHaveLength(1);
  });

  it("lets a new process recover without manual state deletion after a forced owner kill", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "WAIT_FOR_INPUT");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    await forceKill(owner);

    const successor = startLockFixture(lockPath, "HOLD_FOR_MS", 20);
    await waitForFixtureOutput(successor, '"event":"LOCKED"');
    await expect(successor.completion).resolves.toMatchObject({ code: 0, signal: null });
    expect(await readReconciliationReceipts(lockPath)).toHaveLength(1);
  });

  it("recovers when an unrelated live process has reused the dead owner's PID", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    const deadOwnerRecord = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    await owner.completion;
    await rm(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify({ ...deadOwnerRecord, ownerPid: process.pid })}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );

    await expect(
      withDurableMutationLock(lockPath, () => Promise.resolve("recovered")),
    ).resolves.toBe("recovered");
    expect(await readReconciliationReceipts(lockPath)).toHaveLength(1);
  });

  it.each([
    "AFTER_RECONCILIATION_CLAIM_PUBLISH",
    "AFTER_RECONCILIATION_RECEIPT_PUBLISH",
    "AFTER_STALE_OWNER_REMOVE",
  ])("recovers when the elected stale-owner reconciler is force-killed at %s", async (boundary) => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    await owner.completion;

    const interrupted = startLockFixture(lockPath, "HOLD_FOR_MS", 20, {
      HPI_TEST_RECONCILIATION_PAUSE: boundary,
    });
    await waitForFixtureOutput(interrupted, '"event":"RECONCILIATION_PAUSED"');
    const metadataRoot = join(root, ".pending-hpi-mutation-lock-metadata");
    const [claimFilename] = (await readdir(metadataRoot)).filter((filename) =>
      filename.startsWith("active-claim-"),
    );
    expect(claimFilename).toBeDefined();
    const claim = JSON.parse(
      await readFile(join(metadataRoot, claimFilename ?? "missing-claim"), "utf8"),
    ) as Record<string, unknown>;
    await delay(10);
    await forceKill(interrupted);

    const successor = startLockFixture(lockPath, "HOLD_FOR_MS", 20);
    await waitForFixtureOutput(successor, '"event":"LOCKED"');
    await expect(successor.completion).resolves.toMatchObject({ code: 0, signal: null });
    const claimRecoveryReceipts = await readClaimRecoveryReceipts(lockPath);
    expect(claimRecoveryReceipts).toHaveLength(1);
    const claimRecovery = JSON.parse(claimRecoveryReceipts[0] ?? "") as Record<string, unknown>;
    expect(claimRecovery).toMatchObject({
      schemaVersion: "hpi-durable-mutation-lock-claim-recovery-receipt.v2",
      claimObservedAt: claim["observedAt"],
      outcome: "RECONCILER_PROCESS_NOT_FOUND",
    });
    expect(Date.parse(String(claimRecovery["observedAt"]))).toBeGreaterThan(
      Date.parse(String(claimRecovery["claimObservedAt"])),
    );
    expect(await readReconciliationReceipts(lockPath)).toHaveLength(1);
  });

  it.runIf(process.platform === "win32")(
    "elects one reconciler for Windows path aliases of the same physical lock",
    async () => {
      const root = await createRoot();
      const lockPath = join(root, ".mutation-lock");
      const aliasPath = join(root.toUpperCase(), ".MUTATION-LOCK");
      const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
      await waitForFixtureOutput(owner, '"event":"LOCKED"');
      await owner.completion;

      const first = startLockFixture(lockPath, "HOLD_FOR_MS", 20, {
        HPI_TEST_RECONCILIATION_PAUSE: "AFTER_RECONCILIATION_CLAIM_PUBLISH",
      });
      await waitForFixtureOutput(first, '"event":"RECONCILIATION_PAUSED"');
      const second = startLockFixture(aliasPath, "HOLD_FOR_MS", 20, {
        HPI_TEST_RECONCILIATION_PAUSE: "AFTER_RECONCILIATION_CLAIM_PUBLISH",
      });
      await delay(500);

      const metadataRoot = join(root, ".pending-hpi-mutation-lock-metadata");
      const activeClaims = (await readdir(metadataRoot)).filter((filename) =>
        filename.startsWith("active-claim-"),
      );
      expect(activeClaims).toHaveLength(1);
      await Promise.all([forceKill(first), forceKill(second)]);
    },
  );

  it("elects only one reconciler when contenders observe the same dead owner", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    await owner.completion;

    const first = startLockFixture(lockPath, "HOLD_FOR_MS", 100);
    const second = startLockFixture(lockPath, "HOLD_FOR_MS", 100);
    const results = await Promise.all([first.completion, second.completion]);

    expect(results).toEqual([
      expect.objectContaining({ code: 0, signal: null }),
      expect.objectContaining({ code: 0, signal: null }),
    ]);
    const receipts = await readReconciliationReceipts(lockPath);
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(receipts[0] ?? "") as Record<string, unknown>;
    expect([first.pid, second.pid]).toContain(receipt["reconcilerPid"]);
    const metadataRoot = join(root, ".pending-hpi-mutation-lock-metadata");
    expect(
      (await readdir(metadataRoot)).filter(
        (filename) =>
          filename.startsWith("claim-") ||
          filename.startsWith("owner-") ||
          filename.startsWith("active-claim-"),
      ),
    ).toEqual([]);
  });

  it("replays the exact immutable receipt for the same dead owner record", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    const deadOwnerRecord = await readFile(lockPath, "utf8");
    await owner.completion;

    await withDurableMutationLock(lockPath, () => Promise.resolve());
    const receiptDirectory = join(root, ".pending-hpi-mutation-lock-metadata", "receipts");
    const [receiptFilename] = await readdir(receiptDirectory);
    if (receiptFilename === undefined) throw new Error("expected a reconciliation receipt");
    const receiptPath = join(receiptDirectory, receiptFilename);
    const firstReceipt = await readFile(receiptPath, "utf8");
    const firstStats = await stat(receiptPath);
    await writeFile(lockPath, deadOwnerRecord, { flag: "wx", mode: 0o600 });

    await withDurableMutationLock(lockPath, () => Promise.resolve());

    expect(await readFile(receiptPath, "utf8")).toBe(firstReceipt);
    expect((await stat(receiptPath)).mtimeMs).toBe(firstStats.mtimeMs);
    expect(await readReconciliationReceipts(lockPath)).toEqual([firstReceipt]);
  });

  it("rejects tampering with reconciler facts even when the dead-owner identity is unchanged", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD");
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    const deadOwnerRecord = await readFile(lockPath, "utf8");
    await owner.completion;
    await withDurableMutationLock(lockPath, () => Promise.resolve());
    const receiptDirectory = join(root, ".pending-hpi-mutation-lock-metadata", "receipts");
    const [receiptFilename] = await readdir(receiptDirectory);
    if (receiptFilename === undefined) throw new Error("expected a reconciliation receipt");
    const receiptPath = join(receiptDirectory, receiptFilename);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, reconcilerPid: Number(receipt["reconcilerPid"]) + 1 })}\n`,
    );
    await writeFile(lockPath, deadOwnerRecord, { flag: "wx", mode: 0o600 });

    await expect(withDurableMutationLock(lockPath, () => Promise.resolve())).rejects.toMatchObject({
      code: "STORE_CORRUPT",
    });
  });

  it("keeps owner and reconciliation records free of paths and credentials", async () => {
    const credential = "super-secret-value";
    const root = await createRoot("hunter-pi-token-super-secret-value-");
    const lockPath = join(root, ".mutation-lock");
    const owner = startLockFixture(lockPath, "EXIT_WHILE_HELD", 0, {
      HPI_TEST_CREDENTIAL: `token=${credential}`,
    });
    await waitForFixtureOutput(owner, '"event":"LOCKED"');
    const ownerRecord = await readFile(lockPath, "utf8");
    await owner.completion;
    await withDurableMutationLock(lockPath, () => Promise.resolve());
    const [receipt = ""] = await readReconciliationReceipts(lockPath);

    for (const record of [ownerRecord, receipt]) {
      expect(record).not.toContain(root);
      expect(record).not.toContain(credential);
      expect(record).not.toMatch(/[\\/]/u);
      expect(record.toLowerCase()).not.toContain("token=");
    }
  });

  it("does not delete a different owner record installed before normal release", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    let foreignRecord = "";

    await expect(
      withDurableMutationLock(lockPath, async () => {
        const ownerRecord = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        foreignRecord = `${JSON.stringify({ ...ownerRecord, lockId: randomUUID() })}\n`;
        await rm(lockPath);
        await writeFile(lockPath, foreignRecord, { flag: "wx", mode: 0o600 });
        return "completed";
      }),
    ).resolves.toBe("completed");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(foreignRecord);
  });

  it.each(["", "{}\n", "not-json\n"])(
    "fails closed without deleting an ownerless or malformed legacy lock %#",
    async (content) => {
      const root = await createRoot();
      const lockPath = join(root, ".mutation-lock");
      await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });

      await expect(
        withDurableMutationLock(lockPath, () => Promise.resolve()),
      ).rejects.toMatchObject({
        code: "STORE_BUSY",
      });
      await expect(readFile(lockPath, "utf8")).resolves.toBe(content);
    },
  );

  it("fails closed without deleting an ownerless legacy lock directory", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".mutation-lock");
    await mkdir(lockPath);

    await expect(withDurableMutationLock(lockPath, () => Promise.resolve())).rejects.toMatchObject({
      code: "STORE_BUSY",
    });
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  });
});
