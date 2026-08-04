import { access, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as managedChangeModule from "@hunter-pi/managed-change";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

interface Task6Fixture {
  readonly root: string;
  readonly repository: string;
  readonly baseCommit: string;
}

interface Task6Promotion {
  readonly schemaVersion: "hpi-quick-session-promotion.v1";
  readonly fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY";
  readonly baseCommit: string;
  readonly includePaths: readonly string[];
  readonly excludePaths: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly workspaceFingerprint: string;
  readonly sourceFingerprint: string;
  readonly excludedContentFingerprint: string;
}

type CreateFixture = (parentDirectory: string) => Promise<Task6Fixture>;
type CapturePromotion = (
  fixture: Task6Fixture,
  selection: {
    readonly includePaths: readonly string[];
    readonly excludePaths: readonly string[];
  },
) => Promise<Task6Promotion>;
type RemoveFixture = (fixture: Task6Fixture) => Promise<void>;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function requireExport(name: string): unknown {
  const value: unknown = Reflect.get(managedChangeModule, name);
  expect(value, `${name} must be exported`).toBeTypeOf("function");
  return value;
}

describe("Task 6 disposable Managed Change fixture", () => {
  it("captures every dirty path as explicitly included or excluded without portable absolute paths", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-test-parent-");
    cleanupRoots.push(parent);
    const createFixture = requireExport("createTask6DisposableFixture") as CreateFixture;
    const capturePromotion = requireExport("captureTask6QuickSessionPromotion") as CapturePromotion;
    const removeFixture = requireExport("removeTask6DisposableFixture") as RemoveFixture;

    const fixture = await createFixture(parent);
    expect(fixture.baseCommit).toMatch(/^[a-f0-9]{40}$/u);
    const promotion = await capturePromotion(fixture, {
      includePaths: ["result.txt"],
      excludePaths: ["scratch.txt"],
    });

    expect(promotion).toMatchObject({
      schemaVersion: "hpi-quick-session-promotion.v1",
      fixturePolicy: "AUTOMATIC_TEMPORARY_GIT_ONLY",
      baseCommit: fixture.baseCommit,
      includePaths: ["result.txt"],
      excludePaths: ["scratch.txt"],
      dirtyPaths: ["result.txt", "scratch.txt"],
    });
    expect(promotion.workspaceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(promotion.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(promotion.excludedContentFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(promotion)).not.toContain(parent);
    expect(JSON.stringify(promotion)).not.toContain(fixture.repository);

    await removeFixture(fixture);
    await expect(access(fixture.root)).rejects.toThrow();
  });

  it("rejects a dirty path that was not classified during promotion", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-test-parent-");
    cleanupRoots.push(parent);
    const createFixture = requireExport("createTask6DisposableFixture") as CreateFixture;
    const capturePromotion = requireExport("captureTask6QuickSessionPromotion") as CapturePromotion;
    const fixture = await createFixture(parent);
    await writeFile(join(fixture.repository, "unexpected.txt"), "unexpected\n", "utf8");

    await expect(
      capturePromotion(fixture, {
        includePaths: ["result.txt"],
        excludePaths: ["scratch.txt"],
      }),
    ).rejects.toThrow(/unclassified dirty path/u);
  });

  it("rejects overlapping, escaping, and linked mutation targets", async () => {
    const parent = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-task6-test-parent-");
    cleanupRoots.push(parent);
    const createFixture = requireExport("createTask6DisposableFixture") as CreateFixture;
    const capturePromotion = requireExport("captureTask6QuickSessionPromotion") as CapturePromotion;
    const fixture = await createFixture(parent);

    await expect(
      capturePromotion(fixture, {
        includePaths: ["result.txt"],
        excludePaths: ["result.txt", "scratch.txt"],
      }),
    ).rejects.toThrow(/both included and excluded/u);
    await expect(
      capturePromotion(fixture, {
        includePaths: ["../outside.txt", "result.txt"],
        excludePaths: ["scratch.txt"],
      }),
    ).rejects.toThrow(/repository-relative/u);

    const { link } = await import("node:fs/promises");
    await link(join(fixture.repository, "result.txt"), join(fixture.repository, "linked.txt"));
    await expect(
      capturePromotion(fixture, {
        includePaths: ["result.txt", "linked.txt"],
        excludePaths: ["scratch.txt"],
      }),
    ).rejects.toThrow(/linked mutation target/u);
  });
});
