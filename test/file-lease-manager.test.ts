import { createHash } from "node:crypto";
import { link, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as executionModule from "@hunter-pi/execution";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

interface LeaseManager {
  acquire(request: {
    readonly schemaVersion: "hpi-lease-acquire.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly leaseId: string;
    readonly workspaceId: string;
    readonly ownerFingerprint: string;
    readonly resources: readonly string[];
    readonly ttlMs: number;
  }): Promise<{
    readonly receipt: {
      readonly schemaVersion: "hpi-lease-receipt.v1";
      readonly action: "ACQUIRE";
      readonly outcome: "ACQUIRED" | "BLOCKED";
      readonly leaseId: string;
      readonly workspaceId: string;
      readonly ownerFingerprint: string;
      readonly generation: number;
      readonly resourceSetFingerprint: string;
      readonly resourceCount: number;
      readonly state: "ACTIVE" | "NOT_ACQUIRED";
      readonly expiresAt: string | null;
      readonly reasonCodes: readonly string[];
      readonly observedAt: string;
    };
  }>;
  inspect(leaseId: string): Promise<{
    readonly receipt: {
      readonly schemaVersion: "hpi-lease-status.v1";
      readonly leaseId: string;
      readonly workspaceId: string;
      readonly ownerFingerprint: string;
      readonly generation: number;
      readonly resourceSetFingerprint: string;
      readonly resourceCount: number;
      readonly state: "ACTIVE" | "EXPIRED" | "REVOKED" | "RELEASED";
      readonly expiresAt: string;
      readonly bindingFingerprint: string | null;
      readonly observedAt: string;
    };
  }>;
  renew(request: {
    readonly schemaVersion: "hpi-lease-renew.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly leaseId: string;
    readonly ownerFingerprint: string;
    readonly ttlMs: number;
  }): Promise<{ readonly receipt: LeaseMutationReceipt }>;
  bind(request: {
    readonly schemaVersion: "hpi-lease-bind.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly bindingFingerprint: string;
    readonly leases: readonly {
      readonly leaseId: string;
      readonly ownerFingerprint: string;
    }[];
  }): Promise<{
    readonly receipt: {
      readonly schemaVersion: "hpi-lease-bind-receipt.v1";
      readonly action: "BIND";
      readonly outcome: "BOUND";
      readonly bindingFingerprint: string;
      readonly leaseSetFingerprint: string;
      readonly leaseCount: number;
      readonly observedAt: string;
    };
  }>;
  release(request: {
    readonly schemaVersion: "hpi-lease-release.v1";
    readonly operationId: string;
    readonly operationFingerprint: string;
    readonly leaseId: string;
    readonly ownerFingerprint: string;
    readonly bindingFingerprint: string | null;
  }): Promise<{ readonly receipt: LeaseMutationReceipt }>;
}

interface LeaseMutationReceipt {
  readonly schemaVersion: "hpi-lease-mutation-receipt.v1";
  readonly action: "RENEW" | "RELEASE";
  readonly outcome: "RENEWED" | "RELEASED";
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly ownerFingerprint: string;
  readonly generation: number;
  readonly resourceSetFingerprint: string;
  readonly resourceCount: number;
  readonly state: "ACTIVE" | "RELEASED";
  readonly expiresAt: string;
  readonly bindingFingerprint: string | null;
  readonly reasonCodes: readonly [];
  readonly observedAt: string;
}

type CreateLeaseManager = (options: {
  readonly leaseRoot: string;
  readonly now?: () => string;
  readonly reconcileOwner?: (ownerFingerprint: string) => Promise<"ALIVE" | "DEAD" | "NOT_PROVEN">;
}) => Promise<LeaseManager>;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createLeaseFixture(): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await createTemporaryTestDirectory(tmpdir(), "hpi-t7-lease-");
  cleanupRoots.push(parent);
  const root = join(parent, "lease state 测试");
  await mkdir(root);
  return { parent, root };
}

function requireCreateLeaseManager(): CreateLeaseManager {
  const value: unknown = Reflect.get(executionModule, "createFileLeaseManager");
  expect(value, "createFileLeaseManager must be exported").toBeTypeOf("function");
  return value as CreateLeaseManager;
}

