import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptIdSchema,
  observationIdSchema,
  managedChangeSchema,
  planRevisionSchema,
  runSchema,
} from "@hunter-pi/domain";
import {
  DurableStoreError,
  FileWorkflowEventStore,
  LocalStorageController,
  type AtomicWriteBoundary,
} from "@hunter-pi/evidence";
import {
  InMemoryWorkflowKernel,
  workflowEventSchema,
  type WorkflowEvent,
} from "@hunter-pi/workflow-kernel";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const timestamp = "2026-08-03T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createRoot(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-event-store-");
  roots.push(root);
  return root;
}

function createStorage(root: string): LocalStorageController {
  return new LocalStorageController({
    stateRoot: root,
    reserveBytes: 4_096,
    capacityProbe: () => Promise.resolve(1_000_000_000),
  });
}

type RunCreatedEvent = Extract<WorkflowEvent, { type: "RUN_CREATED" }>;
type AttemptStartedEvent = Extract<WorkflowEvent, { type: "ATTEMPT_STARTED" }>;

async function createEvents(): Promise<readonly [RunCreatedEvent, AttemptStartedEvent]> {
  const change = managedChangeSchema.parse({
    schemaVersion: "1.0.0",
    changeId: "chg_durable",
    title: "Exercise durable replay",
    goal: "Persist exact workflow facts",
    nonGoals: ["Run a real Agent"],
    constraints: ["Preserve prior facts"],
    lifecycle: "PLANNED",
    createdAt: timestamp,
  });
  const planRevision = planRevisionSchema.parse({
    schemaVersion: "1.0.0",
    planRevisionId: "plan_durable",
    changeId: change.changeId,
    revision: 1,
    workspaceId: "workspace_durable",
    workspaceFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    goal: change.goal,
    nonGoals: change.nonGoals,
    constraints: change.constraints,
    steps: [
      {
        stepId: "step_durable",
        kind: "agent",
        title: "Return a durable fact",
        dependsOn: [],
        required: true,
        inputContractFingerprint: fingerprint,
        outputContractFingerprint: fingerprint,
      },
    ],
    checks: [
      {
        checkId: "check_durable",
        version: 1,
        label: "Durable fixture",
        kind: "command",
        required: true,
        definition: {
          executable: "npm",
          argv: ["test"],
          workingDirectoryReference: "workspace-root",
        },
        definitionFingerprint: fingerprint,
        configurationFingerprint: fingerprint,
      },
    ],
    loopPolicy: {
      maxIterations: 2,
      maxElapsedMs: 60_000,
      repeatedFailureLimit: 2,
      resourceBudgets: { maxExternalOperations: 4 },
      stopOnUserInput: true,
      stopOnWorkspaceDrift: true,
    },
    createdAt: timestamp,
  });
  const run = runSchema.parse({
    schemaVersion: "1.0.0",
    runId: "run_durable",
    changeId: change.changeId,
    planRevisionId: planRevision.planRevisionId,
    workspaceId: planRevision.workspaceId,
    workspaceFingerprint: fingerprint,
    sourceFingerprint: fingerprint,
    lifecycle: "PLANNED",
    archiveStatus: "UNARCHIVED",
    startedAt: timestamp,
  });
  const kernel = new InMemoryWorkflowKernel();
  const created = await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "CREATE_RUN",
    change,
    planRevision,
    run,
  });
  const started = await kernel.dispatch({
    schemaVersion: "1.0.0",
    type: "START_ATTEMPT",
    runId: run.runId,
    attemptId: attemptIdSchema.parse("att_durable"),
    startedAt: timestamp,
  });
  const createdEvent = workflowEventSchema.parse(created.events[0]);
  const startedEvent = workflowEventSchema.parse(started.events[0]);
  if (createdEvent.type !== "RUN_CREATED" || startedEvent.type !== "ATTEMPT_STARTED") {
    throw new Error("fixture Kernel returned unexpected events");
  }
  return [createdEvent, startedEvent];
}

