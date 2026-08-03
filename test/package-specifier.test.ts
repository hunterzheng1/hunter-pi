import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRelativeFileSpecifier } from "../scripts/package-specifier.mjs";

describe("package smoke file specifiers", () => {
  it("uses a portable relative file reference instead of an absolute URL", () => {
    const fixtureRoot = join("fixture", "root with spaces");
    const consumerDirectory = join(fixtureRoot, "consumer");
    const archivePath = join(fixtureRoot, "archives", "hunter-pi-domain-0.0.0.tgz");

    expect(createRelativeFileSpecifier(consumerDirectory, archivePath)).toBe(
      "file:../archives/hunter-pi-domain-0.0.0.tgz",
    );
  });
});
