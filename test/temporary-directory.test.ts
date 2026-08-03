import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { createCanonicalTemporaryDirectory } from "../scripts/temporary-directory.mjs";

describe("canonical temporary directories", () => {
  it("returns the real path when the configured parent is an alias", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "hunter-pi-temp-directory-test-"));
    const canonicalParent = join(sandbox, "canonical-parent");
    const aliasParent = join(sandbox, "alias-parent");

    try {
      await mkdir(canonicalParent);
      await symlink(
        canonicalParent,
        aliasParent,
        process.platform === "win32" ? "junction" : "dir",
      );

      const created = await createCanonicalTemporaryDirectory("fixture-", aliasParent);
      const expectedParent = await realpath(canonicalParent);

      expect(relative(expectedParent, created)).toMatch(/^fixture-[^/\\]+$/u);
      expect(created).toBe(await realpath(created));
    } finally {
      await rm(sandbox, { force: true, recursive: true });
    }
  });
});
