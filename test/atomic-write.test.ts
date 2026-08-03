import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeImmutableAtomically } from "@hunter-pi/evidence";

import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

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
