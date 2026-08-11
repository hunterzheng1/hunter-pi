import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const portablePackerSource = await readFile(
  resolve(import.meta.dirname, "..", "scripts", "pack-windows-portable.mjs"),
  "utf8",
);

describe("Windows portable package launcher", () => {
  it("preserves the operator working directory when launching the packaged CLI", () => {
    expect(portablePackerSource).toContain('"  cwd: process.cwd(),",');
    expect(portablePackerSource).not.toContain('"  cwd: versionDirectory,",');
  });
});