describe("append-only FileWorkflowEventStore", () => {
  it("persists immutable hash-chained segments and replays them from a new instance", async () => {
    const root = await createRoot();
    const [created, started] = await createEvents();
    const store = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });

    const first = await store.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    });
    const second = await store.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 1,
      events: [started],
    });
    const reopened = new FileWorkflowEventStore({
      stateRoot: root,
      storage: createStorage(root),
    });

    expect(first).toMatchObject({ outcome: "APPLIED", startCursor: 1, endCursor: 1 });
    expect(second).toMatchObject({ outcome: "APPLIED", startCursor: 2, endCursor: 2 });
    expect(await reopened.read("run_durable")).toEqual([created, started]);
    expect(await reopened.listRunIds()).toEqual(["run_durable"]);
    expect(
      (await readdir(join(root, "events", "run_durable"))).filter((name) => name.endsWith(".json")),
    ).toHaveLength(2);
  });

  it("returns NOOP for an exact append replay and rejects a cursor payload conflict", async () => {
    const root = await createRoot();
    const [created] = await createEvents();
    const store = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    const request = {
      schemaVersion: "1.0.0" as const,
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    };

    await store.append(request);
    expect(await store.append(request)).toMatchObject({ outcome: "NOOP" });
    await expect(store.append({ ...request, expectedCursor: 99 })).rejects.toMatchObject({
      code: "CURSOR_CONFLICT",
    });
    await expect(
      store.append({
        ...request,
        events: [
          workflowEventSchema.parse({
            ...created,
            run: { ...created.run, startedAt: "2026-08-03T00:00:01.000Z" },
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "CURSOR_CONFLICT" });
  });

  it("serializes concurrent appends for one Run instead of publishing a fork", async () => {
    const root = await createRoot();
    const [created, started] = await createEvents();
    const storeA = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    const storeB = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    await storeA.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    });
    await storeA.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 1,
      events: [started],
    });
    const observationA = workflowEventSchema.parse({
      schemaVersion: "1.0.0",
      cursor: 3,
      type: "OBSERVATION_RECORDED",
      observation: {
        schemaVersion: "1.0.0",
        observationId: observationIdSchema.parse("obs_durable-a"),
        runId: "run_durable",
        attemptId: "att_durable",
        kind: "AGENT_RETURNED",
        observedAt: timestamp,
        evidenceIds: [],
      },
    }) as Extract<WorkflowEvent, { type: "OBSERVATION_RECORDED" }>;
    const observationB = workflowEventSchema.parse({
      ...observationA,
      observation: {
        ...observationA.observation,
        observationId: observationIdSchema.parse("obs_durable-b"),
      },
    }) as Extract<WorkflowEvent, { type: "OBSERVATION_RECORDED" }>;
    const results = await Promise.allSettled([
      storeA.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 2,
        events: [observationA],
      }),
      storeB.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 2,
        events: [observationB],
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveProperty("reason.code", "CURSOR_CONFLICT");
    expect(await storeA.read("run_durable")).toEqual([created, started, observationA]);
  });

  it("fails closed when another process holds the durable mutation lock", async () => {
    const root = await createRoot();
    const [created] = await createEvents();
    await mkdir(join(root, ".mutation-lock"));
    const store = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });

    await expect(
      store.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 0,
        events: [created],
      }),
    ).rejects.toMatchObject({ code: "STORE_BUSY" });
  });

  it.each([
    ["BEFORE_TEMP_WRITE", 1],
    ["AFTER_TEMP_WRITE", 1],
    ["AFTER_TEMP_SYNC", 1],
  ] as const)("replays a complete prior or new state after a %s fault", async (boundary, count) => {
    const root = await createRoot();
    const [created, started] = await createEvents();
    const clean = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    await clean.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    });
    const faulting = new FileWorkflowEventStore({
      stateRoot: root,
      storage: createStorage(root),
      faultInjector: (observed) => {
        if (observed === boundary) {
          throw new Error(`fixture fault at ${boundary}`);
        }
      },
    });

    await expect(
      faulting.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 1,
        events: [started],
      }),
    ).rejects.toBeInstanceOf(DurableStoreError);
    expect(await clean.read("run_durable")).toHaveLength(count);
  });

  it.each(["FAULT_INJECTED", "STORAGE_EXHAUSTED"] as const)(
    "confirms an exact committed segment and preserves the reserve after %s at publish",
    async (failureKind) => {
      const root = await createRoot();
      const [created, started] = await createEvents();
      const storage = createStorage(root);
      const clean = new FileWorkflowEventStore({ stateRoot: root, storage });
      await clean.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 0,
        events: [created],
      });
      let injected = false;
      const faulting = new FileWorkflowEventStore({
        stateRoot: root,
        storage,
        faultInjector: (boundary) => {
          if (!injected && boundary === "AFTER_PUBLISH") {
            injected = true;
            const error = new Error("fixture fault after publish") as NodeJS.ErrnoException;
            if (failureKind === "STORAGE_EXHAUSTED") {
              error.code = "ENOSPC";
            }
            throw error;
          }
        },
      });

      await expect(
        faulting.append({
          schemaVersion: "1.0.0",
          runId: "run_durable",
          expectedCursor: 1,
          events: [started],
        }),
      ).resolves.toMatchObject({ outcome: "APPLIED", startCursor: 2, endCursor: 2 });
      expect(await clean.read("run_durable")).toEqual([created, started]);
      expect((await stat(join(root, ".critical-reserve"))).size).toBe(4_096);
    },
  );

  it("keeps the prior stream replayable after an injected disk-full write", async () => {
    const root = await createRoot();
    const [created, started] = await createEvents();
    const clean = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    await clean.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    });
    const diskFull = new FileWorkflowEventStore({
      stateRoot: root,
      storage: createStorage(root),
      faultInjector: (boundary: AtomicWriteBoundary) => {
        if (boundary === "AFTER_TEMP_WRITE") {
          const error = new Error("fixture disk full") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        }
      },
    });

    await expect(
      diskFull.append({
        schemaVersion: "1.0.0",
        runId: "run_durable",
        expectedCursor: 1,
        events: [started],
      }),
    ).rejects.toMatchObject({ code: "STORAGE_EXHAUSTED" });
    expect(await clean.read("run_durable")).toEqual([created]);
  });

  it("fails closed on a corrupt committed segment without exposing the state path", async () => {
    const root = await createRoot();
    const [created] = await createEvents();
    const store = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });
    await store.append({
      schemaVersion: "1.0.0",
      runId: "run_durable",
      expectedCursor: 0,
      events: [created],
    });
    const directory = join(root, "events", "run_durable");
    const [segmentName] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    if (segmentName === undefined) {
      throw new Error("expected a committed segment");
    }
    const before = await readFile(join(directory, segmentName), "utf8");
    await writeFile(join(directory, segmentName), `${before.slice(0, -8)}corrupt`, "utf8");

    const error = await store.read("run_durable").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "STORE_CORRUPT" });
    expect(String(error)).not.toContain(root);
  });

  it("fails closed when the events root contains an unknown committed entry", async () => {
    const root = await createRoot();
    await mkdir(join(root, "events"), { recursive: true });
    await writeFile(join(root, "events", "unexpected.json"), "{}\n", "utf8");
    const store = new FileWorkflowEventStore({ stateRoot: root, storage: createStorage(root) });

    await expect(store.listRunIds()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });
});