function acquireRequest(options: {
  readonly suffix: string;
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly resources: readonly string[];
}) {
  return {
    schemaVersion: "hpi-lease-acquire.v1" as const,
    operationId: `op_${options.suffix}`,
    operationFingerprint: fingerprint(`operation:${options.suffix}`),
    leaseId: options.leaseId,
    workspaceId: options.workspaceId,
    ownerFingerprint: fingerprint(`owner:${options.owner}`),
    resources: options.resources,
    ttlMs: 60_000,
  };
}

describe("file-backed exclusive lease manager", () => {
  it("rejects workspace and resource conflicts atomically across manager instances", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const managerA = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:00:00.000Z",
    });
    const managerB = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:00:00.000Z",
    });

    const first = await managerA.acquire(
      acquireRequest({
        suffix: "lease-first",
        leaseId: "lease_task7-first",
        workspaceId: "workspace_task7-shared",
        owner: "first",
        resources: ["cache_alpha", "port_alpha"],
      }),
    );
    expect(first.receipt).toMatchObject({
      schemaVersion: "hpi-lease-receipt.v1",
      action: "ACQUIRE",
      outcome: "ACQUIRED",
      leaseId: "lease_task7-first",
      workspaceId: "workspace_task7-shared",
      generation: 1,
      resourceCount: 2,
      state: "ACTIVE",
      reasonCodes: [],
      observedAt: "2026-08-04T09:00:00.000Z",
    });
    expect(first.receipt.resourceSetFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(first.receipt)).not.toContain(fixture.parent);

    const writerConflict = await managerB.acquire(
      acquireRequest({
        suffix: "lease-writer-conflict",
        leaseId: "lease_task7-writer-conflict",
        workspaceId: "workspace_task7-shared",
        owner: "second",
        resources: ["resource_unrelated"],
      }),
    );
    expect(writerConflict.receipt).toMatchObject({
      outcome: "BLOCKED",
      state: "NOT_ACQUIRED",
      generation: 0,
      reasonCodes: ["WORKSPACE_CONFLICT"],
    });

    const resourceConflict = await managerB.acquire(
      acquireRequest({
        suffix: "lease-resource-conflict",
        leaseId: "lease_task7-resource-conflict",
        workspaceId: "workspace_task7-other",
        owner: "second",
        resources: ["cache_alpha", "resource_beta"],
      }),
    );
    expect(resourceConflict.receipt).toMatchObject({
      outcome: "BLOCKED",
      state: "NOT_ACQUIRED",
      generation: 0,
      reasonCodes: ["RESOURCE_CONFLICT"],
    });

    const noPartialAcquisition = await managerB.acquire(
      acquireRequest({
        suffix: "lease-no-partial",
        leaseId: "lease_task7-no-partial",
        workspaceId: "workspace_task7-third",
        owner: "third",
        resources: ["resource_beta"],
      }),
    );
    expect(noPartialAcquisition.receipt).toMatchObject({
      outcome: "ACQUIRED",
      state: "ACTIVE",
      resourceCount: 1,
      reasonCodes: [],
    });
  });

  it("replays an exact durable acquisition but rejects a changed canonical payload", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const originalManager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:05:00.000Z",
    });
    const request = acquireRequest({
      suffix: "lease-replay",
      leaseId: "lease_task7-replay",
      workspaceId: "workspace_task7-replay",
      owner: "replay",
      resources: ["resource_alpha"],
    });
    const original = await originalManager.acquire(request);

    const restartedManager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:06:00.000Z",
    });
    await expect(restartedManager.acquire({ ...request })).resolves.toEqual(original);
    await expect(
      restartedManager.acquire({
        ...request,
        resources: ["resource_changed"],
      }),
    ).rejects.toMatchObject({
      name: "LeaseError",
      code: "LEASE_OPERATION_CONFLICT",
    });
  });

  it("serializes a concurrent writer race so exactly one lease becomes active", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const [managerA, managerB] = await Promise.all([
      createManager({ leaseRoot: fixture.root, now: () => "2026-08-04T09:07:00.000Z" }),
      createManager({ leaseRoot: fixture.root, now: () => "2026-08-04T09:07:00.000Z" }),
    ]);
    const results = await Promise.all([
      managerA.acquire(
        acquireRequest({
          suffix: "lease-race-a",
          leaseId: "lease_task7-race-a",
          workspaceId: "workspace_task7-race",
          owner: "race-a",
          resources: ["resource_race_a"],
        }),
      ),
      managerB.acquire(
        acquireRequest({
          suffix: "lease-race-b",
          leaseId: "lease_task7-race-b",
          workspaceId: "workspace_task7-race",
          owner: "race-b",
          resources: ["resource_race_b"],
        }),
      ),
    ]);

    expect(results.map((result) => result.receipt.outcome).sort()).toEqual(["ACQUIRED", "BLOCKED"]);
    expect(
      results.find((result) => result.receipt.outcome === "BLOCKED")?.receipt.reasonCodes,
    ).toEqual(["WORKSPACE_CONFLICT"]);
  });

  it("does not overwrite an expired owner until liveness is proven dead", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    let now = "2026-08-04T09:10:00.000Z";
    const originalManager = await createManager({ leaseRoot: fixture.root, now: () => now });
    await originalManager.acquire({
      ...acquireRequest({
        suffix: "lease-expiring",
        leaseId: "lease_task7-expiring",
        workspaceId: "workspace_task7-expiry",
        owner: "possibly-live",
        resources: ["resource_expiring"],
      }),
      ttlMs: 1_000,
    });
    now = "2026-08-04T09:10:02.000Z";

    const uncertainManager = await createManager({
      leaseRoot: fixture.root,
      now: () => now,
      reconcileOwner: () => Promise.resolve("NOT_PROVEN"),
    });
    const uncertain = await uncertainManager.acquire(
      acquireRequest({
        suffix: "lease-expired-uncertain",
        leaseId: "lease_task7-expired-uncertain",
        workspaceId: "workspace_task7-expiry",
        owner: "replacement",
        resources: ["resource_new"],
      }),
    );
    expect(uncertain.receipt).toMatchObject({
      outcome: "BLOCKED",
      state: "NOT_ACQUIRED",
      reasonCodes: ["OWNER_LIVENESS_NOT_PROVEN"],
    });
    await expect(uncertainManager.inspect("lease_task7-expiring")).resolves.toMatchObject({
      receipt: { state: "EXPIRED" },
    });

    const deadOwnerManager = await createManager({
      leaseRoot: fixture.root,
      now: () => now,
      reconcileOwner: () => Promise.resolve("DEAD"),
    });
    const replacement = await deadOwnerManager.acquire(
      acquireRequest({
        suffix: "lease-expired-reconciled",
        leaseId: "lease_task7-replacement",
        workspaceId: "workspace_task7-expiry",
        owner: "replacement",
        resources: ["resource_new"],
      }),
    );
    expect(replacement.receipt).toMatchObject({
      outcome: "ACQUIRED",
      state: "ACTIVE",
      reasonCodes: [],
    });
    await expect(deadOwnerManager.inspect("lease_task7-expiring")).resolves.toMatchObject({
      receipt: { state: "REVOKED", generation: 2 },
    });
  });

  it("renews monotonically, rejects a non-owner, and releases exactly once", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    let now = "2026-08-04T09:15:00.000Z";
    const manager = await createManager({ leaseRoot: fixture.root, now: () => now });
    const ownerFingerprint = fingerprint("owner:renew-owner");
    await manager.acquire(
      acquireRequest({
        suffix: "lease-renew-acquire",
        leaseId: "lease_task7-renew",
        workspaceId: "workspace_task7-renew",
        owner: "renew-owner",
        resources: ["resource_renew"],
      }),
    );

    now = "2026-08-04T09:15:01.000Z";
    const renewed = await manager.renew({
      schemaVersion: "hpi-lease-renew.v1",
      operationId: "op_lease-renew",
      operationFingerprint: fingerprint("operation:lease-renew"),
      leaseId: "lease_task7-renew",
      ownerFingerprint,
      ttlMs: 120_000,
    });
    expect(renewed.receipt).toMatchObject({
      schemaVersion: "hpi-lease-mutation-receipt.v1",
      action: "RENEW",
      outcome: "RENEWED",
      generation: 2,
      state: "ACTIVE",
      expiresAt: "2026-08-04T09:17:01.000Z",
      reasonCodes: [],
    });

    now = "2026-08-04T09:15:02.000Z";
    await expect(
      manager.renew({
        schemaVersion: "hpi-lease-renew.v1",
        operationId: "op_lease-renew-nonmonotonic",
        operationFingerprint: fingerprint("operation:lease-renew-nonmonotonic"),
        leaseId: "lease_task7-renew",
        ownerFingerprint,
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "LEASE_RENEWAL_NOT_MONOTONIC" });
    await expect(
      manager.release({
        schemaVersion: "hpi-lease-release.v1",
        operationId: "op_lease-release-wrong-owner",
        operationFingerprint: fingerprint("operation:lease-release-wrong-owner"),
        leaseId: "lease_task7-renew",
        ownerFingerprint: fingerprint("owner:wrong"),
        bindingFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: "LEASE_OWNER_MISMATCH" });

    now = "2026-08-04T09:15:03.000Z";
    const releaseRequest = {
      schemaVersion: "hpi-lease-release.v1" as const,
      operationId: "op_lease-release",
      operationFingerprint: fingerprint("operation:lease-release"),
      leaseId: "lease_task7-renew",
      ownerFingerprint,
      bindingFingerprint: null,
    };
    const released = await manager.release(releaseRequest);
    expect(released.receipt).toMatchObject({
      action: "RELEASE",
      outcome: "RELEASED",
      generation: 3,
      state: "RELEASED",
      expiresAt: "2026-08-04T09:17:01.000Z",
      observedAt: now,
    });
    await expect(manager.inspect("lease_task7-renew")).resolves.toMatchObject({
      receipt: { state: "RELEASED", generation: 3 },
    });

    const restartedManager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:16:00.000Z",
    });
    await expect(restartedManager.release({ ...releaseRequest })).resolves.toEqual(released);
  });

  it("binds a lease set atomically and rejects release or duplicate use without the binding", async () => {
    const fixture = await createLeaseFixture();
    const manager = await requireCreateLeaseManager()({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:18:00.000Z",
    });
    const ownerFingerprint = fingerprint("owner:binding");
    await manager.acquire(
      acquireRequest({
        suffix: "lease-binding-acquire",
        leaseId: "lease_task7-binding",
        workspaceId: "workspace_task7-binding",
        owner: "binding",
        resources: ["resource_binding"],
      }),
    );
    const bindingFingerprint = fingerprint("process-session-binding");
    await expect(
      manager.bind({
        schemaVersion: "hpi-lease-bind.v1",
        operationId: "op_lease-binding",
        operationFingerprint: fingerprint("operation:lease-binding"),
        bindingFingerprint,
        leases: [{ leaseId: "lease_task7-binding", ownerFingerprint }],
      }),
    ).resolves.toMatchObject({
      receipt: {
        action: "BIND",
        outcome: "BOUND",
        bindingFingerprint,
        leaseCount: 1,
      },
    });
    await expect(manager.inspect("lease_task7-binding")).resolves.toMatchObject({
      receipt: { state: "ACTIVE", generation: 2, bindingFingerprint },
    });
    await expect(
      manager.release({
        schemaVersion: "hpi-lease-release.v1",
        operationId: "op_lease-binding-release-unbound",
        operationFingerprint: fingerprint("operation:lease-binding-release-unbound"),
        leaseId: "lease_task7-binding",
        ownerFingerprint,
        bindingFingerprint: null,
      }),
    ).rejects.toMatchObject({ code: "LEASE_BINDING_MISMATCH" });
    await expect(
      manager.bind({
        schemaVersion: "hpi-lease-bind.v1",
        operationId: "op_lease-binding-duplicate",
        operationFingerprint: fingerprint("operation:lease-binding-duplicate"),
        bindingFingerprint: fingerprint("different-process-session"),
        leases: [{ leaseId: "lease_task7-binding", ownerFingerprint }],
      }),
    ).rejects.toMatchObject({ code: "LEASE_ALREADY_BOUND" });
    await expect(
      manager.release({
        schemaVersion: "hpi-lease-release.v1",
        operationId: "op_lease-binding-release",
        operationFingerprint: fingerprint("operation:lease-binding-release"),
        leaseId: "lease_task7-binding",
        ownerFingerprint,
        bindingFingerprint,
      }),
    ).resolves.toMatchObject({
      receipt: { action: "RELEASE", state: "RELEASED", bindingFingerprint: null },
    });
  });

  it("fails closed when the lease clock moves behind committed state", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const manager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:20:00.000Z",
    });
    await manager.acquire(
      acquireRequest({
        suffix: "lease-clock-acquire",
        leaseId: "lease_task7-clock",
        workspaceId: "workspace_task7-clock",
        owner: "clock",
        resources: [],
      }),
    );
    const rollbackManager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:19:59.000Z",
    });
    await expect(
      rollbackManager.renew({
        schemaVersion: "hpi-lease-renew.v1",
        operationId: "op_lease-clock-renew",
        operationFingerprint: fingerprint("operation:lease-clock-renew"),
        leaseId: "lease_task7-clock",
        ownerFingerprint: fingerprint("owner:clock"),
        ttlMs: 120_000,
      }),
    ).rejects.toMatchObject({ code: "CLOCK_ROLLBACK" });
  });

  it("rejects an aliased lease root before reading local state", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const alias = join(fixture.parent, "lease-root-alias");
    await symlink(fixture.root, alias, process.platform === "win32" ? "junction" : "dir");

    await expect(createManager({ leaseRoot: alias })).rejects.toMatchObject({
      name: "LeaseError",
      code: "LEASE_STORE_CORRUPT",
    });
  });

  it("rejects a state-directory alias introduced after manager initialization", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const manager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:23:00.000Z",
    });
    const operationsRoot = join(fixture.root, "transactions");
    const outside = join(fixture.parent, "outside operations");
    await rm(operationsRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, operationsRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(
      manager.acquire(
        acquireRequest({
          suffix: "lease-aliased-state",
          leaseId: "lease_task7-aliased-state",
          workspaceId: "workspace_task7-aliased-state",
          owner: "aliased-state",
          resources: [],
        }),
      ),
    ).rejects.toMatchObject({ name: "LeaseError", code: "LEASE_STORE_CORRUPT" });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("fails closed on a malformed committed transaction and discards a pre-commit crash file", async () => {
    const malformedFixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    await createManager({ leaseRoot: malformedFixture.root });
    await writeFile(
      join(malformedFixture.root, "transactions", "op_lease-malformed.json"),
      "{}\n",
      "utf8",
    );
    await expect(createManager({ leaseRoot: malformedFixture.root })).rejects.toMatchObject({
      name: "LeaseError",
      code: "LEASE_STORE_CORRUPT",
    });

    const partialFixture = await createLeaseFixture();
    await createManager({ leaseRoot: partialFixture.root });
    await writeFile(
      join(partialFixture.root, "transactions", ".pending-fixture"),
      "partial",
      "utf8",
    );
    const partialManager = await createManager({ leaseRoot: partialFixture.root });
    await expect(
      partialManager.acquire(
        acquireRequest({
          suffix: "lease-after-partial",
          leaseId: "lease_task7-after-partial",
          workspaceId: "workspace_task7-after-partial",
          owner: "partial",
          resources: [],
        }),
      ),
    ).resolves.toMatchObject({ receipt: { outcome: "ACQUIRED" } });
    await expect(readdir(join(partialFixture.root, "transactions"))).resolves.not.toContain(
      ".pending-fixture",
    );
  });

  it("rejects a hard-linked committed lease record", async () => {
    const fixture = await createLeaseFixture();
    const createManager = requireCreateLeaseManager();
    const manager = await createManager({
      leaseRoot: fixture.root,
      now: () => "2026-08-04T09:25:00.000Z",
    });
    await manager.acquire(
      acquireRequest({
        suffix: "lease-hardlink-acquire",
        leaseId: "lease_task7-hardlink",
        workspaceId: "workspace_task7-hardlink",
        owner: "hardlink",
        resources: [],
      }),
    );
    await link(
      join(fixture.root, "transactions", "op_lease-hardlink-acquire.json"),
      join(fixture.parent, "aliased-lease-record.json"),
    );
    await expect(createManager({ leaseRoot: fixture.root })).rejects.toMatchObject({
      name: "LeaseError",
      code: "LEASE_STORE_CORRUPT",
    });
  });
});
