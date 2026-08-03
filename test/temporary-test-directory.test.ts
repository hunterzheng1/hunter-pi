import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const parents: string[] = [];

afterEach(async () => {
  await Promise.all(
    parents.splice(0).map((parent) => rm(parent, { force: true, recursive: true })),
  );
});

describe("temporary test directory containment", () => {
  it("accepts a Windows case alias only when the canonical child remains contained", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-pi-temp-parent-"));
    parents.push(parent);
    const parentAlias = process.platform === "win32" ? parent.toLowerCase() : parent;

    const created = await createTemporaryTestDirectory(parentAlias, "fixture-");
    const canonicalParent = await realpath(parent);

    expect(relative(canonicalParent, created)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
  });
});
